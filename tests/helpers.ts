/** 最小测试辅助：断言 + 汇总，无第三方测试框架。 */
import assert from 'node:assert/strict'

type TestBody = () => Promise<void> | void

interface Case {
  name: string
  body: TestBody
}

const cases: Case[] = []

export function test(name: string, body: TestBody): void {
  cases.push({ name, body })
}

/** 在文件末尾调用，跑完所有用例并按结果设置退出码。 */
export async function run(): Promise<void> {
  let failed = 0
  for (const item of cases) {
    try {
      await item.body()
      process.stdout.write(`  ok   ${item.name}\n`)
    } catch (error) {
      failed += 1
      process.stdout.write(`  FAIL ${item.name}\n`)
      process.stdout.write(`       ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    }
  }
  process.stdout.write(`\n${cases.length - failed}/${cases.length} passed\n`)
  if (failed > 0) process.exitCode = 1
}

export { assert }

/** 轮询等待某个条件成立，避免测试里写死 sleep。 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`condition not met within ${timeoutMs} ms`)
}
