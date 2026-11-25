/**
 * 最小 Modbus TCP 客户端。
 *
 * 移植自 DSH 的 modbus-poll/modbus.js：协定层一行没改，只把 ModbusError 换成
 * ToolboxError，让 MCP 与 Web 两侧拿到同一套错误码。
 *
 * 实作的是监控／轮询工具需要的子集：
 *   FC01 读线圈、FC02 读离散输入、
 *   FC03 读保持暂存器、FC04 读输入暂存器、
 *   FC05 写单一线圈、FC06 写单一暂存器、
 *   FC15 写多笔线圈、FC16 写多笔暂存器。
 *
 * 同一时间只有一个请求在飞；并发呼叫会依序排队，回应按交易 ID 对应，
 * 所以不可能把回应配给错的请求。逾时直接销毁 socket——迟到的讯框
 * 会让整个串流错位，留着它只会让下一个请求拿到别人要的资料。
 */
import net from 'node:net'
import { ToolboxError } from '../../core/errors.js'

const EXCEPTION_NAMES: Readonly<Record<number, string>> = {
  1: 'illegal function',
  2: 'illegal data address',
  3: 'illegal data value',
  4: 'server device failure',
  5: 'acknowledge',
  6: 'server device busy',
  8: 'memory parity error',
  10: 'gateway path unavailable',
  11: 'gateway target failed to respond',
}

/** noUncheckedIndexedAccess 下 Buffer 索引是 `number | undefined`；讯框长度已校验过，缺了当 0。 */
function byteAt(buffer: Buffer, index: number): number {
  return buffer[index] ?? 0
}

function integer(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ToolboxError('invalid-parameter', `${name} must be an integer in ${min}..${max}`, {
      field: name,
      details: { min, max },
    })
  }
  return value
}

export interface ModbusClientOptions {
  host?: string
  port?: number
  unitId?: number
  timeoutMs?: number
}

interface Pending {
  resolve: (body: Buffer) => void
  reject: (error: ToolboxError) => void
  timer: NodeJS.Timeout
}

export interface WriteEcho {
  address: number
  count?: number
  value?: number
}

export class ModbusTcpClient {
  host: string
  port: number
  unitId: number
  timeoutMs: number

  #socket: net.Socket | null = null
  #buffer: Buffer = Buffer.alloc(0)
  #nextTransactionId = 1
  #pending = new Map<number, Pending>()
  #tail: Promise<unknown> = Promise.resolve()
  #closed = true
  #opening: Promise<ModbusTcpClient> | null = null

  constructor(options: ModbusClientOptions = {}) {
    this.host = options.host ?? '127.0.0.1'
    this.port = options.port ?? 502
    this.unitId = options.unitId ?? 1
    this.timeoutMs = options.timeoutMs ?? 3000
  }

  get key(): string {
    return `${this.host}:${this.port}`
  }

  get closed(): boolean {
    return this.#closed
  }

  async open(): Promise<ModbusTcpClient> {
    if (!this.#closed) return this
    if (this.#opening) {
      await this.#opening
      return this
    }

    const promise = new Promise<ModbusTcpClient>((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port })
      socket.setNoDelay(true)
      let settled = false

      const timer = setTimeout(() => {
        fail(new ToolboxError('connect-timeout', `connect timeout after ${this.timeoutMs}ms`))
      }, this.timeoutMs)

      const fail = (error: ToolboxError): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.removeListener('connect', onConnect)
        socket.removeListener('error', onError)
        socket.destroy()
        reject(error)
      }

      const onConnect = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.removeListener('connect', onConnect)
        socket.removeListener('error', onError)
        this.#socket = socket
        this.#closed = false
        this.#buffer = Buffer.alloc(0)
        // 被换掉的旧 socket 迟到的事件不能拆掉当前连线，
        // 否则「逾时后重开」会看起来像死透了。
        socket.on('data', (chunk: Buffer) => {
          if (this.#socket === socket) this.#onData(chunk)
        })
        socket.on('error', (error: Error) => {
          if (this.#socket !== socket) return
          this.#teardown(new ToolboxError('socket-error', `socket error: ${error.message}`))
        })
        socket.on('close', () => {
          if (this.#socket !== socket) return
          this.#teardown(new ToolboxError('connection-closed', 'connection closed by peer'))
        })
        resolve(this)
      }

      const onError = (error: Error): void => {
        fail(new ToolboxError('connect-failed', `connect failed: ${error.message}`, { cause: error }))
      }

      socket.once('connect', onConnect)
      socket.once('error', onError)
    })

    this.#opening = promise
    try {
      return await promise
    } finally {
      this.#opening = null
    }
  }

