# console.ps1 - one-click guild console on the laptop (the brain command line).
# Double-click scripts\console.cmd. Type intents; they are sent to the executor over the LAN.
# NOTE: keep this file ASCII-only (PowerShell 5.1 reads BOM-less files as ANSI).
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "ERROR: Node.js not found on PATH." -ForegroundColor Red
  return
}

$cfg = Get-Content "$repo\config.json" -Raw | ConvertFrom-Json
Write-Host "=== Guild console ===" -ForegroundColor Cyan
Write-Host ("Target executor: {0}:{1}  (edit config.json brain.executorHost to point at the box)" -f $cfg.brain.executorHost, $cfg.brain.executorPort)
Write-Host "Examples:" -ForegroundColor DarkGray
Write-Host "  say Lt1 hello from the brain"
Write-Host "  goto_zone Lt1 nro"
Write-Host "  goto_zone Lt1 nro --resummon bot1,bot2,bot3,bot4,bot5 --delay 15000"
Write-Host "  resummon_bots Lt1 bot1 bot2 bot3 bot4 bot5"
Write-Host "Type 'help' for the full list, 'exit' to quit." -ForegroundColor DarkGray
Write-Host ""

while ($true) {
  $line = Read-Host 'guild'
  if (-not $line) { continue }
  $trimmed = $line.Trim()
  if ($trimmed -in @('exit','quit','q')) { break }
  if ($trimmed -eq 'help') {
    Write-Host "intents: say | goto_zone | resummon_bots | assist_player | engage | group_invite | come_to_player"
    continue
  }
  $parts = $trimmed -split '\s+' | Where-Object { $_ -ne '' }
  & node "$repo\brain\emit.js" @parts
  Write-Host ""
}
