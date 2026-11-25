/**
 * 传输层测试：真实 HTTP 端点 + 真实 stdio 子进程。
 *
 * 这两条都必须真跑一次——InMemoryTransport 不经过 Node http 适配层，
 * 也不验证进程启动参数、stdout 污染等问题。
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import http from 'node:http'
import { assert, run, test, waitFor } from './helpers.js'
import { CommandRegistry } from '../src/core/registry.js'
import { loadModules } from '../src/modules/index.js'
import { JobManager } from '../src/runtime/jobs.js'
import { startServer } from '../src/runtime/server.js'

function buildRegistry(): { registry: CommandRegistry; jobs: JobManager } {
  const registry = new CommandRegistry()
  const jobs = new JobManager({ sweepIntervalMs: 0 })
  loadModules(registry, { jobs })
  return { registry, jobs }
}

test('http: streamable HTTP 端点可用，且只绑 127.0.0.1', async () => {
  const { registry, jobs } = buildRegistry()
  const running = await startServer({
    registry,
    serverInfo: { name: 'mcp-toolbox-http-test', version: '0.0.0' },
    stdio: false,
    http: { port: 0, path: '/mcp' },
    log: () => {},
  })
  assert.ok(running.url, 'http 模式必须给出 url')
  assert.match(running.url!, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  assert.equal(running.toolCount, registry.listFor('mcp').length)

  const client = new Client({ name: 'http-test', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(running.url!))
  try {
    await client.connect(transport)
    const { tools } = await client.listTools()
    assert.equal(tools.length, registry.listFor('mcp').length)
    const result = await client.callTool({ name: 'netscan_list_interfaces', arguments: {} })
    assert.ok(!result.isError || (result.structuredContent as { code?: string }).code !== undefined)
  } finally {
    await client.close().catch(() => {})
    jobs.cancelAll()
    await running.close()
    jobs.dispose()
  }
})

test('http: 未知路径返回 404，不会把请求交给 MCP', async () => {
  const { registry, jobs } = buildRegistry()
  const running = await startServer({
    registry,
    serverInfo: { name: 'mcp-toolbox-http-test', version: '0.0.0' },
    stdio: false,
    http: { port: 0, path: '/mcp' },
    log: () => {},
  })
  try {
    const response = await fetch(running.url!.replace('/mcp', '/other'), { method: 'POST' })
    assert.equal(response.status, 404)
    const body = (await response.json()) as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'not-found')
  } finally {
    jobs.cancelAll()
    await running.close()
    jobs.dispose()
  }
})

test('http: 非 localhost 的 Host 头被 DNS rebinding 防护拒绝', async () => {
  const { registry, jobs } = buildRegistry()
  const running = await startServer({
    registry,
    serverInfo: { name: 'mcp-toolbox-http-test', version: '0.0.0' },
    stdio: false,
    http: { port: 0, path: '/mcp' },
    log: () => {},
  })
  const port = new URL(running.url!).port
  try {
    // 注意：fetch 会忽略伪造的 Host 头，必须用裸 http 才能真的测这条防护。
    const post = (host: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const payload = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'host-header-test', version: '0.0.0' },
          },
        })
        const request = http.request(
          {
            host: '127.0.0.1',
            port,
            path: '/mcp',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              host,
              'content-length': Buffer.byteLength(payload),
              accept: 'application/json, text/event-stream',
            },
          },
          (response) => {
            let body = ''
            response.on('data', (chunk) => {
              body += chunk
            })
            response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
          },
        )
        request.on('error', reject)
        request.end(payload)
      })

    // 合法 Host：必须进到 MCP 层并完成 initialize
    const allowed = await post(`127.0.0.1:${port}`)
    assert.ok(allowed.status < 400, `expected the legitimate host to pass, got ${allowed.status}`)

    // 伪造 Host：必须在进入 MCP 之前被拒
    const rejected = await post('evil.example.com')
    assert.equal(rejected.status, 403)
    assert.match(rejected.body, /Invalid Host/i)
  } finally {
    jobs.cancelAll()
    await running.close()
    jobs.dispose()
  }
})

test('stdio: 子进程启动后能完成 initialize 与 tools/list', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/index.ts'],
    cwd: process.cwd(),
    stderr: 'pipe',
  })
  const client = new Client({ name: 'stdio-test', version: '0.0.0' })
  try {
    await client.connect(transport)
    const { tools } = await client.listTools()
    // 期望值从同一份注册表推导，而不是写死清单：新增模组时不必回来改这里，
    // 而「只给 Web 的命令不该出现」仍由 listFor('mcp') 保证。
    const local = buildRegistry()
    const expected = local.registry.listFor('mcp').map((command) => command.name).sort()
    local.jobs.dispose()
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      expected,
    )
    const result = await client.callTool({ name: 'netscan_get_scan', arguments: { waitMs: 0 } })
    assert.equal(result.isError, true)
    const structured = result.structuredContent as { code: string }
    assert.equal(structured.code, 'not-found')
  } finally {
    await client.close().catch(() => {})
  }
})

test('生命周期: stdio 被客户端关掉后，HTTP 随之关闭、进程退出、端口释放', async () => {
  // 这条测试锁定「挂载 MCP 时开面板、卸载时一起关」这个契约。
  // 它必须用真实子进程：检查的是进程生命周期，InMemoryTransport 测不到。
  const port = 3800 + Math.floor(Math.random() * 90)
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/index.ts', '--http', '--port', String(port)],
    cwd: process.cwd(),
    stderr: 'pipe',
  })
  const client = new Client({ name: 'lifecycle-test', version: '0.0.0' })
  const baseUrl = `http://127.0.0.1:${port}`

  try {
    await client.connect(transport)
    // 挂载期间：HTTP 面板与 API 都必须可用
    const api = await fetch(`${baseUrl}/api/commands`)
    assert.equal(api.status, 200, 'web API 应在挂载期间可用')
    const panel = await fetch(`${baseUrl}/`)
    assert.equal(panel.status, 200, '面板应在挂载期间可用')
    await panel.text()

    // 卸载：关掉 stdio，服务端应当自己收尾
    await client.close()
    await waitFor(
      async () => {
        try {
          await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(600) })
          return false
        } catch {
          return true
        }
      },
      8000,
      200,
    )
    assert.ok(true)
  } finally {
    await client.close().catch(() => {})
  }
})

void run()
