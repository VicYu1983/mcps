/**
 * MCP 协议层测试。
 *
 * 用 SDK 的 InMemoryTransport 直连 server 与 client，不经过网络，
 * 但走的是真实的 JSON-RPC 与 schema 校验链路——能验证：
 *   - tools/list 的工具清单确实来自命令表
 *   - Zod schema 被正确转成 canonical JSON Schema（annotations、required）
 *   - tools/call 正常返回 structuredContent，且与 outputSchema 相符
 *   - 业务错误被翻译成 isError 结果而不是协议级错误
 *   - start → poll → done 的 jobId 轮询流程在协议层可用
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { assert, run, test, waitFor } from './helpers.js'
import { CommandRegistry } from '../src/core/registry.js'
import { attachCommands, callCommand } from '../src/mcp/adapt.js'
import { loadModules } from '../src/modules/index.js'
import { JobManager } from '../src/runtime/jobs.js'
import type { ProbeOutcome } from '../src/modules/netscan/scanner.js'

/** 造一个确定性的假网络：10.7.0.1 有 80 开放，10.7.0.9 只在 ARP 里。 */
function fakeProbe(): (ip: string, port: number) => Promise<ProbeOutcome> {
  const openHost = '10.7.0.1'
  const openPort = 80
  return async (ip, port) => {
    await new Promise((resolve) => setTimeout(resolve, 2))
    const open = ip === openHost && port === openPort
    const responded = ip === openHost
    return { port, open, responded, latencyMs: responded ? 4 : 0 }
  }
}

interface Harness {
  client: Client
  registry: CommandRegistry
  jobs: JobManager
  modules: ReturnType<typeof loadModules>
  close: () => Promise<void>
}

async function harness(): Promise<Harness> {
  const registry = new CommandRegistry()
  const jobs = new JobManager({ sweepIntervalMs: 0 })
  const modules = loadModules(
    registry,
    { jobs },
    {
      netscan: {
        probePort: fakeProbe(),
        readArpTable: async () => new Map([['10.7.0.9', 'AA:BB:CC:00:11:22']]),
      },
    },
  )
  const server = new McpServer({ name: 'mcp-toolbox-test', version: '0.0.0' })
  attachCommands(server, registry, { log: () => {} })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  return {
    client,
    registry,
    jobs,
    modules,
    close: async () => {
      jobs.cancelAll()
      await client.close().catch(() => {})
      await server.close().catch(() => {})
      jobs.dispose()
    },
  }
}

