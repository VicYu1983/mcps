/**
 * 命令注册表。
 *
 * 所有模块把自己的命令注册进来，适配层（MCP、将来的 Web API）只读这张表。
 * 注册表刻意保持「哑」：不做校验、不做路由，只负责查找和冲突检测，
 * 这样它才能在两种传输、多个 server 实例之间安全共享。
 */
import type { AnyCommand } from './command.js'
import { ToolboxError } from './errors.js'

/** 命令對外可見的介面。 */
export type Surface = 'mcp' | 'web'


export class CommandRegistry {
  readonly #commands = new Map<string, AnyCommand>()

  /**
   * 注册一组命令。重名直接抛错——重名意味着两个模块抢同一个名字，
   * 静默覆盖会让其中一个模块的工具凭空消失，且极难排查。
   */
  register(...commands: AnyCommand[]): void {
    for (const command of commands) {
      if (this.#commands.has(command.name)) {
        throw new ToolboxError(
          'internal',
          `duplicate command name ${JSON.stringify(command.name)}`,
          { hint: 'command names must be unique across all modules; prefix them with the module name' },
        )
      }
      this.#commands.set(command.name, command)
    }
  }

  get(name: string): AnyCommand | undefined {
    return this.#commands.get(name)
  }

  /** 取一个命令，缺了就抛 not-found；适配层调用前通常已确认存在。 */
  require(name: string): AnyCommand {
    const command = this.#commands.get(name)
    if (!command) {
      throw new ToolboxError('not-found', `unknown command ${JSON.stringify(name)}`, {
        hint: 'call the list endpoint to see available command names',
      })
    }
    return command
  }

  /** 按名称排序后返回，保证 tools/list 输出稳定（便于快照测试与客户端缓存）。 */
  list(): AnyCommand[] {
    return [...this.#commands.values()].sort((left, right) => left.name.localeCompare(right.name))
  }

  /**
   * 某个介面上真正可见的命令。
   *
   * MCP 适配层与 Web API 层各自用这个过滤，而不是各自判断 expose——
   * 否则哪天新增第三个入口，过滤规则就会各写一份。
   */
  listFor(surface: Surface): AnyCommand[] {
    return this.list().filter((command) => isExposedOn(command, surface))
  }

  get size(): number {
    return this.#commands.size
  }
}

/**
 * 命令是否挂到某个介面。`expose` 省略时两边都可见。
 *
 * 导出给适配层用：Web 的 POST 入口需要知道「这个命令存不存在但不对我开放」，
 * 那种情况要回 not-found 而不是 unauthorized，才不会诱出更多探测。
 */
export function isExposedOn(command: AnyCommand, surface: Surface): boolean {
  const exposure = command.expose
  if (!exposure) return true
  return exposure[surface] !== false
}
