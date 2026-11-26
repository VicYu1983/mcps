/**
 * modbus 模组：命令定义。
 *
 * 工具划分（5 个，对照 DSH 的单一 `modbus_poll` 工具）：
 *   modbus_connection  连线状态／连上／断开（有状态的三件事合成一个）
 *   modbus_read        读一段暂存器或位元，超过 125 笔自动切块
 *   modbus_write       写暂存器／线圈／单一暂存器位元（先读改再写回）
 *   modbus_watch       轮询到值变成 expect，用来「证明」写入真的生效
 *   modbus_scan_units  扫站号，用独立连线
 *
 * 另有一个只给 Web 的 modbus_set_guard：唯读锁定必须由人开关，
 * 否则 Agent 可以自己解掉自己的防误写锁，这个锁就形同虚设。
 */
import { z } from 'zod'
import { defineCommand, type CommandDefinition } from '../../core/command.js'
import { ToolboxError } from '../../core/errors.js'
import { ModbusService, type ModbusServiceOptions, type ReadResult, type WriteResult } from './service.js'
import { KINDS, hex4, isBitKind, normalizeKind, REGISTER_TYPES, WORD_ORDERS } from './types.js'

const KindSchema = z.enum([...KINDS])
const TypeSchema = z.enum([...REGISTER_TYPES])
const WordOrderSchema = z.enum([...WORD_ORDERS])

const RowSchema = z.object({
  index: z.number().int(),
  address: z.number().int(),
  raw: z.array(z.number().int()).describe('Raw 16-bit words as they came off the wire'),
  numeric: z.number().describe('Value before scale and offset'),
  value: z.number().describe('Engineering value: numeric * scale + offset'),
  text: z.string().describe('Formatted engineering value, free of float noise'),
})

const WriteEntrySchema = z.object({
  at: z.string(),
  source: z.enum(['panel', 'tool']),
  kind: KindSchema,
  address: z.number().int(),
  value: z.number().optional(),
  values: z.array(z.number().int()).optional(),
  bit: z.number().int().optional(),
  unitId: z.number().int().nullable(),
  host: z.string().nullable(),
  port: z.number().int().nullable(),
})

/** 读取结果共用的栏位：暂存器与位元表的输出形状不同，所以两边都用可选。 */
const ReadFields = {
  kind: KindSchema,
  start: z.number().int(),
  count: z.number().int().describe('How many addresses were actually read (capped by the per-call limit)'),
  requested: z.number().int().describe('What the caller asked for'),
  truncated: z.boolean().describe('True when requested > count'),
  chunks: z.number().int().describe('Protocol requests used'),
  chunkSize: z.number().int(),
  latencyMs: z.number().int(),
  reconnected: z.boolean().describe('True when a dead socket was reopened for this call'),
  type: TypeSchema.optional(),
  wordOrder: WordOrderSchema.optional(),
  width: z.number().int().describe('Registers per value (1 for 16-bit, 2 for 32-bit)').optional(),
  scale: z.number().optional(),
  offset: z.number().optional(),
  values: z.array(z.number().int()).optional().describe('Raw 16-bit registers'),
  rows: z.array(RowSchema).optional().describe('Decoded values'),
  trailing: z.number().int().optional().describe('Registers left over that cannot complete a 32-bit value'),
  bits: z.array(z.boolean()).optional().describe('Coil or discrete-input states'),
}

function table(rows: ReadResult['rows'], limit = 40): string {
  if (!rows || rows.length === 0) return ''
  const shown = rows.slice(0, limit)
  const lines = ['address\traw\tvalue']
  for (const row of shown) {
    lines.push(`${row.address}\t${row.raw.map(hex4).join(' ')}\t${row.text}`)
  }
  if (rows.length > shown.length) lines.push(`... ${rows.length - shown.length} more row(s)`)
  return `\n${lines.join('\n')}`
}

function bitList(bits: boolean[] | undefined, start: number, limit = 64): string {
  if (!bits) return ''
  const on: number[] = []
  bits.forEach((value, index) => {
    if (value) on.push(start + index)
  })
  const shown = on.slice(0, limit)
  return `\non: ${on.length === 0 ? 'none' : shown.join(', ') + (on.length > shown.length ? ` ... (${on.length - shown.length} more)` : '')}`
}

