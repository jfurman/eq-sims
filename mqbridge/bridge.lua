--[[
  mqbridge/bridge.lua — the in-game half of the bridge (runs INSIDE MacroQuest).

  This is the THIN hands. It does no deciding and knows nothing about the contract.
  It tails a queue file the executor appends to, runs each command in-game via mq.cmd,
  and appends an ack the executor reads back. One MQ instance ("the anchor") runs this;
  it reaches the other clients via the commands the executor sends (e.g. /dex <peer> ...).

  Protocol (must match executor/bridge.js):
    queue.tsv : "<id>\t<command>\n"            (executor appends, we consume)
    acks.tsv  : "<id>\t<status>\t<message>\n"  (we append, executor consumes)
    status is "OK" (command dispatched) or "ERR" (mq.cmd raised).

  Run in-game:  /lua run bridge
  Stop:         /lua stop bridge

  IMPORTANT: set BRIDGE_DIR to the SAME directory as the executor's EQ_BRIDGE_DIR.
  Forward slashes are fine on Windows. Both processes must be on the same machine.
]]--

local mq = require('mq')

local BRIDGE_DIR = 'C:/EQ/.bridge'        -- <-- must match executor EQ_BRIDGE_DIR
local QUEUE = BRIDGE_DIR .. '/queue.tsv'
local ACKS  = BRIDGE_DIR .. '/acks.tsv'
local POLL_MS = 100

-- Byte offset already consumed from the queue file.
local offset = 0

local function fileSize(path)
  local f = io.open(path, 'rb')
  if not f then return nil end
  local size = f:seek('end')
  f:close()
  return size
end

-- Start AFTER whatever is already in the queue so a reload doesn't replay old commands.
local function initOffset()
  offset = fileSize(QUEUE) or 0
end

local function appendAck(id, status, message)
  local f = io.open(ACKS, 'ab')
  if not f then
    print(string.format('[mqbridge] ERROR: cannot open acks file %s', ACKS))
    return
  end
  -- message must not contain tab/newline; sanitize defensively.
  message = (message or ''):gsub('[\t\n]', ' ')
  f:write(string.format('%s\t%s\t%s\n', id, status, message))
  f:close()
end

local function runCommand(id, command)
  print(string.format('[mqbridge] %s -> %s', id, command))
  local ok, err = pcall(function() mq.cmd(command) end)
  if ok then
    appendAck(id, 'OK', command)
  else
    appendAck(id, 'ERR', tostring(err))
  end
end

-- Read any complete new lines from the queue and dispatch them.
local function pollQueue()
  local size = fileSize(QUEUE)
  if not size or size <= offset then return end
  local f = io.open(QUEUE, 'rb')
  if not f then return end
  f:seek('set', offset)
  local chunk = f:read('a') or ''
  f:close()
  -- Find the final newline; process only complete lines, leave any partial tail.
  local pos = nil
  for i = #chunk, 1, -1 do
    if chunk:sub(i, i) == '\n' then pos = i break end
  end
  if not pos then return end               -- no complete line yet
  local complete = chunk:sub(1, pos)
  offset = offset + #complete              -- advance by bytes consumed
  for line in complete:gmatch('[^\n]+') do
    local id, command = line:match('^([^\t]*)\t(.*)$')
    if id and command then
      runCommand(id, command)
      mq.delay(1)                          -- let the command buffer breathe
    else
      print('[mqbridge] skipping malformed line: ' .. line)
    end
  end
end

print('[mqbridge] starting. dir=' .. BRIDGE_DIR)
initOffset()
print(string.format('[mqbridge] tailing %s from offset %d', QUEUE, offset))

while true do
  pollQueue()
  mq.delay(POLL_MS)
end
