'use strict';
/*
 * brain/emit.js — Phase 0 intent emitter (NO LLM yet).
 *
 * Runs on the laptop. Builds ONE contract intent and sends it over the LAN to the
 * executor on the 32 GB box, then prints the executor's result. This is the brain's
 * job in miniature: decide (here, you decide on the command line) -> emit an intent.
 * Intents cross the LAN; keystrokes never do.
 *
 * Usage:
 *   node brain/emit.js say <target> <text...>
 *   node brain/emit.js goto_zone <squad> <zoneShortName> [--resummon b1,b2,...] [--delay <ms>]
 *   node brain/emit.js come_to_player <squad> <zone> [--x <n> --y <n> --z <n>] [--player <name>]
 *   node brain/emit.js resummon_bots <squad> <bot1> <bot2> ...
 *   node brain/emit.js assist_player <squad> <player>
 *   node brain/emit.js engage <squad> <mobName>
 *   node brain/emit.js group_invite <inviter> <member>
 *   node brain/emit.js make_leader <leader> <by>
 *   node brain/emit.js drop_bot <squad> <bot>
 *
 * Env:
 *   EQ_EXEC_HOST  executor address (default 127.0.0.1; set to the box's LAN IP)
 *   EQ_EXEC_PORT  executor port    (default 8777)
 */

const net = require('net');
const contract = require('../contract/intents');
const config = require('../config');

const HOST = config.brain.host;
const PORT = config.brain.port;

/** Pull "--flag value" pairs out of an arg list, returning { flags, positional }. */
function splitFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { flags[args[i].slice(2)] = args[++i]; }
    else positional.push(args[i]);
  }
  return { flags, positional };
}

function buildFromArgv(argv) {
  const [type, ...rest] = argv;
  switch (type) {
    case 'say':           return contract.build.say(rest[0], rest.slice(1).join(' '));
    case 'goto_zone': {
      const { flags, positional } = splitFlags(rest);
      const opts = {};
      if (flags.resummon) opts.resummonBots = flags.resummon.split(',').filter(Boolean);
      if (flags.delay) opts.resummonDelayMs = parseInt(flags.delay, 10);
      return contract.build.gotoZone(positional[0], positional[1], opts);
    }
    case 'resummon_bots': return contract.build.resummonBots(rest[0], rest.slice(1));
    case 'assist_player': return contract.build.assistPlayer(rest[0], rest[1]);
    case 'engage':        return contract.build.engage(rest[0], rest.slice(1).join(' '));
    case 'group_invite':  return contract.build.groupInvite(rest[0], rest[1]);
    case 'make_leader':   return contract.build.makeLeader(rest[0], rest[1]);
    case 'drop_bot':      return contract.build.dropBot(rest[0], rest[1]);
    case 'come_to_player': {
      const { flags, positional } = splitFlags(rest);
      const opts = { player: flags.player };
      for (const k of ['x', 'y', 'z']) if (flags[k] !== undefined) opts[k] = parseFloat(flags[k]);
      if (flags.delay !== undefined) opts.arriveDelayMs = parseInt(flags.delay, 10);
      return contract.build.comeToPlayer(positional[0], positional[1], opts);
    }
    default:
      throw new Error(`unknown intent "${type}". See usage in brain/emit.js`);
  }
}

/** Send one intent and resolve with the executor's parsed result. */
function sendIntent(intent, { host = HOST, port = PORT, timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port }, () => {
      sock.write(contract.serialize(intent) + '\n');
    });
    sock.setEncoding('utf8');
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('executor reply timeout')); }, timeoutMs);
    sock.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        clearTimeout(timer);
        sock.end();
        try { resolve(JSON.parse(buf.slice(0, nl))); }
        catch (e) { reject(new Error(`bad reply: ${e.message}: ${buf.slice(0, nl)}`)); }
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.error('usage: node brain/emit.js <intentType> <args...>  (see file header)');
    process.exit(2);
  }
  let intent;
  try {
    intent = buildFromArgv(argv);
  } catch (e) {
    console.error('error:', e.message);
    process.exit(2);
  }
  console.log(`emitting -> ${HOST}:${PORT}:`, contract.serialize(intent));
  try {
    const res = await sendIntent(intent);
    console.log('result:', JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  } catch (e) {
    console.error('failed:', e.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { sendIntent, buildFromArgv };
