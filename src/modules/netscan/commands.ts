/**
 * netscan 模块：命令定义 + 模块级状态。
 *
 * 工具划分原则（4 个，不多不少）：
 *   - 读写分离：两个读（list / get）、一个写（start）、一个控制（stop）
 *   - start 不阻塞，立即返回 jobId；get 负责轮询
 *   - 每个工具名都带 `netscan_` 前缀，因为它会和别的模块共处一个命名空间
 *
 * 状态（当前 jobId）挂在模块实例上而不是进程全局，方便测试并行创建多个实例。
 */
import { z } from 'zod'
import { defineCommand, type CommandDefinition } from '../../core/command.js'
import { ToolboxError } from '../../core/errors.js'
import type { JobManager } from '../../runtime/jobs.js'
import {
  DEFAULT_PORTS,
  listInterfaces,
  normalizeScanOptions,
  runScan,
  type HostResult,
  type NetworkInterfaceInfo,
} from './scanner.js'

const HostSchema = z.object({
  ip: z.string().describe('IPv4 address'),
  hostname: z.string().optional().describe('Reverse-DNS name, omitted when unresolved'),
  mac: z.string().optional().describe('MAC address from the OS ARP cache, omitted when unknown'),
  ports: z.array(z.number().int()).describe('Open TCP ports among the probed ones; empty for ARP-only hosts'),
  latencyMs: z.number().int().describe('Lowest TCP round trip in milliseconds; 0 for ARP-only hosts'),
  via: z.enum(['tcp', 'arp']).describe('tcp = answered a TCP probe; arp = only in the ARP cache (weaker signal)'),
})

const InterfaceSchema = z.object({
  name: z.string(),
  address: z.string(),
  netmask: z.string(),
  cidr: z.string(),
})

function seconds(milliseconds: number): string {
  return `${(Math.max(0, milliseconds) / 1000).toFixed(1)} s`
}

function formatHostTable(hosts: HostResult[], limit: number): string {
  const shown = hosts.slice(0, limit)
  const lines = ['IP\tHostname\tMAC\tOpen ports\tLatency\tVia']
  for (const host of shown) {
    lines.push(
      [
        host.ip,
        host.hostname ?? '-',
        host.mac ?? '-',
        host.ports.length > 0 ? host.ports.join(',') : '-',
        host.via === 'arp' ? '-' : `${host.latencyMs} ms`,
        host.via,
      ].join('\t'),
    )
  }
  if (hosts.length > shown.length) lines.push(`... ${hosts.length - shown.length} more host(s)`)
  return lines.join('\n')
}

export interface NetscanModuleOptions {
  jobs: JobManager
  /** 单次扫描地址上限，默认 4096。 */
  maxHosts?: number
  /** 测试注入：替换 OS 的 ARP 表读取。 */
  readArpTable?: Parameters<typeof runScan>[0]['readArpTable']
  /** 测试注入：替换真实的 TCP 探测。 */
  probePort?: Parameters<typeof runScan>[0]['probePort']
}

export interface NetscanModule {
  commands: CommandDefinition[]
  /** 当前（或最近一次）扫描的 jobId；没有扫描过时为 null。 */
  currentJobId: () => string | null
}

const DEFAULT_POLL_MS = 1500
const DEFAULT_WAIT_MS = 20_000
const HOST_PAGE_LIMIT = 200

