'use strict';
// Per-conversation model/effort against the real claude: switch mid-conversation, conversation continues,
// ~/.claude/settings.json stays untouched.
// Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron test/e2e/model-e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const claudeEnv = require('../../src/main/claudeEnv');
const { SessionManager } = require('../../src/main/sessions');
const { Inbox } = require('../../src/main/inbox');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const before = fs.readFileSync(SETTINGS, 'utf8');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ork e2e '));
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-proj-'));
execFileSync('git', ['init', '-q', '-b', 'main', proj]);
const env = claudeEnv.prepare(data);
const mgr = new SessionManager(env);
const kinds = [];
const inbox = new Inbox(env.inboxDir, (ev) => {
  kinds.push(ev.kind);
  mgr.handleEvent(ev);
});
inbox.start();
let screen = '';
mgr.on('data', (_id, d) => (screen += d));
const plain = () => screen.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(250);
  }
  return false;
}
const id = mgr.create({ cwd: proj, model: 'haiku', effort: 'medium' });
const s = () => mgr.list()[0];
(async () => {
  await sleep(5000);
  if (/trust/i.test(plain())) {
    mgr.write(id, '\x1b[B');
    await sleep(400);
    mgr.write(id, '\r');
    await sleep(4000);
  }
  mgr.write(id, 'Remember the word: pelican. Reply with just: noted');
  await sleep(300);
  mgr.write(id, '\r');
  await waitFor(() => kinds.includes('stop'), 90000);
  await waitFor(() => s().status && s().status.model, 20000);
  console.log('first:', s().status.model, s().status.effort, 'state', s().state);
  screen = '';
  console.log('setModel:', JSON.stringify(mgr.setModel(id, { model: 'sonnet', effort: 'low' })));
  await waitFor(() => s().status && /Sonnet/.test(s().status.model) && s().status.effort === 'low', 30000);
  console.log('after switch:', s().status.model, s().status.effort, 'state', s().state, 'alive', !!s().pty);
  console.log('conversation still on screen:', /pelican/.test(plain()));
  const n = kinds.filter((k) => k === 'stop').length;
  mgr.write(id, 'What word did I ask you to remember? One word.');
  await sleep(300);
  mgr.write(id, '\r');
  await waitFor(() => kinds.filter((k) => k === 'stop').length > n, 90000);
  await sleep(1500);
  const tail = plain().slice(-1500);
  console.log('remembers after switch:', /pelican/i.test(tail.split('What word')[1] || ''));
  console.log('settings.json untouched:', fs.readFileSync(SETTINGS, 'utf8') === before);
  console.log('saved:', JSON.stringify(mgr.saved()[0].model), JSON.stringify(mgr.saved()[0].effort));
  mgr.killAll();
  inbox.stop();
  setTimeout(() => process.exit(0), 500);
})();
