'use strict';
// End-to-end check against the real claude: hooks and status line reach the inbox, states change,
// and the user's own status line does not show up in the terminal.
// Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron test/e2e/pty-e2e.js
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
fs.writeFileSync(path.join(proj, 'a.txt'), 'x');

const env = claudeEnv.prepare(data);
console.log('claude:', env.claude);
env.extraArgs = ['--model', 'haiku'];
const mgr = new SessionManager(env);
const events = [];
const inbox = new Inbox(env.inboxDir, (ev) => {
  events.push(ev.kind);
  if (ev.kind !== 'status') console.log('event', ev.kind, ev.data && (ev.data.message || ev.data.hook_event_name || ''));
  mgr.handleEvent(ev);
});
inbox.start();
let screen = '';
mgr.on('data', (_id, d) => (screen += d));
const states = [];
mgr.on('change', () => {
  const s = mgr.list()[0];
  if (s && states[states.length - 1] !== s.state) {
    states.push(s.state);
    console.log('state', s.state, s.askMsg || '', JSON.stringify(s.git));
  }
});
const id = mgr.create({ cwd: proj });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = () => screen.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(250);
  }
  console.log('TIMEOUT', label);
  return false;
}
(async () => {
  mgr.resize(id, 140, 40);
  // trust dialog for a new folder
  await sleep(5000);
  if (/trust/i.test(plain())) {
    console.log('trust dialog -> accept');
    mgr.write(id, '\x1b[B');
    await sleep(400);
    mgr.write(id, '\r');
    await sleep(3000);
  }
  mgr.write(id, 'Use the Bash tool to run exactly: echo orkestra-ok');
  await sleep(300);
  mgr.write(id, '\r');
  await waitFor(() => events.includes('notify') || events.includes('stop'), 90000, 'notify/stop');
  if (mgr.list()[0].state === 'ask') {
    console.log('approving permission');
    mgr.write(id, '\r');
  }
  await waitFor(() => events.includes('stop'), 90000, 'stop');
  await sleep(2500);
  const s = mgr.list()[0];
  const txt = plain();
  console.log('--- result'); console.log('SCREEN-TAIL', plain().slice(-1200));
  console.log('states:', states.join(' > '));
  console.log('kinds:', [...new Set(events)].join(','));
  console.log('status:', JSON.stringify(s.status));
  console.log('limits:', JSON.stringify(mgr.limits));
  console.log('claudeId == id:', s.claudeId === id);
  console.log('user statusline visible:', /Remote (on|off)|Context [█░]/.test(txt));
  console.log('transcript saved:', require('../../src/main/history').transcriptExists(id));
  // --- resume: end the process, start it again, the old conversation must come back
  const before = events.length;
  s.pty.kill();
  await waitFor(() => mgr.list()[0].state === 'exited', 10000, 'exit');
  console.log('after kill:', mgr.list()[0].state);
  screen = '';
  mgr.restart(id);
  await sleep(9000);
  console.log('after restart:', mgr.list()[0].state, 'alive:', !!mgr.list()[0].pty);
  console.log('resumed shows old message:', /orkestra-ok/.test(plain()));
  // --- broadcast: text + Enter must submit a prompt
  const r = mgr.broadcast([id], 'Reply with exactly: second-ok');
  console.log('broadcast:', JSON.stringify(r));
  await waitFor(() => events.slice(before).includes('stop'), 90000, 'broadcast stop');
  console.log('broadcast answered:', /second-ok/.test(plain()), 'state:', mgr.list()[0].state);
  mgr.killAll();
  inbox.stop();
  setTimeout(() => process.exit(0), 500);
})();
