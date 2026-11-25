/**
 * 把 web/ 原样复制到 dist/public。
 *
 * 前端刻意没有构建步骤：浏览器直接跑 ES module，改完刷新即可。
 * 所以这里只需要复制，不需要打包器。
 *
 * 为什么目标目录叫 public 而不是 web：src/web/api.ts 编译后是 dist/web/api.js，
 * 静态资源若也放进 dist/web 会互相覆盖。源码目录 web/ 与产物目录 dist/public 分开。
 */
import { cp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'web')
const target = path.join(root, 'dist', 'public')

await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await cp(source, target, { recursive: true })

console.log(`copied ${path.relative(root, source)} -> ${path.relative(root, target)}`)
