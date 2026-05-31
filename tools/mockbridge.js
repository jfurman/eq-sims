'use strict';
/*
 * tools/mockbridge.js — a test double for mqbridge/bridge.lua (NO game, NO MacroQuest).
 *
 * It speaks the EXACT same file protocol as the real Lua bridge: tail queue.tsv by byte
 * offset, "execute" each "<id>\t<command>" line, append "<id>\tOK\t<command>" to acks.tsv.
 * Instead of calling mq.cmd, it just records/prints the command. So a green end-to-end run
 * here proves the brain -> executor -> bridge-files contract; only the final mq.cmd hop is
 * left for the real box. Keep this in lockstep with bridge.lua's protocol.
 *
 * Env: EQ_BRIDGE_DIR (default <repo>/.bridge). Optional: pass --once to poll once and exit.
 */

const fs = require('fs');
const path = require('path');

const BRIDGE_DIR = process.env.EQ_BRIDGE_DIR || path.join(__dirname, '..', '.bridge');
const QUEUE = path.join(BRIDGE_DIR, 'queue.tsv');
const ACKS = path.join(BRIDGE_DIR, 'acks.tsv');

fs.mkdirSync(BRIDGE_DIR, { recursive: true });
fs.closeSync(fs.openSync(QUEUE, 'a'));
fs.closeSync(fs.openSync(ACKS, 'a'));

// Start after existing queue content (don't replay), mirroring the Lua initOffset().
let offset = fs.statSync(QUEUE).size;
const executed = []; // record of dispatched commands (for the test to assert on)

function pollQueue() {
  const size = fs.statSync(QUEUE).size;
  if (size <= offset) return;
  const fd = fs.openSync(QUEUE, 'r');
  try {
    const len = size - offset;
    const buf = Buffer.allocUnsafe(len);
    const read = fs.readSync(fd, buf, 0, len, offset);
    const text = buf.toString('utf8', 0, read);
    const lastNl = text.lastIndexOf('\n');
    if (lastNl === -1) return; // no complete line yet
    const complete = text.slice(0, lastNl + 1);
    offset += Buffer.byteLength(complete, 'utf8');
    for (const line of complete.split('\n')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      if (tab === -1) { console.error('[mockbridge] malformed:', line); continue; }
      const id = line.slice(0, tab);
      const command = line.slice(tab + 1);
      // The real bridge would: mq.cmd(command). We just record it.
      executed.push({ id, command });
      console.log(`[mockbridge] ${id} -> ${command}`);
      fs.appendFileSync(ACKS, `${id}\tOK\t${command}\n`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

if (process.argv.includes('--once')) {
  pollQueue();
} else {
  console.log('[mockbridge] tailing', QUEUE);
  setInterval(pollQueue, 100);
}

module.exports = { pollQueue, executed, get _offset() { return offset; } };
