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
  spawn:   (name) => `^spawn ${name}`,   // spawn one of your persisted bots
  summon:  ()     => '^summon',          // pull your spawned bots to you (gather on arrival)
  follow:  ()     => '^follow on',       // make your bots follow you
  despawn: (name) => `^depop ${name}`,   // remove a bot to free its group slot (Mode B). Verify
                                         // your build's syntax (^depop vs ^botgroup remove vs #bot).
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

    case 'group_invite':
      // The inviter invites the member; the member auto-accepts via e3next (must be guilded).
      return {
        commands: [relay(intent.inviter, `/invite ${intent.member}`)],
        verified: false,
        note: 'member must be guilded with the inviter for e3next auto-accept (Phase 0a finding)',
      };

    case 'make_leader':
      // `by` (current group leader) promotes `leader` to group leader.
      return {
        commands: [relay(intent.by, `/makeleader ${intent.leader}`)],
        verified: false,
        note: 'issued by the current leader; used after Mode A assembly to hand you the group',
      };

    case 'drop_bot':
      // Despawn a named bot to free a group slot (Mode B: you fill its ROLE). Server command.
      return {
        commands: [relayGameCmd(intent.squad, BOT.despawn(intent.bot))],
        verified: false,
        note: 'verify despawn syntax in mapping.js BOT.despawn for your server build',
      };

    case 'come_to_player': {
      // Teleport the squad into the player's zone (bots follow #zone natively). If coords are
      // given, follow up after a load delay with #goto to land near the player.
      const commands = [relayGameCmd(intent.squad, `#zone ${intent.zone}`)];
      const hasLoc = intent.x !== undefined && intent.y !== undefined && intent.z !== undefined;
      if (hasLoc) {
        return {
          commands,
          delayed: [relayGameCmd(intent.squad, `#goto ${intent.x} ${intent.y} ${intent.z}`)],
          delayMs: intent.arriveDelayMs,
          verified: false,
          note: 'verify #goto coord order for your build; bots follow the Lt to coords via ^follow',
        };
      }
      return {
        commands,
        verified: false,
        note: 'lands at the zone safe point; pass x/y/z to arrive at the player. bots follow #zone',
      };
    }

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
        commands: [relay(intent.squad, `/assist ${intent.player}`)],
        verified: false,
        note: 'vanilla /assist on the player; tune to e3next auto-assist if preferred',
      };

    case 'engage':
      // Target the mob, then let e3next's combat take over (do not melee/cast from here).
      return {
        commands: [relay(intent.squad, `/target ${intent.target}`)],
        verified: false,
        note: 'targets the mob; e3next executes combat locally. Confirm target-by-name works for your mobs',
      };

    default:
      // validate() should have caught this; defensive.
      return { commands: [], verified: false, note: `no mapping for type "${intent.type}"` };
  }
}

module.exports = { mapIntent, relay, resummonCommands, BOT };