function describeRead(result: ReadResult): string {
  const where = isBitKind(result.kind) ? `${result.kind} ${result.start}` : `${result.kind} ${result.start}..${result.start + result.count - 1}`
  const size = isBitKind(result.kind) ? `${result.bits?.length ?? 0} bit(s)` : `${result.rows?.length ?? 0} value(s)`
  const cuts =
    result.chunks > 1 ? ` in ${result.chunks} chunk(s)` : ''
  const cap = result.truncated ? ` (capped at ${result.count}, asked for ${result.requested})` : ''
  const trailing = result.trailing ? `\n${result.trailing} trailing register(s) could not complete a ${result.type} value` : ''
  const reconnect = result.reconnected ? ' [reconnected]' : ''
  return `read ${where}: ${size}${cuts}, ${result.latencyMs} ms${cap}${reconnect}${trailing}`
}

function describeWrite(written: WriteResult): string {
  if (written.bit !== undefined) {
    const verb = written.value ? 'set' : 'cleared'
    return `${verb} bit ${written.bit} of holding register ${written.address} (${hex4(written.before ?? 0)} -> ${hex4(written.after ?? 0)})`
  }
  if (written.kind === 'coil') {
    if (written.values && written.values.length > 1) {
      return `wrote ${written.count ?? written.values.length} coil(s) from ${written.address}: ${written.values.join(',')}`
    }
    return `wrote coil ${written.address} = ${written.value}`
  }
  if (written.values && written.values.length > 1) {
    const type = written.type ? ` (${written.type} ${written.wordOrder})` : ''
    return `wrote ${written.count ?? written.values.length} register(s)${type} from ${written.address}: ${written.values.map(hex4).join(' ')}`
  }
  return `wrote ${written.value} (${hex4(written.value ?? 0)}) to holding register ${written.address}`
}

export type ModbusModuleOptions = ModbusServiceOptions

export interface ModbusModule {
  commands: CommandDefinition[]
  /** 面板与命令共用同一个 service 实例。 */
  service: ModbusService
}

const CONNECTION_DESCRIPTION =
  'Report, open or close the Modbus TCP connection used by every modbus_* tool. ' +
  'action "status" answers without touching the wire (host, port, unitId, read-only lock, recent writes); ' +
  'action "connect" opens or reuses a connection to host:port (reusing the same host:port just switches unitId); ' +
  'action "disconnect" closes it. A dead socket is reopened automatically by the next read or write, and the ' +
  'result says reconnected=true when that happened. One server at a time: connect again to switch device.'

