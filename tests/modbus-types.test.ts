/** 型别／字序／比例：纯函式，不碰 socket。 */
import { assert, run, test } from './helpers.js'
import { ToolboxError } from '../src/core/errors.js'
import {
  MAX_READ_REGISTERS,
  decodeRegisters,
  encodeValue,
  formatNumber,
  hex4,
  isBitKind,
  normalizeKind,
  normalizeScaling,
  normalizeType,
  normalizeWordOrder,
  typeWidth,
} from '../src/modules/modbus/types.js'

test('typeWidth: 16 位占 1 个暂存器，32 位占 2 个', () => {
  assert.equal(typeWidth('u16'), 1)
  assert.equal(typeWidth('i16'), 1)
  assert.equal(typeWidth('u32'), 2)
  assert.equal(typeWidth('i32'), 2)
  assert.equal(typeWidth('f32'), 2)
  assert.equal(MAX_READ_REGISTERS, 125)
})

test('known layouts: f32 1.0 在四种字序下的字组', () => {
  assert.deepEqual(encodeValue(1.0, { type: 'f32', wordOrder: 'ABCD' }), [0x3f80, 0x0000])
  assert.deepEqual(encodeValue(1.0, { type: 'f32', wordOrder: 'CDAB' }), [0x0000, 0x3f80])
  assert.deepEqual(encodeValue(1.0, { type: 'f32', wordOrder: 'BADC' }), [0x803f, 0x0000])
  assert.deepEqual(encodeValue(1.0, { type: 'f32', wordOrder: 'DCBA' }), [0x0000, 0x803f])
})

test('roundtrip: 四种字序 × 五种型别编码后再解码要得到同一个值', () => {
  const cases: Array<[string, number]> = [
    ['u16', 4321],
    ['i16', -1234],
    ['u32', 3_000_000_000],
    ['i32', -123_456_789],
    ['f32', 23.5],
  ]
  for (const order of ['ABCD', 'CDAB', 'BADC', 'DCBA'] as const) {
    for (const [type, value] of cases) {
      const words = encodeValue(value, { type, wordOrder: order })
      const decoded = decodeRegisters(words, { type, wordOrder: order })
      assert.equal(decoded.rows.length, 1)
      assert.equal(decoded.rows[0]?.numeric, type === 'f32' ? Math.fround(value) : value, `${type}/${order}`)
      assert.equal(decoded.trailing, 0)
    }
  }
})

test('scaling: 读到的 235 显示 23.5，写回的 23.5 变成 235', () => {
  const decoded = decodeRegisters([235], { type: 'u16', scale: 0.1, start: 100 })
  assert.equal(decoded.rows[0]?.value, 23.5)
  assert.equal(decoded.rows[0]?.text, '23.5')
  assert.equal(decoded.rows[0]?.address, 100)
  assert.deepEqual(encodeValue(23.5, { type: 'u16', scale: 0.1 }), [235])

  const offset = decodeRegisters([100], { type: 'u16', scale: 0.5, offset: -10 })
  assert.equal(offset.rows[0]?.value, 40)
  assert.deepEqual(encodeValue(40, { type: 'u16', scale: 0.5, offset: -10 }), [100])
})

test('decodeRegisters: 32 位型别的尾端暂存器记在 trailing，不静默丢掉', () => {
  const decoded = decodeRegisters([1, 2, 3], { type: 'u32', start: 0 })
  assert.equal(decoded.rows.length, 1)
  assert.equal(decoded.rows[0]?.raw.length, 2)
  assert.equal(decoded.trailing, 1)
  assert.equal(decoded.width, 2)
})

test('decodeRegisters: 负数与边界值', () => {
  assert.equal(decodeRegisters([0xffff], { type: 'i16' }).rows[0]?.numeric, -1)
  assert.equal(decodeRegisters([0x7fff], { type: 'i16' }).rows[0]?.numeric, 32767)
  assert.equal(decodeRegisters([0x8000], { type: 'i16' }).rows[0]?.numeric, -32768)
  assert.equal(decodeRegisters([0xffff], { type: 'u16' }).rows[0]?.numeric, 65535)
})

test('参数校验: 非法型别／字序／比例都带可行动的 code 与 field', () => {
  const cases: Array<[() => unknown, string]> = [
    [() => normalizeType('f64'), 'type'],
    [() => normalizeWordOrder('ABDC'), 'wordOrder'],
    [() => normalizeKind('register'), 'kind'],
    [() => normalizeScaling({ scale: 0 }), 'scale'],
    [() => normalizeScaling({ scale: 'abc' }), 'scale'],
    [() => encodeValue(1.5, { type: 'u16' }), 'value'],
    [() => encodeValue(70_000, { type: 'u16' }), 'value'],
    [() => encodeValue(-1, { type: 'u16' }), 'value'],
    [() => encodeValue(40_000, { type: 'i16' }), 'value'],
    [() => encodeValue(Number.NaN, { type: 'u16' }), 'value'],
  ]
  for (const [body, field] of cases) {
    try {
      body()
      assert.fail(`expected rejection for field ${field}`)
    } catch (error) {
      assert.ok(error instanceof ToolboxError, `expected ToolboxError for ${field}`)
      assert.equal(error.code, 'invalid-parameter')
      assert.equal(error.field, field)
    }
  }
})

test('预设值: 省略参数时是 holding / u16 / ABCD / scale 1 / offset 0', () => {
  assert.equal(normalizeKind(undefined), 'holding')
  assert.equal(normalizeType(undefined), 'u16')
  assert.equal(normalizeWordOrder(undefined), 'ABCD')
  assert.deepEqual(normalizeScaling(), { scale: 1, offset: 0 })
  assert.equal(isBitKind('coil'), true)
  assert.equal(isBitKind('discrete'), true)
  assert.equal(isBitKind('holding'), false)
})

test('显示格式: 去浮点噪声、hex4 补齐四位', () => {
  assert.equal(formatNumber(23.500000000000004), '23.5')
  assert.equal(formatNumber(-0), '0')
  assert.equal(formatNumber(1234), '1234')
  assert.equal(hex4(0), '0x0000')
  assert.equal(hex4(0xff), '0x00FF')
  assert.equal(hex4(0x1234), '0x1234')
})

void run()
