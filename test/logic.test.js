'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { transition, nextWaiting } = require('../src/main/states');
const { parseName, Inbox } = require('../src/main/inbox');
const { encodeProjectDir, listConversations } = require('../src/main/history');
const { HOOK_SCRIPT, buildSettings } = require('../src/main/claudeEnv');

const run = (s, ...evs) => evs.reduce((acc, ev) => ({ ...acc, ...(transition(acc, ev, 1000) || {}) }), s);

test('a prompt runs, stop makes it done, looking at it makes it idle', () => {
  let s = run({ state: 'idle' }, { type: 'prompt' });
  assert.equal(s.state, 'running');
  s = run(s, { type: 'stop' });
  assert.equal(s.state, 'done');
  s = run(s, { type: 'ack' });
  assert.equal(s.state, 'idle');
});

test('a permission prompt keeps glowing when looked at, and clears when the tool runs', () => {
  let s = run({ state: 'running' }, { type: 'notify', message: 'Claude needs your permission to use Bash' });
  assert.equal(s.state, 'ask');
  assert.match(s.askMsg, /Bash/);
  s = run(s, { type: 'ack' });
  assert.equal(s.state, 'ask');
  s = run(s, { type: 'posttool' });
  assert.equal(s.state, 'running');
  assert.equal(s.askMsg, null);
});

test('posttool while running changes nothing', () => {
  assert.equal(transition({ state: 'running' }, { type: 'posttool' }), null);
});

test('typing answers a prompt and clears a finished glow', () => {
  assert.equal(run({ state: 'ask' }, { type: 'input' }).state, 'running');
  assert.equal(run({ state: 'done' }, { type: 'input' }).state, 'idle');
  assert.equal(transition({ state: 'running' }, { type: 'input' }), null);
});

test('a stop with background work still running is not done; the session stays running until that work ends', () => {
  const shell = { id: 'b1', type: 'shell', status: 'running', description: 'Run tests', command: 'npm test' };
  let s = run({ state: 'idle' }, { type: 'prompt' });
  s = { ...s, since: 500 };
  s = run(s, { type: 'stop', tasks: [shell, { id: 'b0', type: 'shell', status: 'completed' }] });
  assert.equal(s.state, 'running');
  assert.equal(s.since, 500, 'keeps counting from when the work started');
  assert.deepEqual(s.bg, [{ type: 'shell', description: 'Run tests' }]);
  // looking at it or typing does not turn it into idle or done
  assert.equal(transition(s, { type: 'ack' }), null);
  assert.equal(transition(s, { type: 'input' }), null);
  // the task finishes: Claude Code wakes Claude with a task-notification prompt, then stops with nothing left
  s = run(s, { type: 'prompt' });
  assert.equal(s.state, 'running');
  assert.equal(s.since, 500);
  s = run(s, { type: 'stop', tasks: [] });
  assert.equal(s.state, 'done');
  assert.equal(s.bg, null);
});

test('a new prompt or a permission prompt clears the background list; the next stop sets it again', () => {
  const bg = [{ type: 'agent', description: 'review' }];
  assert.equal(run({ state: 'running', bg }, { type: 'notify', message: 'x' }).bg, null);
  assert.equal(run({ state: 'running', bg }, { type: 'exit', code: 0 }).bg, null);
  assert.equal(run({ state: 'done', since: 1 }, { type: 'prompt' }).bg, null);
  assert.equal(run({ state: 'running' }, { type: 'stop' }).state, 'done');
});

test('hook events after exit do not revive a session', () => {
  const s = run({ state: 'running' }, { type: 'exit', code: 0 });
  assert.equal(s.state, 'exited');
  assert.equal(run(s, { type: 'stop' }).state, 'exited');
  assert.equal(run(s, { type: 'notify' }).state, 'exited');
});

