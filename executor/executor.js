'use strict';
/*
 * executor/executor.js — the THIN relay on the 32 GB box.
 *
 * Responsibilities, and nothing more (no decision logic — that lives in the brain):
 *   1. Listen on the LAN (TCP) for contract intents from the brain (one JSON per line).
 *   2. Validate each against the contract.
 *   3. Map intent -> raw MQ command(s) via the executor-owned mapping table.
 *   4. Hand the command(s) to mqbridge.lua over the local bridge files; await acks.
 *   5. Reply to the brain with a result line (also JSON).
 *
 * Run on the same machine as MacroQuest + mqbridge.lua. The brain runs elsewhere (laptop).
 *
 * Env / config:
 *   EQ_EXEC_HOST   bind address      (default 0.0.0.0  — reachable across the LAN)
 *   EQ_EXEC_PORT   listen port       (default 8777)
 *   EQ_BRIDGE_DIR  bridge file dir   (default <repo>/.bridge — must match mqbridge.lua)
 */

const net = require('net');
const contract = require('../contract/intents');
const config = require('../config');
const { Bridge } = require('./bridge');
const { mapIntent } = require('./mapping');

const HOST = config.executor.host;
const PORT = config.executor.port;
const BRIDGE_DIR = config.bridgeDir;

const bridge = new Bridge(BRIDGE_DIR);
bridge.startPolling(100);

function log(...args) {
  console.log(new Date().toISOString(), '[executor]', ...args);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Send a list of commands through the bridge in order, awaiting each ack.
 * Appends to `results`. Returns { ok, error? } — stops on the first failure.
 */
async function sendBatch(intent, commands, results) {
  for (const cmd of commands) {
    // Stable, unique bridge id per command (intent id + running index).
    const cmdId = `${intent.id}.${results.length}`;
    log(`-> bridge ${cmdId}: ${cmd}`);
    try {
      const ack = await bridge.send(cmdId, cmd);
      results.push({ cmd, ...ack });
      if (ack.status !== 'OK') return { ok: false, error: 'bridge reported error' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  return { ok: true };
}

/** Process one intent end-to-end and return a result object for the brain. */
async function handleIntent(intent) {
  const problems = contract.validate(intent);
  if (problems.length) {
    return { ok: false, id: intent && intent.id, error: 'invalid intent', problems };
  }
  const { commands, delayed, delayMs, verified, note } = mapIntent(intent);
  if (commands.length === 0) {
    return { ok: false, id: intent.id, type: intent.type, error: 'no command produced', note };
  }
  const results = [];
  let r = await sendBatch(intent, commands, results);
  if (!r.ok) return { ok: false, id: intent.id, type: intent.type, error: r.error, results, note };

  // Delayed second batch (e.g. re-summon bots after the squad finishes zoning).
  if (delayed && delayed.length) {
    const wait = Number.isFinite(delayMs) ? delayMs : contract.DEFAULT_RESUMMON_DELAY_MS;
    log(`waiting ${wait}ms before re-summon batch (${delayed.length} cmds)`);
    await sleep(wait);
    r = await sendBatch(intent, delayed, results);
    if (!r.ok) return { ok: false, id: intent.id, type: intent.type, error: r.error, results, note };
  }
  return { ok: true, id: intent.id, type: intent.type, verified, note, results };
}

const server = net.createServer((sock) => {
  const peer = `${sock.remoteAddress}:${sock.remotePort}`;
  log('brain connected:', peer);
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let intent;
      try {
        intent = contract.parse(line);
      } catch (e) {
        sock.write(JSON.stringify({ ok: false, error: 'bad JSON', detail: e.message }) + '\n');
        continue;
      }
      log('intent in:', line);
      handleIntent(intent)
        .then((res) => sock.write(JSON.stringify(res) + '\n'))
        .catch((e) => sock.write(JSON.stringify({ ok: false, error: e.message }) + '\n'));
    }
  });
  sock.on('error', (e) => log('socket error from', peer, e.message));
  sock.on('close', () => log('brain disconnected:', peer));
});

server.listen(PORT, HOST, () => {
  log(`listening on ${HOST}:${PORT}`);
  log(`bridge dir: ${BRIDGE_DIR}`);
  log(`contract v${contract.CONTRACT_VERSION}`);
});

module.exports = { handleIntent, bridge };
