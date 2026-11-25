/**
 * Modbus 模组的业务层：连线状态、自动重连、读写、watch、站号扫描、唯读锁定。
 *
 * 移植自 DSH modbus-poll/index.js 的业务段落。刻意与传输层无关：
 * 这里不认识 MCP，也不认识 HTTP，命令层只是把它包成工具。
 *
 * 状态挂在**模组实例**上（与 netscan 的 currentJobId 同一层级），
 * 不是进程全域——测试才能并行建立多个互不干扰的实例。
 */
import { ToolboxError } from '../../core/errors.js'
import { ModbusTcpClient, type ModbusClientOptions } from './client.js'
import {
  MAX_RANGE_BITS,
  MAX_RANGE_REGISTERS,
  MAX_READ_BITS,
  MAX_READ_REGISTERS,
  decodeRegisters,
  encodeValue,
  formatNumber,
  isBitKind,
  normalizeKind,
  normalizeScaling,
  normalizeType,
  normalizeWordOrder,
  typeWidth,
  type Kind,
  type RegisterRow,
  type RegisterType,
  type WordOrder,
} from './types.js'

/** 写入纪录上限：够看得出「刚才谁动了哪个点位」，又不会把记忆体吃光。 */
const WRITE_LOG_LIMIT = 50

export interface ConnectionTarget {
  host: string
  port: number
  unitId: number
}

export interface WriteEntry {
  at: string
  source: 'panel' | 'tool'
  kind: Kind
  address: number
  value?: number
  values?: number[]
  bit?: number
  unitId: number | null
  host: string | null
  port: number | null
}

export interface ConnectionSnapshot {
  connected: boolean
  host: string | null
  port: number | null
  unitId: number | null
  lastError: string | null
  readOnly: boolean
  writeCount: number
  recentWrites: WriteEntry[]
}

export interface ReadResult {
  kind: Kind
  start: number
  count: number
  requested: number
  truncated: boolean
  chunks: number
  chunkSize: number
  latencyMs: number
  reconnected: boolean
  /** 暂存器表才有。 */
  type?: RegisterType
  wordOrder?: WordOrder
  width?: 1 | 2
  scale?: number
  offset?: number
  values?: number[]
  rows?: RegisterRow[]
  trailing?: number
  /** 位元表才有。 */
  bits?: boolean[]
}

export interface WriteResult {
  kind: Kind
  address: number
  count?: number
  value?: number
  values?: number[]
  bit?: number
  before?: number
  after?: number
  type?: RegisterType
  wordOrder?: WordOrder
  scale?: number
  offset?: number
  latencyMs: number
  reconnected: boolean
  /** 写后读回的结果；未要求验证时为 null。 */
  verified: boolean | null
  /** 读回的工程值（暂存器）或 0/1（线圈），验证失败时就是它揭穿的。 */
  readBack?: number
}

export interface WatchResult extends ReadResult {
  expect: number
  matched: boolean
  attempts: number
  elapsedMs: number
  current: string
}

export interface ScanUnitsResult {
  host: string
  port: number
  from: number
  to: number
  scanned: number
  responded: number[]
  truncated: boolean
  elapsedMs: number
}

export interface ModbusServiceOptions {
  /** 单次请求逾时，预设 3000 ms。 */
  requestTimeoutMs?: number
  /** 测试注入：换掉真实的 socket 客户端。 */
  createClient?: (options: ModbusClientOptions) => ModbusTcpClient
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function toBit(value: unknown, field = 'value'): boolean {
  if (value === true || value === 1 || value === '1' || value === 'on' || value === 'true') return true
  if (value === false || value === 0 || value === '0' || value === 'off' || value === 'false') return false
  throw new ToolboxError('invalid-parameter', `${field} must be 0 or 1`, { field })
}

export class ModbusService {
  #client: ModbusTcpClient | null = null
  #target: ConnectionTarget | null = null
  #lastError: string | null = null
  #readOnly = false
  #writes: WriteEntry[] = []
  #reopening: Promise<ModbusTcpClient> | null = null
  readonly #timeoutMs: number
  readonly #createClient: (options: ModbusClientOptions) => ModbusTcpClient

  constructor(options: ModbusServiceOptions = {}) {
    this.#timeoutMs = options.requestTimeoutMs ?? 3000
    this.#createClient = options.createClient ?? ((clientOptions) => new ModbusTcpClient(clientOptions))
  }

