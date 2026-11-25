/** 扫描核心：地址解析、端口解析、ARP 解析、真实 TCP 探测。 */
import { z } from 'zod'
import net from 'node:net'
import { assert, run, test } from './helpers.js'
import {
  DEFAULT_PORTS,
  MAX_PORTS,
  listInterfaces,
  normalizeScanOptions,
  parseArpTable,
  parsePorts,
  parseRange,
  parseTargets,
  runScan,
} from '../src/modules/netscan/scanner.js'
import { ToolboxError } from '../src/core/errors.js'

test('parseTargets: CIDR 展开为可用地址，不含网络号与广播地址', () => {
  const target = parseTargets('192.168.1.0/24')
  assert.equal(target.count, 254)
  assert.equal(target.hosts[0], '192.168.1.1')
  assert.equal(target.hosts.at(-1), '192.168.1.254')
  assert.equal(target.label, '192.168.1.0/24')
})

test('parseTargets: /31 不扣网络号与广播地址', () => {
  const target = parseTargets('10.0.0.0/31')
  assert.deepEqual(target.hosts, ['10.0.0.0', '10.0.0.1'])
})

test('parseTargets: 起讫范围 / 简写范围 / 通配符 / 单地址', () => {
  assert.equal(parseTargets('10.0.0.10-10.0.0.12').count, 3)
  const short = parseTargets('10.0.0.10-12')
  assert.deepEqual(short.hosts, ['10.0.0.10', '10.0.0.11', '10.0.0.12'])
  assert.equal(parseTargets('10.0.0.*').count, 254)
  assert.deepEqual(parseTargets('10.0.0.7').hosts, ['10.0.0.7'])
})

test('parseTargets: 非法输入给出可行动的 code 与 field', () => {
  for (const bad of ['', '300.1.1.1', '10.0.0.0/33', '10.0.0.9-10.0.0.2', 'not-an-ip']) {
    try {
      parseTargets(bad)
      assert.fail(`expected ${JSON.stringify(bad)} to be rejected`)
    } catch (error) {
      assert.ok(error instanceof ToolboxError, `expected ToolboxError for ${JSON.stringify(bad)}`)
      assert.equal(error.code, 'invalid-target')
      assert.ok(error.field)
      assert.ok(error.message.length > 0)
    }
  }
})

test('parseTargets: 超过地址上限回 too-many-hosts 并带上 count/max', () => {
  try {
    parseTargets('10.0.0.0/16')
    assert.fail('expected rejection')
  } catch (error) {
    assert.ok(error instanceof ToolboxError)
    assert.equal(error.code, 'too-many-hosts')
    assert.equal(error.details?.max, 4096)
    assert.ok(Number(error.details?.count) > 4096)
  }
})

test('parseRange: 闭区间与反向区间', () => {
  const range = parseRange('192.168.0.1', '192.168.0.4')
  assert.deepEqual(range.hosts, ['192.168.0.1', '192.168.0.2', '192.168.0.3', '192.168.0.4'])
  assert.throws(() => parseRange('192.168.0.9', '192.168.0.1'), /after end IP/)
})

test('parsePorts: 默认值、数组、字符串与区间', () => {
  assert.deepEqual(parsePorts(undefined), [...DEFAULT_PORTS])
  assert.deepEqual(parsePorts([443, 80]), [80, 443])
  assert.deepEqual(parsePorts('80,443,8000-8002'), [80, 443, 8000, 8001, 8002])
  assert.deepEqual(parsePorts('80;443 8080'), [80, 443, 8080])
  assert.throws(() => parsePorts([0]), /1\.\.65535/)
  assert.throws(() => parsePorts('1-100'), (error: unknown) => {
    return error instanceof ToolboxError && error.code === 'invalid-parameter' && error.details?.max === MAX_PORTS
  })
})

test('parseArpTable: Windows 与 Unix 两种格式都能解析，过滤无效 MAC', () => {
  const windows = [
    '接口: 192.168.1.5 --- 0x8',
    '  Internet 地址         物理地址              类型',
    '  192.168.1.1           aa-bb-cc-dd-ee-ff     动态',
    '  192.168.1.255         ff-ff-ff-ff-ff-ff     静态',
  ].join('\r\n')
  const table = parseArpTable(windows)
  assert.equal(table.get('192.168.1.1'), 'AA:BB:CC:DD:EE:FF')
  assert.equal(table.has('192.168.1.255'), false)

  const unix = '? (192.168.1.9) at 11:22:33:44:55:66 [ether] on eth0'
  assert.equal(parseArpTable(unix).get('192.168.1.9'), '11:22:33:44:55:66')
})

