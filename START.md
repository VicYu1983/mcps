# 啟動與部署

## 最快的方式：雙擊

到 `C:\Users\final\Documents\vic\mcps`，雙擊 **`start.cmd`**。

它會依序做這些事，任何一步失敗都會停下來把原因說清楚：

1. 檢查 Node（需要 18 以上）
2. 若 `node_modules` 不存在 → 自動跑 `npm install`
3. 若 `dist\index.js` 或 `dist\public\index.html` 不存在 → 自動建置
4. 檢查埠 3777 是否被佔用（會指出是哪個行程佔的）
5. 啟動服務，等埠真的通了才開瀏覽器

啟動後終端機會顯示：

```
============================================================
  MCP Toolbox
  面板：http://127.0.0.1:3777/
  MCP ：http://127.0.0.1:3777/mcp
  按 Ctrl+C 停止服務
============================================================
```

**關掉視窗或按 `Ctrl+C` 就停止服務。** 它不會常駐、不會開機自動啟動。

---

## 隨 MCP 生命週期啟停（掛載時開面板，卸載時關）

這是 MCP 客戶端專用的模式：**客戶端載入這個 MCP server 時，面板自動可用；客戶端卸載時，面板一起關掉。**

不用自己手寫設定——跑一次這個，它會印出可直接貼上的片段：

```bash
.\start.ps1 -Config
```

想直接複製到剪貼簿：

```bash
.\start.ps1 -Config | Set-Clipboard
```

輸出就像這樣：

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

參數說明：

| 參數 | 作用 |
|---|---|
| `--http` | 同時開 stdio（給客戶端）與 HTTP（給面板）。**不能用 `--http-only`**，那樣客戶端連不上 |
| `--open` | 啟動後用系統預設瀏覽器打開面板 |
| `--port` | HTTP 埠，預設 3777 |

行為時序：

```
客戶端載入 MCP  →  行程啟動  →  stdio 連上、HTTP 監聽  →  自動開瀏覽器
客戶端卸載 MCP  →  stdin 關閉  →  HTTP 關閉、埠釋放  →  行程結束
```

實測日誌（`--http --port 3812`，載入後卸載）：

```
[http] listening on http://127.0.0.1:3812/mcp
[stdio] connected
[mcp-toolbox] ready: 4 tools, transport=stdio+http, url=http://127.0.0.1:3812/mcp
[mcp-toolbox] stdin-closed: shutting down
```

### 幾個必須知道的細節

**1. 客戶端行為決定它何時關**

MCP 客戶端關閉子行程的方式不完全一樣。Claude Desktop 關閉時會結束子行程；某些客戶端在「停用某個 MCP server」時只關 stdio 而不殺行程 —— 這種情況下本專案會自己收尾（監聽 stdin 的 `end`/`close` 事件），不會留下佔著埠的殭屍。

反過來說：**如果你在客戶端裡只是「暫時停用」再「重新啟用」，面板會跟著關一次再開一次。** 這是預期行為，不是 bug。

**2. 埠衝突**

如果客戶端啟動時 3777 已被別的行程佔用，服務會啟動失敗。兩個應對方式：

- 換埠：`"--port", "3778"`
- 或把原本常駐的那份關掉

注意同一個客戶端裡若設定了兩份 mcp-toolbox（不同埠），兩份都會各自開面板 —— 通常不是你想要的。

**3. 不要同時用 `start.cmd`**

`start.cmd` 跑的是 `--http-only` 常駐模式。如果它已經佔著 3777，MCP 客戶端那份會起不來。選一種用就好：

- 想「開著就一直能用面板」→ 用 `start.cmd`
- 想「跟著編輯器/MCP 客戶端開關」→ 用上面這段設定，不要跑 `start.cmd`

**4. 安全性**

`--http` 仍然只綁 `127.0.0.1`，Host/Origin 校驗照舊，外部機器連不進來。但面板會在你沒預期的時候自動彈出來 —— 如果覺得干擾，去掉 `--open`，需要時自己開瀏覽器。

---

## 帶參數啟動

`start.cmd` 的參數會原樣轉給 `start.ps1`：