  /** 连线状态；不碰线路上任何东西。 */
  snapshot(): ConnectionSnapshot {
    const client = this.#client
    const base = { readOnly: this.#readOnly, writeCount: this.#writes.length, recentWrites: this.#writes.slice(0, 10) }
    if (!client || client.closed) {
      return { connected: false, host: null, port: null, unitId: null, lastError: this.#lastError, ...base }
    }
    return {
      connected: true,
      host: client.host,
      port: client.port,
      unitId: client.unitId,
      lastError: this.#lastError,
      ...base,
    }
  }

  /** 唯读锁定是面板的开关；Agent 只能读，不能解。 */
  setGuard(readOnly: boolean): ConnectionSnapshot {
    this.#readOnly = toBit(readOnly, 'readOnly')
    return this.snapshot()
  }

  #assertWritable(): void {
    if (this.#readOnly) {
      throw new ToolboxError(
        'write-protected',
        'writes are locked by the read-only guard',
        { hint: 'clear the lock in the Modbus panel; only a human can toggle it, so an agent cannot unlock its own write protection' },
      )
    }
  }

  #recordWrite(source: 'panel' | 'tool', entry: Omit<WriteEntry, 'at' | 'source' | 'unitId' | 'host' | 'port'>): void {
    const client = this.#client
    this.#writes.unshift({
      at: new Date().toISOString(),
      source,
      unitId: client ? client.unitId : (this.#target?.unitId ?? null),
      host: client ? client.host : (this.#target?.host ?? null),
      port: client ? client.port : (this.#target?.port ?? null),
      ...entry,
    })
    if (this.#writes.length > WRITE_LOG_LIMIT) this.#writes.length = WRITE_LOG_LIMIT
  }

  async connect(body: { host?: unknown; port?: unknown; unitId?: unknown; timeoutMs?: unknown }): Promise<ConnectionSnapshot> {
    const host = String(body.host ?? '').trim()
    if (host === '') throw new ToolboxError('invalid-parameter', 'host is required', { field: 'host' })
    const port = body.port === undefined ? 502 : Number(body.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ToolboxError('invalid-parameter', 'port must be an integer in 1..65535', { field: 'port' })
    }
    const unitId = body.unitId === undefined ? 1 : Number(body.unitId)
    if (!Number.isInteger(unitId) || unitId < 0 || unitId > 255) {
      throw new ToolboxError('invalid-parameter', 'unitId must be an integer in 0..255', { field: 'unitId' })
    }
    const timeoutMs =
      body.timeoutMs === undefined ? this.#timeoutMs : clamp(Number(body.timeoutMs), 100, 60_000)

    const current = this.#client
    if (current && !current.closed && current.host === host && current.port === port) {
      current.unitId = unitId
      this.#target = { host, port, unitId }
      this.#lastError = null
      return this.snapshot()
    }
    if (current) current.close()
    this.#client = null

    const client = this.#createClient({ host, port, unitId, timeoutMs })
    try {
      await client.open()
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error)
      throw error
    }
    this.#client = client
    this.#target = { host, port, unitId }
    this.#lastError = null
    return this.snapshot()
  }

  disconnect(): ConnectionSnapshot {
    if (this.#client) this.#client.close()
    this.#client = null
    this.#target = null
    this.#lastError = null
    return this.snapshot()
  }

  /**
   * 取得可用连线；socket 死掉就用同一个目标重开。
   *
   * 轮询台要活过短暂的网路抖动——直接让读取失败，对现场帮助不大。
   * 呼叫方从 `reconnected` 得知「重开了」，才能老实说出来，而不是假装没事。
   */
  async #ensureClient(unitId?: unknown): Promise<{ client: ModbusTcpClient; reconnected: boolean }> {
    let nextUnitId: number | undefined
    if (unitId !== undefined && unitId !== null && unitId !== '') {
      const parsed = Number(unitId)
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) {
        throw new ToolboxError('invalid-parameter', 'unitId must be an integer in 0..255', { field: 'unitId' })
      }
      nextUnitId = parsed
    }

    const current = this.#client
    if (current && !current.closed) {
      if (nextUnitId !== undefined) current.unitId = nextUnitId
      return { client: current, reconnected: false }
    }

    const target = this.#target
    if (!target) throw new ToolboxError('not-connected', 'not connected to a Modbus server', { hint: 'call modbus_connection with action "connect" first' })

    if (!this.#reopening) {
      this.#reopening = (async () => {
        const next = this.#createClient({
          host: target.host,
          port: target.port,
          unitId: nextUnitId ?? target.unitId,
          timeoutMs: this.#timeoutMs,
        })
        await next.open()
        this.#client = next
        this.#lastError = null
        return next
      })().finally(() => {
        this.#reopening = null
      })
    }

    const client = await this.#reopening
    if (nextUnitId !== undefined) client.unitId = nextUnitId
    return { client, reconnected: true }
  }

  /**
   * 读取一段范围；超过协定上限自动切块。
   *
   * DSH 版把「小范围读取」与「大范围 dump」拆成两个动作，这里合并：
   * 呼叫方只要说「从 0 读 300 个」，切块是实作细节，不该变成 LLM 的选择题。
   * 32 位型别的切块会依值宽对齐，否则一个浮点数会被切成两半。
   */
  async read(body: {
    kind?: unknown
    start?: unknown
    count?: unknown
    unitId?: unknown
    type?: unknown
    wordOrder?: unknown
    scale?: unknown
    offset?: unknown
  }): Promise<ReadResult> {
    const kind = normalizeKind(body.kind)
    const start = Number(body.start)
    if (!Number.isInteger(start) || start < 0 || start > 65535) {
      throw new ToolboxError('invalid-parameter', 'start must be an integer in 0..65535', { field: 'start' })
    }
    const requested = Number(body.count ?? 1)
    if (!Number.isInteger(requested) || requested < 1) {
      throw new ToolboxError('invalid-parameter', 'count must be a positive integer', { field: 'count' })
    }

    const bits = isBitKind(kind)
    const type = bits ? null : normalizeType(body.type)
    const width = bits ? 1 : typeWidth(type)
    const limit = bits ? MAX_RANGE_BITS : MAX_RANGE_REGISTERS
    const count = Math.min(requested, limit)
    const hardChunk = bits ? MAX_READ_BITS : MAX_READ_REGISTERS
    const chunkSize = bits ? hardChunk : Math.max(width, Math.floor(hardChunk / width) * width)

    const { client, reconnected } = await this.#ensureClient(body.unitId)
    const began = Date.now()

    const values: number[] = []
    const rows: RegisterRow[] = []
    const bitValues: boolean[] = []
    let trailing = 0
    let chunks = 0

    for (let offset = 0; offset < count; offset += chunkSize) {
      const size = Math.min(chunkSize, count - offset)
      chunks += 1
      if (bits) {
        const part =
          kind === 'coil'
            ? await client.readCoils(start + offset, size)
            : await client.readDiscreteInputs(start + offset, size)
        bitValues.push(...part)
      } else {
        const part =
          kind === 'input'
            ? await client.readInputRegisters(start + offset, size)
            : await client.readHoldingRegisters(start + offset, size)
        values.push(...part)
        const decoded = decodeRegisters(part, {
          type,
          wordOrder: body.wordOrder,
          scale: body.scale,
          offset: body.offset,
          start: start + offset,
        })
        rows.push(...decoded.rows)
        trailing += decoded.trailing
      }
    }

    const latencyMs = Date.now() - began
    const base = { kind, start, count, requested, truncated: requested > count, chunks, chunkSize, latencyMs, reconnected }

    if (bits) return { ...base, bits: bitValues }

    const scaling = normalizeScaling({ scale: body.scale, offset: body.offset })
    return {
      ...base,
      type: type as RegisterType,
      wordOrder: normalizeWordOrder(body.wordOrder),
      width: width as 1 | 2,
      scale: scaling.scale,
      offset: scaling.offset,
      values,
      rows,
      trailing,
    }
  }

  /** 写入暂存器或线圈；`bit` 有值就做「先读、改位元、再写回」。 */
  async write(
    body: {
      kind?: unknown
      address?: unknown
      start?: unknown
      value?: unknown
      values?: unknown
      bit?: unknown
      unitId?: unknown
      type?: unknown
      wordOrder?: unknown
      scale?: unknown
      offset?: unknown
      verify?: unknown
    },
    source: 'panel' | 'tool' = 'tool',
  ): Promise<WriteResult> {
    this.#assertWritable()
    const kind = normalizeKind(body.kind)
    if (kind === 'discrete') {
      throw new ToolboxError('invalid-parameter', 'discrete inputs are read-only', { field: 'kind' })
    }
    if (kind === 'input') {
      throw new ToolboxError('invalid-parameter', 'input registers are read-only (FC04); write holding registers instead', {
        field: 'kind',
      })
    }

    const address = Number(body.address ?? body.start)
    if (!Number.isInteger(address) || address < 0 || address > 65535) {
      throw new ToolboxError('invalid-parameter', 'address must be an integer in 0..65535', { field: 'address' })
    }

    const { client, reconnected } = await this.#ensureClient(body.unitId)
    const began = Date.now()

    if (body.bit !== undefined && body.bit !== null) {
      if (kind !== 'holding') {
        throw new ToolboxError('invalid-parameter', 'bit writes only apply to holding registers', { field: 'kind' })
      }
      const bit = Number(body.bit)
      if (!Number.isInteger(bit) || bit < 0 || bit > 15) {
        throw new ToolboxError('invalid-parameter', 'bit must be an integer in 0..15', { field: 'bit' })
      }
      const enabled = toBit(body.value)
      const before = (await client.readHoldingRegisters(address, 1))[0] ?? 0
      const mask = 1 << bit
      const after = enabled ? (before | mask) & 0xffff : before & ~mask & 0xffff
      await client.writeSingleRegister(address, after)
      const result: WriteResult = {
        kind,
        address,
        bit,
        value: enabled ? 1 : 0,
        before,
        after,
        latencyMs: Date.now() - began,
        reconnected,
        verified: null,
      }
      this.#recordWrite(source, { kind, address, bit, value: enabled ? 1 : 0, values: [after] })
      return result
    }

    if (kind === 'coil') {
      if (Array.isArray(body.values)) {
        const bits = body.values.map((value) => toBit(value, 'values'))
        const written = await client.writeMultipleCoils(address, bits)
        const result: WriteResult = {
          kind,
          address: written.address ?? address,
          count: written.count ?? bits.length,
          values: bits.map((on) => (on ? 1 : 0)),
          latencyMs: Date.now() - began,
          reconnected,
          verified: null,
        }
        this.#recordWrite(source, { kind, address, values: result.values })
        return result
      }
      const written = await client.writeSingleCoil(address, toBit(body.value))
      const result: WriteResult = {
        kind,
        address: written.address ?? address,
        value: written.value ?? 0,
        values: [written.value ?? 0],
        latencyMs: Date.now() - began,
        reconnected,
        verified: null,
      }
      this.#recordWrite(source, { kind, address, value: result.value })
      return result
    }

    if (Array.isArray(body.values)) {
      const words = body.values.map((value) => Number(value))
      const written = await client.writeMultipleRegisters(address, words)
      const result: WriteResult = {
        kind,
        address: written.address ?? address,
        count: written.count ?? words.length,
        values: words,
        latencyMs: Date.now() - began,
        reconnected,
        verified: null,
      }
      this.#recordWrite(source, { kind, address, values: words })
      return result
    }

    const type = normalizeType(body.type)
    const wordOrder = normalizeWordOrder(body.wordOrder)
    const { scale, offset } = normalizeScaling({ scale: body.scale, offset: body.offset })
    const words = encodeValue(Number(body.value), { type, wordOrder, scale, offset })
    const written =
      words.length === 1
        ? await client.writeSingleRegister(address, words[0] ?? 0)
        : await client.writeMultipleRegisters(address, words)
    const result: WriteResult = {
      kind,
      address: written.address ?? address,
      ...(words.length === 1 ? { value: written.value } : { count: written.count }),
      values: words,
      type,
      wordOrder,
      scale,
      offset,
      latencyMs: Date.now() - began,
      reconnected,
      verified: null,
    }
    this.#recordWrite(source, { kind, address, value: result.value, values: words })
    return result
  }

  /**
   * 轮询一个值直到等于 `expect`，或逾时。
   *
   * 这是让 Agent「证明写入真的生效」的方法，而不是送出封包就宣称成功。
   * 浮点值预设带极小相对容差，也可用 `tolerance` 指定绝对容差。
   */
  async watch(body: {
    kind?: unknown
    start?: unknown
    count?: unknown
    unitId?: unknown
    type?: unknown
    wordOrder?: unknown
    scale?: unknown
    offset?: unknown
    expect?: unknown
    tolerance?: unknown
    timeoutMs?: unknown
    intervalMs?: unknown
  }): Promise<WatchResult> {
    const expect = Number(body.expect)
    if (!Number.isFinite(expect)) {
      throw new ToolboxError('invalid-parameter', 'expect must be a finite number', { field: 'expect' })
    }
    const type = normalizeType(body.type)
    const timeoutMs = clamp(Number(body.timeoutMs ?? 5000), 100, 60_000)
    const intervalMs = clamp(Number(body.intervalMs ?? 200), 50, 5000)
    const tolerance =
      body.tolerance === undefined
        ? type === 'f32'
          ? 1e-6 * Math.max(1, Math.abs(expect))
          : 0
        : Number(body.tolerance)
    if (!Number.isFinite(tolerance) || tolerance < 0) {
      throw new ToolboxError('invalid-parameter', 'tolerance must be a non-negative number', { field: 'tolerance' })
    }

    const began = Date.now()
    let attempts = 0
    for (;;) {
      attempts += 1
      const current = await this.read({
        kind: body.kind,
        start: body.start,
        count: body.count ?? (isBitKind(normalizeKind(body.kind)) ? 1 : typeWidth(type)),
        unitId: body.unitId,
        type: body.type,
        wordOrder: body.wordOrder,
        scale: body.scale,
        offset: body.offset,
      })
      const currentText = describeCurrent(current)
      if (matchesWatch(current, expect, tolerance)) {
        return { ...current, expect, matched: true, attempts, elapsedMs: Date.now() - began, current: currentText }
      }
      const remaining = timeoutMs - (Date.now() - began)
      if (remaining <= 0) {
        return { ...current, expect, matched: false, attempts, elapsedMs: Date.now() - began, current: currentText }
      }
      await sleep(Math.min(intervalMs, remaining))
    }
  }

  /**
   * 在单一主机上扫站号，用**独立连线**，不干扰主连线。
   *
   * 有回应（含 Modbus 例外）就算存在，静默不算——
   * 设备回「这个位址非法」正说明它活着且听得懂。
   */
  async scanUnits(body: {
    host?: unknown
    port?: unknown
    from?: unknown
    to?: unknown
    timeoutMs?: unknown
    maxMs?: unknown
    address?: unknown
  }): Promise<ScanUnitsResult> {
    const target = this.#target
    const host = String(body.host ?? target?.host ?? '').trim()
    if (host === '') {
      throw new ToolboxError('invalid-parameter', 'host is required (connect first, or pass host)', { field: 'host' })
    }
    const port = Number(body.port ?? target?.port ?? 502)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ToolboxError('invalid-parameter', 'port must be an integer in 1..65535', { field: 'port' })
    }
    const from = clamp(Number(body.from ?? 1), 0, 255)
    const to = clamp(Number(body.to ?? 247), 0, 255)
    if (to < from) {
      throw new ToolboxError('invalid-parameter', 'to must be greater than or equal to from', { field: 'to' })
    }
    const probeTimeout = clamp(Number(body.timeoutMs ?? 150), 50, 2000)
    const maxMs = clamp(Number(body.maxMs ?? 60_000), 1000, 120_000)
    const address = Number.isInteger(Number(body.address)) ? Number(body.address) : 0

    const began = Date.now()
    const responded: number[] = []
    let scanned = 0
    let truncated = false

    const client = this.#createClient({ host, port, unitId: from, timeoutMs: probeTimeout })
    await client.open()
    try {
      for (let unitId = from; unitId <= to; unitId += 1) {
        if (Date.now() - began > maxMs) {
          truncated = true
          break
        }
        if (client.closed) await client.open()
        client.unitId = unitId
        scanned += 1
        try {
          await client.readHoldingRegisters(address, 1)
          responded.push(unitId)
        } catch (error) {
          const code = error instanceof ToolboxError ? error.code : 'internal'
          if (code === 'modbus-exception') {
            responded.push(unitId)
          } else if (code === 'timeout' || code === 'connection-closed' || code === 'socket-error') {
            // 静默：站号不存在，或它不理这个位址。
          } else {
            throw error
          }
        }
      }
    } finally {
      client.close()
    }

    return { host, port, from, to, scanned, responded, truncated, elapsedMs: Date.now() - began }
  }

  /** 关掉连线；程序结束或切换目标时用。 */
  close(): void {
    if (this.#client) this.#client.close()
    this.#client = null
    this.#target = null
  }
}

/** watch 的比对：位元表比第一位的 0/1，暂存器比解码后的工程值。 */
function matchesWatch(result: ReadResult, expect: number, tolerance: number): boolean {
  if (Array.isArray(result.bits)) return (result.bits[0] ? 1 : 0) === expect
  const row = result.rows?.[0]
  if (!row) {
    throw new ToolboxError('invalid-parameter', 'watch needs at least one decoded value', { field: 'count' })
  }
  return Math.abs(row.value - expect) <= tolerance
}

function describeCurrent(result: ReadResult): string {
  if (Array.isArray(result.bits)) return result.bits[0] ? '1' : '0'
  const row = result.rows?.[0]
  return row ? formatNumber(row.value) : '?'
}
