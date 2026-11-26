/**
 * 命令定义（command table）。
 *
 * 整个架构只有这一处「定义」：工具名、参数、输出、注解、执行体。
 * MCP 适配层与 Web API 层都从这张表生成自己的暴露面，所以
 * 「Agent 能做的」和「面板能做的」不可能不一致。
 */
import type { z } from 'zod'

/**
 * 工具注解，语义对齐 MCP 规范。
 * 这里也用于 Web 侧（只读操作不加确认框、destructive 操作二次确认）。
 */
export interface CommandAnnotations {
  /** 不改变任何外部状态。 */
  readOnlyHint?: boolean
  /** 可能造成破坏性变更；客户端应在执行前确认。 */
  destructiveHint?: boolean
  /** 同样参数重复调用不产生额外副作用。 */
  idempotentHint?: boolean
  /** 会与外部世界交互（网络、硬件、第三方服务）。 */
  openWorldHint?: boolean
}

/**
 * 长时任务声明。
 *
 * 一旦声明，命令体必须**立刻返回**，不能等任务跑完：MCP 客户端的请求超时
 * 不可控（Claude Desktop 常见 60s，Cursor 更短），同步等待必然超时。
 * 声明后调用方拿到 { jobId }，再用 job 查询命令轮询。
 */
/**
 * 命令要出現在哪一個介面上。
 *
 * 預設兩邊都出現——這正是「同構」的意思：Agent 做得到的面板也做得到。
 * 少數命令刻意只給其中一邊，例如 Modbus 的唯讀鎖定開關：面板能開關，
 * Agent 只能讀狀態，否則「防誤寫」就失去意義。
 */
export interface CommandExposure {
  /** 掛到 MCP 工具清單（預設 true）。 */
  mcp?: boolean
  /** 掛到 Web API 與面板的命令目錄（預設 true）。 */
  web?: boolean
}

export interface LongRunningSpec {
  /** 单次任务的硬上限；超时后由 JobManager 标记为 failed。 */
  timeoutMs: number
  /** 建议的轮询间隔，写进返回给 LLM 的提示里。 */
  pollIntervalMs?: number
}

export interface CommandContext {
  /** 取消信号：客户端断开或显式 stop 时触发。 */
  signal: AbortSignal
  /** 请求级日志，stdio 模式下绝不能写 stdout。 */
  log: (message: string) => void
  /** 呼叫來源供稽核紀錄使用；Web 面板為 panel，MCP 工具為 tool。 */
  source?: 'panel' | 'tool'
}

export interface CommandDefinition<
  TInput extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
  TOutput extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
> {
  /** 完整工具名，格式 `{服务}_{动作}_{对象}`，例如 `netscan_start_scan`。 */
  name: string
  /** 一行标题，用于 UI 与 Inspector。 */
  title: string
  /** 给 LLM 看的功能描述：说清「做什么 / 什么时候用 / 限制」。 */
  description: string
  input: TInput
  output: TOutput
  annotations: CommandAnnotations
  /** 只掛到單一介面時使用；省略代表 MCP 與 Web 都可見。 */
  expose?: CommandExposure
  /** 声明为长时任务后，handler 必须返回 { jobId } 形态。 */
  longRunning?: LongRunningSpec
  /**
   * 把结构化输出渲染成人类可读的一段文字。
   * MCP 的 content.text 用它填，Web UI 也可以直接展示。
   */
  render: (output: z.output<TOutput>) => string
  handler: (input: z.output<TInput>, ctx: CommandContext) => Promise<z.output<TOutput>>
}

/** 声明式定义，唯一的目的是让 TS 从 Zod schema 推导出 input/output 类型。 */
export function defineCommand<
  TInput extends z.ZodObject<z.ZodRawShape>,
  TOutput extends z.ZodObject<z.ZodRawShape>,
>(definition: CommandDefinition<TInput, TOutput>): CommandDefinition<TInput, TOutput> {
  return definition
}

/** 擦除泛型后的命令类型，供注册表在运行时保存异构命令。 */
export type AnyCommand = CommandDefinition<z.ZodObject<z.ZodRawShape>, z.ZodObject<z.ZodRawShape>>
