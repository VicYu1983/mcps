/**
 * 暂存器型别、32 位字序与工程比例。
 *
 * 移植自 DSH 的 modbus-poll/types.js，只换掉错误类型（ToolboxError），
 * 其余语义一字不改——因为面板与 Agent 必须对同一组原始暂存器算出同一个数字，
 * 这段逻辑一旦分岔，现场看到的值就会对不上。
 *
 * 这里没有任何 socket 代码：编码把工程值变成 16 位字，解码把字变回工程值。
 */
import { ToolboxError } from '../../core/errors.js'

export const REGISTER_TYPES = ['u16', 'i16', 'u32', 'i32', 'f32'] as const
export type RegisterType = (typeof REGISTER_TYPES)[number]

export const WORD_ORDERS = ['ABCD', 'CDAB', 'BADC', 'DCBA'] as const
export type WordOrder = (typeof WORD_ORDERS)[number]

/** 资料表种类：两种暂存器（16 位）与两种位元表。 */
export const KINDS = ['holding', 'input', 'coil', 'discrete'] as const
export type Kind = (typeof KINDS)[number]

const TYPE_WIDTH: Readonly<Record<RegisterType, 1 | 2>> = { u16: 1, i16: 1, u32: 2, i32: 2, f32: 2 }

/** 单次读取的协定上限：FC03/04 最多 125 个暂存器，FC01/02 最多 2000 个位元。 */
export const MAX_READ_REGISTERS = 125
export const MAX_READ_BITS = 2000
/** 一次工具调用的上限，超过就截断并回報 truncated。 */
export const MAX_RANGE_REGISTERS = 1024
export const MAX_RANGE_BITS = 2048

function invalid(message: string, field: string): never {
  throw new ToolboxError('invalid-parameter', message, { field })
}

export function normalizeKind(value: unknown): Kind {
  const kind = value === undefined || value === null || value === '' ? 'holding' : String(value).toLowerCase()
  if (!(KINDS as readonly string[]).includes(kind)) {
    invalid(`kind must be one of ${KINDS.join(', ')}`, 'kind')
  }
  return kind as Kind
}

export function isBitKind(kind: Kind): boolean {
  return kind === 'coil' || kind === 'discrete'
}

export function normalizeType(value: unknown): RegisterType {
  const type = value === undefined || value === null || value === '' ? 'u16' : String(value).toLowerCase()
  if (!(REGISTER_TYPES as readonly string[]).includes(type)) {
    invalid(`type must be one of ${REGISTER_TYPES.join(', ')}`, 'type')
  }
  return type as RegisterType
}

export function normalizeWordOrder(value: unknown): WordOrder {
  const order = value === undefined || value === null || value === '' ? 'ABCD' : String(value).toUpperCase()
  if (!(WORD_ORDERS as readonly string[]).includes(order)) {
    invalid(`wordOrder must be one of ${WORD_ORDERS.join(', ')}`, 'wordOrder')
  }
  return order as WordOrder
}

/** 这个型别占几个暂存器。 */
export function typeWidth(type: unknown): 1 | 2 {
  return TYPE_WIDTH[normalizeType(type)]
}

export interface Scaling {
  scale: number
  offset: number
}

export function normalizeScaling(options: { scale?: unknown; offset?: unknown } = {}): Scaling {
  const scale = finite('scale', options.scale, 1)
  if (scale === 0) invalid('scale must not be 0', 'scale')
  return { scale, offset: finite('offset', options.offset, 0) }
}

function finite(name: string, value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) invalid(`${name} must be a finite number`, name)
  return number
}

/**
 * 把四个位元组拆成两个字，依要求的字序排列。
 *
 * `ABCD` 是自然的大端排列（高位字在前），另外三种是设备实际会出现的互换版本。
 */
function bufferToWords(buffer: Buffer, order: WordOrder): [number, number] {
  const a = buffer[0] ?? 0
  const b = buffer[1] ?? 0
  const c = buffer[2] ?? 0
  const d = buffer[3] ?? 0
  switch (order) {
    case 'CDAB':
      return [((c << 8) | d) & 0xffff, ((a << 8) | b) & 0xffff]
    case 'BADC':
      return [((b << 8) | a) & 0xffff, ((d << 8) | c) & 0xffff]
    case 'DCBA':
      return [((d << 8) | c) & 0xffff, ((b << 8) | a) & 0xffff]
    case 'ABCD':
    default:
      return [((a << 8) | b) & 0xffff, ((c << 8) | d) & 0xffff]
  }
}

function wordsToBuffer(words: readonly number[], order: WordOrder): Buffer {
  const first = (words[0] ?? 0) & 0xffff
  const second = (words[1] ?? 0) & 0xffff
  const hi = (word: number): number => (word >> 8) & 0xff
  const lo = (word: number): number => word & 0xff
  switch (order) {
    case 'CDAB':
      return Buffer.from([hi(second), lo(second), hi(first), lo(first)])
    case 'BADC':
      return Buffer.from([lo(first), hi(first), lo(second), hi(second)])
    case 'DCBA':
      return Buffer.from([lo(second), hi(second), lo(first), hi(first)])
    case 'ABCD':
    default:
      return Buffer.from([hi(first), lo(first), hi(second), lo(second)])
  }
}

