# start-box.ps1 - one-click startup on the 32 GB box (executor + bridge handoff).
# Double-click scripts\start-box.cmd, or run:  powershell -ExecutionPolicy Bypass -File scripts\start-box.ps1
# NOTE: keep this file ASCII-only. PowerShell 5.1 reads BOM-less files as ANSI, so non-ASCII
# characters (em-dashes, smart quotes) corrupt parsing.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

Write-Host "=== EQ Guild Agent - box startup ===" -ForegroundColor Cyan

# 1) Node present?
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "ERROR: Node.js not found on PATH. Install Node.js LTS, then re-run." -ForegroundColor Red
  return
}
Write-Host ("Node: {0}" -f (node -v))

# 2) Read config + ensure the bridge dir exists.
$cfg = Get-Content "$repo\config.json" -Raw | ConvertFrom-Json
$bridgeDir = $cfg.bridgeDir
New-Item -ItemType Directory -Force $bridgeDir | Out-Null
Write-Host ("Bridge dir: {0}" -f $bridgeDir)
Write-Host ("Executor:   {0}:{1}" -f $cfg.executor.host, $cfg.executor.port)

# 3) Guard the #1 silent failure: config.bridgeDir must equal bridge.lua's BRIDGE_DIR.
$lua = Get-Content "$repo\mqbridge\bridge.lua" -Raw
$m = [regex]::Match($lua, "local\s+BRIDGE_DIR\s*=\s*'([^']*)'")
if ($m.Success) {
  $luaDir = $m.Groups[1].Value
  $a = ($luaDir   -replace '\\','/').TrimEnd('/').ToLower()
  $b = ($bridgeDir -replace '\\','/').TrimEnd('/').ToLower()
  if ($a -ne $b) {
    Write-Host "WARNING: bridge.lua BRIDGE_DIR ('$luaDir') does not match config.json bridgeDir ('$bridgeDir')." -ForegroundColor Yellow
    Write-Host "         The bridge and executor will not talk until these match. Fix one of them." -ForegroundColor Yellow
  } else {
    Write-Host "Bridge dir matches bridge.lua. Good." -ForegroundColor Green
  }
} else {
  Write-Host "WARNING: could not find BRIDGE_DIR in mqbridge\bridge.lua to verify." -ForegroundColor Yellow
}

# 4) Hand off the bridge load command (run this once in the anchor client MQ console).
try { Set-Clipboard -Value '/lua run bridge'; $clip = ' (copied to clipboard)' } catch { $clip = '' }
Write-Host ""
Write-Host "NEXT: in your ANCHOR client MacroQuest console, run:" -ForegroundColor Cyan
Write-Host "        /lua run bridge$clip"
Write-Host "      (the anchor is the always-on client that sees all peers in /dnet, e.g. the Guild Leader)"
Write-Host ""
Write-Host "Starting executor now. Leave this window open. Ctrl+C to stop." -ForegroundColor Cyan
Write-Host "------------------------------------------------------------"

# 5) Run the executor in the foreground (keeps this window as its log).
node executor/executor.js