| 指令 | 作用 |
|---|---|
| `start.cmd` | 預設埠 3777，自動開瀏覽器 |
| `start.cmd 8080` | 改用埠 8080 |
| `start.cmd -NoOpen` | 啟動但不開瀏覽器 |
| `start.cmd -Rebuild` | 啟動前先重新建置（改過程式碼後用） |
| `start.cmd -Stdio` | stdio 模式，給 MCP 客戶端用（不開埠） |
| `start.cmd -Config` | 印出「隨 MCP 啟停」的設定片段 |
| `start.cmd -Help` | 顯示說明 |

在 PowerShell 裡也可以直接呼叫 `.\start.ps1 -Port 8080 -NoOpen`。

> 若 PowerShell 說「無法載入檔案，因為這個系統上已停用指令碼執行」，改用 `start.cmd`
> 即可 —— 它已經帶了 `-ExecutionPolicy Bypass`，不需要改系統設定。

---

## 開發時

改程式碼時不要用 `start.cmd`（它會跑建置產物），改用：

```bash
cd C:/Users/final/Documents/vic/mcps
npm run dev -- --http-only --port 3777
```

差別：

- `npm run dev` 走 `tsx src/index.ts`，直接跑 TypeScript 原始碼，改完存檔重跑就生效
- 前端（`web/assets/*.js`、`*.css`）改完**只要按瀏覽器 F5**，不用重跑任何東西
- 只有在 `dist/public` 不存在時，`api.ts` 才會回退去讀來源的 `web/`；所以開發環境第一次要先跑過一次 `npm run build:web`

---

## 給 Claude Desktop / Cursor 當工具用

這個模式**不要**自己開埠，讓客戶端用 stdio 拉起行程。

Claude Desktop 的設定檔（`%APPDATA%\Claude\claude_desktop_config.json`）加：

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

注意：

- 路徑用**正斜線** `/`，或雙反斜線 `\\`，不要用單反斜線
- 若客戶端回報找不到 `node`，把 `"command"` 換成 `node` 的絕對路徑（用 `where node` 查，通常是 `C:\Program Files\nodejs\node.exe`）
- 改完設定要**完全結束** Claude Desktop（從系統匣退出）再重開，光關視窗不算

面板與 MCP 要同時可用，就用 `--http`（不是 `--http-only`）再加 `--open`，見上面「隨 MCP 生命週期啟停」。

---

## 常見問題

**埠被佔用**

```
[錯誤] 埠 3777 已被佔用：node (PID 13768)。
```

腳本會告訴你是哪個行程。找出它：

```bash
netstat -ano | findstr :3777
```

結束它，或換一個埠（`start.cmd 8080`）。

**改了程式碼但面板沒變**

`start.cmd` 跑的是 `dist/`。改完原始碼要 `start.cmd -Rebuild`，或改用 `npm run dev`。

**面板打開是「連不上」**

代表服務沒起來。看終端機視窗的錯誤訊息，通常是埠被佔或建置失敗。

**在 MCP 客戶端裡停用再啟用，面板會關一次再開一次，正常嗎？**

正常。這是「隨生命週期啟停」的定義行為 —— 停用等於卸載，面板就跟著關。如果你希望面板一直開著，改用 `start.cmd` 常駐模式，不要在客戶端設定裡放 `--http`。

**不想要每次載入 MCP 都彈出瀏覽器**

把 `--open` 拿掉，其餘照舊。服務照樣隨載入啟動，你需要時自己開 `http://127.0.0.1:3777/`。

**想讓它關掉視窗也繼續跑**

用 `start.cmd` 起一份常駐，不要在 MCP 客戶端設定裡重複設一份（會搶埠）。若真的要背景常駐、關視窗不停，得另外裝 `pm2` 或註冊成 Windows 排程工作 —— 但這是一個會主動探測網路的工具，長期常駐建議先加上鑑權（目前 Web 層只綁 `127.0.0.1`，不接受外部連入）。

---

## 檔案說明

| 檔案 | 用途 |
|---|---|
| `start.cmd` | 雙擊入口，純 ASCII，只負責轉呼叫 PowerShell |
| `start.ps1` | 真正的啟動邏輯（檢查環境、建置、埠檢查、開瀏覽器、印 MCP 設定） |
| `scripts/copy-web.mjs` | 把 `web/` 複製到 `dist/public`，由 `npm run build` 呼叫 |

`start.cmd` 裡刻意沒有中文：`cmd.exe` 用系統 OEM 編碼讀 `.cmd` 檔，中文會在建置前就變亂碼。
所有中文提示都放在 `start.ps1`（UTF-8 with BOM，PowerShell 5.1 需要 BOM 才認得）。
