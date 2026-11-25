# mcp-toolbox

MCP + Web 同构工具箱。**一份命令核心，同时驱动 MCP server 与 Web API**，两者永远一致。

当前实现：`netscan`（IPv4 网段扫描），4 个工具，双传输（stdio + streamable HTTP）。

## 为什么长这样

一份「命令表」定义全部能力，两条通道各自从它生成暴露面：

```
          ┌─────────────────┐        ┌──────────────┐
MCP 客户端 ─→ MCP 适配层    ─┐      │              │
          └─────────────────┘ ├──→ 命令表 + 领域模块 ──→ 硬件/网络/文件
          ┌─────────────────┐ │      │              │
浏览器    ─→ Web API 层     ─┘      └──────────────┘
          └─────────────────┘
```

好处：

- **不会漂移**：改一处，两边同时生效。
- **不用手写 JSON Schema**：Zod 直接交给 SDK 转，canonical JSON Schema、`required` 顶层数组、annotations 全部自动正确。
- **可独立使用**：不依赖任何桌面宿主，Claude Desktop / Cursor / Claude Code / Inspector 都能接。

## 目录

```
src/
├── core/
│   ├── command.ts      defineCommand()：zod schema + annotations + handler
│   ├── registry.ts     注册表（重名立即报错，稳定排序）
│   └── errors.ts       ToolboxError：一个错误码 → MCP / HTTP 两种形态
├── runtime/
│   ├── jobs.ts         JobManager：长时任务的 jobId + 轮询 + 超时 + 回收
│   └── server.ts       stdio + streamable HTTP 同时启动（单 McpServer 实例）
├── mcp/
│   └── adapt.ts        命令表 → MCP tools（含 callCommand，供非 MCP 入口复用）
├── modules/
│   ├── index.ts        模块装配：加新模块在这里加一行
│   └── netscan/
│       ├── scanner.ts  扫描核心（纯逻辑，可注入 probe/arp，零框架依赖）
│       └── commands.ts 4 个 netscan_* 工具定义
└── index.ts            入口与 CLI 参数
```

## 用法

```bash
npm install
npm run build

node dist/index.js                          # stdio（被 MCP 客户端拉起）
node dist/index.js --http                   # stdio + HTTP
node dist/index.js --http-only --port 3777  # 只开 HTTP
node dist/index.js --http --open            # stdio + HTTP，并打开浏览器面板
```

Windows 用户可直接双击 `start.cmd`，细节见 [START.md](./START.md)。

HTTP 端点固定为 `http://127.0.0.1:<port>/mcp`，只绑 `127.0.0.1`，并校验 Host / Origin 防 DNS rebinding。
Web 面板与 `/api/*` 和 MCP 共用同一端口：`/` 是面板，`/mcp` 是 MCP。

MCP 客户端配置（Claude Desktop / Cursor 等）：

```json
{
  "mcpServers": {
    "mcp-toolbox": {
      "command": "node",
      "args": ["C:/Users/final/Documents/vic/mcps/dist/index.js"]
    }
  }
}
```

想在挂载 MCP 的同时自动打开面板、卸载时自动关闭，加上 `--http --open`：

```json
{
  "mcpServers": {
    "mcp-toolbox": {
      "command": "node",
      "args": [
        "C:/Users/final/Documents/vic/mcps/dist/index.js",
        "--http",
        "--open",
        "--port", "3777"
      ]
    }
  }
}
```

生命周期由 stdio 的 `end`/`close` 事件驱动：客户端卸载 → stdin 关闭 → HTTP 关闭、端口释放、进程退出。
用 `.\start.ps1 -Config` 可以直接打印这段配置。

## 工具

| 工具 | 类型 | 说明 |
| --- | --- | --- |
| `netscan_list_interfaces` | 只读 | 本机非内部 IPv4 网段，链路本地排最后 |
| `netscan_start_scan` | 写 | 启动扫描，**立即返回 jobId** |
| `netscan_get_scan` | 只读 | 查进度/结果，分页（默认 50，上限 200） |
| `netscan_stop_scan` | 控制 | 中止并返回部分结果，幂等 |

### 为什么 start 不阻塞

MCP 客户端的 `tools/call` 超时不可控（Claude Desktop 常见 60s，Cursor 更短），而扫 4096 个地址可能超过两分钟。同步等待会在部分客户端超时，且超时后任务仍在后台跑，客户端却以为失败。改用 jobId 轮询后，任何客户端都可靠：

```jsonc
// 1
{ "name": "netscan_start_scan", "arguments": { "target": "192.168.0.0/24", "ports": "22,80,443" } }
// → { "jobId": "scan-1", "status": "running", "total": 254, "pollIntervalMs": 1500 }

// 2 每 ~1.5s 一次，直到 status 不是 running
{ "name": "netscan_get_scan", "arguments": { "jobId": "scan-1", "waitMs": 2000 } }
```

## 扫描原理

浏览器不能开 raw socket，全部探测在主进程完成：

1. 对每个目标的每个端口发起 TCP 连接。连接成功 = 端口开放；收到 `ECONNREFUSED` = 主机有回应但端口关闭。两者都算「存活」，所以没有开放端口的设备也能被发现。
2. 扫描后读 OS 的 ARP 表（Windows `arp -a`，其他 `arp -an`）。同一 L2 段上防火墙静默丢包的设备会留下 ARP 项，这些以 `via: "arp"` 加入结果。
3. 对存活主机做有超时上限的反向 DNS。

限制：单次最多 4096 个地址、32 个端口；同时只允许一个扫描（第二次启动回 `scan-running`）。

## 测试

```bash
npm run typecheck   # tsc --noEmit（src + tests）
npm test            # 35 个用例，4 个文件
```

| 文件 | 覆盖 |
| --- | --- |
| `tests/scanner.test.ts` | 地址/端口/ARP 解析、真实 TCP 探测、ARP 补漏、中止 |
| `tests/core.test.ts` | 注册表、错误模型、JobManager（成功/失败/取消/超时/回收） |
| `tests/mcp.test.ts` | InMemoryTransport 走真实 JSON-RPC：tools/list、schema、isError、轮询流程、并发限制 |
| `tests/transport.test.ts` | 真实 HTTP 端点、404、DNS rebinding（需裸 http 才能伪造 Host）、真实 stdio 子进程 |

## 加一个模块

1. 建 `src/modules/<name>/`：`scanner.ts`（或等价的核心逻辑，不碰传输）+ `commands.ts`。
2. 在 `commands.ts` 里用 `defineCommand()` 声明工具，名字一律 `<name>_<动作>_<对象>`，**必须带前缀**（所有模块共用一个命名空间）。
3. 在 `src/modules/index.ts` 里 `createXxxModule()` → `registry.register(...)`。
4. 写测试。MCP 与 HTTP 两侧不用改任何代码。

**工具粒度原则**：每个模块 3~6 个工具。Agent 需要的是「能力」，不是「API 全集」——增删改这类 UI 操作不必暴露给 Agent，摊平几十个工具会直接拉低选择准确率。

## 未做的部分

- **Web 前端**：`src/mcp/adapt.ts` 的 `callCommand()` 已经把非 MCP 入口的路打通（Web API 层直接调它即可），但 UI 与 HTTP 路由尚未实现。
- **鉴权**：本地单用户场景不需要；若要远程部署，必须在 HTTP 层加 OAuth 2.1 或 token 校验。
- **其他模块**：modbus / serial-485 / 案场检查器等可按同一模式迁移。
