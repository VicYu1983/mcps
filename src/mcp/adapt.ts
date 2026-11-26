/**
 * MCP 适配层：命令表 → MCP tools。
 *
 * 这一层只做三件事：
 *   1. 把 Zod schema 原样交给 SDK（SDK 自己转 JSON Schema，比手写 canonical schema 可靠）
 *   2. 把调用转发给命令 handler
 *   3. 把 ToolboxError 翻译成 isError 结果（不抛协议级错误，LLM 才能读懂并重试）
 *
 * 这里没有任何业务逻辑。改业务只改 modules/，改协议只改这个文件。
 */
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { AnyCommand, CommandContext } from '../core/command.js'
import { toToolboxError } from '../core/errors.js'
import type { CommandRegistry } from '../core/registry.js'

export interface McpAdapterOptions {
  /** 注入给每个命令的日志函数。stdio 模式下必须写到 stderr。 */
  log?: (message: string) => void
  /** 让测试或调用方在命令体里读到请求级信息（如客户端名）。 */
  context?: Partial<Omit<CommandContext, 'signal' | 'log'>>
}

/** 错误结果：MCP 规范要求用 isError 表达，而不是抛 JSON-RPC error。 */
function errorResult(error: unknown, name: string) {
  const failure = toToolboxError(error)
  const payload: Record<string, unknown> = { ok: false, code: failure.code, message: failure.toClientMessage() }
  if (failure.field) payload.field = failure.field
  if (failure.details) payload.details = failure.details
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `[${failure.code}] ${failure.toClientMessage()}` }],
    structuredContent: payload,
  }
}

/**
 * 把注册表里的全部命令挂到 McpServer 上。
 * 返回挂载数量，便于启动日志与测试断言。
 */
export function attachCommands(
  server: McpServer,
  registry: CommandRegistry,
  options: McpAdapterOptions = {},
): number {
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`))
  const commands = registry.listFor('mcp')

  for (const command of commands) {
    const { name, title, description, input, output, annotations, render, handler } = command

    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: input,
        outputSchema: output,
        annotations: {
          ...(annotations.readOnlyHint !== undefined ? { readOnlyHint: annotations.readOnlyHint } : {}),
          ...(annotations.destructiveHint !== undefined ? { destructiveHint: annotations.destructiveHint } : {}),
          ...(annotations.idempotentHint !== undefined ? { idempotentHint: annotations.idempotentHint } : {}),
          ...(annotations.openWorldHint !== undefined ? { openWorldHint: annotations.openWorldHint } : {}),
        },
      },
      async (args: Record<string, unknown>) => {
        const controller = new AbortController()
        try {
          // 二次校验：SDK 已经校验过一次，但 handler 可能被其他适配层直接调用，
          // 这里保证「任何入口进来的参数都经过同一份 schema」。
          const parsed = input.parse(args ?? {}) as z.output<typeof input>
          const result = (await handler(parsed, {
            signal: controller.signal,
            log: (message: string) => log(`[${name}] ${message}`),
            source: 'tool',
            ...options.context,
          })) as z.output<typeof output>
          return {
            content: [{ type: 'text' as const, text: render(result) }],
            structuredContent: result as Record<string, unknown>,
          }
        } catch (error) {
          log(`[${name}] failed: ${error instanceof Error ? error.message : String(error)}`)
          return errorResult(error, name)
        }
      },
    )
  }

  return commands.length
}

/**
 * 供非 MCP 入口（Web API、CLI、测试）复用同一份 handler。
 *
 * 注意：这里刻意不经过 MCP 传输，直接跑 command.handler——
 * 所以 Web 面板与 Agent 走的是同一段业务代码，而不是「另一个实现」。
 */
export async function callCommand(
  registry: CommandRegistry,
  name: string,
  rawInput: unknown,
  options: { signal?: AbortSignal; log?: (message: string) => void; command?: AnyCommand; source?: 'panel' | 'tool' } = {},
): Promise<{ text: string; structured: Record<string, unknown> }> {
  const command: AnyCommand = options.command ?? registry.require(name)
  const parsed = command.input.parse(rawInput ?? {})
  const output = await command.handler(parsed, {
    signal: options.signal ?? new AbortController().signal,
    log: options.log ?? (() => {}),
    source: options.source,
  })
  return { text: command.render(output), structured: output as Record<string, unknown> }
}
