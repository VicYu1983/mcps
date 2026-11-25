/** netscan 模块入口。模块只导出「一个创建函数 + 它声明的命令」，不含任何传输层知识。 */
export { createNetscanModule, type NetscanModule, type NetscanModuleOptions } from './commands.js'
export {
  DEFAULT_PORTS,
  DEFAULT_TIMEOUT_MS,
  MAX_HOSTS,
  MAX_PORTS,
  listInterfaces,
  parseArpTable,
  parsePorts,
  parseRange,
  parseTargets,
  runScan,
  type HostResult,
  type NetworkInterfaceInfo,
  type ScanRunResult,
} from './scanner.js'
