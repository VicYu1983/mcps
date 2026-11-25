/** modbus 命令层：连线、读取切块、写入验证、watch、扫站号、唯读锁定。 */
import { assert, run, test } from './helpers.js'
import { ToolboxError } from '../src/core/errors.js'
import { CommandRegistry } from '../src/core/registry.js'
import { callCommand } from '../src/mcp/adapt.js'
import { loadModules } from '../src/modules/index.js'
import { JobManager } from '../src/runtime/jobs.js'
import { startFakeServer, type FakeServerOptions } from './fake-modbus-server.js'

interface Harness {
  registry: CommandRegistry
  modules: ReturnType<typeof loadModules>
  close: () => void
}

function harness(): Harness {
  const registry = new CommandRegistry()
  const jobs = new JobManager({ sweepIntervalMs: 0 })
  const modules = loadModules(registry, { jobs }, { modbus: { requestTimeoutMs: 400 } })
  return {
    registry,
    modules,
    close: () => {
      modules.modbus.service.close()
      jobs.dispose()
    },
  }
}

async function withModbus<T>(
  options: FakeServerOptions,
  body: (context: Harness & { server: Awaited<ReturnType<typeof startFakeServer>> }) => Promise<T>,
): Promise<T> {
  const server = await startFakeServer(options)
  const context = harness()
  try {
    return await body({ ...context, server })
  } finally {
    context.close()
    await server.close()
  }
}

/** 命令名 → 直接跑 handler（等同 MCP 与 Web 两条通道的共用入口）。 */
async function call(context: Harness, name: string, input: unknown) {
  return callCommand(context.registry, name, input)
}

test('注册: modbus 五个工具进 MCP，第六个（唯读锁）只留在 Web', () => {
  const context = harness()
  try {
    const mcp = context.registry.listFor('mcp').map((command) => command.name)
    const web = context.registry.listFor('web').map((command) => command.name)
    for (const name of ['modbus_connection', 'modbus_read', 'modbus_write', 'modbus_watch', 'modbus_scan_units']) {
      assert.ok(mcp.includes(name), `${name} 应该挂在 MCP 上`)
      assert.ok(web.includes(name), `${name} 也应该给 Web 用`)
    }
    assert.ok(!mcp.includes('modbus_set_guard'), 'Agent 不该拿到唯读锁开关')
    assert.ok(web.includes('modbus_set_guard'), '唯读锁开关必须留在 Web')
    assert.equal(context.registry.list().length, 4 + 6)
  } finally {
    context.close()
  }
})

test('连线: status → connect → 读 → disconnect', async () => {
  await withModbus({ holding: [11, 22, 33] }, async (context) => {
    const idle = await call(context, 'modbus_connection', {})
    assert.equal((idle.structured as { connected: boolean }).connected, false)

    const connected = await call(context, 'modbus_connection', {
      action: 'connect',
      host: '127.0.0.1',
      port: context.server.port,
      unitId: 1,
    })
    const snapshot = connected.structured as { connected: boolean; host: string; port: number; unitId: number }
    assert.equal(snapshot.connected, true)
    assert.equal(snapshot.host, '127.0.0.1')
    assert.equal(snapshot.port, context.server.port)

    const read = await call(context, 'modbus_read', { start: 0, count: 3 })
    const result = read.structured as { values: number[]; rows: Array<{ text: string }>; chunks: number }
    assert.deepEqual(result.values, [11, 22, 33])
    assert.deepEqual(result.rows.map((row) => row.text), ['11', '22', '33'])
    assert.equal(result.chunks, 1)
    assert.match(read.text, /holding 0\.\.2: 3 value\(s\)/)

    const gone = await call(context, 'modbus_connection', { action: 'disconnect' })
    assert.equal((gone.structured as { connected: boolean }).connected, false)
  })
})

test('读取切块: 300 个暂存器分三次请求；f32 的切块依值宽对齐', async () => {
  const holding = Array.from({ length: 1024 }, (_, index) => index)
  await withModbus({ holding }, async (context) => {
    await call(context, 'modbus_connection', { action: 'connect', host: '127.0.0.1', port: context.server.port })

    const plain = await call(context, 'modbus_read', { start: 0, count: 300 })
    const plainResult = plain.structured as { chunks: number; rows: Array<{ address: number }>; trailing: number }
    assert.equal(plainResult.chunks, 3)
    assert.equal(plainResult.rows.length, 300)
    assert.equal(plainResult.rows.at(-1)?.address, 299)
    assert.equal(plainResult.trailing, 0)

    const floats = await call(context, 'modbus_read', { start: 0, count: 300, type: 'f32' })
    const floatResult = floats.structured as { chunks: number; chunkSize: number; rows: unknown[] }
    assert.equal(floatResult.chunkSize, 124, '125 不能被 2 整除，必须向下对齐到 124')
    assert.equal(floatResult.chunks, 3)
    assert.equal(floatResult.rows.length, 150)
  })
})

test('读取截断: 超过 1024 个暂存器会 capped 并回报 truncated', async () => {
  const holding = Array.from({ length: 2048 }, (_, index) => index)
  await withModbus({ holding }, async (context) => {
    await call(context, 'modbus_connection', { action: 'connect', host: '127.0.0.1', port: context.server.port })
    const read = await call(context, 'modbus_read', { start: 0, count: 5000 })
    const result = read.structured as { count: number; requested: number; truncated: boolean; rows: unknown[] }
    assert.equal(result.count, 1024)
    assert.equal(result.requested, 5000)
    assert.equal(result.truncated, true)
    assert.equal(result.rows.length, 1024)
  })
})

