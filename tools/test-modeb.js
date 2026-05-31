'use strict';
/*
 * tools/test-modeb.js — unit tests for Mode B's drop selection (pickDropBot). Pure, no game/network.
 * Key rule: a Cleric must always remain in the group (never dropped) unless the player IS a Cleric.
 * Run: node tools/test-modeb.js
 */

const { pickDropBot } = require('../brain/group');

// A balanced Lt squad: tank/healer(Cleric)/cc/support/dps.
const SQUAD = {
  name: 'Oram',
  bots: [
    { name: 'Tankbot',    class: 'Warrior',   role: 'tank' },
    { name: 'Healbot',    class: 'Cleric',    role: 'healer' },
    { name: 'Crowdbot',   class: 'Enchanter', role: 'cc' },
    { name: 'Slowbot',    class: 'Shaman',    role: 'support' },
    { name: 'Nukebot',    class: 'Wizard',    role: 'dps' },
  ],
};
const OPTS = { essentialClasses: ['Cleric'], dropPriority: ['dps', 'support', 'cc', 'healer', 'tank'] };

let failures = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` -- got ${got}, want ${want}`}`);
}

console.log('Mode B drop-selection tests\n');

// Shaman player (healer role): must KEEP the Cleric, drop a redundant non-essential (dps first).
check('Shaman player keeps Cleric, drops dps',
  pickDropBot(SQUAD, { class: 'Shaman', role: 'healer' }, OPTS).bot.name, 'Nukebot');

// Druid player (healer role): same — Cleric stays, redundant dps dropped.
check('Druid player keeps Cleric, drops dps',
  pickDropBot(SQUAD, { class: 'Druid', role: 'healer' }, OPTS).bot.name, 'Nukebot');

// Cleric player: replaces the Cleric bot (player IS the essential).
check('Cleric player replaces the Cleric bot',
  pickDropBot(SQUAD, { class: 'Cleric', role: 'healer' }, OPTS).bot.name, 'Healbot');

// Warrior player (tank role): non-essential role-match -> drop the tank bot.
check('Warrior player drops the tank bot',
  pickDropBot(SQUAD, { class: 'Warrior', role: 'tank' }, OPTS).bot.name, 'Tankbot');

// Wizard player (dps): drop the dps bot.
check('Wizard player drops the dps bot',
  pickDropBot(SQUAD, { class: 'Wizard', role: 'dps' }, OPTS).bot.name, 'Nukebot');

// The Cleric is never the drop unless the player is a Cleric — sweep all non-cleric healers.
const got = pickDropBot(SQUAD, { class: 'Druid', role: 'healer' }, OPTS).bot.class;
check('drop is never the Cleric class for a Druid player', got !== 'Cleric', true);

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
