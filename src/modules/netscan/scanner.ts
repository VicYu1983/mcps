/**
 * 网段扫描核心（移植自 DSH netscanner 插件的 scanner.js）。
 *
 * 与旧版的差异只有三点，都是为了让它在任何宿主里行为一致：
 *   1. 不依赖任何框架（旧版依赖进程环境，这里把 ArpReader 做成可注入）
 *   2. 不再维护「单例 + 当前扫描」的状态机——任务由 JobManager 管，
 *      这里只负责「扫一次并把结果返回」
 *   3. 进度与取消通过回调注入，不自己持有定时器
 *
 * 探测原理（与旧版相同，注释保留）：
 *   浏览器不能开 raw socket，所以全部在这里做。TCP connect 成功 = 端口开，
 *   收到 RST（ECONNREFUSED）也证明主机活着，所以没有开放端口的设备也能被发现；
 *   操作系统 ARP 表补上「防火墙静默丢包但同一 L2 段的设备」（手机、电视、IoT）。
 */
import { execFile } from 'node:child_process'
import dns from 'node:dns/promises'
import net from 'node:net'
import os from 'node:os'
import { promisify } from 'node:util'
import { ToolboxError } from '../../core/errors.js'

const execFileAsync = promisify(execFile)

export const MAX_HOSTS = 4096
export const MAX_PORTS = 32
export const MAX_CONCURRENCY = 128
export const DEFAULT_TIMEOUT_MS = 700
export const DEFAULT_CONCURRENCY = 48
export const DEFAULT_PORTS: readonly number[] = Object.freeze([
  21, 22, 23, 80, 135, 139, 443, 445, 3389, 8080,
])

const MIN_TIMEOUT_MS = 50
const MAX_TIMEOUT_MS = 10_000
const HOSTNAME_TIMEOUT_MS = 800
const HOSTNAME_CONCURRENCY = 8
const ARP_TIMEOUT_MS = 4_000

export interface Target {
  input: string
  label: string
  hosts: string[]
  count: number
}

export interface HostResult {
  ip: string
  hostname: string | null
  mac: string | null
  ports: number[]
  latencyMs: number
  /** tcp = 有 TCP 响应（强信号）；arp = 仅 ARP 缓存命中（弱信号）。 */
  via: 'tcp' | 'arp'
}

export interface NetworkInterfaceInfo {
  name: string
  address: string
  netmask: string
  cidr: string
}

export interface ScanOptions {
  cidr?: string
  target?: string
  startIp?: string
  endIp?: string
  ports?: unknown
  timeoutMs?: unknown
  concurrency?: unknown
  resolveNames?: boolean
  maxHosts?: number
}

export interface ScanProgress {
  (phase: string, scanned: number, total: number, alive: number): void
}

export type ArpReader = () => Promise<Map<string, string>>

// ---------------------------------------------------------------- 地址解析

export function parseIpv4(text: unknown): number[] | null {
  const parts = String(text ?? '').trim().split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number.parseInt(part, 10)
    if (!Number.isInteger(value) || value < 0 || value > 255) return null
    octets.push(value)
  }
  return octets
}

