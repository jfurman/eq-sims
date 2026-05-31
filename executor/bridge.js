'use strict';
/*
 * executor/bridge.js — the executor's half of the local bridge to MacroQuest.
 *
 * The executor and the MQ Lua bridge run on the SAME machine (the 32 GB box), so they
 * talk over two append-only line files in a shared bridge directory — no socket library
 * needed inside MQ's Lua, and atomic by virtue of being newline-delimited appends.
 *
 *   queue.tsv : executor APPENDS   "<id>\t<command>\n"            (mqbridge.lua consumes)
 *   acks.tsv  : mqbridge.lua APPENDS "<id>\t<status>\t<message>\n" (executor consumes)
 *
 * status is "OK" or "ERR". This module hides the file plumbing behind send()/poll().
 */

const fs = require('fs');
const path = require('path');

class Bridge {
  /** @param {string} dir bridge directory shared with mqbridge.lua */
  constructor(dir) {
    this.dir = dir;
    this.queuePath = path.join(dir, 'queue.tsv');
    this.acksPath = path.join(dir, 'acks.tsv');
    this._ackOffset = 0;            // byte offset already consumed from acks.tsv
    this._pending = new Map();      // id -> { resolve, reject, timer }
    fs.mkdirSync(dir, { recursive: true });
    // Touch the files so reads don't race file creation.
    fs.closeSync(fs.openSync(this.queuePath, 'a'));
    fs.closeSync(fs.openSync(this.acksPath, 'a'));
    // Start reading acks AFTER whatever is already there (don't replay history).
    this._ackOffset = fs.statSync(this.acksPath).size;
  }

  /**
   * Enqueue one raw MQ command for the bridge to run in-game, and resolve when its ack
   * arrives. The command must not contain a tab or newline (it's one TSV field).
   * @returns {Promise<{id, status, message}>}
   */
  send(id, command, timeoutMs = 8000) {
    if (/[\t\n]/.test(command)) {
      return Promise.reject(new Error('command may not contain tab or newline'));
    }
    const line = `${id}\t${command}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`bridge timeout: no ack for ${id} within ${timeoutMs}ms (is mqbridge.lua running?)`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try {
        fs.appendFileSync(this.queuePath, line);
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(e);
      }
    });
  }

  /** Read any new ack lines and settle matching pending sends. Call on an interval. */
  poll() {
    let size;
    try {
      size = fs.statSync(this.acksPath).size;
    } catch {
      return;
    }
    if (size <= this._ackOffset) return;
    const fd = fs.openSync(this.acksPath, 'r');
    try {
      const len = size - this._ackOffset;
      const buf = Buffer.allocUnsafe(len);
      const read = fs.readSync(fd, buf, 0, len, this._ackOffset);
      const text = buf.toString('utf8', 0, read);
      // Only consume up to the last complete line; leave any partial tail for next poll.
      const lastNl = text.lastIndexOf('\n');
      if (lastNl === -1) return; // no complete line yet
      const complete = text.slice(0, lastNl);
      this._ackOffset += Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8');
      for (const raw of complete.split('\n')) {
        if (!raw) continue;
        const [id, status, ...rest] = raw.split('\t');
        const message = rest.join('\t');
        const p = this._pending.get(id);
        if (p) {
          clearTimeout(p.timer);
          this._pending.delete(id);
          p.resolve({ id, status, message });
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Start the ack poller. Returns a stop() function. */
  startPolling(intervalMs = 100) {
    const h = setInterval(() => this.poll(), intervalMs);
    if (h.unref) h.unref();
    return () => clearInterval(h);
  }
}

module.exports = { Bridge };
