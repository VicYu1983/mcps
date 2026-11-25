/**
 * 统一错误模型。
 *
 * 一个错误码只定义一次，MCP 适配层和（未来的）Web API 层各自把它映射成
 * 自己协议下的错误形态。业务代码只抛 ToolboxError，永远不直接拼 MCP 或
 * HTTP 的错误结构——否则两边的语义迟早会漂移。
 */

/** 错误码 → HTTP 状态的单一映射表；MCP 侧只用 code/message，不看状态码。 */
export const ERROR_HTTP_STATUS: Readonly<Record<string, number>> = {
  'invalid-parameter': 400,
  'invalid-target': 400,
  'too-many-hosts': 400,
  'invalid-json': 400,
  'not-found': 404,
  'scan-running': 409,
  'method-not-allowed': 405,
  'body-too-large': 413,
  'unauthorized': 401,
  'job-failed': 500,
  'internal': 500,
}

export interface ToolboxErrorInit {
  /** 出错的字段名，供表单高亮使用。 */
  field?: string
  /** 结构化细节，例如 { count, max }。 */
  details?: Record<string, unknown>
  /** 给调用方的下一步建议，会附加在错误消息后面。 */
  hint?: string
  /** 底层原因，仅用于日志，不发给客户端。 */
  cause?: unknown
}

export class ToolboxError extends Error {
  readonly code: string
  readonly field?: string
  readonly details?: Record<string, unknown>
  readonly hint?: string

  constructor(code: string, message: string, init: ToolboxErrorInit = {}) {
    super(message)
    this.name = 'ToolboxError'
    this.code = code
    if (init.field !== undefined) this.field = init.field
    if (init.details !== undefined) this.details = init.details
    if (init.hint !== undefined) this.hint = init.hint
    if (init.cause !== undefined) this.cause = init.cause
  }

  /** 面向 LLM 的完整消息：原因 + 建议。不要塞堆栈。 */
  toClientMessage(): string {
    return this.hint ? `${this.message}. ${this.hint}` : this.message
  }
}

/** 把任意抛出物归一成 ToolboxError，避免适配层各写一份 instanceof 判断。 */
export function toToolboxError(error: unknown): ToolboxError {
  if (error instanceof ToolboxError) return error
  if (error instanceof Error) {
    return new ToolboxError('internal', error.message, { cause: error })
  }
  return new ToolboxError('internal', String(error))
}

export function httpStatusFor(code: string): number {
  return ERROR_HTTP_STATUS[code] ?? 500
}
