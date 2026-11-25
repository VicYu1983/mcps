/**
 * 长时任务管理。
 *
 * 为什么不用「一个 await 等到扫完」：
 *   MCP 客户端对 tools/call 的请求超时各不相同（Claude Desktop 60s，Cursor 更短），
 *   而扫一个 /24 只要十几秒、扫 4096 个地址就可能两分钟。同步等待必然在部分客户端超时，
 *   而且超时后任务还在后台跑，客户端却已经认为失败。
 *
 * 所以：start 类命令立即返回 jobId，客户端再用 get 类命令轮询。
 * 这个模型对 Agent、Web UI、CLI 都一致，不依赖任何客户端的进度通知能力。
 */

export type JobStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface JobSnapshot<T = unknown> {
  jobId: string
  status: JobStatus
  /** 0..1 的粗略进度，任务自己上报。 */
  progress: number
  /** 人读的阶段名，例如 scanning / arp / resolving。 */
  phase: string
  startedAt: number
  finishedAt: number | null
  elapsedMs: number
  /** 失败时的错误码与消息。 */
  error?: { code: string; message: string }
  /** 只有 succeeded / failed 后才会有值。 */
  result?: T
}

export interface JobHandle<T> {
  /** 任务体；返回值会成为 snapshot.result。 */
  work: (job: JobControl) => Promise<T>
}

export interface JobControl {
  /** 任务内部上报进度。 */
  report: (phase: string, progress: number) => void
  /** 取消信号，任务应在安全点检查。 */
  signal: AbortSignal
}

interface JobRecord<T = unknown> {
  jobId: string
  status: JobStatus
  progress: number
  phase: string
  startedAt: number
  finishedAt: number | null
  error?: { code: string; message: string }
  result?: T
  controller: AbortController
  timer?: NodeJS.Timeout
}

export interface JobManagerOptions {
  /** 已完成任务的保留时长，超时清理以免长期占用内存。 */
  retentionMs?: number
  /** 同时保留的已完成任务上限。 */
  maxFinished?: number
  /** 定时清理间隔；测试里可以传 0 关闭。 */
  sweepIntervalMs?: number
}

export class JobManager {
  readonly #jobs = new Map<string, JobRecord>()
  readonly #retentionMs: number
  readonly #maxFinished: number
  #sweepTimer: NodeJS.Timeout | undefined
  #sequence = 0

  constructor(options: JobManagerOptions = {}) {
    this.#retentionMs = options.retentionMs ?? 10 * 60_000
    this.#maxFinished = options.maxFinished ?? 100
    const sweep = options.sweepIntervalMs ?? 60_000
    if (sweep > 0) {
      this.#sweepTimer = setInterval(() => this.#sweep(), sweep)
      // 不要因为一个定时清理器让进程无法退出。
      if (typeof this.#sweepTimer.unref === 'function') this.#sweepTimer.unref()
    }
  }

  get runningCount(): number {
    let count = 0
    for (const job of this.#jobs.values()) if (job.status === 'running') count += 1
    return count
  }

  /**
   * 启动一个任务并立即返回快照。任务体在后台跑。
   * 注意：调用方拿到的是 running 状态的快照，不是最终结果。
   */
  start<T>(prefix: string, job: JobHandle<T>, options: { timeoutMs?: number } = {}): JobSnapshot<T> {
    this.#sequence += 1
    const jobId = `${prefix}-${this.#sequence}`
    const controller = new AbortController()
    const record: JobRecord<T> = {
      jobId,
      status: 'running',
      progress: 0,
      phase: 'pending',
      startedAt: Date.now(),
      finishedAt: null,
      controller,
    }
    this.#jobs.set(jobId, record as JobRecord)

    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      record.timer = setTimeout(() => {
        this.#fail(record as JobRecord, 'job-timeout', `job exceeded its ${options.timeoutMs} ms budget`)
        controller.abort()
      }, options.timeoutMs)
      if (typeof record.timer.unref === 'function') record.timer.unref()
    }

    const control: JobControl = {
      report: (phase, progress) => {
        if (record.status !== 'running') return
        record.phase = phase
        record.progress = Math.max(0, Math.min(1, progress))
      },
      signal: controller.signal,
    }

    void (async () => {
      try {
        const result = await job.work(control)
        if (record.status === 'running') {
          record.status = 'succeeded'
          record.result = result
          record.progress = 1
          record.phase = 'complete'
        }
      } catch (error) {
        if (record.status === 'running') {
          const failure = error as { code?: string; message?: string }
          this.#fail(record as JobRecord, failure.code ?? 'internal', failure.message ?? String(error))
        }
      } finally {
        record.finishedAt = Date.now()
        if (record.timer) clearTimeout(record.timer)
        this.#trim()
      }
    })()

    return this.#snapshot(record as JobRecord<T>)
  }

  get<T>(jobId: string): JobSnapshot<T> | undefined {
    const record = this.#jobs.get(jobId)
    return record ? this.#snapshot(record as JobRecord<T>) : undefined
  }

  /** 取消任务。已结束的任务保持原状态不变，返回现状。 */
  cancel(jobId: string): JobSnapshot | undefined {
    const record = this.#jobs.get(jobId)
    if (!record) return undefined
    if (record.status === 'running') {
      record.status = 'cancelled'
      record.phase = 'cancelled'
      record.finishedAt = Date.now()
      if (record.timer) clearTimeout(record.timer)
      record.controller.abort()
    }
    return this.#snapshot(record)
  }

  /** 取消全部运行中的任务，进程关闭时调用。 */
  cancelAll(): void {
    for (const record of this.#jobs.values()) {
      if (record.status === 'running') {
        record.status = 'cancelled'
        record.phase = 'cancelled'
        record.finishedAt = Date.now()
        record.controller.abort()
      }
      if (record.timer) clearTimeout(record.timer)
    }
  }

  /** 全部任务 ID，按启动顺序（旧→新）。 */
  ids(): string[] {
    return [...this.#jobs.keys()]
  }

  dispose(): void {
    this.cancelAll()
    if (this.#sweepTimer) clearInterval(this.#sweepTimer)
    this.#sweepTimer = undefined
  }

  #fail(record: JobRecord, code: string, message: string): void {
    record.status = 'failed'
    record.error = { code, message }
    record.phase = 'failed'
  }

  #snapshot<T>(record: JobRecord<T>): JobSnapshot<T> {
    const snapshot: JobSnapshot<T> = {
      jobId: record.jobId,
      status: record.status,
      progress: record.progress,
      phase: record.phase,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      elapsedMs: Math.max(0, (record.finishedAt ?? Date.now()) - record.startedAt),
    }
    if (record.error) snapshot.error = record.error
    if (record.result !== undefined) snapshot.result = record.result
    return snapshot
  }

  #trim(): void {
    const finished = [...this.#jobs.values()].filter((job) => job.status !== 'running')
    if (finished.length <= this.#maxFinished) return
    finished.sort((left, right) => (left.finishedAt ?? 0) - (right.finishedAt ?? 0))
    for (const job of finished.slice(0, finished.length - this.#maxFinished)) {
      this.#jobs.delete(job.jobId)
    }
  }

  #sweep(): void {
    const now = Date.now()
    for (const [jobId, job] of this.#jobs) {
      if (job.status === 'running') continue
      if (job.finishedAt !== null && now - job.finishedAt > this.#retentionMs) this.#jobs.delete(jobId)
    }
  }
}
