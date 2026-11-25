/**
 * 测试用假 Modbus TCP 伺服器。
 *
 * 移植自 DSH 的 modbus-poll-tests/fake-server.mjs，改成 TS 并拿掉展示用的 CLI。
 * 支援 FC01/02/03/04/05/06/15/16，可以模拟：
 *   - 不合的站号静默不回（真实现场的常见行为）
 *   - 指定站号完全静默（用来测逾时与「静默不算存在」）
 *   - 位址越界回例外码 2（设备回例外也算活着）
 */
import net from 'node:net'
import type { AddressInfo } from 'node:net'

export interface FakeServerOptions {
  unitId?: number
  holding?: number[]
  input?: number[]
  coils?: boolean[]
  discrete?: boolean[]
  /** 这些站号完全不回应。 */
  silentUnits?: number[]
  /** 这些位址读到时回例外码 2。 */
  exceptionAddresses?: number[]
}

export interface FakeServer {
  port: number
  /** 收到的请求数，含被静默忽略的。 */
  requests: number
  state: {
    holding: number[]
    input: number[]
    coils: boolean[]
    discrete: boolean[]
  }
  close: () => Promise<void>
}

const ILLEGAL_FUNCTION = 1
const ILLEGAL_ADDRESS = 2

export async function startFakeServer(options: FakeServerOptions = {}): Promise<FakeServer> {
  const unitId = options.unitId ?? 1
  const silent = new Set(options.silentUnits ?? [])
  const badAddresses = new Set(options.exceptionAddresses ?? [])

  const state = {
    holding: [...(options.holding ?? Array.from({ length: 256 }, () => 0))],
    input: [...(options.input ?? Array.from({ length: 256 }, () => 0))],
    coils: [...(options.coils ?? Array.from({ length: 256 }, () => false))],
    discrete: [...(options.discrete ?? Array.from({ length: 256 }, () => false))],
  }

  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (buffer.length < 7) return
        const length = buffer.readUInt16BE(4)
        const total = 6 + length
        if (buffer.length < total) return
        const frame = buffer.subarray(0, total)
        buffer = buffer.subarray(total)
        result.requests += 1
        const reply = handle(frame)
        if (reply) socket.write(reply)
      }
    })
    socket.on('error', () => {})
  })

  const result: FakeServer = {
    port: 0,
    requests: 0,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }

  function exception(frame: Buffer, code: number): Buffer {
    const pdu = Buffer.from([(frame[7] ?? 0) | 0x80, code])
    return wrap(frame, pdu)
  }

  function wrap(frame: Buffer, pdu: Buffer): Buffer {
    const header = Buffer.alloc(7)
    frame.copy(header, 0, 0, 4)
    header.writeUInt16BE(pdu.length + 1, 4)
    header.writeUInt8(frame[6] ?? 1, 6)
    return Buffer.concat([header, pdu])
  }

  function handle(frame: Buffer): Buffer | null {
    const frameUnit = frame[6] ?? 0
    if (frameUnit !== unitId) return null // 站号不合就静默，跟真的设备一样
    if (silent.has(frameUnit)) return null

    const fc = frame[7] ?? 0
    const start = ((frame[8] ?? 0) << 8) | (frame[9] ?? 0)
    const countOrValue = ((frame[10] ?? 0) << 8) | (frame[11] ?? 0)

    switch (fc) {
      case 1:
      case 2: {
        const table = fc === 1 ? state.coils : state.discrete
        if (start + countOrValue > table.length) return exception(frame, ILLEGAL_ADDRESS)
        const byteCount = Math.ceil(countOrValue / 8)
        const data = Buffer.alloc(byteCount)
        for (let index = 0; index < countOrValue; index += 1) {
          if (table[start + index]) data[index >> 3] = (data[index >> 3] ?? 0) | (1 << (index & 7))
        }
        return wrap(frame, Buffer.concat([Buffer.from([fc, byteCount]), data]))
      }
      case 3:
      case 4: {
        const table = fc === 3 ? state.holding : state.input
        if (start + countOrValue > table.length) return exception(frame, ILLEGAL_ADDRESS)
        for (let index = 0; index < countOrValue; index += 1) {
          if (badAddresses.has(start + index)) return exception(frame, ILLEGAL_ADDRESS)
        }
        const data = Buffer.alloc(countOrValue * 2)
        for (let index = 0; index < countOrValue; index += 1) {
          data.writeUInt16BE(table[start + index] ?? 0, index * 2)
        }
        return wrap(frame, Buffer.concat([Buffer.from([fc, countOrValue * 2]), data]))
      }
      case 5: {
        if (start >= state.coils.length) return exception(frame, ILLEGAL_ADDRESS)
        state.coils[start] = countOrValue === 0xff00
        return wrap(frame, Buffer.from([5, (start >> 8) & 0xff, start & 0xff, (countOrValue >> 8) & 0xff, countOrValue & 0xff]))
      }
      case 6: {
        if (start >= state.holding.length) return exception(frame, ILLEGAL_ADDRESS)
        state.holding[start] = countOrValue
        return wrap(frame, Buffer.from([6, (start >> 8) & 0xff, start & 0xff, (countOrValue >> 8) & 0xff, countOrValue & 0xff]))
      }
      case 15: {
        const byteCount = frame[12] ?? 0
        if (start + countOrValue > state.coils.length) return exception(frame, ILLEGAL_ADDRESS)
        for (let index = 0; index < countOrValue; index += 1) {
          const byte = frame[13 + (index >> 3)] ?? 0
          state.coils[start + index] = ((byte >> (index & 7)) & 1) === 1
        }
        void byteCount
        return wrap(frame, Buffer.from([15, (start >> 8) & 0xff, start & 0xff, (countOrValue >> 8) & 0xff, countOrValue & 0xff]))
      }
      case 16: {
        if (start + countOrValue > state.holding.length) return exception(frame, ILLEGAL_ADDRESS)
        for (let index = 0; index < countOrValue; index += 1) {
          state.holding[start + index] = ((frame[13 + index * 2] ?? 0) << 8) | (frame[14 + index * 2] ?? 0)
        }
        return wrap(frame, Buffer.from([16, (start >> 8) & 0xff, start & 0xff, (countOrValue >> 8) & 0xff, countOrValue & 0xff]))
      }
      default:
        return exception(frame, ILLEGAL_FUNCTION)
    }
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  result.port = (server.address() as AddressInfo).port
  return result
}
