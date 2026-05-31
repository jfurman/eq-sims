--[[
  mqbridge/playerwatch.lua — the player's eyes (runs INSIDE the player's MacroQuest, on the laptop).

  Read-only. It does NOT drive your character. Every tick it writes your current zone, location,
  class, and name to a small state file that the brain (also on the laptop) watches. When your zone
  changes, the brain emits a come_to_player intent so your squad shadows you.

  Run in-game:  /lua run playerwatch
  Stop:         /lua stop playerwatch

  State file (single tab-separated line, overwritten each write; matches brain/shadow.js):
    <zone>\t<x>\t<y>\t<z>\t<class>\t<name>\t<zoning>

  Set PLAYER_STATE to a path the brain reads (PLAYER_STATE_FILE / config). Forward slashes are fine.
  Keep this file ASCII-only.
]]--

local mq = require('mq')

local STATE_DIR  = 'C:/EQ/.player'
local STATE_FILE = STATE_DIR .. '/state.tsv'
local POLL_MS = 1000           -- refresh cadence; zone changes are caught within this window

-- Best-effort: ensure the directory exists (ignore failure if it already does).
os.execute('mkdir "' .. STATE_DIR:gsub('/', '\\') .. '" 2>nul')

local function field(tlo, default)
  local ok, v = pcall(tlo)
  if not ok or v == nil then return default end
  return v
end

local function writeState()
  local zone   = field(function() return mq.TLO.Zone.ShortName() end, 'unknown')
  local x      = field(function() return mq.TLO.Me.X() end, 0)
  local y      = field(function() return mq.TLO.Me.Y() end, 0)
  local z      = field(function() return mq.TLO.Me.Z() end, 0)
  local class  = field(function() return mq.TLO.Me.Class.ShortName() end, '?')
  local name   = field(function() return mq.TLO.Me.Name() end, '?')
  local zoning = field(function() return mq.TLO.Me.Zoning() end, false)
  local line = string.format('%s\t%s\t%s\t%s\t%s\t%s\t%s',
    tostring(zone), tostring(x), tostring(y), tostring(z),
    tostring(class), tostring(name), zoning and '1' or '0')
  local f = io.open(STATE_FILE, 'w')
  if f then f:write(line .. '\n'); f:close() end
end

print('[playerwatch] writing ' .. STATE_FILE .. ' every ' .. POLL_MS .. 'ms')
local lastZone = nil
while true do
  writeState()
  local z = field(function() return mq.TLO.Zone.ShortName() end, nil)
  if z and z ~= lastZone then
    print('[playerwatch] zone -> ' .. tostring(z))
    lastZone = z
  end
  mq.delay(POLL_MS)
end
