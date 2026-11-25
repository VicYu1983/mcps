/**
 * 顺序跑全部测试文件。每个文件自带断言与退出码，
 * 这里只负责汇总：任何一个失败都让整个进程以 1 退出。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'

const files = readdirSync('tests')
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => `tests/${name}`)

let failed = 0
for (const file of files) {
  process.stdout.write(`\n### ${file}\n`)
  const result = spawnSync(process.execPath, ['--import', 'tsx', file], { stdio: 'inherit' })
  if (result.status !== 0) failed += 1
}

process.stdout.write(`\n${files.length - failed}/${files.length} test files passed\n`)
if (failed > 0) process.exitCode = 1
