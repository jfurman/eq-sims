'use strict';
/*
 * brain/shadow.js — the shadow loop (runs on the laptop, NO LLM).
 *
 * Watches the player-state file written by mqbridge/playerwatch.lua and, when you change zones,
 * emits a come_to_player intent so the configured shadow squad(s) teleport into your zone. This is
 * the Phase 1 "eyes -> intent" loop: a real in-game event (you zoning) drives an automatic intent.
 * Low-frequency and event-driven; nothing per-tick crosses to the executor beyond a zone change.
 *
 * Config (config.json):
 *   playerStateFile   path written by playerwatch.lua (default C:/EQ/.player/state.tsv)
 *   shadow.squads     array of client names that follow you between zones
 *   shadow.sendCoords if true, also pass your x/y/z so the squad #goto's to you on arrival
 *
 * Run:  node brain/shadow.js        (Ctrl+C to stop)
 */

const fs = require('fs');
const contract = require('../contract/intents');
const config = require('../config');
const { sendIntent } = require('./emit');

const STATE_FILE = config.playerStateFile;
const SQUADS = (config.shadow && config.shadow.squads) || [];
const SEND_COORDS = !!(config.shadow && config.shadow.sendCoords);
const POLL_MS = 1000;

function log(...a) { console.log(new Date().toISOString(), '[shadow]', ...a); }

/** Parse playerwatch.lua's single TSV line. Returns null if not readable yet. */
function readState() {
  let text;
  try { text = fs.readFileSync(STATE_FILE, 'utf8'); } catch { return null; }
  const line = text.split('\n')[0];
  if (!line) return null;
  const [zone, x, y, z, klass, name, zoning] = line.split('\t');
  if (!zone) return null;
  return {
    zone,
    x: parseFloat(x), y: parseFloat(y), z: parseFloat(z),
    class: klass, name,
    zoning: zoning === '1',
  };
}

async function onZoneChange(state) {
  log(`player ${state.name} entered ${state.zone} -> shadowing with [${SQUADS.join(', ')}]`);
  for (const squad of SQUADS) {
    const opts = { player: state.name };
    if (SEND_COORDS) { opts.x = state.x; opts.y = state.y; opts.z = state.z; }
    const intent = contract.build.comeToPlayer(squad, state.zone, opts);
    try {
      const res = await sendIntent(intent);
      log(`  ${squad}:`, res.ok ? 'ok' : `FAILED: ${res.error || JSON.stringify(res)}`);
    } catch (e) {
      log(`  ${squad}: send failed:`, e.message);
    }
  }
}

function main() {
  if (SQUADS.length === 0) {
    log('no shadow.squads configured in config.json — nothing to do. Set shadow.squads and restart.');
  }
  log(`watching ${STATE_FILE}; shadow squads: [${SQUADS.join(', ')}]; sendCoords=${SEND_COORDS}`);

  let lastZone = null;
  let primed = false; // skip the very first reading so we don't teleport on startup

  setInterval(async () => {
    const s = readState();
    if (!s || s.zoning) return;            // not ready, or mid-zone — wait
    if (!primed) { lastZone = s.zone; primed = true; log(`primed at zone ${s.zone}`); return; }
    if (s.zone !== lastZone) {
      lastZone = s.zone;
      if (SQUADS.length) await onZoneChange(s);
    }
  }, POLL_MS);
}

if (require.main === module) main();

module.exports = { readState };
