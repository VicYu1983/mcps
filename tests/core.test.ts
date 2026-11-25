/** 核心层：命令注册表、长时任务管理、错误模型。 */
import { z } from 'zod'
import { assert, run, test, waitFor } from './helpers.js'
import { defineCommand } from '../src/core/command.js'
import { ToolboxError, httpStatusFor, toToolboxError } from '../src/core/errors.js'
import { CommandRegistry } from '../src/core/registry.js'
import { JobManager } from '../src/runtime/jobs.js'

test('registry: 注册、按名查找、稳定排序', () => {
  const registry = new CommandRegistry()
  const make = (name: string) =>
    defineCommand({
      name,
      title: name,
      description: name,
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      annotations: { readOnlyHint: true },
      render: () => 'ok',
      handler: async () => ({ ok: true }),
    })
  registry.register(make('mod_b'), make('mod_a'))
  assert.equal(registry.size, 2)
  assert.deepEqual(
    registry.list().map((command) => command.name),
    ['mod_a', 'mod_b'],
  )
  assert.equal(registry.require('mod_a').name, 'mod_a')
})

test('registry: 重名立即抛错，绝不静默覆盖', () => {
  const registry = new CommandRegistry()
  const command = defineCommand({
    name: 'dup',
    title: 'dup',
    description: 'dup',
    input: z.object({}),
    output: z.object({}),
    annotations: {},
    render: () => '',
    handler: async () => ({}),
  })
  registry.register(command)
  assert.throws(() => registry.register(command), /duplicate command name/)
})

test('registry: 未知命令抛 not-found 并带提示', () => {
  const registry = new CommandRegistry()
  try {
    registry.require('nope')
    assert.fail('expected throw')
  } catch (error) {
    assert.ok(error instanceof ToolboxError)
    assert.equal(error.code, 'not-found')
    assert.match(error.toClientMessage(), /see available command names/)
  }
})

test('errors: 任意抛出物都能归一，且不泄露堆栈', () => {
  const wrapped = toToolboxError(new Error('boom'))
  assert.equal(wrapped.code, 'internal')
  assert.equal(wrapped.toClientMessage(), 'boom')
  assert.equal(toToolboxError('plain string').code, 'internal')
  const withHint = new ToolboxError('invalid-parameter', 'bad port', { hint: 'use 1-65535' })
  assert.equal(withHint.toClientMessage(), 'bad port. use 1-65535')
  assert.equal(httpStatusFor('invalid-parameter'), 400)
  assert.equal(httpStatusFor('scan-running'), 409)
  assert.equal(httpStatusFor('unknown-code'), 500)
})

test('jobs: 立即返回 running 快照，成功后带 result', async () => {
  const jobs = new JobManager({ sweepIntervalMs: 0 })
  const snapshot = jobs.start('t', {
    work: async (job) => {
      await Promise.resolve()
      job.report('half', 0.5)
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { value: 42 }
    },
  })
  // start() 是同步的：它必须先把 running 快照交出去，再让任务体跑起来，
  // 否则「立即返回 jobId」这个契约就不成立。
  assert.equal(snapshot.status, 'running')
  assert.equal(snapshot.progress, 0)
  await waitFor(() => jobs.get(snapshot.jobId)?.status === 'succeeded')
  assert.ok(jobs.get(snapshot.jobId)!.progress >= 0.5, 'progress reported by the job must be visible')
  const done = jobs.get<{ value: number }>(snapshot.jobId)
  assert.ok(done)
  assert.equal(done.result?.value, 42)
  assert.equal(done.progress, 1)
  jobs.dispose()
})

test('jobs: 任务抛 ToolboxError 时把 code 带进快照', async () => {
  const jobs = new JobManager({ sweepIntervalMs: 0 })
  const snapshot = jobs.start('t', {
    work: async () => {
      throw new ToolboxError('invalid-target', 'bad target')
    },
  })
  await waitFor(() => jobs.get(snapshot.jobId)?.status === 'failed')
  const failed = jobs.get(snapshot.jobId)
  assert.equal(failed?.error?.code, 'invalid-target')
  assert.equal(failed?.error?.message, 'bad target')
  jobs.dispose()
})

test('jobs: cancel 会触发 signal 并标记 cancelled', async () => {
  const jobs = new JobManager({ sweepIntervalMs: 0 })
  let aborted = false
  const snapshot = jobs.start('t', {
    work: async (job) => {
      job.signal.addEventListener('abort', () => {
        aborted = true
      })
      await new Promise((resolve) => setTimeout(resolve, 200))
      return {}
    },
  })
  const afterCancel = jobs.cancel(snapshot.jobId)
  assert.equal(afterCancel?.status, 'cancelled')
  await waitFor(() => aborted)
  await waitFor(() => jobs.get(snapshot.jobId)?.finishedAt !== null)
  jobs.dispose()
})

test('jobs: 超时由 timeoutMs 兜底', async () => {
  const jobs = new JobManager({ sweepIntervalMs: 0 })
  const snapshot = jobs.start(
    't',
    { work: async () => new Promise((resolve) => setTimeout(resolve, 500)) },
    { timeoutMs: 30 },
  )
  await waitFor(() => jobs.get(snapshot.jobId)?.status === 'failed', 2_000)
  assert.equal(jobs.get(snapshot.jobId)?.error?.code, 'job-timeout')
  jobs.dispose()
})

test('jobs: 已完成任务按 maxFinished 上限回收', async () => {
  const jobs = new JobManager({ maxFinished: 2, sweepIntervalMs: 0 })
  const ids: string[] = []
  for (let index = 0; index < 5; index += 1) {
    const snapshot = jobs.start('t', { work: async () => index })
    ids.push(snapshot.jobId)
    await waitFor(() => jobs.get(snapshot.jobId)?.status === 'succeeded')
  }
  const survivors = jobs.ids()
  assert.ok(survivors.length <= 3, `expected trimming, got ${survivors.length}`)
  assert.deepEqual(survivors.slice(-2), ids.slice(-2), '最新完成的任务必须保留')
  jobs.dispose()
})

void run()
