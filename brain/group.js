'use strict';
/*
 * brain/group.js — Phase 1 group assembly (runs on the laptop, NO LLM).
 *
 * Sequences the contract's grouping PRIMITIVES (group_invite / make_leader / drop_bot) into the
 * two modes from the design. The executor never sees "Mode A/B" — only primitives — so the brain
 * owns the orchestration and the role logic.
 *
 *   Mode A — you + the 5 Lt clients, zero bots. The anchor Lt invites you + the other Lts, then
 *            hands you group leadership.
 *   Mode B — you join one Lt's squad (Lt + 5 bots). That Lt drops the bot in YOUR ROLE (role, not
 *            class — a Warrior player displaces the tank bot whatever its class), then invites you.
 *
 * Roster comes from config.json `roster`. Run:
 *   node brain/group.js a              # Mode A (all-client group)
 *   node brain/group.js b <ltName>     # Mode B (join that Lt's squad)
 */

const config = require('../config');
const contract = require('../contract/intents');
const { sendIntent } = require('./emit');

const roster = config.roster || {};

function log(...a) { console.log(new Date().toISOString(), '[group]', ...a); }

function requireRoster() {
  const problems = [];
  if (!roster.player || !roster.player.name) problems.push('roster.player.name');
  if (!roster.player || !roster.player.role) problems.push('roster.player.role');
  if (!Array.isArray(roster.lieutenants) || roster.lieutenants.length === 0) problems.push('roster.lieutenants');
  if (!roster.anchor) problems.push('roster.anchor');
  if (problems.length) {
    throw new Error(`roster incomplete in config.json — missing: ${problems.join(', ')}`);
  }
}

/** Send a list of intents in order, logging each result. Returns true if all ok. */
async function runSequence(intents) {
  let allOk = true;
  for (const intent of intents) {
    try {
      const res = await sendIntent(intent);
      log(`  ${intent.type}`, JSON.stringify(intent).slice(0, 80), '->', res.ok ? 'ok' : `FAIL: ${res.error}`);
      if (!res.ok) allOk = false;
    } catch (e) {
      log(`  ${intent.type}: send failed:`, e.message);
      allOk = false;
    }
  }
  return allOk;
}

/** Mode A: the all-client group (you + the 5 Lt clients). */
async function modeA() {
  requireRoster();
  const anchor = roster.anchor;
  const lts = roster.lieutenants.map((l) => l.name);
  const player = roster.player.name;
  // anchor invites everyone else (the other Lts + you); then makes you leader.
  const members = [...lts.filter((n) => n !== anchor), player];
  log(`Mode A: anchor ${anchor} invites [${members.join(', ')}], then makes ${player} leader`);
  const intents = members.map((m) => contract.build.groupInvite(anchor, m));
  intents.push(contract.build.makeLeader(player, anchor));
  return runSequence(intents);
}

/** Mode B: you join one Lt's squad; that Lt drops the bot in your role. */
async function modeB(ltName) {
  requireRoster();
  const lt = roster.lieutenants.find((l) => l.name && l.name.toLowerCase() === String(ltName).toLowerCase());
  if (!lt) throw new Error(`no lieutenant "${ltName}" in roster.lieutenants`);
  const player = roster.player.name;
  const playerRole = roster.player.role;
  const dropBot = (lt.bots || []).find((b) => b.role && b.role.toLowerCase() === playerRole.toLowerCase());

  const intents = [];
  if (dropBot) {
    log(`Mode B: ${lt.name} drops ${dropBot.name} (role ${dropBot.role}) so ${player} (${playerRole}) fills it, then invites ${player}`);
    intents.push(contract.build.dropBot(lt.name, dropBot.name));
  } else {
    log(`Mode B: no bot with role "${playerRole}" found on ${lt.name} (bots: ${(lt.bots || []).map((b) => `${b.name}:${b.role}`).join(', ') || 'none configured'}). Inviting ${player} without a drop — group may hit the 6-cap.`);
  }
  intents.push(contract.build.groupInvite(lt.name, player));
  return runSequence(intents);
}

async function main() {
  const [mode, arg] = process.argv.slice(2);
  try {
    let ok;
    if (mode === 'a') ok = await modeA();
    else if (mode === 'b') ok = await modeB(arg);
    else { console.error('usage: node brain/group.js a | b <ltName>'); process.exit(2); }
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error('error:', e.message);
    process.exit(2);
  }
}

if (require.main === module) main();

module.exports = { modeA, modeB };