test('normalizeScanOptions: 把面板表单与工具参数归一成同一份结构', () => {
  const fromRange = normalizeScanOptions({ startIp: '10.0.0.1', endIp: '10.0.0.5', ports: '22' })
  assert.equal(fromRange.target.count, 5)
  assert.deepEqual(fromRange.ports, [22])
  assert.equal(fromRange.timeoutMs, 700)
  assert.equal(fromRange.concurrency, 48)

  const fromCidr = normalizeScanOptions({ cidr: '10.0.0.0/30', resolveNames: false })
  assert.equal(fromCidr.target.count, 2)
  assert.equal(fromCidr.resolveNames, false)
})

test('listInterfaces: 返回的对象符合接口 schema', () => {
  const schema = z.object({
    name: z.string(),
    address: z.string(),
    netmask: z.string(),
    cidr: z.string().regex(/^\d+\.\d+\.\d+\.\d+\/\d+$/),
  })
  for (const entry of listInterfaces()) schema.parse(entry)
})

test('runScan: 探测本机真实监听的端口', async () => {
  // 起一个只在 127.0.0.1 上监听的服务器，扫它自己。
  const server = net.createServer((socket) => socket.end())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port

  try {
    const phases: string[] = []
    const result = await runScan({
      target: { input: '127.0.0.1', label: '127.0.0.1', hosts: ['127.0.0.1'], count: 1 },
      ports: [port],
      timeoutMs: 800,
      concurrency: 4,
      resolveNames: false,
      readArpTable: async () => new Map(),
      onProgress: (phase) => {
        phases.push(phase)
      },
    })
    assert.equal(result.total, 1)
    assert.equal(result.scanned, 1)
    assert.equal(result.stopped, false)
    const host = result.hosts.find((entry) => entry.ip === '127.0.0.1')
    assert.ok(host, 'the local listener must be discovered')
    assert.deepEqual(host.ports, [port])
    assert.equal(host.via, 'tcp')
    assert.ok(phases.includes('scanning'))
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('runScan: ARP 补上「无 TCP 响应但同 L2 段」的设备，并标记 via=arp', async () => {
  const result = await runScan({
    target: { input: '10.9.9.1-10.9.9.3', label: '10.9.9.1-10.9.9.3', hosts: ['10.9.9.1', '10.9.9.2', '10.9.9.3'], count: 3 },
    ports: [1, 2],
    timeoutMs: 50,
    concurrency: 3,
    resolveNames: false,
    probePort: async (ip, port) => ({ port, open: false, responded: ip === '10.9.9.1' && port === 1, latencyMs: 3 }),
    readArpTable: async () => new Map([['10.9.9.3', 'AA:BB:CC:DD:EE:01']]),
  })
  const byIp = new Map(result.hosts.map((host) => [host.ip, host]))
  assert.equal(byIp.get('10.9.9.1')?.via, 'tcp')
  assert.equal(byIp.get('10.9.9.3')?.via, 'arp')
  assert.equal(byIp.get('10.9.9.3')?.mac, 'AA:BB:CC:DD:EE:01')
  assert.equal(byIp.has('10.9.9.2'), false)
})

test('runScan: 中止后立刻收尾，返回部分结果并标记 stopped', async () => {
  const controller = new AbortController()
  const hosts = Array.from({ length: 50 }, (_, index) => `10.8.0.${index + 1}`)
  const promise = runScan({
    target: { input: '10.8.0.0/26', label: '10.8.0.0/26', hosts, count: hosts.length },
    ports: [80],
    timeoutMs: 5_000,
    concurrency: 2,
    resolveNames: false,
    readArpTable: async () => new Map(),
    signal: controller.signal,
    probePort: async (ip, port, _timeout, signal) => {
      // 模拟一个永远挂住的探测，只有中止才能结束它
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve()
        signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      return { port, open: false, responded: false, latencyMs: 0 }
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  controller.abort()
  const result = await promise
  assert.equal(result.stopped, true)
  assert.ok(result.scanned < hosts.length, 'an aborted scan must not finish every host')
})

void run()
