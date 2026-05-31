'use strict';
/*
 * brain/group.js — Phase 1 group assembly (runs on the laptop, NO LLM).
 *
 * Sequences the contract's grouping PRIMITIVES (group_invite / make_leader / drop_bot) into the
 * two modes from the design. The executor never sees "Mode A/B" — only primitives — so the brain
 * owns the orchestration and the role logic.
 *
 * IMPORTANT (2026-05-31 finding): e3next only auto-accepts invites when inviter and invitee are in
 * the SAME ZONE. So we CO-LOCATE FIRST: bring each member into the player's zone (come_to_player),
 * wait for zone-load, THEN invite. The player's zone comes from the playerwatch state file.
 *
 *   Mode A — you + the 5 Lt clients, zero bots. Bring the Lts to your zone, the anchor invites you +
 *            the other Lts, then hands you group leadership.
 *   Mode B — you join one Lt's squad (Lt + 5 bots). Bring that Lt to your zone, it drops the bot in
 *            YOUR ROLE (role, not class), then invites you.
 *
 * Roster + shadow source from config.json. Run:
 *   node brain/group.js a [--no-move] [--zone <shortname>]
 *   node brain/group.js b <ltName> [--no-move] [--zone <shortname>]
 */

const config = require('../config');
const contract = require('../contract/intents');
const { sendIntent } = require('./emit');
const { readState } = require('./shadow');

const roster = config.roster || {};
const COLOCATE_DELAY_MS = 13000; // wait for teleported members to finish zoning before inviting

function log(...a) { console.log(new Date().toISOString(), '[group]', ...a); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function requireRoster() {
  const problems = [];
  if (!roster.player || !roster.player.name) problems.push('roster.player.name');
  if (!roster.player || !roster.player.role) problems.push('roster.player.role');
  if (!Array.isArray(roster.lieutenants) || roster.lieutenants.length === 0) problems.push('roster.lieutenants');
  if (!roster.anchor) problems.push('roster.anchor');
  if (problems.length) throw new Error(`roster incomplete in config.json — missing: ${problems.join(', ')}`);
}

/** The player's current zone: --zone override, else the playerwatch state file. */
function playerZone(flags) {
  if (flags.zone) return flags.zone;
  const s = readState();
  if (!s || !s.zone) {
    throw new Error('cannot read player zone — is playerwatch.lua running? (or pass --zone <shortname>)');
  }
  return s.zone;
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

/** Teleport members into `zone`, then wait for them to finish zoning (co-location). */
async function coLocate(members, zone) {
  log(`co-locating [${members.join(', ')}] into ${zone}, then waiting ${COLOCATE_DELAY_MS}ms for zone-load`);
  await runSequence(members.map((m) => contract.build.comeToPlayer(m, zone)));
  await sleep(COLOCATE_DELAY_MS);
}

/** Mode A: the all-client group (you + the 5 Lt clients). */
async function modeA(flags) {
  requireRoster();
  const anchor = roster.anchor;
  const lts = roster.lieutenants.map((l) => l.name);
  const player = roster.player.name;

  if (!flags['no-move']) await coLocate(lts, playerZone(flags));

  // anchor invites everyone else (the other Lts + you); then makes you leader.
  const members = [...lts.filter((n) => n !== anchor), player];
  log(`Mode A: anchor ${anchor} invites [${members.join(', ')}], then makes ${player} leader`);
  const intents = members.map((m) => contract.build.groupInvite(anchor, m));
  intents.push(contract.build.makeLeader(player, anchor));
  return runSequence(intents);
}

/**
 * Choose which bot a Lt drops to make room for the player in Mode B.
 * Rule: a Cleric (essentialClasses) must always remain in the group, so it is never dropped —
 * UNLESS the player IS that class (then the player replaces it). When the player's role-match would
 * be an essential (e.g. a Shaman/Druid healer whose only role-match is the Cleric), keep the
 * essential and drop the most-redundant non-essential bot by dropPriority.
 * Pure function (no I/O) so it's unit-testable.
 * @returns {{ bot: object|null, reason: string }}
 */
function pickDropBot(lt, player, opts = {}) {
  const bots = lt.bots || [];
  const essential = (opts.essentialClasses || ['Cleric']).map((s) => String(s).toLowerCase());
  const order = (opts.dropPriority || ['dps', 'support', 'cc', 'healer', 'tank']).map((s) => String(s).toLowerCase());
  const pClass = String(player.class || '').toLowerCase();
  const pRole = String(player.role || '').toLowerCase();
  const isEssential = (b) => essential.includes(String(b.class || '').toLowerCase());

  // Player is an essential class (e.g. a Cleric) -> they replace that same-class bot.
  if (essential.includes(pClass)) {
    const same = bots.find((b) => String(b.class || '').toLowerCase() === pClass);
    if (same) return { bot: same, reason: `player is ${player.class}; replaces the same-class bot` };
  }
  // Prefer a NON-essential bot in the player's role (fill the role, keep essentials).
  const roleMatch = bots.find((b) => !isEssential(b) && String(b.role || '').toLowerCase() === pRole);
  if (roleMatch) return { bot: roleMatch, reason: `non-essential ${roleMatch.role} bot matches your role` };
  // Role-match is essential (kept) -> drop the most-redundant non-essential by priority.
  for (const role of order) {
    const b = bots.find((x) => !isEssential(x) && String(x.role || '').toLowerCase() === role);
    if (b) return { bot: b, reason: `keeping essential (${essential.join('/')}); dropping redundant ${role}` };
  }
  const any = bots.find((b) => !isEssential(b));
  if (any) return { bot: any, reason: 'fallback: first non-essential bot' };
  return { bot: null, reason: 'no droppable (non-essential) bot found' };
}

/** Mode B: you join one Lt's squad; that Lt drops a bot (keeping a Cleric) so you fill a slot. */
async function modeB(ltName, flags) {
  requireRoster();
  const lt = roster.lieutenants.find((l) => l.name && l.name.toLowerCase() === String(ltName).toLowerCase());
  if (!lt) throw new Error(`no lieutenant "${ltName}" in roster.lieutenants`);
  const player = roster.player.name;

  if (!flags['no-move']) await coLocate([lt.name], playerZone(flags));

  const { bot: dropBot, reason } = pickDropBot(lt, roster.player, {
    essentialClasses: roster.essentialClasses,
    dropPriority: roster.dropPriority,
  });
  const intents = [];
  if (dropBot) {
    log(`Mode B: ${lt.name} drops ${dropBot.name} (${dropBot.class}/${dropBot.role}) [${reason}], then invites ${player}`);
    intents.push(contract.build.dropBot(lt.name, dropBot.name));
  } else {
    log(`Mode B: ${reason} on ${lt.name} (bots: ${(lt.bots || []).map((b) => `${b.name}:${b.class}/${b.role}`).join(', ') || 'none configured'}). Inviting without a drop — group may hit the 6-cap.`);
  }
  intents.push(contract.build.groupInvite(lt.name, player));
  return runSequence(intents);
}

/** Minimal flag parser: --flag value (or boolean --flag). */
function parseArgs(argv) {
  const flags = {}; const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(argv[i]);
  }
  return { flags, positional };
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const [mode, arg] = positional;
  try {
    let ok;
    if (mode === 'a') ok = await modeA(flags);
    else if (mode === 'b') ok = await modeB(arg, flags);
    else { console.error('usage: node brain/group.js a | b <ltName>  [--no-move] [--zone <shortname>]'); process.exit(2); }
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error('error:', e.message);
    process.exit(2);
  }
}

if (require.main === module) main();

module.exports = { modeA, modeB, pickDropBot };