test('tools/list: 清单完全来自命令表，命名带模块前缀', async () => {
  const h = await harness()
  try {
    const { tools } = await h.client.listTools()
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['netscan_get_scan', 'netscan_list_interfaces', 'netscan_start_scan', 'netscan_stop_scan'],
    )
    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a real description`)
      assert.equal(tool.inputSchema.type, 'object')
      // canonical JSON Schema：required 是顶层数组，且不能出现 type 数组
      if (tool.inputSchema.required !== undefined) assert.ok(Array.isArray(tool.inputSchema.required))
      for (const property of Object.values(tool.inputSchema.properties ?? {})) {
        assert.ok(!Array.isArray((property as { type?: unknown }).type), 'type arrays are not allowed')
      }
    }
  } finally {
    await h.close()
  }
})

test('tools/list: 注解与输出 schema 都传到客户端', async () => {
  const h = await harness()
  try {
    const { tools } = await h.client.listTools()
    const byName = new Map(tools.map((tool) => [tool.name, tool]))

    const listInterfaces = byName.get('netscan_list_interfaces')
    assert.equal(listInterfaces?.annotations?.readOnlyHint, true)
    assert.equal(listInterfaces?.annotations?.openWorldHint, false)

    const start = byName.get('netscan_start_scan')
    assert.equal(start?.annotations?.readOnlyHint, false)
    assert.equal(start?.annotations?.openWorldHint, true)
    assert.ok(start?.outputSchema, 'start_scan must advertise an outputSchema')

    const outputProperties = (start?.outputSchema as { properties?: Record<string, unknown> }).properties
    assert.ok(outputProperties?.jobId, 'outputSchema must declare jobId')
  } finally {
    await h.close()
  }
})

test('tools/call: 只读工具返回结构化结果 + 人读文本', async () => {
  const h = await harness()
  try {
    const result = await h.client.callTool({ name: 'netscan_list_interfaces', arguments: {} })
    assert.ok(!result.isError)
    const structured = result.structuredContent as { count: number; interfaces: unknown[] }
    assert.equal(typeof structured.count, 'number')
    assert.equal(structured.interfaces.length, structured.count)
    const text = (result.content as Array<{ type: string; text: string }>)[0]
    assert.equal(text?.type, 'text')
    assert.ok(text!.text.length > 0)
  } finally {
    await h.close()
  }
})

test('tools/call: 参数校验失败被翻译成 isError，且不抛协议错误', async () => {
  const h = await harness()
  try {
    const result = await h.client.callTool({
      name: 'netscan_start_scan',
      arguments: { target: '300.0.0.0/24' },
    })
    assert.equal(result.isError, true)
    const structured = result.structuredContent as { code: string; field?: string }
    assert.equal(structured.code, 'invalid-target')
    assert.equal(structured.field, 'target')
    const text = (result.content as Array<{ text: string }>)[0]
    assert.match(text!.text, /invalid-target/)
  } finally {
    await h.close()
  }
})

test('tools/call: start → poll → done 的 jobId 轮询流程', async () => {
  const h = await harness()
  try {
    const started = await h.client.callTool({
      name: 'netscan_start_scan',
      arguments: { target: '10.7.0.1-10.7.0.10', ports: 80, resolveNames: false },
    })
    assert.ok(!started.isError, JSON.stringify(started))
    const job = started.structuredContent as { jobId: string; status: string; total: number; pollIntervalMs: number }
    assert.match(job.jobId, /^scan-\d+$/)
    assert.equal(job.status, 'running')
    assert.equal(job.total, 10)
    assert.ok(job.pollIntervalMs > 0, '必须告诉调用方轮询间隔')

    await waitFor(() => h.jobs.get(job.jobId)?.status === 'succeeded', 5_000)

    const polled = await h.client.callTool({
      name: 'netscan_get_scan',
      arguments: { jobId: job.jobId, waitMs: 0 },
    })
    assert.ok(!polled.isError)
    const scan = polled.structuredContent as {
      status: string
      aliveCount: number
      hosts: Array<{ ip: string; ports: number[]; via: string; mac?: string }>
      hasMore: boolean
    }
    assert.equal(scan.status, 'succeeded')
    assert.equal(scan.aliveCount, 2)
    const byIp = new Map(scan.hosts.map((host) => [host.ip, host]))
    assert.deepEqual(byIp.get('10.7.0.1')?.ports, [80])
    assert.equal(byIp.get('10.7.0.9')?.via, 'arp')
    assert.equal(byIp.get('10.7.0.9')?.mac, 'AA:BB:CC:00:11:22')
    assert.equal(scan.hasMore, false)
  } finally {
    await h.close()
  }
})

test('tools/call: 扫描中点 stop 会收敛成 cancelled 并带回部分结果', async () => {
  const h = await harness()
  try {
    const started = await h.client.callTool({
      name: 'netscan_start_scan',
      arguments: { target: '10.7.1.0/24', ports: 80, resolveNames: false, concurrency: 2 },
    })
    const job = started.structuredContent as { jobId: string }
    await new Promise((resolve) => setTimeout(resolve, 30))

    const stopped = await h.client.callTool({ name: 'netscan_stop_scan', arguments: { jobId: job.jobId } })
    assert.ok(!stopped.isError)
    const result = stopped.structuredContent as { status: string; message: string; scanned: number }
    assert.ok(['cancelled', 'succeeded'].includes(result.status))
    assert.match(result.message, /scan (stopped|stopped after)|already finished/)

    // 再调一次必须幂等，不能抛错
    const again = await h.client.callTool({ name: 'netscan_stop_scan', arguments: { jobId: job.jobId } })
    assert.ok(!again.isError)
  } finally {
    await h.close()
  }
})

test('tools/call: 同时只允许一个扫描，第二次启动回 scan-running', async () => {
  const h = await harness()
  try {
    const first = await h.client.callTool({
      name: 'netscan_start_scan',
      arguments: { target: '10.7.2.0/24', ports: 80, resolveNames: false, concurrency: 1 },
    })
    assert.ok(!first.isError)
    const second = await h.client.callTool({
      name: 'netscan_start_scan',
      arguments: { target: '10.7.3.0/24', ports: 80, resolveNames: false },
    })
    assert.equal(second.isError, true)
    const structured = second.structuredContent as { code: string; details?: { jobId?: string } }
    assert.equal(structured.code, 'scan-running')
    assert.ok(structured.details?.jobId, '必须告诉调用方是哪个 job 占着')
    await h.client.callTool({ name: 'netscan_stop_scan', arguments: {} })
  } finally {
    await h.close()
  }
})

test('adapt: callCommand 让非 MCP 入口复用同一份 handler', async () => {
  // Web API 层将来就是这样调用：绕开传输，直接跑命令。
  const registry = new CommandRegistry()
  const jobs = new JobManager({ sweepIntervalMs: 0 })
  loadModules(registry, { jobs }, { netscan: { probePort: fakeProbe() } })
  try {
    const { text, structured } = await callCommand(registry, 'netscan_list_interfaces', {})
    assert.equal(typeof structured.count, 'number')
    assert.ok(text.length > 0 || structured.count === 0)
    const bad = await callCommand(registry, 'netscan_get_scan', {}).catch((error: unknown) => error)
    assert.equal((bad as { code?: string }).code, 'not-found')
  } finally {
    jobs.dispose()
  }
})

test('adapt: 命令的 input schema 拒绝多余字段之外的类型错误', async () => {
  const registry = new CommandRegistry()
  const jobs = new JobManager({ sweepIntervalMs: 0 })
  loadModules(registry, { jobs }, { netscan: { probePort: fakeProbe() } })
  try {
    await callCommand(registry, 'netscan_start_scan', { target: '10.7.0.1', ports: 'not-a-port' }).then(
      () => assert.fail('expected rejection'),
      (error: unknown) => {
        assert.ok(error instanceof Error)
      },
    )
  } finally {
    jobs.dispose()
  }
})

void run()
