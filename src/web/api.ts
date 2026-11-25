/**
 * Web API 层：命令表 → REST 端点 + 静态前端。
 *
 * 这是「同构」的第二条通道。它和 MCP 适配层平级，都调用同一份 commands：
 *
 *   GET  /api/commands          命令清单 + JSON Schema（前端据此渲染表单/说明）
 *   POST /api/commands/:name    调用一个命令，body 是命令的 input
 *   GET  /                      单页前端
 *   GET  /assets/*              前端静态资源
 *
 * 错误约定与 MCP 侧一致：{ ok: false, error: { code, message, field?, details? } }，
 * HTTP 状态码由 errors.ts 的单一映射表决定，不在各处硬编码。
 */
import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { httpStatusFor, toToolboxError } from '../core/errors.js'
import type { CommandRegistry } from '../core/registry.js'
import { isExposedOn } from '../core/registry.js'
import { callCommand } from '../mcp/adapt.js'

const MAX_BODY_BYTES = 256 * 1024

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
}

/** 把 Zod 转成 JSON Schema 交给前端；前端只用它做展示与默认值，不做重复校验。 */
function commandCatalog(registry: CommandRegistry) {
  return registry.listFor('web').map((command) => ({
    name: command.name,
    title: command.title,
    description: command.description,
    annotations: command.annotations,
    longRunning: command.longRunning ?? null,
    input: z.toJSONSchema(command.input, { io: 'input', unrepresentable: 'any' }),
  }))
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

function sendError(response: ServerResponse, error: unknown): void {
  const failure = toToolboxError(error)
  sendJson(response, httpStatusFor(failure.code), {
    ok: false,
    error: {
      code: failure.code,
      message: failure.toClientMessage(),
      ...(failure.field ? { field: failure.field } : {}),
      ...(failure.details ? { details: failure.details } : {}),
    },
  })
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      const error = toToolboxError(new Error('request body too large'))
      throw Object.assign(error, { code: 'body-too-large' })
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(toToolboxError(new Error('request body is not valid JSON')), { code: 'invalid-json' })
  }
}

export interface WebApiOptions {
  registry: CommandRegistry
  /** 前端静态文件目录。发布形态是 dist/public，开发形态回退到源码的 web/。 */
  staticDir?: string
  log?: (message: string) => void
}

/**
 * 默认静态目录：优先 dist/public（npm run build 的产物），
 * 其次仓库根的 web/（tsx 直跑源码时不存在 dist/）。
 * 注意不能用 dist/web —— 那是本文件编译后的位置，会和静态资源互相覆盖。
 */
function defaultStaticDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const built = path.join(here, '..', 'public')
  const source = path.join(here, '..', '..', 'web')
  return existsSync(path.join(built, 'index.html')) ? built : source
}

/**
 * 处理 Web 请求。返回 true 表示这个请求被 Web 层接管了。
 * 由 runtime/server.ts 在 MCP 路由之前调用，所以两者可以共用一个端口。
 */
export function createWebHandler(options: WebApiOptions) {
  const { registry } = options
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`))
  const staticRoot = options.staticDir ?? defaultStaticDir()

  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname

    // ---- API
    if (pathname === '/api/commands') {
      if (request.method !== 'GET') {
        response.setHeader('allow', 'GET')
        sendJson(response, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use GET' } })
        return true
      }
      sendJson(response, 200, { ok: true, commands: commandCatalog(registry), tools: registry.size })
      return true
    }

    if (pathname.startsWith('/api/commands/')) {
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST')
        sendJson(response, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use POST' } })
        return true
      }
      const name = decodeURIComponent(pathname.slice('/api/commands/'.length))
      const startedAt = Date.now()
      const known = registry.get(name)
      if (known && !isExposedOn(known, 'web')) {
        // 存在但不对 Web 开放：回 not-found，不告诉调用方「其实有这个命令」。
        sendJson(response, 404, {
          ok: false,
          error: { code: 'not-found', message: `unknown command ${JSON.stringify(name)}` },
        })
        return true
      }
      try {
        const body = await readJsonBody(request)
        const result = await callCommand(registry, name, body, { log })
        log(`[web] ${name} ok in ${Date.now() - startedAt} ms`)
        sendJson(response, 200, { ok: true, text: result.text, result: result.structured })
      } catch (error) {
        const failure = toToolboxError(error)
        log(`[web] ${name} failed (${failure.code}) in ${Date.now() - startedAt} ms: ${failure.message}`)
        sendError(response, error)
      }
      return true
    }

    if (pathname.startsWith('/api/')) {
      sendJson(response, 404, { ok: false, error: { code: 'not-found', message: `no such endpoint ${pathname}` } })
      return true
    }

    // ---- 静态资源
    return serveStatic(staticRoot, pathname, request.method ?? 'GET', response)
  }

  async function serveStatic(root: string, pathname: string, method: string, response: ServerResponse): Promise<boolean> {
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    // 目录穿越防护：规范化后必须仍在 root 之下。
    const resolved = path.resolve(root, relative)
    if (!resolved.startsWith(path.resolve(root) + path.sep) && resolved !== path.resolve(root)) {
      sendJson(response, 403, { ok: false, error: { code: 'unauthorized', message: 'path escapes the web root' } })
      return true
    }
    let filePath = resolved
    let fileExists = false
    try {
      const info = await stat(filePath)
      filePath = info.isDirectory() ? path.join(filePath, 'index.html') : filePath
      await stat(filePath)
      fileExists = true
    } catch {
      // 静态文件不存在时，GET/HEAD 对无扩展名路径回退到前端 SPA；其他方法直接 404。
      if ((method === 'GET' || method === 'HEAD') && path.extname(filePath) === '') {
        try {
          await stat(path.join(root, 'index.html'))
          filePath = path.join(root, 'index.html')
          fileExists = true
        } catch {
          /* 落到 404 */
        }
      }
    }

    if (!fileExists) {
      sendJson(response, 404, {
        ok: false,
        error: { code: 'not-found', message: 'frontend assets are missing; run `npm run build:web`' },
      })
      return true
    }

    if (method !== 'GET' && method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD')
      sendJson(response, 405, { ok: false, error: { code: 'method-not-allowed', message: 'use GET' } })
      return true
    }
    return streamFile(filePath, response)
  }

  function streamFile(filePath: string, response: ServerResponse): boolean {
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    })
    createReadStream(filePath).pipe(response)
    return true
  }
}