export function createModbusModule(options: ModbusModuleOptions = {}): ModbusModule {
  const service = new ModbusService(options)

  const connection = defineCommand({
    name: 'modbus_connection',
    title: 'Modbus connection status, connect, disconnect',
    description: CONNECTION_DESCRIPTION,
    input: z.object({
      action: z
        .enum(['status', 'connect', 'disconnect'])
        .optional()
        .describe('status (default) reads the current state; connect opens host:port; disconnect closes it'),
      host: z.string().optional().describe('Server host name or IP; required for action "connect"'),
      port: z.number().int().min(1).max(65535).optional().describe('TCP port (default 502)'),
      unitId: z.number().int().min(0).max(255).optional().describe('Modbus unit (slave) id, 0-255 (default 1)'),
      timeoutMs: z
        .number()
        .int()
        .min(100)
        .max(60_000)
        .optional()
        .describe('Per-request timeout in ms (default 3000)'),
    }),
    output: z.object({
      action: z.string(),
      connected: z.boolean(),
      host: z.string().nullable(),
      port: z.number().int().nullable(),
      unitId: z.number().int().nullable(),
      lastError: z.string().nullable(),
      readOnly: z.boolean().describe('True when the read-only guard blocks writes; only the panel can clear it'),
      writeCount: z.number().int(),
      recentWrites: z.array(WriteEntrySchema),
      summary: z.string(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    expose: { mcp: false },
    render: (output) => output.summary,
    async handler(input) {
      const action = input.action ?? 'status'
      if (action === 'connect') {
        const snapshot = await service.connect({
          host: input.host,
          port: input.port,
          unitId: input.unitId,
          timeoutMs: input.timeoutMs,
        })
        return {
          action,
          ...snapshot,
          summary: `connected to ${snapshot.host}:${snapshot.port} unit ${snapshot.unitId}${snapshot.readOnly ? ' (read-only guard ON)' : ''}`,
        }
      }
      if (action === 'disconnect') {
        const snapshot = service.disconnect()
        return { action, ...snapshot, summary: 'disconnected' }
      }
      const snapshot = service.snapshot()
      const state = snapshot.connected
        ? `connected to ${snapshot.host}:${snapshot.port} unit ${snapshot.unitId}`
        : `not connected${snapshot.lastError ? ` (last error: ${snapshot.lastError})` : ''}`
      const guard = snapshot.readOnly ? '; read-only guard is ON (writes will be refused)' : ''
      const writes = snapshot.recentWrites.length === 0 ? '' : `\n${snapshot.recentWrites.length} recent write(s) on record`
      return { action, ...snapshot, summary: `${state}${guard}${writes}` }
    },
  })

  const read = defineCommand({
    name: 'modbus_read',
    title: 'Read Modbus registers or bits',
    description:
      'Read holding registers (FC03, default), input registers (FC04), coils (FC01) or discrete inputs (FC02). ' +
      'Choose the data type (u16 default, i16, u32, i32, f32) and the 32-bit word order (ABCD default, CDAB, BADC, DCBA); ' +
      'scale/offset turn raw registers into engineering values (scale 0.1 shows register 235 as 23.5). ' +
      'Large ranges are read in protocol-sized chunks automatically and 32-bit types are aligned to their width, ' +
      'so one float is never split across two requests. ' +
      'Caps: 1024 registers or 2048 bits per call (truncated=true when the request exceeded it, and trailing registers ' +
      'that cannot complete a value are reported instead of silently dropped). Connects with the current connection; ' +
      'call modbus_connection first.',
    input: z.object({
      start: z.number().int().min(0).max(65535).describe('First address to read'),
      count: z.number().int().min(1).optional().describe('Registers (max 1024) or bits (max 2048); default 1'),
      kind: KindSchema.optional().describe('holding (default), input, coil or discrete'),
      type: TypeSchema.optional().describe('Register data type (default u16)'),
      wordOrder: WordOrderSchema.optional().describe('32-bit word order (default ABCD)'),
      scale: z.number().optional().describe('Multiplied after reading (default 1)'),
      offset: z.number().optional().describe('Added after reading (default 0)'),
      unitId: z.number().int().min(0).max(255).optional().describe('Unit id for this call (default: current connection)'),
    }),
    output: z.object({ ...ReadFields, summary: z.string() }),
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    expose: { mcp: false },
    render: (output) =>
      `${output.summary}${bitList(output.bits, output.start)}${table(output.rows)}`,
    async handler(input) {
      const result = await service.read(input)
      return {
        ...result,
        summary: describeRead(result),
      }
    },
  })

  const write = defineCommand({
    name: 'modbus_write',
    title: 'Write Modbus registers or coils',
    description:
      'Write holding registers (FC06/FC16) or coils (FC05/FC15); changes take effect on the device immediately. ' +
      'Pass `value` for a single write, `values` for a batch, or `bit` (0-15) to toggle one bit of a holding register — ' +
      'the bit path reads the register, flips the bit and writes it back, so callers never hand-compute masks. ' +
      'type/wordOrder/scale/offset apply in reverse, so a value read as 23.5 with scale 0.1 is written back as 235. ' +
      'Set verify=true to read the addresses back after writing; the result then carries verified=false when the device ' +
      'did not keep the value. ' +
      'Refused while the read-only guard is on (only the panel can clear it), and input registers / discrete inputs are read-only. ' +
      'Prefer following a write with verify or modbus_watch instead of assuming success once the frame leaves.',
    input: z.object({
      address: z.number().int().min(0).max(65535).describe('First address to write'),
      kind: KindSchema.optional().describe('holding (default) or coil'),
      value: z.number().optional().describe('Single value to write (engineering value when scale/offset are set)'),
      values: z.array(z.number().int()).optional().describe('Batch write: register words or coil states (0/1), starting at address'),
      bit: z.number().int().min(0).max(15).optional().describe('Bit index inside a holding register; value 0/1 toggles it'),
      type: TypeSchema.optional().describe('Data type for encoding (default u16)'),
      wordOrder: WordOrderSchema.optional().describe('32-bit word order (default ABCD)'),
      scale: z.number().optional().describe('Divided out before writing (default 1)'),
      offset: z.number().optional().describe('Subtracted before writing (default 0)'),
      unitId: z.number().int().min(0).max(255).optional().describe('Unit id for this call'),
      verify: z.boolean().optional().describe('Read the addresses back after writing (default false)'),
    }),
    output: z.object({
      kind: KindSchema,
      address: z.number().int(),
      count: z.number().int().optional(),
      value: z.number().optional(),
      values: z.array(z.number().int()).optional(),
      bit: z.number().int().optional(),
      before: z.number().int().optional(),
      after: z.number().int().optional(),
      type: TypeSchema.optional(),
      wordOrder: WordOrderSchema.optional(),
      scale: z.number().optional(),
      offset: z.number().optional(),
      latencyMs: z.number().int(),
      reconnected: z.boolean(),
      verified: z.boolean().nullable().describe('null when verify was not requested'),
      readBack: z.number().optional().describe('Value read back after the write (registers: engineering value, coils: 0/1)'),
      summary: z.string(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
    expose: { mcp: false },
    render: (output) => output.summary,
    async handler(input, ctx) {
      if (input.value === undefined && input.values === undefined) {
        throw new ToolboxError('invalid-parameter', 'pass either value or values to write', {
          field: 'value',
          hint: 'modbus_write needs a value (single) or values (batch)',
        })
      }
      if (input.value !== undefined && input.values !== undefined) {
        throw new ToolboxError('invalid-parameter', 'pass value or values, not both', { field: 'values' })
      }
      const kind = normalizeKind(input.kind)
      const written = await service.write({ ...input, kind }, ctx.source ?? 'tool')
      let verified: boolean | null = null
      let readBack: number | undefined

      if (input.verify === true) {
        const back = await service.read({
          kind: written.kind,
          start: written.address,
          count: written.values?.length ?? 1,
          unitId: input.unitId,
          type: input.type,
          wordOrder: input.wordOrder,
          scale: input.scale,
          offset: input.offset,
        })
        if (Array.isArray(back.bits)) {
          readBack = back.bits[0] ? 1 : 0
          verified = (written.value ?? 0) === readBack
        } else {
          readBack = back.rows?.[0]?.value
          const expected = input.value ?? input.values?.[0]
          const tolerance =
            input.type === 'f32' ? 1e-6 * Math.max(1, Math.abs(Number(expected ?? 0))) : 0
          verified =
            expected === undefined || readBack === undefined ? null : Math.abs(readBack - Number(expected)) <= tolerance
        }
      }

      const note = verified === null ? '' : verified ? ' (verified by read-back)' : ` (NOT verified: device reports ${readBack})`
      const reconnect = written.reconnected ? ' [reconnected]' : ''
      return {
        ...written,
        verified,
        ...(readBack !== undefined ? { readBack } : {}),
        summary: `${describeWrite(written)}${note}${reconnect}`,
      }
    },
  })

  const watch = defineCommand({
    name: 'modbus_watch',
    title: 'Wait until a Modbus value settles',
    description:
      'Poll one address until its decoded value equals `expect`, or until the deadline passes. ' +
      'This is how a write gets proved: use it after modbus_write to confirm the device really changed, instead of ' +
      'reporting success as soon as the frame left. For coil/discrete, expect is 0 or 1 on the first bit. ' +
      'Floats default to a small relative tolerance; pass tolerance for an absolute one. ' +
      'It is polling, not a subscription: timeoutMs max 60000, intervalMs 50-5000.',
    input: z.object({
      start: z.number().int().min(0).max(65535).describe('Address to watch'),
      expect: z.number().describe('Value to wait for, after type/scale/offset are applied'),
      kind: KindSchema.optional().describe('holding (default), input, coil or discrete'),
      count: z.number().int().min(1).optional().describe('Registers per poll (default: one value of the chosen type)'),
      type: TypeSchema.optional().describe('Data type (default u16)'),
      wordOrder: WordOrderSchema.optional().describe('32-bit word order (default ABCD)'),
      scale: z.number().optional(),
      offset: z.number().optional(),
      unitId: z.number().int().min(0).max(255).optional(),
      tolerance: z.number().optional().describe('Absolute tolerance (default 0; f32 uses a small relative epsilon)'),
      timeoutMs: z.number().int().min(100).max(60_000).optional().describe('Deadline in ms (default 5000)'),
      intervalMs: z.number().int().min(50).max(5000).optional().describe('Poll interval in ms (default 200)'),
    }),
    output: z.object({
      kind: KindSchema,
      start: z.number().int(),
      expect: z.number(),
      matched: z.boolean(),
      attempts: z.number().int(),
      elapsedMs: z.number().int(),
      current: z.string().describe('Last value seen, formatted'),
      bits: z.array(z.boolean()).optional(),
      values: z.array(z.number().int()).optional(),
      rows: z.array(RowSchema).optional(),
      latencyMs: z.number().int(),
      reconnected: z.boolean(),
      summary: z.string(),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    expose: { mcp: false },
    render: (output) => output.summary,
    async handler(input) {
      const result = await service.watch(input)
      const where = isBitKind(result.kind) ? `${result.kind} ${result.start}` : `${result.kind} register ${result.start}`
      const summary = result.matched
        ? `watch ${where}: matched ${result.expect} as ${result.current} after ${result.attempts} attempt(s) in ${result.elapsedMs} ms`
        : `watch ${where}: still ${result.current} after ${result.elapsedMs} ms (${result.attempts} attempt(s)), expected ${result.expect}`
      return {
        kind: result.kind,
        start: result.start,
        expect: result.expect,
        matched: result.matched,
        attempts: result.attempts,
        elapsedMs: result.elapsedMs,
        current: result.current,
        ...(result.bits ? { bits: result.bits } : {}),
        ...(result.values ? { values: result.values } : {}),
        ...(result.rows ? { rows: result.rows } : {}),
        latencyMs: result.latencyMs,
        reconnected: result.reconnected,
        summary,
      }
    },
  })

  const scanUnits = defineCommand({
    name: 'modbus_scan_units',
    title: 'Probe Modbus unit ids on one host',
    description:
      'Probe a range of Modbus unit (slave) ids on one host to find which ones answer, using a dedicated socket so the ' +
      'current connection is not disturbed. A Modbus exception counts as present (the device answered); silence does not. ' +
      'Costs roughly (units x timeoutMs) when everything is silent, so narrow from/to. maxMs is an overall time budget; ' +
      'truncated=true when it ran out.',
    input: z.object({
      host: z.string().optional().describe('Host to probe (default: current connection host)'),
      port: z.number().int().min(1).max(65535).optional().describe('TCP port (default 502 or current connection port)'),
      from: z.number().int().min(0).max(255).optional().describe('First unit id (default 1)'),
      to: z.number().int().min(0).max(255).optional().describe('Last unit id (default 247)'),
      address: z.number().int().min(0).max(65535).optional().describe('Register address used as the probe (default 0)'),
      timeoutMs: z.number().int().min(50).max(2000).optional().describe('Per-unit timeout (default 150)'),
      maxMs: z.number().int().min(1000).max(120_000).optional().describe('Overall budget in ms (default 60000)'),
    }),
    output: z.object({
      host: z.string(),
      port: z.number().int(),
      from: z.number().int(),
      to: z.number().int(),
      scanned: z.number().int(),
      responded: z.array(z.number().int()),
      truncated: z.boolean(),
      elapsedMs: z.number().int(),
      summary: z.string(),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
    expose: { mcp: false },
    render: (output) => output.summary,
    async handler(input) {
      const result = await service.scanUnits(input)
      const list = result.responded.length === 0 ? 'none' : result.responded.join(', ')
      return {
        ...result,
        summary:
          `scan-units ${result.host}:${result.port} units ${result.from}..${result.to}: ` +
          `${result.scanned} probed in ${result.elapsedMs} ms, responded: ${list}` +
          `${result.truncated ? ' (stopped early by maxMs)' : ''}`,
      }
    },
  })

  const setGuard = defineCommand({
    name: 'modbus_set_guard',
    title: 'Toggle the read-only guard (panel only)',
    description: 'Turn the read-only write guard on or off. Panel only: an agent must not be able to unlock its own write protection.',
    input: z.object({
      readOnly: z.boolean().describe('true blocks every write from the panel and from agents'),
    }),
    output: z.object({
      readOnly: z.boolean(),
      writeCount: z.number().int(),
      summary: z.string(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    // 刻意只給 Web：Agent 能解鎖的話，這個鎖就沒有意義。
    expose: { mcp: false },
    render: (output) => output.summary,
    async handler(input) {
      const snapshot = service.setGuard(input.readOnly)
      return {
        readOnly: snapshot.readOnly,
        writeCount: snapshot.writeCount,
        summary: `read-only guard is ${snapshot.readOnly ? 'ON' : 'off'}`,
      }
    },
  })

  // The original DSH plugin exposes one action-dispatch tool. Keep that MCP
  // contract while the Web panel continues to call the same focused commands.
  const poll = defineCommand({
    name: 'modbus_poll',
    title: 'Modbus TCP read/write tool',
    description:
      'Operate the Modbus TCP read/write panel through one action: status, connect, disconnect, read, write, write-bit, watch, dump, scan-units, or guard. ' +
      'Supports holding/input registers, coils/discrete inputs, u16/i16/u32/i32/f32, four 32-bit word orders, scale/offset, verified writes, chunked dumps, and a panel-controlled read-only guard. ' +
      'Connect before reading or writing. Writes take effect immediately. The guard action only reports status and recent writes; only the Web panel can unlock it.',
    input: z.object({
      action: z.enum(['status', 'connect', 'disconnect', 'read', 'write', 'write-bit', 'watch', 'dump', 'scan-units', 'guard']).describe('Operation to perform'),
      host: z.string().optional(),
      port: z.number().int().min(1).max(65535).optional(),
      unitId: z.number().int().min(0).max(255).optional(),
      timeoutMs: z.number().int().min(50).max(60_000).optional(),
      kind: KindSchema.optional(),
      start: z.number().int().min(0).max(65535).optional(),
      count: z.number().int().min(1).optional(),
      type: TypeSchema.optional(),
      wordOrder: WordOrderSchema.optional(),
      scale: z.number().optional(),
      offset: z.number().optional(),
      address: z.number().int().min(0).max(65535).optional(),
      value: z.union([z.number(), z.boolean()]).optional(),
      values: z.array(z.union([z.number(), z.boolean()])).optional(),
      bit: z.number().int().min(0).max(15).optional(),
      verify: z.boolean().optional(),
      expect: z.number().optional(),
      tolerance: z.number().optional(),
      intervalMs: z.number().int().min(50).max(5000).optional(),
      chunk: z.number().int().min(1).max(125).optional(),
      from: z.number().int().min(0).max(255).optional(),
      to: z.number().int().min(0).max(255).optional(),
      maxMs: z.number().int().min(1000).max(120_000).optional(),
    }),
    output: z.object({ action: z.string(), summary: z.string() }).passthrough(),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
    expose: { web: false },
    render: (output) => output.summary,
    async handler(input, ctx) {
      const args: Record<string, unknown> = input
      const action = input.action
      let command: CommandDefinition
      let commandArgs: Record<string, unknown>
      switch (action) {
        case 'status':
        case 'connect':
        case 'disconnect':
          command = connection
          commandArgs = { ...args, action }
          break
        case 'read':
        case 'dump':
          command = read
          commandArgs = args
          break
        case 'write':
        case 'write-bit':
          command = write
          commandArgs = {
            ...args,
            kind: action === 'write-bit' ? 'holding' : args.kind,
            ...(typeof args.value === 'boolean' ? { value: Number(args.value) } : {}),
            ...(Array.isArray(args.values) ? { values: args.values.map((value) => Number(value)) } : {}),
          }
          break
        case 'watch':
          command = watch
          commandArgs = args
          break
        case 'scan-units':
          command = scanUnits
          commandArgs = args
          break
        case 'guard':
          {
            const snapshot = service.snapshot()
            const lines = snapshot.recentWrites.map((entry) => {
              const detail = entry.values?.length ? entry.values.join(',') : String(entry.value)
              return `${entry.at} ${entry.source} ${entry.kind} ${entry.address}: ${detail}`
            })
            const output = {
              action,
              ...snapshot,
              summary: `read-only guard is ${snapshot.readOnly ? 'ON' : 'off'}; ${snapshot.recentWrites.length} recent write(s)` +
                (lines.length ? `\nwhen\tsource\tkind\taddress\tvalue\n${lines.join('\n')}` : ''),
            }
            return output
          }
      }
      const parsed = command.input.parse(commandArgs)
      const result = await command.handler(parsed as never, ctx)
      const output = result as Record<string, unknown>
      const summary = typeof output.summary === 'string' && action === 'dump'
        ? output.summary.replace(/^read /, 'dump ')
        : output.summary
      return { ...output, action, summary } as { action: string; summary: string } & Record<string, unknown>
    },
  })

  return { commands: [connection, read, write, watch, scanUnits, setGuard, poll], service }
}
