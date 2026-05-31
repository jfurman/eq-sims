'use strict';
/*
 * executor/mapping.js — the intent -> in-game-command mapping table.
 *
 * Per the build brief, the EXECUTOR owns this table; the brain never sees commands.
 * Each mapping turns one validated contract intent into raw MQ command strings to hand to
 * mqbridge.lua. Commands target a specific client by name through a configurable relay
 * (config.json `relay`, default e3next's `/e3bct {peer} {cmd}`), which runs the command
 * LOCALLY on the target client — the bridge itself runs in one "anchor" MQ instance.
 *
 * A mapping may return a SECOND, DELAYED batch (`delayed` + `delayMs`): commands the
 * executor fires after a pause. Used for re-summon-on-arrival — bots are re-spawned a few
 * seconds after the #zone, once the squad has finished loading the new zone.
 *
 * `verified` marks which mappings are proven vs. scaffolded defaults that need tuning to
 * your e3next/DanNet/server bot setup. Keep this honest.
 */

const config = require('../config');

// Relay one command to run LOCALLY on a named client. Template from config.json `relay`
// (default `/e3bct {peer} {cmd}` = e3next targeted broadcast).
//
// Why not DanNet `/dex`: it executes the command on the peer through a path that does NOT
// trigger the client's `#`/`^` chat-command routing, so relayed server commands are sent as
// literal say and never parsed. Confirmed in Phase 0d: `/dex Cynric /say #zone X` -> literal
// say; but `/docommand /say #zone X` run locally -> teleports. e3next's bus runs the command
// locally on the target (the path that works), so we relay through it.
const relay = (peer, cmd) => config.relay.replace('{peer}', peer).replace('{cmd}', cmd);

// EQEmu parses server commands (`#...` GM, `^...` bot) from the chat-command path. MacroQuest's
// parser drops a bare `#`/`^`, so wrap them in /say (same as typing them in the chat box). The
// relay then makes that /say run locally on the peer where the `#`/`^` routing fires.
const relayGameCmd = (peer, gameCmd) => relay(peer, `/say ${gameCmd}`);

// EQEmu bot commands. Modern builds (akk-stack) use the `^` alias prefix. If your server
// uses the older `#bot ...` form, change these three and nothing else.
const BOT = {
  spawn:  (name) => `^spawn ${name}`,   // spawn one of your persisted bots
  summon: ()     => '^summon',          // pull your spawned bots to you (gather on arrival)
  follow: ()     => '^follow on',       // make your bots follow you
};

/** Build the re-summon command sequence for a squad's bots, relayed to run locally. */
function resummonCommands(squad, bots) {
  // `^` bot commands are server-parsed from chat, same as `#` — must go through /say.
  return [
    ...bots.map((b) => relayGameCmd(squad, BOT.spawn(b))),
    relayGameCmd(squad, BOT.summon()),
    relayGameCmd(squad, BOT.follow()),
  ];
}

/**
 * @param {object} intent a validated contract intent
 * @returns {{ commands: string[], delayed?: string[], delayMs?: number, verified: boolean, note?: string }}
 */
function mapIntent(intent) {
  switch (intent.type) {
    case 'say':
      // Phase 0b primary test: make a named client /say text. text is the rest of the line.
      return { commands: [relay(intent.target, `/say ${intent.text}`)], verified: true };

    case 'goto_zone': {
      // Phase 0d: GM teleport. Requires the client's account to have the scoped #zone status.
      // Sent via /say + local relay so the server parses the `#` (see relayGameCmd note).
      const commands = [relayGameCmd(intent.squad, `#zone ${intent.zone}`)];
      if (intent.resummonBots && intent.resummonBots.length) {
        // Bots didn't follow the teleport (or we're not sure) -> re-spawn on arrival.
        return {
          commands,
          delayed: resummonCommands(intent.squad, intent.resummonBots),
          delayMs: intent.resummonDelayMs,
          verified: false,
          note: 'teleport then re-summon bots after zone-load delay; verify bot command syntax (^spawn/^summon/^follow)',
        };
      }
      return {
        commands,
        verified: true,
        note: 'requires scoped GM (#zone) status on the squad account; verify bots follow (Phase 0d)',
      };
    }

    case 'resummon_bots':
      // Standalone re-summon (assumes the squad is already zoned-in/settled).
      return {
        commands: resummonCommands(intent.squad, intent.bots),
        verified: false,
        note: 'EQEmu bot commands vary by build (^spawn vs #bot spawn); squad must be done zoning',
      };

    case 'assist_player':
      // Vanilla /assist points the squad at the player's target; e3next then engages.
      return {
        commands: [relay(intent.squad, `/assist ${intent.player || '${Group.Leader}'}`)],
        verified: false,
        note: 'default uses vanilla /assist; tune to e3next auto-assist if preferred',
      };

    case 'engage':
      // Target the mob, then let e3next's combat take over (do not melee/cast from here).
      return {
        commands: [relay(intent.squad, `/target ${intent.target}`)],
        verified: false,
        note: 'targets the mob; e3next executes combat locally. Confirm target-by-name works for your mobs',
      };

    case 'group_invite':
      // The actual invite is issued by the group leader/player; the member must accept.
      // Recommended: enable auto-accept in e3next. Default here nudges the member to accept.
      return {
        commands: [relay(intent.member, '/notify ConfirmationDialogBox Yes_Button leftmouseup')],
        verified: false,
        note: 'leader issues the /invite; this only auto-accepts. Prefer e3next auto-accept-group config',
      };

    case 'come_to_player':
      // Needs the player's current zone + loc from the Phase 1 shadow hook; not derivable yet.
      return {
        commands: [],
        verified: false,
        note: 'Phase 1: requires player zone/loc from the zone-event shadow hook before it can emit a command',
      };

    default:
      // validate() should have caught this; defensive.
      return { commands: [], verified: false, note: `no mapping for type "${intent.type}"` };
  }
}

module.exports = { mapIntent, relay, resummonCommands, BOT };