export function ipv4ToInt(text: unknown): number | null {
  const octets = parseIpv4(text)
  if (!octets) return null
  return (((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0)
}

export function intToIpv4(value: number): string {
  const n = Number(value) >>> 0
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`
}

export function maskToPrefix(mask: unknown): number | null {
  const octets = parseIpv4(mask)
  if (!octets) return null
  let prefix = 0
  let seenZero = false
  for (const octet of octets) {
    for (let bit = 7; bit >= 0; bit -= 1) {
      if ((octet >> bit) & 1) {
        if (seenZero) return null
        prefix += 1
      } else {
        seenZero = true
      }
    }
  }
  return prefix
}

function prefixToMask(prefix: number): number {
  if (prefix === 0) return 0
  return (0xffffffff << (32 - prefix)) >>> 0
}

function countHosts(prefix: number): number {
  const size = 2 ** (32 - prefix)
  return prefix >= 31 ? size : Math.max(0, size - 2)
}

function targetError(message: string, field: string, details?: Record<string, unknown>): ToolboxError {
  return new ToolboxError('invalid-target', message, {
    field,
    ...(details ? { details } : {}),
    hint: 'use a CIDR (192.168.1.0/24), a range (192.168.1.10-50), a wildcard (192.168.1.*) or a single IPv4 address',
  })
}

/**
 * 把用户输入变成明确的 IPv4 列表。
 * 接受 CIDR、完整/简写范围、末段通配符、单个地址。
 */
export function parseTargets(input: unknown, maxHosts = MAX_HOSTS): Target {
  const raw = String(input ?? '').trim()
  if (raw === '') {
    throw new ToolboxError('invalid-target', 'a scan target is required', { field: 'target' })
  }

  const hosts: string[] = []
  let label = raw

  if (raw.includes('/')) {
    const slash = raw.indexOf('/')
    const networkIp = raw.slice(0, slash).trim()
    const prefixText = raw.slice(slash + 1).trim()
    if (!parseIpv4(networkIp) || !/^\d{1,2}$/.test(prefixText)) {
      throw targetError(`invalid CIDR target ${JSON.stringify(raw)}`, 'target')
    }
    const prefix = Number.parseInt(prefixText, 10)
    if (prefix < 8 || prefix > 32) {
      throw new ToolboxError('invalid-target', 'the prefix length must be between 8 and 32', {
        field: 'target',
        details: { prefix },
      })
    }
    const count = countHosts(prefix)
    if (count > maxHosts) {
      throw new ToolboxError(
        'too-many-hosts',
        `${label} contains ${count} addresses; the limit is ${maxHosts}`,
        { field: 'target', details: { count, max: maxHosts } },
      )
    }
    const address = ipv4ToInt(networkIp)!
    const mask = prefixToMask(prefix)
    const network = (address & mask) >>> 0
    const broadcast = (network | (~mask >>> 0)) >>> 0
    const first = prefix >= 31 ? network : network + 1
    const last = prefix >= 31 ? broadcast : broadcast - 1
    for (let value = first; value <= last; value += 1) hosts.push(intToIpv4(value))
    label = `${intToIpv4(network)}/${prefix}`
  } else if (/^(\d{1,3}\.){3}\d{1,3}\s*-\s*(\d{1,3}\.){3}\d{1,3}$/.test(raw)) {
    const [startText, endText] = raw.split('-').map((part) => part.trim()) as [string, string]
    const start = ipv4ToInt(startText)
    const end = ipv4ToInt(endText)
    if (start === null || end === null || start > end) {
      throw targetError(`invalid address range ${JSON.stringify(raw)}`, 'target')
    }
    const count = end - start + 1
    if (count > maxHosts) {
      throw new ToolboxError('too-many-hosts', `${label} contains ${count} addresses; the limit is ${maxHosts}`, {
        field: 'target',
        details: { count, max: maxHosts },
      })
    }
    for (let value = start; value <= end; value += 1) hosts.push(intToIpv4(value))
    label = `${intToIpv4(start)}-${intToIpv4(end)}`
  } else if (/^(\d{1,3}\.){3}\d{1,3}\s*-\s*\d{1,3}$/.test(raw)) {
    const [startText, endText] = raw.split('-').map((part) => part.trim()) as [string, string]
    const octets = parseIpv4(startText)
    const lastOctet = Number.parseInt(endText, 10)
    if (!octets || !/^\d{1,3}$/.test(endText) || lastOctet < 0 || lastOctet > 255) {
      throw targetError(`invalid address range ${JSON.stringify(raw)}`, 'target')
    }
    const start = octets[3]!
    if (lastOctet < start) {
      throw targetError(`invalid address range ${JSON.stringify(raw)}`, 'target')
    }
    const base = `${octets[0]}.${octets[1]}.${octets[2]}`
    for (let value = start; value <= lastOctet; value += 1) hosts.push(`${base}.${value}`)
    label = `${base}.${start}-${lastOctet}`
  } else if (/^(\d{1,3}\.){3}\*$/.test(raw)) {
    const octets = parseIpv4(`${raw.slice(0, -1)}0`)
    if (!octets) throw targetError(`invalid wildcard target ${JSON.stringify(raw)}`, 'target')
    const base = `${octets[0]}.${octets[1]}.${octets[2]}`
    for (let value = 1; value <= 254; value += 1) hosts.push(`${base}.${value}`)
    label = `${base}.1-254`
  } else {
    if (!parseIpv4(raw)) throw targetError(`invalid IPv4 target ${JSON.stringify(raw)}`, 'target')
    hosts.push(raw)
    label = raw
  }

  if (hosts.length === 0) {
    throw targetError('the target contains no usable addresses', 'target')
  }
  if (hosts.length > maxHosts) {
    throw new ToolboxError('too-many-hosts', `the target exceeds the ${maxHosts}-address limit`, {
      field: 'target',
      details: { count: hosts.length, max: maxHosts },
    })
  }
  return { input: raw, label, hosts, count: hosts.length }
}

/** 面板的两个输入框产出的闭区间；单个地址时首尾相同。 */
export function parseRange(startInput: unknown, endInput: unknown, maxHosts = MAX_HOSTS): Target {
  const startText = String(startInput ?? '').trim()
  const endText = String(endInput ?? '').trim()
  const start = ipv4ToInt(startText)
  if (start === null) {
    throw new ToolboxError('invalid-target', `invalid start IP ${JSON.stringify(startText)}`, { field: 'startIp' })
  }
  const end = ipv4ToInt(endText)
  if (end === null) {
    throw new ToolboxError('invalid-target', `invalid end IP ${JSON.stringify(endText)}`, { field: 'endIp' })
  }
  if (start > end) {
    throw new ToolboxError('invalid-target', `start IP ${startText} is after end IP ${endText}`, { field: 'endIp' })
  }
  const count = end - start + 1
  if (count > maxHosts) {
    throw new ToolboxError(
      'too-many-hosts',
      `${startText}-${endText} contains ${count} addresses; the limit is ${maxHosts}`,
      { field: 'endIp', details: { count, max: maxHosts } },
    )
  }
  const hosts: string[] = []
  for (let value = start; value <= end; value += 1) hosts.push(intToIpv4(value))
  return { input: `${startText} - ${endText}`, label: `${startText}-${endText}`, hosts, count }
}

/** 逗号/空格分隔的端口，支持闭区间 8000-8010。 */
export function parsePorts(value: unknown): number[] {
  if (value === undefined || value === null) return [...DEFAULT_PORTS]
  const tokens = (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item ?? '').split(/[\s,;]+/))
    .filter((token) => token !== '')
  if (tokens.length === 0) {
    throw new ToolboxError('invalid-parameter', 'at least one port is required', { field: 'ports' })
  }

  const ports = new Set<number>()
  for (const token of tokens) {
    const match = /^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/.exec(token)
    if (!match) {
      throw new ToolboxError('invalid-parameter', `invalid port ${JSON.stringify(token)}`, {
        field: 'ports',
        details: { token },
      })
    }
    const low = Number.parseInt(match[1]!, 10)
    const high = match[2] === undefined ? low : Number.parseInt(match[2], 10)
    if (low < 1 || low > 65535 || high < 1 || high > 65535 || low > high) {
      throw new ToolboxError('invalid-parameter', `port ${JSON.stringify(token)} must be within 1..65535`, {
        field: 'ports',
        details: { token },
      })
    }
    for (let port = low; port <= high; port += 1) {
      ports.add(port)
      if (ports.size > MAX_PORTS) {
        throw new ToolboxError('invalid-parameter', `a scan may use at most ${MAX_PORTS} ports`, {
          field: 'ports',
          details: { max: MAX_PORTS },
        })
      }
    }
  }
  return [...ports].sort((left, right) => left - right)
}

function boundedInteger(name: string, value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new ToolboxError('invalid-parameter', `${name} must be an integer in ${min}..${max}`, {
      field: name,
      details: { min, max },
    })
  }
  return number
}

// ---------------------------------------------------------------- ARP / 网卡

/** 归一化各平台的 ARP 表输出：一行一个 IP → MAC。 */
export function parseArpTable(text: unknown): Map<string, string> {
  const table = new Map<string, string>()
  const pattern = /\b(\d{1,3}(?:\.\d{1,3}){3})\)?\s+(?:at\s+)?([0-9a-f]{2}(?:[-:][0-9a-f]{2}){5})\b/gi
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = pattern.exec(line)
    pattern.lastIndex = 0
    if (!match) continue
    const ip = match[1]!
    if (ipv4ToInt(ip) === null) continue
    const mac = match[2]!.replace(/-/g, ':').toUpperCase()
    if (mac === 'FF:FF:FF:FF:FF:FF' || mac === '00:00:00:00:00:00') continue
    if (!table.has(ip)) table.set(ip, mac)
  }
  return table
}

export const readSystemArpTable: ArpReader = async () => {
  const args = process.platform === 'win32' ? ['-a'] : ['-an']
  try {
    const { stdout } = await execFileAsync('arp', args, {
      timeout: ARP_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    })
    return parseArpTable(stdout)
  } catch {
    return new Map()
  }
}

/** 本机所有非内部 IPv4 网段；链路本地（169.254）排在最后。 */
export function listInterfaces(): NetworkInterfaceInfo[] {
  const found: NetworkInterfaceInfo[] = []
  const seen = new Set<string>()
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      const prefix = maskToPrefix(address.netmask)
      if (prefix === null) continue
      const mask = prefixToMask(prefix)
      const network = (ipv4ToInt(address.address)! & mask) >>> 0
      const cidr = `${intToIpv4(network)}/${prefix}`
      const key = `${cidr}|${name}`
      if (seen.has(key)) continue
      seen.add(key)
      found.push({ name, address: address.address, netmask: address.netmask, cidr })
    }
  }
  found.sort((left, right) => {
    const leftLink = left.address.startsWith('169.254.') ? 1 : 0
    const rightLink = right.address.startsWith('169.254.') ? 1 : 0
    return leftLink - rightLink || left.name.localeCompare(right.name)
  })
  return found
}

// ---------------------------------------------------------------- 探测

async function reverseLookup(ip: string, timeoutMs: number): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined
  try {
    const pending = dns
      .reverse(ip)
      .then((names) => {
        if (!Array.isArray(names) || names.length === 0) return null
        const name = String(names[0]).replace(/\.$/, '')
        return name === ip ? null : name
      })
      .catch(() => null)
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    return await Promise.race([pending, timeout])
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface ProbeOutcome {
  port: number
  open: boolean
  responded: boolean
  latencyMs: number
}

export interface ScanRunOptions {
  target: Target
  ports: number[]
  timeoutMs: number
  concurrency: number
  resolveNames: boolean
  signal?: AbortSignal
  onProgress?: ScanProgress
  readArpTable?: ArpReader
  /** 测试注入：跳过真实 socket。 */
  probePort?: (ip: string, port: number, timeoutMs: number, signal?: AbortSignal) => Promise<ProbeOutcome>
}

export interface ScanRunResult {
  label: string
  hosts: HostResult[]
  total: number
  scanned: number
  durationMs: number
  stopped: boolean
}

function defaultProbePort(
  ip: string,
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    const started = Date.now()
    if (signal?.aborted) {
      resolve({ port, open: false, responded: false, latencyMs: 0 })
      return
    }
    const socket = new net.Socket()
    let settled = false
    const finish = (open: boolean, responded: boolean) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      resolve({ port, open, responded, latencyMs: Date.now() - started })
    }
    const onAbort = () => finish(false, false)
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true, true))
    socket.once('timeout', () => finish(false, false))
    socket.once('close', () => finish(false, false))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      const code = error?.code
      finish(false, code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE')
    })
    try {
      socket.connect({ port, host: ip })
    } catch {
      finish(false, false)
    }
  })
}

/**
 * 扫一次并返回结果。不持有任何跨调用状态——同一时刻只允许一个扫描
 * 这件事由上层（命令层 + JobManager）保证。
 */
export async function runScan(options: ScanRunOptions): Promise<ScanRunResult> {
  const { target, ports, timeoutMs, concurrency, resolveNames, signal } = options
  const probe = options.probePort ?? defaultProbePort
  const readArp = options.readArpTable ?? readSystemArpTable
  const onProgress = options.onProgress ?? (() => {})
  const startedAt = Date.now()

  const results = new Map<string, HostResult>()
  let cursor = 0
  let scanned = 0
  let stopped = false

  onProgress('scanning', 0, target.count, 0)

  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return
      const index = cursor
      cursor += 1
      if (index >= target.hosts.length) return
      const ip = target.hosts[index]!

      const outcomes = await Promise.all(ports.map((port) => probe(ip, port, timeoutMs, signal)))
      if (signal?.aborted) return
      scanned += 1

      const openPorts = outcomes
        .filter((outcome) => outcome.open)
        .map((outcome) => outcome.port)
        .sort((left, right) => left - right)
      const responses = outcomes.filter((outcome) => outcome.responded)
      if (responses.length > 0) {
        results.set(ip, {
          ip,
          hostname: null,
          mac: null,
          ports: openPorts,
          latencyMs: Math.max(0, Math.min(...responses.map((outcome) => outcome.latencyMs))),
          via: 'tcp',
        })
      }
      // 每 10 台报一次进度，避免高频回调本身成为开销。
      if (scanned % 10 === 0) onProgress('scanning', scanned, target.count, results.size)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, target.hosts.length) }, () => worker()))
  if (signal?.aborted) stopped = true
  onProgress('scanning', scanned, target.count, results.size)

  if (!stopped) {
    // ARP 补漏：同一 L2 段上防火墙静默丢包的设备，会留下 ARP 缓存项。
    onProgress('arp', scanned, target.count, results.size)
    try {
      const table = await readArp()
      if (table && table.size > 0) {
        for (const [ip, row] of results) {
          const mac = table.get(ip)
          if (mac) row.mac = mac
        }
        const targets = new Set(target.hosts)
        for (const [ip, mac] of table) {
          if (results.has(ip) || !targets.has(ip)) continue
          results.set(ip, { ip, hostname: null, mac, ports: [], latencyMs: 0, via: 'arp' })
        }
      }
    } catch {
      // ARP 只是增强信号，读不到不影响主流程
    }
  }

  if (!stopped && resolveNames && results.size > 0) {
    onProgress('resolving', scanned, target.count, results.size)
    const rows = [...results.values()]
    let nameCursor = 0
    const nameWorker = async () => {
      for (;;) {
        if (signal?.aborted) return
        const index = nameCursor
        nameCursor += 1
        if (index >= rows.length) return
        const row = rows[index]!
        const name = await reverseLookup(row.ip, HOSTNAME_TIMEOUT_MS)
        if (name) row.hostname = name
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(HOSTNAME_CONCURRENCY, rows.length) }, () => nameWorker()),
    )
  }

  const hosts = [...results.values()].sort(
    (left, right) => (ipv4ToInt(left.ip) ?? 0) - (ipv4ToInt(right.ip) ?? 0),
  )

  return {
    label: target.label,
    hosts,
    total: target.count,
    scanned,
    durationMs: Math.max(0, Date.now() - startedAt),
    stopped: stopped || Boolean(signal?.aborted),
  }
}

/** 把 ScanOptions 归一成一份可直接交给 runScan 的参数。 */
export function normalizeScanOptions(options: ScanOptions): {
  target: Target
  ports: number[]
  timeoutMs: number
  concurrency: number
  resolveNames: boolean
} {
  const maxHosts = options.maxHosts ?? MAX_HOSTS
  const target =
    options.startIp !== undefined || options.endIp !== undefined
      ? parseRange(options.startIp ?? options.endIp, options.endIp ?? options.startIp, maxHosts)
      : parseTargets(options.cidr ?? options.target, maxHosts)
  return {
    target,
    ports: parsePorts(options.ports),
    timeoutMs: boundedInteger('timeoutMs', options.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    concurrency: boundedInteger('concurrency', options.concurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY),
    resolveNames: options.resolveNames !== false,
  }
}
