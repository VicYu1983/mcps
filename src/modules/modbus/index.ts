/** modbus 模块入口：一个创建函数 + 它声明的命令 + 可共用的 service。 */
export { createModbusModule, type ModbusModule, type ModbusModuleOptions } from './commands.js'
export { ModbusService, type ConnectionSnapshot, type ReadResult, type ScanUnitsResult, type WatchResult, type WriteResult } from './service.js'
export { ModbusTcpClient, type ModbusClientOptions } from './client.js'
export {
  KINDS,
  MAX_RANGE_BITS,
  MAX_RANGE_REGISTERS,
  MAX_READ_BITS,
  MAX_READ_REGISTERS,
  REGISTER_TYPES,
  WORD_ORDERS,
  decodeRegisters,
  encodeValue,
  formatNumber,
  hex4,
  isBitKind,
  normalizeKind,
  normalizeScaling,
  normalizeType,
  normalizeWordOrder,
  typeWidth,
  type DecodedRegisters,
  type Kind,
  type RegisterRow,
  type RegisterType,
  type WordOrder,
} from './types.js'