  close(): void {
    const socket = this.#socket
    this.#teardown(new ToolboxError('disconnected', 'disconnected'))
    if (socket) socket.destroy()
  }

  #teardown(error: ToolboxError): void {
    this.#closed = true
    this.#socket = null
    this.#buffer = Buffer.alloc(0)
    if (this.#pending.size === 0) return
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const entry of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
  }

  #onData(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    while (this.#buffer.length >= 7) {
      const length = this.#buffer.readUInt16BE(4)
      const total = 6 + length
      if (length < 2 || total > 260) {
        this.#teardown(new ToolboxError('protocol-error', 'invalid response frame'))
        return
      }
      if (this.#buffer.length < total) return
      const frame = this.#buffer.subarray(0, total)
      this.#buffer = this.#buffer.subarray(total)
      this.#onFrame(frame)
    }
  }

  #onFrame(frame: Buffer): void {
    const transactionId = frame.readUInt16BE(0)
    const entry = this.#pending.get(transactionId)
    if (!entry) return
    this.#pending.delete(transactionId)
    clearTimeout(entry.timer)

    const functionCode = frame.readUInt8(7)
    if (functionCode & 0x80) {
      const exceptionCode = frame.readUInt8(8)
      entry.reject(
        new ToolboxError(
          'modbus-exception',
          `modbus exception ${exceptionCode}: ${EXCEPTION_NAMES[exceptionCode] ?? 'unknown'}`,
          { details: { exceptionCode, functionCode: functionCode & 0x7f } },
        ),
      )
      return
    }
    entry.resolve(frame.subarray(8))
  }

  /** 排队执行：前一个请求落定后才发下一个。 */
  request(pdu: Buffer): Promise<Buffer> {
    const run = (): Promise<Buffer> => this.#transact(pdu)
    const result = this.#tail.then(run, run)
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  #transact(pdu: Buffer): Promise<Buffer> {
    const socket = this.#socket
    if (!socket || this.#closed) {
      return Promise.reject(new ToolboxError('not-connected', 'not connected'))
    }

    const transactionId = this.#nextTransactionId
    this.#nextTransactionId = transactionId >= 0xffff ? 1 : transactionId + 1

    const frame = Buffer.allocUnsafe(7 + pdu.length)
    frame.writeUInt16BE(transactionId, 0)
    frame.writeUInt16BE(0, 2)
    frame.writeUInt16BE(pdu.length + 1, 4)
    frame.writeUInt8(this.unitId & 0xff, 6)
    pdu.copy(frame, 7)

    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(transactionId)
        const error = new ToolboxError('timeout', `no response within ${this.timeoutMs}ms`)
        // 先读目前 socket 再 teardown，否则迟到的那个 socket 没人销毁，会漏一条连线。
        const current = this.#socket
        this.#teardown(error)
        if (current) current.destroy()
        reject(error)
      }, this.timeoutMs)

      this.#pending.set(transactionId, { resolve, reject, timer })

      socket.write(frame, (error?: Error | null) => {
        if (!error) return
        const entry = this.#pending.get(transactionId)
        if (!entry) return
        this.#pending.delete(transactionId)
        clearTimeout(entry.timer)
        entry.reject(new ToolboxError('write-failed', `write failed: ${error.message}`, { cause: error }))
      })
    })
  }

  readHoldingRegisters(start: number, count: number): Promise<number[]> {
    return this.#readRegisters(3, start, count)
  }

  readInputRegisters(start: number, count: number): Promise<number[]> {
    return this.#readRegisters(4, start, count)
  }

  async #readRegisters(functionCode: number, start: number, count: number): Promise<number[]> {
    integer('start', start, 0, 65535)
    integer('count', count, 1, 125)
    const pdu = Buffer.from([functionCode, (start >> 8) & 0xff, start & 0xff, (count >> 8) & 0xff, count & 0xff])
    const body = await this.request(pdu)
    const expected = count * 2
    if (body.length < 1 + expected || byteAt(body, 0) < expected) {
      throw new ToolboxError('protocol-error', 'short register response', {
        details: { expected, received: Math.max(0, body.length - 1) },
      })
    }
    const values = new Array<number>(count)
    for (let index = 0; index < count; index += 1) {
      values[index] = (byteAt(body, 1 + index * 2) << 8) | byteAt(body, 2 + index * 2)
    }
    return values
  }

  async writeSingleRegister(address: number, value: number): Promise<WriteEcho> {
    integer('address', address, 0, 65535)
    integer('value', value, 0, 65535)
    const pdu = Buffer.from([6, (address >> 8) & 0xff, address & 0xff, (value >> 8) & 0xff, value & 0xff])
    const body = await this.request(pdu)
    if (body.length < 4) {
      throw new ToolboxError('protocol-error', 'short write response', { details: { received: body.length } })
    }
    return { address: (byteAt(body, 0) << 8) | byteAt(body, 1), value: (byteAt(body, 2) << 8) | byteAt(body, 3) }
  }

  readCoils(start: number, count: number): Promise<boolean[]> {
    return this.#readBits(1, start, count)
  }

  readDiscreteInputs(start: number, count: number): Promise<boolean[]> {
    return this.#readBits(2, start, count)
  }

  async #readBits(functionCode: number, start: number, count: number): Promise<boolean[]> {
    integer('start', start, 0, 65535)
    integer('count', count, 1, 2000)
    const pdu = Buffer.from([functionCode, (start >> 8) & 0xff, start & 0xff, (count >> 8) & 0xff, count & 0xff])
    const body = await this.request(pdu)
    const expected = Math.ceil(count / 8)
    if (body.length < 1 + expected || byteAt(body, 0) < expected) {
      throw new ToolboxError('protocol-error', 'short bit response', {
        details: { expected, received: Math.max(0, body.length - 1) },
      })
    }
    const bits = new Array<boolean>(count)
    for (let index = 0; index < count; index += 1) {
      bits[index] = ((byteAt(body, 1 + (index >> 3)) >> (index & 7)) & 1) === 1
    }
    return bits
  }

  async writeSingleCoil(address: number, on: boolean): Promise<WriteEcho> {
    integer('address', address, 0, 65535)
    const pdu = Buffer.from([5, (address >> 8) & 0xff, address & 0xff, on ? 0xff : 0x00, 0x00])
    const body = await this.request(pdu)
    if (body.length < 4) {
      throw new ToolboxError('protocol-error', 'short coil write response', { details: { received: body.length } })
    }
    return { address: (byteAt(body, 0) << 8) | byteAt(body, 1), value: ((byteAt(body, 2) << 8) | byteAt(body, 3)) === 0xff00 ? 1 : 0 }
  }

  async writeMultipleCoils(start: number, bits: readonly boolean[]): Promise<WriteEcho> {
    integer('start', start, 0, 65535)
    if (!Array.isArray(bits) || bits.length === 0) {
      throw new ToolboxError('invalid-parameter', 'bits must be a non-empty array', { field: 'bits' })
    }
    const count = bits.length
    integer('count', count, 1, 1968)
    const byteCount = Math.ceil(count / 8)
    const data = Buffer.alloc(byteCount)
    bits.forEach((on, index) => {
      const byte = index >> 3
      if (on) data[byte] = byteAt(data, byte) | (1 << (index & 7))
    })
    const pdu = Buffer.concat([
      Buffer.from([15, (start >> 8) & 0xff, start & 0xff, (count >> 8) & 0xff, count & 0xff, byteCount]),
      data,
    ])
    const body = await this.request(pdu)
    if (body.length < 4) {
      throw new ToolboxError('protocol-error', 'short multi-coil write response', { details: { received: body.length } })
    }
    return { address: (byteAt(body, 0) << 8) | byteAt(body, 1), count: (byteAt(body, 2) << 8) | byteAt(body, 3) }
  }

  async writeMultipleRegisters(start: number, values: readonly number[]): Promise<WriteEcho> {
    integer('start', start, 0, 65535)
    if (!Array.isArray(values) || values.length === 0) {
      throw new ToolboxError('invalid-parameter', 'values must be a non-empty array', { field: 'values' })
    }
    const count = values.length
    integer('count', count, 1, 123)
    const data = Buffer.alloc(count * 2)
    values.forEach((value, index) => {
      integer('value', value, 0, 65535)
      data.writeUInt16BE(value, index * 2)
    })
    const pdu = Buffer.concat([
      Buffer.from([16, (start >> 8) & 0xff, start & 0xff, (count >> 8) & 0xff, count & 0xff, (count * 2) & 0xff]),
      data,
    ])
    const body = await this.request(pdu)
    if (body.length < 4) {
      throw new ToolboxError('protocol-error', 'short multi-register write response', {
        details: { received: body.length },
      })
    }
    return { address: (byteAt(body, 0) << 8) | byteAt(body, 1), count: (byteAt(body, 2) << 8) | byteAt(body, 3) }
  }
}
