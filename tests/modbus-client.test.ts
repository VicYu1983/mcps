/** Modbus TCP 核心：对假伺服器验证 FC01–FC16 子集、例外、逾时与排队。 */
import { assert, run, test } from './helpers.js'
import { ToolboxError } from '../src/core/errors.js'
import { ModbusTcpClient } from '../src/modules/modbus/client.js'
import { startFakeServer } from './fake-modbus-server.js'

async function withServer<T>(
  options: Parameters<typeof startFakeServer>[0],
  body: (port: number) => Promise<T>,
): Promise<T> {
  const server = await startFakeServer(options)
  try {
    return await body(server.port)
  } finally {
    await server.close()
  }
}

test('FC03/FC04: 读保持与输入暂存器', async () => {
  const holding = Array.from({ length: 64 }, (_, index) => 1000 + index)
  const input = Array.from({ length: 64 }, (_, index) => 500 - index)
  await withServer({ holding, input }, async (port) => {
    const client = new ModbusTcpClient({ host: '127.0.0.1', port, unitId: 1, timeoutMs: 1000 })
    await client.open()
    try {
      assert.deepEqual(await client.readHoldingRegisters(10, 3), [1010, 1011, 1012])
      assert.deepEqual(await client.readInputRegisters(0, 2), [500, 499])
    } finally {
      client.close()
    }
  })
})

test('FC01/FC02: 读线圈与离散输入', async () => {
  const coils = Array.from({ length: 32 }, (_, index) => index % 3 === 0)
  await withServer({ coils }, async (port) => {
    const client = new ModbusTcpClient({ host: '127.0.0.1', port, timeoutMs: 1000 })
    await client.open()
    try {
      const bits = await client.readCoils(0, 9)
      assert.deepEqual(bits, [true, false, false, true, false, false, true, false, false])
      const discrete = await client.readDiscreteInputs(0, 4)
      assert.deepEqual(discrete, [false, false, false, false])
    } finally {
      client.close()
    }
  })
})

test('FC05/FC06/FC15/FC16: 写入真的落在设备上', async () => {
  const server = await startFakeServer({})
  const client = new ModbusTcpClient({ host: '127.0.0.1', port: server.port, timeoutMs: 1000 })
  await client.open()
  try {
    const single = await client.writeSingleRegister(7, 4242)
    assert.equal(single.value, 4242)
    assert.equal(server.state.holding[7], 4242)

    await client.writeMultipleRegisters(10, [1, 2, 3])
    assert.deepEqual(server.state.holding.slice(10, 13), [1, 2, 3])

    await client.writeSingleCoil(3, true)
    assert.equal(server.state.coils[3], true)

    await client.writeMultipleCoils(5, [true, false, true])
    assert.deepEqual(server.state.coils.slice(5, 8), [true, false, true])
  } finally {
    client.close()
    await server.close()
  }
})

test('例外码: 越界位址回 modbus-exception，且带 exceptionCode', async () => {
  await withServer({ exceptionAddresses: [42] }, async (port) => {
    const client = new ModbusTcpClient({ host: '127.0.0.1', port, timeoutMs: 1000 })
    await client.open()
    try {
      await client.readHoldingRegisters(41, 1)
      await assert.rejects(
        () => client.readHoldingRegisters(42, 1),
        (error: unknown) => {
          assert.ok(error instanceof ToolboxError)
          assert.equal(error.code, 'modbus-exception')
          assert.deepEqual(error.details, { exceptionCode: 2, functionCode: 3 })
          return true
        },
      )
    } finally {
      client.close()
    }
  })
})

test('逾时: 站号不合时静默，逾时后 code 是 timeout 而不是挂住', async () => {
  await withServer({ unitId: 9 }, async (port) => {
    const client = new ModbusTcpClient({ host: '127.0.0.1', port, unitId: 1, timeoutMs: 200 })
    await client.open()
    try {
      const began = Date.now()
      await assert.rejects(
        () => client.readHoldingRegisters(0, 1),
        (error: unknown) => {
          assert.ok(error instanceof ToolboxError)
          assert.equal(error.code, 'timeout')
          return true
        },
      )
      const elapsed = Date.now() - began
      assert.ok(elapsed >= 180 && elapsed < 2000, `逾时应约 200 ms，实际 ${elapsed} ms`)
      assert.equal(client.closed, true, '逾时后 socket 必须销毁，否则下一帧会错位')
    } finally {
      client.close()
    }
  })
})

test('未连线: request 回 not-connected', async () => {
  const client = new ModbusTcpClient({ host: '127.0.0.1', port: 1, timeoutMs: 200 })
  await assert.rejects(
    () => client.readHoldingRegisters(0, 1),
    (error: unknown) => {
      assert.ok(error instanceof ToolboxError)
      assert.equal(error.code, 'not-connected')
      return true
    },
  )
})

test('并发: 同时发三个请求，回应不会被配错', async () => {
  const holding = Array.from({ length: 32 }, (_, index) => index * 7)
  await withServer({ holding }, async (port) => {
    const client = new ModbusTcpClient({ host: '127.0.0.1', port, timeoutMs: 1000 })
    await client.open()
    try {
      const [a, b, c] = await Promise.all([
        client.readHoldingRegisters(0, 4),
        client.readHoldingRegisters(10, 2),
        client.readHoldingRegisters(20, 1),
      ])
      assert.deepEqual(a, [0, 7, 14, 21])
      assert.deepEqual(b, [70, 77])
      assert.deepEqual(c, [140])
    } finally {
      client.close()
    }
  })
})

void run()