test('next waiting: prompts first, then finished, oldest first, skipping the current one', () => {
  const list = [
    { id: 'a', state: 'done', since: 1 },
    { id: 'b', state: 'ask', since: 5 },
    { id: 'c', state: 'ask', since: 3 },
    { id: 'd', state: 'running', since: 0 },
  ];
  assert.equal(nextWaiting(list, null), 'c');
  assert.equal(nextWaiting(list, 'c'), 'b');
  assert.equal(nextWaiting([{ id: 'a', state: 'done', since: 1 }], 'a'), 'a');
  assert.equal(nextWaiting([{ id: 'd', state: 'running', since: 0 }], null), null);
});

test('inbox file names carry time, session and kind', () => {
  const id = '3f1c2a7e-1111-2222-3333-444455556666';
  assert.deepEqual(parseName(`1764230000123_812_9921__${id}__stop.json`), { ts: 1764230000123, session: id, kind: 'stop' });
  assert.equal(parseName('.tmp-1-2'), null);
  assert.equal(parseName('junk.json'), null);
});

test('project folder encoding matches Claude Code', () => {
  assert.equal(encodeProjectDir('/Users/x/Projects/Acme'), '-Users-x-Projects-Acme');
  assert.equal(
    encodeProjectDir('/Users/x/Projects/A/.claude/worktrees/keen'),
    '-Users-x-Projects-A--claude-worktrees-keen',
  );
});

test('past conversations: title, first typed message, newest first', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-hist-'));
  const cwd = '/tmp/demo-proj';
  const dir = path.join(root, encodeProjectDir(cwd));
  fs.mkdirSync(dir);
  const line = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(
    path.join(dir, 'old.jsonl'),
    line({ type: 'user', isMeta: true, message: { content: '<command-name>/x</command-name>' } }) +
      line({ type: 'user', message: { role: 'user', content: 'ilk soru' } }),
  );
  const t = Date.now() / 1000;
  fs.utimesSync(path.join(dir, 'old.jsonl'), t - 100, t - 100);
  fs.writeFileSync(
    path.join(dir, 'new.jsonl'),
    line({ type: 'user', message: { content: [{ type: 'text', text: 'yeni iş' }] } }) + line({ type: 'ai-title', aiTitle: 'Başlık' }),
  );
  fs.writeFileSync(path.join(dir, 'empty.jsonl'), line({ type: 'mode', mode: 'normal' }));
  const list = listConversations(cwd, { root });
  assert.deepEqual(
    list.map((c) => [c.id, c.title, c.first]),
    [
      ['new', 'Başlık', 'yeni iş'],
      ['old', null, 'ilk soru'],
    ],
  );
});

test('hook script copies stdin into the inbox, prints nothing, and is silent without the env', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ork-hook-'));
  const hook = path.join(dir, 'hook.sh');
  const inboxDir = path.join(dir, 'inbox with space');
  fs.mkdirSync(inboxDir);
  fs.writeFileSync(hook, HOOK_SCRIPT, { mode: 0o755 });
  const out = execFileSync(hook, ['stop'], {
    input: '{"session_id":"abc"}',
    env: { ...process.env, ORKESTRA_SESSION: 'sess-1', ORKESTRA_INBOX: inboxDir },
    encoding: 'utf8',
  });
  assert.equal(out, '');
  const quiet = execFileSync(hook, ['stop'], { input: '{}', env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(quiet, '');

  const got = [];
  const inbox = new Inbox(inboxDir, (ev) => got.push(ev));
  inbox.sweep();
  assert.equal(got.length, 1);
  assert.equal(got[0].session, 'sess-1');
  assert.equal(got[0].kind, 'stop');
  assert.deepEqual(got[0].data, { session_id: 'abc' });
  assert.deepEqual(fs.readdirSync(inboxDir), []);
});

test('settings quote a hook path with spaces', () => {
  const s = buildSettings('/Users/x/Library/Application Support/Orkestra/hook.sh');
  assert.equal(s.statusLine.command, "'/Users/x/Library/Application Support/Orkestra/hook.sh' status");
  assert.ok(s.hooks.Notification[0].matcher.includes('permission_prompt'));
  assert.ok(!s.hooks.Notification[0].matcher.includes('idle_prompt'));
});
