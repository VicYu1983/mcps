/**
 * 模块装配。
 *
 * 新模块在这里加一行即可：createXxxModule() → registry.register(...)。
 * 命令名冲突会在注册时立刻抛错（registry 检测），不会静默覆盖。
 */
import type { AnyCommand } from '../core/command.js'
import type { CommandRegistry } from '../core/registry.js'
import type { JobManager } from '../runtime/jobs.js'
import { createModbusModule, type ModbusModuleOptions } from './modbus/index.js'
import { createNetscanModule, type NetscanModuleOptions } from './netscan/index.js'

export interface ModuleDeps {
  jobs: JobManager
}

export interface ModuleOverrides {
  netscan?: Omit<NetscanModuleOptions, 'jobs'>
  modbus?: ModbusModuleOptions
}

export interface LoadedModules {
  /** 供上层（例如 stop-all 或状态查询）拿到模块实例。 */
  netscan: ReturnType<typeof createNetscanModule>
  modbus: ReturnType<typeof createModbusModule>
}

export function loadModules(
  registry: CommandRegistry,
  deps: ModuleDeps,
  overrides: ModuleOverrides = {},
): LoadedModules {
  const netscan = createNetscanModule({ jobs: deps.jobs, ...overrides.netscan })
  const modbus = createModbusModule({ ...overrides.modbus })
  registry.register(...(netscan.commands as AnyCommand[]))
  registry.register(...(modbus.commands as AnyCommand[]))
  return { netscan, modbus }
}
