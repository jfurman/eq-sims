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

const CONTRACT_VERSION = '0.2.0';

/*
 * The intent vocabulary. Each spec declares required (`req`) and optional (`opt`) fields
 * with types. Supported types: 'string', 'number', 'string[]'. Start tiny (Phase 0) and
 * grow; `say` is the easiest first test.
 *
 * goto_zone carries an OPTIONAL re-summon batch: if a teleported squad's bots don't follow
 * the #zone (the design's Phase 0d risk), the brain supplies the bot names and a post-zone
 * delay, and the executor re-spawns/summons them on arrival. The brain decides the timing
 * (resummonDelayMs); the executor just relays it.
 */
const INTENT_SPECS = {
  say:            { req: { target: 'string', text: 'string' } },
  group_invite:   { req: { member: 'string' } },
  assist_player:  { req: { squad: 'string' } },
  goto_zone:      { req: { squad: 'string', zone: 'string' },
                    opt: { resummonBots: 'string[]', resummonDelayMs: 'number' } },
  engage:         { req: { squad: 'string', target: 'string' } },
  come_to_player: { req: { squad: 'string' } },
  resummon_bots:  { req: { squad: 'string', bots: 'string[]' } },
};

const DEFAULT_RESUMMON_DELAY_MS = 15000; // ~zone load + settle before re-spawning bots

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
  say:          (target, text)  => makeIntent('say', { target, text }),
  groupInvite:  (member)        => makeIntent('group_invite', { member }),
  assistPlayer: (squad)         => makeIntent('assist_player', { squad }),
  engage:       (squad, target) => makeIntent('engage', { squad, target }),
  comeToPlayer: (squad)         => makeIntent('come_to_player', { squad }),
  resummonBots: (squad, bots)   => makeIntent('resummon_bots', { squad, bots }),
  // goto_zone with optional re-summon-on-arrival.
  gotoZone: (squad, zone, opts = {}) => makeIntent('goto_zone', {
    squad,
    zone,
    resummonBots: opts.resummonBots,
    resummonDelayMs: opts.resummonBots
      ? (opts.resummonDelayMs ?? DEFAULT_RESUMMON_DELAY_MS)
      : undefined,
  }),
};

module.exports = {
  CONTRACT_VERSION,
  DEFAULT_RESUMMON_DELAY_MS,
  INTENT_SPECS,
  makeIntent,
  validate,
  serialize,
  parse,
  build,
  nextId,
};
