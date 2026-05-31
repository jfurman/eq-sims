'use strict';
/*
 * config.js — resolves runtime config from config.json, with env-var overrides.
 *
 * Precedence: env var > config.json > built-in default. Both the executor and the brain
 * import this so there is ONE place to set paths/ports. config.json is the file users edit.
 */

const fs = require('fs');
const path = require('path');

function loadFile() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

const f = loadFile();
const ex = f.executor || {};
const br = f.brain || {};

const bridgeDir = process.env.EQ_BRIDGE_DIR || f.bridgeDir || path.join(__dirname, '.bridge');

module.exports = {
  bridgeDir,
  executor: {
    host: process.env.EQ_EXEC_HOST || ex.host || '0.0.0.0',
    port: parseInt(process.env.EQ_EXEC_PORT || ex.port || 8777, 10),
  },
  brain: {
    // EQ_EXEC_HOST/PORT override here too, so a laptop session can point at the box ad hoc.
    host: process.env.EQ_EXEC_HOST || br.executorHost || '127.0.0.1',
    port: parseInt(process.env.EQ_EXEC_PORT || br.executorPort || 8777, 10),
  },
};
