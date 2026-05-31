'use strict';
/*
 * contract/intents.js — THE SEAM between brain and executor.
 *
 * This is the ONLY coupling between the brain (laptop) and the executor (32 GB box).
 * It is DATA, not commands: ids and values that describe intent. The executor owns the
 * intent -> in-game-command mapping; the brain owns the decision to emit. Both depend
 * only on this file.
 *
 * Versioned. Change deliberately. Wire format is one JSON object per line ("\n"-delimited).
 */

const CONTRACT_VERSION = '0.3.0';

/*
 * The intent vocabulary. Each spec declares required (`req`) and optional (`opt`) fields
 * with types. Supported types: 'string', 'number', 'string[]'.
 *
 * Phase 1 adds player-grouping + come-to-me primitives. Grouping is built from small
 * primitives (group_invite / make_leader / drop_bot) that the BRAIN sequences into Mode A
 * (you + the 5 Lt clients) and Mode B (you join one Lt's squad, dropping the bot in YOUR
 * ROLE — role, not class). The executor only knows the primitives.
 */
const INTENT_SPECS = {
  say:            { req: { target: 'string', text: 'string' } },
  // Grouping primitives (member/leader auto-accept via e3next once guilded).
  group_invite:   { req: { inviter: 'string', member: 'string' } }, // inviter /invite member
  make_leader:    { req: { leader: 'string', by: 'string' } },      // `by` issues /makeleader leader
  drop_bot:       { req: { squad: 'string', bot: 'string' } },      // despawn a named bot to free a slot
  // Combat direction (e3next executes locally).
  assist_player:  { req: { squad: 'string', player: 'string' } },
  engage:         { req: { squad: 'string', target: 'string' } },
  // Travel.
  goto_zone:      { req: { squad: 'string', zone: 'string' },
                    opt: { resummonBots: 'string[]', resummonDelayMs: 'number' } },
  come_to_player: { req: { squad: 'string', zone: 'string' },
                    opt: { x: 'number', y: 'number', z: 'number', player: 'string',
                           arriveDelayMs: 'number' } },
  resummon_bots:  { req: { squad: 'string', bots: 'string[]' } },
};

const DEFAULT_RESUMMON_DELAY_MS = 15000; // ~zone load + settle before re-spawning bots
const DEFAULT_ARRIVE_DELAY_MS = 12000;   // ~zone load before teleport-to-player-coords

/** Monotonic-ish id without external deps. Unique per process run. */
let _seq = 0;
function nextId() {
  _seq += 1;
  return `i${process.pid.toString(36)}-${Date.now().toString(36)}-${_seq}`;
}

function typeOk(value, type) {
  switch (type) {
    case 'string':   return typeof value === 'string' && value !== '';
    case 'number':   return typeof value === 'number' && Number.isFinite(value);
    case 'string[]': return Array.isArray(value) && value.length > 0 &&
                            value.every((s) => typeof s === 'string' && s !== '');
    default:         return false;
  }
}

/**
 * Build a validated intent envelope ready for the wire.
 * @param {string} type one of INTENT_SPECS
 * @param {object} fields the type-specific fields (omit undefined optionals)
 * @returns {object} { v, id, type, ...fields }
 */
function makeIntent(type, fields = {}) {
  const spec = INTENT_SPECS[type];
  if (!spec) throw new Error(`unknown intent type: ${type}`);
  const intent = { v: CONTRACT_VERSION, id: nextId(), type };
  for (const [k, val] of Object.entries(fields)) {
    if (val !== undefined) intent[k] = val;
  }
  const problems = validate(intent);
  if (problems.length) throw new Error(`invalid ${type} intent: ${problems.join('; ')}`);
  return intent;
}

/**
 * Validate an intent envelope. Returns an array of problem strings (empty = valid).
 * Used by the executor on every received intent before acting.
 */
function validate(intent) {
  const problems = [];
  if (intent == null || typeof intent !== 'object') return ['not an object'];
  if (intent.v !== CONTRACT_VERSION) {
    problems.push(`contract version mismatch: got ${JSON.stringify(intent.v)}, want ${CONTRACT_VERSION}`);
  }
  if (typeof intent.id !== 'string' || !intent.id) problems.push('missing id');
  const spec = INTENT_SPECS[intent.type];
  if (!spec) {
    problems.push(`unknown type: ${JSON.stringify(intent.type)}`);
    return problems; // can't check fields without a spec
  }
  for (const [f, t] of Object.entries(spec.req || {})) {
    if (!typeOk(intent[f], t)) problems.push(`field "${f}" must be ${t}`);
  }
  for (const [f, t] of Object.entries(spec.opt || {})) {
    if (intent[f] !== undefined && !typeOk(intent[f], t)) {
      problems.push(`optional field "${f}", if present, must be ${t}`);
    }
  }
  return problems;
}

/** Serialize one intent to a single wire line (no embedded newlines). */
function serialize(intent) {
  return JSON.stringify(intent);
}

/** Parse one wire line into an intent (throws on malformed JSON). */
function parse(line) {
  return JSON.parse(line);
}

// Convenience builders — what the brain calls.
const build = {
  say:          (target, text)   => makeIntent('say', { target, text }),
  groupInvite:  (inviter, member) => makeIntent('group_invite', { inviter, member }),
  makeLeader:   (leader, by)     => makeIntent('make_leader', { leader, by }),
  dropBot:      (squad, bot)     => makeIntent('drop_bot', { squad, bot }),
  assistPlayer: (squad, player)  => makeIntent('assist_player', { squad, player }),
  engage:       (squad, target)  => makeIntent('engage', { squad, target }),
  resummonBots: (squad, bots)    => makeIntent('resummon_bots', { squad, bots }),
  gotoZone: (squad, zone, opts = {}) => makeIntent('goto_zone', {
    squad,
    zone,
    resummonBots: opts.resummonBots,
    resummonDelayMs: opts.resummonBots
      ? (opts.resummonDelayMs ?? DEFAULT_RESUMMON_DELAY_MS)
      : undefined,
  }),
  comeToPlayer: (squad, zone, opts = {}) => makeIntent('come_to_player', {
    squad,
    zone,
    x: opts.x,
    y: opts.y,
    z: opts.z,
    player: opts.player,
    arriveDelayMs: (opts.x !== undefined && opts.y !== undefined && opts.z !== undefined)
      ? (opts.arriveDelayMs ?? DEFAULT_ARRIVE_DELAY_MS)
      : undefined,
  }),
};

module.exports = {
  CONTRACT_VERSION,
  DEFAULT_RESUMMON_DELAY_MS,
  DEFAULT_ARRIVE_DELAY_MS,
  INTENT_SPECS,
  makeIntent,
  validate,
  serialize,
  parse,
  build,
  nextId,
};
