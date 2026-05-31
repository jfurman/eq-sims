# deploy-lua.ps1 - copy our tracked MQ Lua assets into a MacroQuest lua folder.
# Our source of truth for Lua is /mqbridge (version-controlled); the MQ install is not.
# This pushes our scripts into a client's lua folder so /lua run finds them.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\deploy-lua.ps1 -LuaDir "<MQ lua dir>"
# Find the dir in-game with:  /echo ${MacroQuest.Path[lua]}
# Then in MQ:  /lua run bridge  (box anchor)   or   /lua run playerwatch  (player client)
# NOTE: keep this file ASCII-only (PowerShell 5.1 reads BOM-less files as ANSI).
param([Parameter(Mandatory=$true)][string]$LuaDir)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path $LuaDir)) {
  Write-Host "ERROR: lua dir not found: $LuaDir" -ForegroundColor Red
  Write-Host "       Run '/echo `${MacroQuest.Path[lua]}' in that client's MQ console to get it."
  exit 1
}

foreach ($f in 'bridge.lua','playerwatch.lua') {
  $src = Join-Path $repo "mqbridge\$f"
  Copy-Item $src (Join-Path $LuaDir $f) -Force
  Write-Host ("deployed {0} -> {1}" -f $f, $LuaDir) -ForegroundColor Green
}
Write-Host "Done. In MQ: /lua run bridge (box anchor) or /lua run playerwatch (player client)."