test('比例: scale 0.1 读成 23.5，写回 23.5 变 235', async () => {
  await withModbus({ holding: [235] }, async (context) => {
    await call(context, 'modbus_connection', { action: 'connect', host: '127.0.0.1', port: context.server.port })
    const read = await call(context, 'modbus_read', { start: 0, count: 1, scale: 0.1 })
    assert.equal((read.structured as { rows: Array<{ text: string }> }).rows[0]?.text, '23.5')

    const written = await call(context, 'modbus_write', {
      address: 0,
      value: 40,
      scale: 0.1,
      verify: true,
    })
    const result = written.structured as { verified: boolean | null; readBack: number; values: number[] }
    assert.deepEqual(result.values, [400])
    assert.equal(context.server.state.holding[0], 400)
    assert.equal(result.verified, true)
    assert.equal(result.readBack, 40)
  })
})

test('写入: 单笔、批量、线圈、位元（先读改再写回）', async () => {
  await withModbus({ holding: Array.from({ length: 64 }, () => 0) }, async (context) => {
    await call(context, 'modbus_connection', { action: 'connect', host: '127.0.0.1', port: context.server.port })

    await call(context, 'modbus_write', { address: 5, value: 1234 })
    assert.equal(context.server.state.holding[5], 1234)

    await call(context, 'modbus_write', { address: 6, values: [1, 2, 3] })
    assert.deepEqual(context.server.state.holding.slice(6, 9), [1, 2, 3])

    await call(context, 'modbus_write', { kind: 'coil', address: 9, value: 1 })
    assert.equal(context.server.state.coils[9], true)

    const bit = await call(context, 'modbus_write', { address: 5, bit: 3, value: 1 })
    const bitResult = bit.structured as { before: number; after: number }
    assert.equal(bitResult.before, 1234)
    assert.equal(bitResult.after, 1234 | 0b1000)
    assert.equal(context.server.state.holding[5], 1234 | 0b1000)

    const cleared = await call(context, 'modbus_write', { address: 5, bit: 3, value: 0 })
    assert.equal((cleared.structured as { after: number }).after, 1234)
  })
})

test('唯读锁定: 面板能开关，Agent 写入被 write-protected 挡下', async () => {
  await withModbus({}, async (context) => {
    await call(context, 'modbus_connection', { action: 'connect', host: '127.0.0.1', port: context.server.port })
    await call(context, 'modbus_set_guard', { readOnly: true })

    await assert.rejects(
      () => call(context, 'modbus_write', { address: 1, value: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof ToolboxError)
        assert.equal(error.code, 'write-protected')
        return true
      },
    )

    const status = await call(context, 'modbus_connection', {})
    assert.equal((status.structured as { readOnly: boolean }).readOnly, true)

    await call(context, 'modbus_set_guard', { readOnly: false })
    await call(context, 'modbus_write', { address: 1, value: 1 })
    assert.equal(context.server.state.holding[1], 1)
  })
})

test('watch: 写入后等到值settle，逾时则 matched=false', async () => {
  await withModbus({ holding: [0] }, async (context) => {
    await call(context, 'modbus_connection', { action: 'connect', host: '127.0.0.1', port: context.server.port })
    await call(context, 'modbus_write', { address: 0, value: 7 })

    const matched = await call(context, 'modbus_watch', { start: 0, expect: 7, timeoutMs: 2000 })
    const result = matched.structured as { matched: boolean; attempts: number; current: string }
    assert.equal(result.matched, true)
    assert.equal(result.attempts, 1)
    assert.equal(result.current, '7')
    assert.match(matched.text, /matched 7 as 7/)

    const missed = await call(context, 'modbus_watch', {
      start: 0,
      expect: 99,
      timeoutMs: 300,
      intervalMs: 50,
    })
    const missedResult = missed.structured as { matched: boolean; attempts: number }
    assert.equal(missedResult.matched, false)
    assert.ok(missedResult.attempts >= 2, `应该反复轮询，实际 ${missedResult.attempts} 次`)
  })
})

test('scan-units: 有回应的站号才算存在，静默不算', async () => {
  await withModbus({ unitId: 3 }, async (context) => {
    const scan = await call(context, 'modbus_scan_units', {
      host: '127.0.0.1',
      port: context.server.port,
      from: 1,
      to: 5,
      timeoutMs: 120,
      maxMs: 10_000,
    })
    const result = scan.structured as { responded: number[]; scanned: number; truncated: boolean }
    assert.deepEqual(result.responded, [3])
    assert.equal(result.scanned, 5)
    assert.equal(result.truncated, false)
  })
})

test('错误: 未连线读取回 not-connected，附可行动提示', async () => {
  const context = harness()
  try {
    await assert.rejects(
      () => call(context, 'modbus_read', { start: 0, count: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof ToolboxError)
        assert.equal(error.code, 'not-connected')
        assert.match(error.toClientMessage(), /modbus_connection/)
        return true
      },
    )
    // 写入也要先过同一个门槛（但唯读锁才是第一道）
    await assert.rejects(() => call(context, 'modbus_write', { address: 0, value: 1 }))
  } finally {
    context.close()
  }
})

void run()
