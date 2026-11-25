@echo off
rem ===========================================================================
rem  MCP Toolbox launcher (ASCII only on purpose).
rem
rem  cmd.exe reads .cmd files in the OEM code page, so Chinese text here would
rem  be garbled before chcp takes effect. All user-facing text lives in
rem  start.ps1, which handles UTF-8 properly. This file only forwards args.
rem
rem    start.cmd              default port 3777, opens the browser
rem    start.cmd 8080         custom port
rem    start.cmd -NoOpen      do not open the browser
rem    start.cmd -Rebuild     rebuild before starting
rem    start.cmd -Stdio       stdio mode for MCP clients
rem ===========================================================================
setlocal
set "ROOT=%~dp0"
set "PS1=%ROOT%start.ps1"

where powershell >nul 2>&1
if errorlevel 1 (
  echo [ERROR] PowerShell not found. Windows 10/11 ships with it; check your PATH.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set "EXIT_CODE=%errorlevel%"

rem Only pause when double-clicked (no args) or on failure, so that
rem calling it from a terminal stays non-interactive.
if not "%EXIT_CODE%"=="0" pause
if "%~1"=="" if "%EXIT_CODE%"=="0" pause

endlocal & exit /b %EXIT_CODE%