function decodeOne(words: readonly number[], type: RegisterType, order: WordOrder): number {
  if (type === 'u16') return (words[0] ?? 0) & 0xffff
  if (type === 'i16') {
    const raw = (words[0] ?? 0) & 0xffff
    return raw & 0x8000 ? raw - 0x10000 : raw
  }
  const buffer = wordsToBuffer(words, order)
  if (type === 'u32') return buffer.readUInt32BE(0)
  if (type === 'i32') return buffer.readInt32BE(0)
  return buffer.readFloatBE(0)
}

/** 显示用格式化，避免浮点噪声（`23.500000000000004` → `23.5`）。 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toFixed(6)))
}

/** `23` → `0x0017`，现场沟通与写错遮罩时最快看出问题。 */
export function hex4(value: number): string {
  return `0x${(value & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`
}

export interface RegisterRow {
  index: number
  address: number
  raw: number[]
  numeric: number
  value: number
  text: string
}

export interface DecodedRegisters {
  type: RegisterType
  wordOrder: WordOrder
  width: 1 | 2
  scale: number
  offset: number
  rows: RegisterRow[]
  /** 凑不成一个完整值的尾端暂存器数量；不静默丢弃。 */
  trailing: number
}

/**
 * 把一段原始暂存器解码成有型别的列。
 *
 * 尾端凑不满 32 位的暂存器记在 `trailing` 里，而不是悄悄丢掉——
 * 数量抓错时「少了两个」比「值很怪」难查得多。
 */
export function decodeRegisters(
  registers: readonly number[],
  options: { type?: unknown; wordOrder?: unknown; scale?: unknown; offset?: unknown; start?: number } = {},
): DecodedRegisters {
  if (!Array.isArray(registers)) invalid('registers must be an array', 'registers')
  const type = normalizeType(options.type)
  const wordOrder = normalizeWordOrder(options.wordOrder)
  const width = TYPE_WIDTH[type]
  const { scale, offset } = normalizeScaling(options)
  const start = Number.isInteger(options.start) ? (options.start as number) : null

  const complete = Math.floor(registers.length / width)
  const rows: RegisterRow[] = []
  for (let index = 0; index < complete; index += 1) {
    const slice = registers.slice(index * width, index * width + width)
    const numeric = decodeOne(slice, type, wordOrder)
    const value = numeric * scale + offset
    rows.push({
      index,
      address: start === null ? index * width : start + index * width,
      raw: [...slice],
      numeric,
      value,
      text: formatNumber(value),
    })
  }

  return { type, wordOrder, width, scale, offset, rows, trailing: registers.length - complete * width }
}

/**
 * 把一个工程值编码成写出去时该送的暂存器。
 *
 * `scale`／`offset` 反向套用：以 `scale: 0.1` 读到的 `23.5`，写回去就是 `235`。
 */
export function encodeValue(
  value: unknown,
  options: { type?: unknown; wordOrder?: unknown; scale?: unknown; offset?: unknown } = {},
): number[] {
  const type = normalizeType(options.type)
  const wordOrder = normalizeWordOrder(options.wordOrder)
  const { scale, offset } = normalizeScaling(options)

  const engineering = Number(value)
  if (!Number.isFinite(engineering)) invalid('value must be a finite number', 'value')
  const raw = (engineering - offset) / scale

  if (type === 'f32') {
    const buffer = Buffer.alloc(4)
    buffer.writeFloatBE(raw, 0)
    return bufferToWords(buffer, wordOrder)
  }

  if (!Number.isInteger(raw)) {
    throw new ToolboxError(
      'invalid-parameter',
      `value ${formatNumber(engineering)} is not a whole register value after scaling`,
      { field: 'value' },
    )
  }

  if (type === 'u16') {
    if (raw < 0 || raw > 0xffff) invalid('value must be in 0..65535', 'value')
    return [raw & 0xffff]
  }
  if (type === 'i16') {
    if (raw < -0x8000 || raw > 0x7fff) invalid('value must be in -32768..32767', 'value')
    return [raw & 0xffff]
  }

  const buffer = Buffer.alloc(4)
  if (type === 'u32') {
    if (raw < 0 || raw > 0xffffffff) invalid('value must be in 0..4294967295', 'value')
    buffer.writeUInt32BE(raw, 0)
  } else {
    if (raw < -0x80000000 || raw > 0x7fffffff) invalid('value must be in -2147483648..2147483647', 'value')
    buffer.writeInt32BE(raw, 0)
  }
  return bufferToWords(buffer, wordOrder)
}
