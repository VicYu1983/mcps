/**
 * 双传输服务器。
 *
 * 两种 transport 同时从**同一个 McpServer 实例**提供服务：
 *   - stdio：被 MCP 客户端当子进程拉起（Claude Desktop / Cursor / DSH 的 mcp-client）
 *   - streamable HTTP：浏览器、Inspecter、远程客户端
 *
 * 单实例是刻意的：命令表只有一份，工具清单不会在两处漂移。
 *
 * 安全要点（MCP 最佳实践）：
 *   - HTTP 只绑 127.0.0.1，不绑 0.0.0.0
 *   - 校验 Host 与 Origin，防 DNS rebinding
 *   - 任何日志都不写 stdout（stdio 传输会把 stdout 当协议流，写一个字符就崩）
 */
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import {
  NodeStreamableHTTPServerTransport,
  localhostHostValidation,
  localhostOriginValidation,
} from '@modelcontextprotocol/node'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { attachCommands } from '../mcp/adapt.js'
import type { CommandRegistry } from '../core/registry.js'
import { createWebHandler } from '../web/api.js'

export interface ServerInfo {
  name: string
  version: string
}

export interface HttpOptions {
  /** MCP 端点路径，默认 /mcp。 */
  path?: string
  /** 监听端口；0 表示由系统分配（测试用）。 */
  port?: number
  host?: string
  /** 是否同时提供 Web 面板与 /api/*；默认 true。 */
  web?: boolean
}

export interface StartOptions {
  registry: CommandRegistry
  serverInfo: ServerInfo
  stdio?: boolean
  http?: HttpOptions | false
  log?: (message: string) => void
  /** Web 前端静态文件目录，默认 dist/web。 */
  staticDir?: string
}

export interface RunningServer {
  /** 实际监听地址，http 关闭时为 null。 */
  url: string | null
  /** 已挂载的工具数量。 */
  toolCount: number
  close: () => Promise<void>
}

function defaultLog(message: string): void {
  process.stderr.write(`${message}\n`)
}

export async function startServer(options: StartOptions): Promise<RunningServer> {
  const log = options.log ?? defaultLog
  const server = new McpServer(options.serverInfo)
  const toolCount = attachCommands(server, options.registry, { log })

  const closers: Array<() => Promise<void>> = []
  let url: string | null = null

  if (options.http !== false && options.http !== undefined) {
    const httpOptions = options.http
    const path = httpOptions.path ?? '/mcp'
    const host = httpOptions.host ?? '127.0.0.1'

    // 有状态模式：一次 initialize 换一个 sessionId，后续请求靠它找回同一个 transport。
    const transports = new Map<string, NodeStreamableHTTPServerTransport>()
    const validateHost = localhostHostValidation()
    const validateOrigin = localhostOriginValidation()
    const webHandler =
      httpOptions.web === false
        ? null
        : createWebHandler({
            registry: options.registry,
            log,
            ...(options.staticDir ? { staticDir: options.staticDir } : {}),
          })

    const httpServer = http.createServer((request, response) => {
      void (async () => {
        // DNS rebinding 防护：先过 Host / Origin，不过就直接拒绝（守卫已写好 403 响应，
        // 带 "Invalid Host" 说明）。这两步必须在任何 MCP 处理之前。
        if (!validateHost(request, response)) return
        if (!validateOrigin(request, response)) return

        const requestPath = new URL(request.url ?? '/', `http://${host}`).pathname

        // Web 面板与 /api/* 先处理：同一个端口、同一份命令表，不额外起服务。
        if (webHandler && requestPath !== path) {
          try {
            if (await webHandler(request, response)) return
          } catch (error) {
            log(`[web] unhandled: ${error instanceof Error ? error.message : String(error)}`)
            if (!response.headersSent) {
              response.writeHead(500, { 'content-type': 'application/json' })
              response.end(JSON.stringify({ ok: false, error: { code: 'internal', message: 'request failed' } }))
            }
            return
          }
        }

        if (requestPath !== path) {
          response.writeHead(404, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'not-found', path }))
          return
        }

        const sessionId = request.headers['mcp-session-id']
        const existing = typeof sessionId === 'string' ? transports.get(sessionId) : undefined

        try {
          if (existing) {
            await existing.handleRequest(request, response)
            return
          }
          // 没有匹配的 session：只接受新的 initialize 请求，其余视为过期会话。
          const transport = new NodeStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id: string) => {
              transports.set(id, transport)
            },
          })
          transport.onclose = () => {
            const id = transport.sessionId
            if (id) transports.delete(id)
          }
          await server.connect(transport)
          await transport.handleRequest(request, response)
        } catch (error) {
          log(`[http] request failed: ${error instanceof Error ? error.message : String(error)}`)
          if (!response.headersSent) {
            response.writeHead(500, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ error: 'internal', message: 'request failed' }))
          }
        }
      })()
    })

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(httpOptions.port ?? 3777, host, () => resolve())
    })
    const address = httpServer.address() as AddressInfo
    url = `http://${host}:${address.port}${path}`
    log(`[http] listening on ${url}`)

    closers.push(async () => {
      for (const transport of transports.values()) await transport.close().catch(() => {})
      transports.clear()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    })
  }

  if (options.stdio) {
    const transport = new StdioServerTransport()
    await server.connect(transport)
    log('[stdio] connected')
  }

  return {
    url,
    toolCount,
    close: async () => {
      await server.close().catch(() => {})
      for (const close of closers) await close()
    },
  }
}