export function createNetscanModule(options: NetscanModuleOptions): NetscanModule {
  const { jobs } = options
  let currentJobId: string | null = null

  function runningJobId(): string | null {
    if (currentJobId === null) return null
    const snapshot = jobs.get(currentJobId)
    if (!snapshot || snapshot.status !== 'running') return null
    return currentJobId
  }

  /** 把 job 快照转成工具输出；只暴露给 LLM 有意义的部分。 */
  function toScanOutput(jobId: string, limit: number, offset: number) {
    const snapshot = jobs.get<{ label: string; hosts: HostResult[]; total: number; scanned: number }>(jobId)
    if (!snapshot) {
      throw new ToolboxError('not-found', `unknown job ${JSON.stringify(jobId)}`, {
        hint: 'job ids are returned by netscan_start_scan and are dropped after 10 minutes',
      })
    }
    const result = snapshot.result
    const allHosts = result?.hosts ?? []
    const page = allHosts.slice(offset, offset + limit)
    const hasMore = offset + page.length < allHosts.length
    return {
      jobId,
      status: snapshot.status,
      phase: snapshot.phase,
      progress: Number(snapshot.progress.toFixed(3)),
      target: result?.label ?? null,
      total: result?.total ?? 0,
      scanned: result?.scanned ?? 0,
      aliveCount: allHosts.length,
      elapsedMs: snapshot.elapsedMs,
      hasMore,
      nextOffset: hasMore ? offset + page.length : null,
      hosts: page.map((host) => {
        const row: { ip: string; ports: number[]; latencyMs: number; via: 'tcp' | 'arp'; hostname?: string; mac?: string } = {
          ip: host.ip,
          ports: host.ports,
          latencyMs: host.latencyMs,
          via: host.via,
        }
        if (host.hostname) row.hostname = host.hostname
        if (host.mac) row.mac = host.mac
        return row
      }),
      ...(snapshot.error ? { error: { code: snapshot.error.code, message: snapshot.error.message } } : {}),
    }
  }

  const listInterfacesCommand = defineCommand({
    name: 'netscan_list_interfaces',
    title: 'List local network interfaces',
    description:
      'List this host\'s non-internal IPv4 subnets (name, address, netmask, CIDR). ' +
      'Use it first when the user has not said which network to scan, or to pick a sensible default target. ' +
      'Link-local 169.254.x.x interfaces are sorted last because they rarely hold real devices.',
    input: z.object({
      includeLinkLocal: z.boolean().optional().describe('Include 169.254.0.0/16 link-local interfaces (default true)'),
    }),
    output: z.object({
      count: z.number().int(),
      interfaces: z.array(InterfaceSchema),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    render: (output) =>
      output.count === 0
        ? 'no non-internal IPv4 interfaces found'
        : output.interfaces.map((entry) => `${entry.name}\t${entry.address}\t${entry.cidr}`).join('\n'),
    async handler(input) {
      const all: NetworkInterfaceInfo[] = listInterfaces()
      const interfaces =
        input.includeLinkLocal === false
          ? all.filter((entry) => !entry.address.startsWith('169.254.'))
          : all
      return { count: interfaces.length, interfaces }
    },
  })

  const startScanCommand = defineCommand({
    name: 'netscan_start_scan',
    title: 'Start a network scan',
    description:
      'Start scanning an IPv4 segment from this host and return immediately with a jobId. ' +
      'Targeting: pass `target` as CIDR (192.168.1.0/24), range (192.168.1.10-192.168.1.50 or 192.168.1.10-50), ' +
      'wildcard (192.168.1.*) or a single address; or pass `startIp` + `endIp` for an inclusive range. ' +
      'TCP probes run in parallel: a completed connection means the port is open, a refused connection still proves the host is alive. ' +
      'Hosts that never answer TCP but sit on the same L2 segment are recovered from the OS ARP cache and reported with via="arp". ' +
      `Limits: ${4096} addresses and 32 ports per scan, one scan at a time. ` +
      'Follow up with netscan_get_scan(jobId) until status is no longer "running", or netscan_stop_scan to abort. ' +
      'Only scan networks you are authorized to test.',
    input: z.object({
      target: z
        .string()
        .optional()
        .describe('CIDR, range, wildcard or single IPv4 address. Omit when using startIp + endIp.'),
      startIp: z.string().optional().describe('First address of an inclusive range, e.g. 192.168.0.1'),
      endIp: z.string().optional().describe('Last address of an inclusive range, e.g. 192.168.0.254'),
      ports: z
        .union([z.array(z.number().int()), z.number().int(), z.string()])
        .optional()
        .describe(
          `TCP ports to probe, max 32. Accepts an array, a single port, or a string like "80,443,8000-8010". Defaults to ${DEFAULT_PORTS.join(',')}.`,
        ),
      timeoutMs: z.number().int().min(50).max(10_000).optional().describe('Per-connection timeout (default 700)'),
      concurrency: z.number().int().min(1).max(128).optional().describe('Hosts probed in parallel (default 48)'),
      resolveNames: z.boolean().optional().describe('Reverse-DNS responsive hosts (default true)'),
    }),
    output: z.object({
      jobId: z.string(),
      status: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
      target: z.string(),
      total: z.number().int(),
      ports: z.array(z.number().int()),
      pollIntervalMs: z.number().int(),
      hint: z.string(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    longRunning: { timeoutMs: 5 * 60_000, pollIntervalMs: DEFAULT_POLL_MS },
    render: (output) =>
      `scan started (job ${output.jobId}) over ${output.target}: ${output.total} address(es), ` +
      `ports ${output.ports.join(',')}.\n${output.hint}`,
    async handler(input) {
      const busy = runningJobId()
      if (busy) {
        throw new ToolboxError('scan-running', `a scan is already running (job ${busy})`, {
          details: { jobId: busy },
          hint: 'call netscan_get_scan for its progress, or netscan_stop_scan before starting another one',
        })
      }
      const normalized = normalizeScanOptions({
        ...(input.target !== undefined ? { cidr: input.target } : {}),
        ...(input.startIp !== undefined ? { startIp: input.startIp } : {}),
        ...(input.endIp !== undefined ? { endIp: input.endIp } : {}),
        ...(input.ports !== undefined ? { ports: input.ports } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {}),
        ...(input.resolveNames !== undefined ? { resolveNames: input.resolveNames } : {}),
        maxHosts: options.maxHosts,
      })

      const snapshot = jobs.start(
        'scan',
        {
          work: (job) =>
            runScan({
              ...normalized,
              signal: job.signal,
              onProgress: (phase, scanned, total, alive) => {
                job.report(phase, total > 0 ? scanned / total : 0)
                void alive
              },
              ...(options.readArpTable ? { readArpTable: options.readArpTable } : {}),
              ...(options.probePort ? { probePort: options.probePort } : {}),
            }),
        },
        { timeoutMs: 5 * 60_000 },
      )
      currentJobId = snapshot.jobId
      return {
        jobId: snapshot.jobId,
        status: 'running' as const,
        target: normalized.target.label,
        total: normalized.target.count,
        ports: normalized.ports,
        pollIntervalMs: DEFAULT_POLL_MS,
        hint: `poll netscan_get_scan with jobId "${snapshot.jobId}" every ${DEFAULT_POLL_MS} ms until status is not "running"`,
      }
    },
  })

  const getScanCommand = defineCommand({
    name: 'netscan_get_scan',
    title: 'Get scan progress and results',
    description:
      'Read a scan job by id: status (running/succeeded/failed/cancelled), phase, progress, and the discovered hosts. ' +
      `Hosts are paged: at most ${HOST_PAGE_LIMIT} per call, use offset with nextOffset. ` +
      'Omit jobId to read the current or most recent scan of this session. ' +
      'Poll every ~1.5 s while running; results are complete once status is "succeeded".',
    input: z.object({
      jobId: z.string().optional().describe('Job id from netscan_start_scan; omit for the current scan'),
      limit: z.number().int().min(1).max(HOST_PAGE_LIMIT).optional().describe(`Hosts per page, 1-${HOST_PAGE_LIMIT} (default 50)`),
      offset: z.number().int().min(0).optional().describe('Skip this many hosts (default 0)'),
      waitMs: z
        .number()
        .int()
        .min(0)
        .max(120_000)
        .optional()
        .describe(
          `Block up to this long for the job to finish before answering (default ${DEFAULT_WAIT_MS}). ` +
            'Use 0 to return the current snapshot immediately.',
        ),
    }),
    output: z.object({
      jobId: z.string(),
      status: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
      phase: z.string(),
      progress: z.number(),
      target: z.string().nullable(),
      total: z.number().int(),
      scanned: z.number().int(),
      aliveCount: z.number().int(),
      elapsedMs: z.number().int(),
      hasMore: z.boolean(),
      nextOffset: z.number().int().nullable(),
      hosts: z.array(HostSchema),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    render: (output) => {
      const scope = output.target ?? 'the target'
      const header =
        output.status === 'running'
          ? `scanning ${scope}: ${output.scanned}/${output.total} addresses, ${output.aliveCount} host(s) responded, ${seconds(output.elapsedMs)} elapsed (phase ${output.phase})`
          : output.status === 'failed'
            ? `scan of ${scope} failed: ${output.error?.message ?? 'unknown error'}`
            : output.status === 'cancelled'
              ? `scan of ${scope} stopped after ${output.scanned}/${output.total} addresses: ${output.aliveCount} host(s) responded`
              : `scanned ${scope}: ${output.aliveCount}/${output.total} host(s) responded in ${seconds(output.elapsedMs)}`
      const table = output.hosts.length > 0 ? `\n${formatHostTable(output.hosts as HostResult[], HOST_PAGE_LIMIT)}` : ''
      const more = output.hasMore ? `\n(page ends at offset ${output.nextOffset}; pass offset=${output.nextOffset} for more)` : ''
      return `${header}${table}${more}`
    },
    async handler(input) {
      const jobId = input.jobId ?? currentJobId
      if (jobId === null || jobId === undefined) {
        throw new ToolboxError('not-found', 'no scan has been started in this session', {
          hint: 'call netscan_start_scan first',
        })
      }
      const waitMs = input.waitMs ?? DEFAULT_WAIT_MS
      if (waitMs > 0) await waitForJob(jobs, jobId, waitMs)
      return toScanOutput(jobId, input.limit ?? 50, input.offset ?? 0)
    },
  })

  const stopScanCommand = defineCommand({
    name: 'netscan_stop_scan',
    title: 'Stop the running scan',
    description:
      'Abort the running scan (or the one named by jobId) and return its partial results. ' +
      'Safe to call when nothing is running: it returns the current snapshot unchanged.',
    input: z.object({
      jobId: z.string().optional().describe('Job to stop; omit for the current scan'),
    }),
    output: z.object({
      jobId: z.string().nullable(),
      status: z.enum(['idle', 'running', 'succeeded', 'failed', 'cancelled']),
      aliveCount: z.number().int(),
      scanned: z.number().int(),
      total: z.number().int(),
      message: z.string(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    render: (output) => output.message,
    async handler(input) {
      const jobId = input.jobId ?? currentJobId
      if (jobId === null || jobId === undefined) {
        return { jobId: null, status: 'idle' as const, aliveCount: 0, scanned: 0, total: 0, message: 'no scan has been started in this session' }
      }
      const before = jobs.get(jobId)
      if (!before) {
        throw new ToolboxError('not-found', `unknown job ${JSON.stringify(jobId)}`, {
          hint: 'job ids are returned by netscan_start_scan',
        })
      }
      if (before.status !== 'running') {
        return {
          jobId,
          status: before.status,
          aliveCount: before.result ? (before.result as { hosts?: unknown[] }).hosts?.length ?? 0 : 0,
          scanned: before.result ? (before.result as { scanned?: number }).scanned ?? 0 : 0,
          total: before.result ? (before.result as { total?: number }).total ?? 0 : 0,
          message: `job ${jobId} already finished with status "${before.status}"; nothing to stop`,
        }
      }
      // 取消信号一发出，仍在飞行的 socket 会立即销毁，所以这里等一小段收敛。
      jobs.cancel(jobId)
      const settled = await waitForJob(jobs, jobId, 5_000)
      const result = settled?.result as { hosts?: unknown[]; scanned?: number; total?: number } | undefined
      return {
        jobId,
        status: settled?.status ?? 'cancelled',
        aliveCount: result?.hosts?.length ?? 0,
        scanned: result?.scanned ?? 0,
        total: result?.total ?? 0,
        message: `scan stopped after ${result?.scanned ?? 0}/${result?.total ?? 0} addresses: ${result?.hosts?.length ?? 0} host(s) responded`,
      }
    },
  })

  return {
    commands: [listInterfacesCommand, startScanCommand, getScanCommand, stopScanCommand],
    currentJobId: () => currentJobId,
  }
}

/** 轮询等任务收敛；超时返回当前快照，不抛错（调用方会用 status 判断）。 */
async function waitForJob(jobs: JobManager, jobId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  let snapshot = jobs.get(jobId)
  while (snapshot && snapshot.status === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    snapshot = jobs.get(jobId)
  }
  return snapshot
}
