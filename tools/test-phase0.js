'use strict';
/*
 * tools/test-phase0.js — end-to-end proof of the Phase 0 pipeline WITHOUT the game.
 *
 *   brain (emit.sendIntent)  --TCP loopback-->  executor  --queue.tsv-->  mock bridge
 *                            <--result JSON---            <--acks.tsv----
 *
 * Everything but the final mq.cmd hop is exercised. The mock bridge speaks the same file
 * protocol the real Lua bridge does, so PASS here means the brain/executor/contract are
 * correct and only the in-game landing remains to verify on the box (steps 0b/0c/0d).
 *
 * Run: node tools/test-phase0.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate this run: a fresh temp bridge dir and a test port, set BEFORE requiring modules.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eqbridge-'));
process.env.EQ_BRIDGE_DIR = TMP;
process.env.EQ_EXEC_HOST = '127.0.0.1';
process.env.EQ_EXEC_PORT = '8799';

const executor = require('../executor/executor');   // starts the LAN server + ack poller
require('./mockbridge');                             // starts the queue tailer (stand-in for Lua)
const { sendIntent, buildFromArgv } = require('../brain/emit');

const OPTS = { host: '127.0.0.1', port: 8799 };
let failures = 0;

function check(name, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ' -- ' + detail : ''}`);
  }
}

async function run() {
  console.log('Phase 0 end-to-end pipeline test (no game)\n');

  // 1) say: the canonical Phase 0b command. Must produce /dex <peer> /say <text>.
  {
    const intent = buildFromArgv(['say', 'Lt1', 'hail', 'and', 'well', 'met']);
    const res = await sendIntent(intent, OPTS);
    check('say returns ok', res.ok === true, JSON.stringify(res));
    check('say verified', res.verified === true);
    check('say -> /dex Lt1 /say hail and well met',
      res.results && res.results[0] && res.results[0].cmd === '/dex Lt1 /say hail and well met',
      res.results && res.results[0] && res.results[0].cmd);
    check('say acked OK', res.results && res.results[0] && res.results[0].status === 'OK');
  }

  // 2) goto_zone: the Phase 0d teleport command.
  {
    const intent = buildFromArgv(['goto_zone', 'Lt1', 'nro']);
    const res = await sendIntent(intent, OPTS);
    check('goto_zone returns ok', res.ok === true, JSON.stringify(res));
    check('goto_zone -> /dex Lt1 /say #zone nro (server cmd via chat)',
      res.results && res.results[0] && res.results[0].cmd === '/dex Lt1 /say #zone nro',
      res.results && res.results[0] && res.results[0].cmd);
  }

  // 2b) resummon_bots: standalone re-spawn/summon/follow sequence for a squad.
  {
    const intent = buildFromArgv(['resummon_bots', 'Lt1', 'botA', 'botB']);
    const res = await sendIntent(intent, OPTS);
    const cmds = (res.results || []).map((x) => x.cmd);
    check('resummon_bots returns ok', res.ok === true, JSON.stringify(res));
    check('resummon_bots spawns each bot + summon + follow (via /say)',
      cmds.join(' | ') === '/dex Lt1 /say ^spawn botA | /dex Lt1 /say ^spawn botB | /dex Lt1 /say ^summon | /dex Lt1 /say ^follow on',
      cmds.join(' | '));
  }

  // 2c) goto_zone WITH re-summon: #zone first, then a delayed bot batch after the pause.
  {
    const intent = buildFromArgv(['goto_zone', 'Lt1', 'nro', '--resummon', 'botA,botB', '--delay', '300']);
    const t0 = Date.now();
    const res = await sendIntent(intent, OPTS);
    const elapsed = Date.now() - t0;
    const cmds = (res.results || []).map((x) => x.cmd);
    check('goto_zone+resummon returns ok', res.ok === true, JSON.stringify(res));
    check('goto_zone+resummon issues #zone then spawns then summon/follow (via /say)',
      cmds.join(' | ') === '/dex Lt1 /say #zone nro | /dex Lt1 /say ^spawn botA | /dex Lt1 /say ^spawn botB | /dex Lt1 /say ^summon | /dex Lt1 /say ^follow on',
      cmds.join(' | '));
    check('goto_zone+resummon waited for the post-zone delay', elapsed >= 300, `elapsed=${elapsed}ms`);
  }

  // 3) come_to_player: not yet executable (Phase 1) -> ok:false, no command.
  {
    const intent = buildFromArgv(['come_to_player', 'Lt1']);
    const res = await sendIntent(intent, OPTS);
    check('come_to_player reports not-yet-implemented', res.ok === false && /no command/.test(res.error || ''),
      JSON.stringify(res));
  }

  // 4) contract enforcement: a stale-version intent must be rejected by the executor.
  {
    const bad = { v: '0.0.1', id: 'x1', type: 'say', target: 'Lt1', text: 'hi' };
    const res = await sendIntent(bad, OPTS);
    check('stale contract version rejected', res.ok === false && /invalid intent/.test(res.error || ''),
      JSON.stringify(res));
  }

  // 5) unknown intent type rejected.
  {
    const bad = { v: require('../contract/intents').CONTRACT_VERSION, id: 'x2', type: 'nuke', squad: 'Lt1' };
    const res = await sendIntent(bad, OPTS);
    check('unknown intent type rejected', res.ok === false, JSON.stringify(res));
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((e) => { console.error('test crashed:', e); process.exit(1); });
