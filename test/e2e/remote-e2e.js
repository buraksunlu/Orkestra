'use strict';
// Remote Control toggle against the real claude: on and off in a running session, and on at start.
// Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron test/e2e/remote-e2e.js
// Creates short-lived Remote Control sessions on the signed-in claude.ai account.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const claudeEnv = require('../../src/main/claudeEnv');
const { SessionManager } = require('../../src/main/sessions');
const { Inbox } = require('../../src/main/inbox');

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ork e2e '));
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-proj-'));
execFileSync('git', ['init', '-q', '-b', 'main', proj]);
const env = claudeEnv.prepare(data);
env.extraArgs = ['--model', 'haiku'];
let remoteAtStart = false;
env.remoteFor = () => remoteAtStart;
const mgr = new SessionManager(env);
const inbox = new Inbox(env.inboxDir, (ev) => mgr.handleEvent(ev));
inbox.start();
let screen = '';
mgr.on('data', (_id, d) => (screen += d));
const plain = () => screen.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const id = mgr.create({ cwd: proj, name: 'ork-rc-test' });
(async () => {
  await sleep(5000);
  if (/trust/i.test(plain())) {
    mgr.write(id, '\x1b[B');
    await sleep(400);
    mgr.write(id, '\r');
    await sleep(4000);
  }
  const s = () => mgr.list()[0];
  console.log('start: state', s().state, 'remote', s().remote);
  let r = await mgr.toggleRemote(id, true);
  console.log('on:', JSON.stringify(r), 'remote', s().remote, 'state', s().state);
  await sleep(2500);
  console.log('state 2.5s later:', s().state);
  r = await mgr.toggleRemote(id, false);
  console.log('off:', JSON.stringify(r), 'remote', s().remote, 'state', s().state);
  // restart with the project preference on
  remoteAtStart = true;
  s().pty.kill();
  await sleep(1500);
  mgr.restart(id);
  await sleep(9000);
  mgr.refreshRemote();
  console.log('restart with pref on: remote', s().remote, 'state', s().state); console.log('TAIL', plain().slice(-700));
  r = await mgr.toggleRemote(id, false);
  console.log('off again:', JSON.stringify(r), 'remote', s().remote);
  mgr.killAll();
  inbox.stop();
  setTimeout(() => process.exit(0), 500);
})();
