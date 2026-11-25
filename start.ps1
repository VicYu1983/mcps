# =============================================================================
#  MCP Toolbox 啟動腳本（Windows PowerShell）
#
#  用法：
#    .\start.ps1                    # 預設埠 3777，啟動後自動開瀏覽器
#    .\start.ps1 -Port 8080         # 指定埠
#    .\start.ps1 -NoOpen            # 只啟動，不開瀏覽器
#    .\start.ps1 -Rebuild           # 啟動前重新建置
#    .\start.ps1 -Stdio             # 不開埠，給 Claude Desktop / Cursor 用
#    .\start.ps1 -Config            # 印出「隨 MCP 啟停」的設定片段
# =============================================================================
[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 3777,

  [switch]$NoOpen,
  [switch]$Rebuild,
  [switch]$Stdio,
  [switch]$Config
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Entry = Join-Path $Root 'dist\index.js'

function Write-Step($message) { Write-Host "[設定] $message" -ForegroundColor Cyan }
function Write-Build($message) { Write-Host "[建置] $message" -ForegroundColor Cyan }
function Write-Fail($message) { Write-Host "[錯誤] $message" -ForegroundColor Red }

function Stop-WithError($message) {
  Write-Fail $message
  # 互動式終端才停下來等 Enter，讓雙擊啟動的人看得到錯誤。
  # 用 try/catch 而非 IsInputRedirected：非互動主機（腳本、IDE、CI）上
  # Read-Host 會丟 InvalidOperationException，不能讓它蓋掉真正的錯誤訊息。
  try {
    Write-Host ''
    Write-Host '按 Enter 結束...' -ForegroundColor DarkGray
    [void](Read-Host)
  } catch {
    Write-Host '(非互動模式，直接結束)' -ForegroundColor DarkGray
  }
  exit 1
}

# ---- -Config：只印設定片段，不啟動、不建置 --------------------------------
if ($Config) {
  $entryPath = $Entry -replace '\\', '/'
  $snippet = @"
{
  "mcpServers": {
    "mcp-toolbox": {
      "command": "node",
      "args": [
        "$entryPath",
        "--http",
        "--open",
        "--port", "$Port"
      ]
    }
  }
}
"@

  Write-Host '把下面這段貼進 MCP 客戶端的設定檔（Claude Desktop 是 claude_desktop_config.json）：' -ForegroundColor Cyan
  Write-Host ''
  Write-Host $snippet -ForegroundColor White
  Write-Host '行為：客戶端載入這個 MCP → 啟動服務並開瀏覽器；卸載 → 服務與面板一起關閉。' -ForegroundColor DarkGray
  Write-Host '注意：這個模式不要再同時跑 start.cmd，會搶同一個埠。' -ForegroundColor DarkGray
  Write-Host ''
  Write-Host '想把設定複製到剪貼簿：' -ForegroundColor DarkGray
  Write-Host '  .\start.ps1 -Config | Set-Clipboard' -ForegroundColor DarkGray
  exit 0
}

# ---- 確認 Node --------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Stop-WithError '找不到 node。請先安裝 Node.js 18 以上版本：https://nodejs.org/ ，安裝後重開終端機。'
}

$nodeVersion = (& node --version) -replace '^v', ''
$nodeMajor = [int]($nodeVersion -split '\.')[0]
if ($nodeMajor -lt 18) {
  Stop-WithError "Node 版本過舊（$nodeVersion），本專案需要 18 以上。"
}

# ---- 確認依賴 ---------------------------------------------------------------
if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
  Write-Step '第一次啟動，正在安裝依賴（npm install）…'
  Push-Location $Root
  try {
    & npm install
    if ($LASTEXITCODE -ne 0) { throw 'npm install 失敗' }
  } catch {
    Pop-Location
    Stop-WithError '依賴安裝失敗，請看上面的 npm 輸出。'
  } finally {
    if ((Get-Location).Path -eq $Root) { Pop-Location }
  }
}

# ---- 建置 -------------------------------------------------------------------
$needsBuild = $Rebuild -or -not (Test-Path $Entry) -or -not (Test-Path (Join-Path $Root 'dist\public\index.html'))
if ($needsBuild) {
  Write-Build '正在編譯 TypeScript 並複製前端資源…'
  Push-Location $Root
  try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw '建置失敗' }
  } catch {
    Pop-Location
    Stop-WithError '建置失敗，請看上面 tsc 的錯誤訊息。'
  } finally {
    if ((Get-Location).Path -eq $Root) { Pop-Location }
  }
}

# ---- stdio 模式：只需轉交給 MCP 客戶端 ---------------------------------------
if ($Stdio) {
  Write-Host '以 stdio 模式啟動（不開埠）。這個模式通常由 MCP 客戶端拉起，' -ForegroundColor DarkGray
  Write-Host '若是手動執行，請直接關掉視窗結束。' -ForegroundColor DarkGray
  & node $Entry
  exit $LASTEXITCODE
}

# ---- 檢查埠是否被佔用 -------------------------------------------------------
$inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($inUse) {
  $owners = $inUse | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
    $proc = Get-Process -Id $_ -ErrorAction SilentlyContinue
    if ($proc) { "$($proc.ProcessName) (PID $($proc.Id))" } else { "PID $_" }
  }
  Stop-WithError "埠 $Port 已被佔用：$($owners -join ', ')。換一個埠：.\start.ps1 -Port 8080"
}

# ---- 啟動 -------------------------------------------------------------------
$Url = "http://127.0.0.1:$Port/"
Write-Host '============================================================' -ForegroundColor DarkGray
Write-Host '  MCP Toolbox' -ForegroundColor White
Write-Host "  面板：$Url" -ForegroundColor Green
Write-Host "  MCP ：http://127.0.0.1:$Port/mcp" -ForegroundColor Green
Write-Host '  按 Ctrl+C 停止服務' -ForegroundColor DarkGray
Write-Host '============================================================' -ForegroundColor DarkGray
Write-Host ''

if (-not $NoOpen) {
  # 在背景等服務真的監聽上埠再開瀏覽器，避免開到「無法連線」頁。
  Start-Job -ScriptBlock {
    param($targetPort, $targetUrl)
    for ($i = 0; $i -lt 60; $i++) {
      Start-Sleep -Milliseconds 250
      try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $client.Connect('127.0.0.1', $targetPort)
        $client.Close()
        Start-Process $targetUrl
        return
      } catch {
        if ($client) { $client.Dispose() }
      }
    }
  } -ArgumentList $Port, $Url | Out-Null
}

Push-Location $Root
try {
  & node $Entry --http-only --port $Port
  $exitCode = $LASTEXITCODE
} finally {
  Pop-Location
  Get-Job | Where-Object { $_.State -in 'Running', 'Completed' } | Remove-Job -Force -ErrorAction SilentlyContinue
}

if ($exitCode -ne 0) {
  Write-Host ''
  Stop-WithError "服務異常結束，代碼 $exitCode。"
}

Write-Host ''
Write-Host '服務已停止。' -ForegroundColor DarkGray
