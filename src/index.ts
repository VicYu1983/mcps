/**
 * 入口。
 *
 * 用法：
 *   node dist/index.js                  # stdio（被 MCP 客户端拉起）
 *   node dist/index.js --http           # stdio + streamable HTTP
 *   node dist/index.js --http-only --port 3777
 *   node dist/index.js --http --open    # 额外用浏览器打开面板
 *
 * 为什么不默认开 HTTP：stdio 模式是被动拉起，开一个端口属于副作用，
 * 用户没要求时不该发生。
 *
 * 生命周期（--http 且被 MCP 客户端拉起时）：
 *   客户端 initialize → 进程活、面板可访问
 *   客户端断开 stdio → stdin 结束 → HTTP 随之关闭 → 进程退出
 *   即「挂载 MCP 的同时开面板，卸载 MCP 时一起关」，见 START.md「随 MCP 生命周期启停」。
 */
import { spawn } from 'node:child_process'
import { CommandRegistry } from './core/registry.js'
import { loadModules } from './modules/index.js'
import { JobManager } from './runtime/jobs.js'
import { startServer } from './runtime/server.js'

const SERVER_INFO = { name: 'mcp-toolbox', version: '0.1.0' } as const

function readFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  return argv[index + 1]
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`)
}

/**
 * 用系统默认浏览器打开 URL。
 *
 * 三个约束：
 *   1. detached + unref：浏览器进程不能成为本进程的子进程，否则 stdio 关闭后
 *      事件循环还被它牵着，进程退不出去。这是「卸载即关闭」的必要条件。
 *   2. stdio 全部 ignore：不能继承 stdout —— 那是 MCP 协议流，写一个字节就崩。
 *   3. 失败只记日志，不抛错：打不开浏览器不该让 MCP 服务起不来。
 */
function openBrowser(url: string, log: (message: string) => void): void {
  const command =
    process.platform === 'win32'
      ? { file: 'cmd', args: ['/c', 'start', '""', url] }
      : process.platform === 'darwin'
        ? { file: 'open', args: [url] }
        : { file: 'xdg-open', args: [url] }

  try {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    log(`[open] opened ${url}`)
  } catch (error) {
    log(`[open] could not launch a browser: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const httpOnly = hasFlag(argv, 'http-only')
  const withHttp = httpOnly || hasFlag(argv, 'http')
  const shouldOpen = hasFlag(argv, 'open')
  const portText = readFlag(argv, 'port')
  const port = portText === undefined ? 3777 : Number.parseInt(portText, 10)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`invalid --port ${JSON.stringify(portText)}\n`)
    process.exit(2)
  }
  if (shouldOpen && !withHttp) {
    process.stderr.write('--open requires --http or --http-only (nothing to open in stdio-only mode)\n')
    process.exit(2)
  }

  const log = (message: string) => process.stderr.write(`${message}\n`)

  const registry = new CommandRegistry()
  const jobs = new JobManager()
  const modules = loadModules(registry, { jobs })

  const running = await startServer({
    registry,
    serverInfo: SERVER_INFO,
    stdio: !httpOnly,
    http: withHttp ? { port, path: '/mcp' } : false,
    log,
  })

  log(
    `[mcp-toolbox] ready: ${running.toolCount} tools, transport=${httpOnly ? 'http' : withHttp ? 'stdio+http' : 'stdio'}` +
      (running.url ? `, url=${running.url}` : ''),
  )

  if (shouldOpen && running.url) {
    // running.url 是 http://host:port/mcp，面板在同源根路径。
    const panelUrl = new URL('/', running.url).toString()
    // 等一帧再开，让 listen 回调之后的 ready 日志先打出来。
    setImmediate(() => openBrowser(panelUrl, log))
  }

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log(`[mcp-toolbox] ${signal}: shutting down`)
    jobs.cancelAll()
    await running.close()
    jobs.dispose()
    void modules
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  // MCP 客户端卸载时会关掉子进程的 stdin。stdio transport 自己会处理 EOF，
  // 但 HTTP 监听会继续占着事件循环，进程就退不出去 —— 必须显式收尾。
  // 用 once + 延迟一个 tick：先让 transport 把剩余消息处理完，再关服务器。
  if (!httpOnly) {
    process.stdin.once('end', () => void shutdown('stdin-closed'))
    process.stdin.once('close', () => void shutdown('stdin-closed'))
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[mcp-toolbox] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exit(1)
})
