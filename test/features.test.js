'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { transition } = require('../src/main/states');
const { cleanMessage, summarizeTool } = require('../src/main/text');
const spaces = require('../src/main/spaces');
const { buildSettings } = require('../src/main/claudeEnv');
const { parseDiff } = require('../src/main/git');

const run = (s, ...evs) => evs.reduce((acc, ev) => ({ ...acc, ...(transition(acc, ev, 1000) || {}) }), s);

// ---- states: kind of prompt, Esc ----------------------------------------------------------------

test('a permission prompt and a question dialog are told apart', () => {
  assert.equal(run({ state: 'running' }, { type: 'notify', askKind: 'permission' }).askKind, 'permission');
  assert.equal(run({ state: 'running' }, { type: 'askq' }).askKind, 'question');
  assert.equal(run({ state: 'ask', askKind: 'permission' }, { type: 'posttool' }).askKind, null);
});

test('Esc on a prompt ends the turn without a Stop hook: the session goes idle, not stuck running', () => {
  const s = run({ state: 'ask', askKind: 'permission', askMsg: 'x' }, { type: 'deny' });
  assert.equal(s.state, 'idle');
  assert.equal(s.askKind, null);
  assert.equal(transition({ state: 'running' }, { type: 'deny' }), null);
});

// ---- text: last message and the tool asking for permission --------------------------------------

test('the last message is flattened from markdown into one readable line', () => {
  const md = '## Sonuç\n\n**Testler geçti.** `npm test` çalıştı, [PR](https://x.y/1) açıldı.\n\n- bir\n- iki\n```js\nconst a = 1;\n```';
  assert.equal(cleanMessage(md), 'Sonuç Testler geçti. npm test çalıştı, PR açıldı. bir iki const a = 1;');
  assert.equal(cleanMessage('a'.repeat(50), 20), 'a'.repeat(19) + '…');
  assert.equal(cleanMessage(null), '');
});

test('the tool asking for permission is summed up by what matters in it', () => {
  assert.deepEqual(summarizeTool('Bash', { command: 'rm -rf dist\necho ok', description: 'x' }), { tool: 'Bash', text: 'rm -rf dist ⏎ echo ok' });
  assert.deepEqual(summarizeTool('Edit', { file_path: '/Users/a/p/src/x.js' }, '/Users/a'), { tool: 'Edit', text: '~/p/src/x.js' });
  assert.deepEqual(summarizeTool('WebFetch', { url: 'https://a.b' }), { tool: 'WebFetch', text: 'https://a.b' });
  assert.deepEqual(summarizeTool('mcp__github__create_pr', { title: 't' }), { tool: 'github: create_pr', text: '' });
  assert.equal(summarizeTool('AskUserQuestion', { questions: [{ question: 'Hangisi?' }] }).text, 'Hangisi?');
  assert.equal(summarizeTool('Bash', { command: 'x'.repeat(500) }).text.length, 300);
});

// ---- workspaces ----------------------------------------------------------------------------------

const m = (id, extra = {}) => ({ id, claudeId: id, cwd: `/p/${id}`, name: id, ...extra });

test('saving a workspace with an existing name replaces it, keeping its id and place', () => {
  let list = spaces.upsert([], { name: 'Backend', members: [m('a'), m('b')], layout: { cols: [0.5, 0.5] } });
  const id = list[0].id;
  list = spaces.upsert(list, { name: 'Orkestra', members: [m('c')] });
  list = spaces.upsert(list, { name: 'backend ', members: [m('a'), m('b'), m('d'), m('e')] });
  assert.equal(list.length, 2);
  assert.equal(list[0].id, id);
  assert.equal(list[0].name, 'backend');
  assert.deepEqual(list[0].members.map((x) => x.id), ['a', 'b', 'd', 'e']);
});

test('a workspace keeps at most six sessions, needs a name and at least one session', () => {
  const list = spaces.upsert([], { name: 'X', members: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((k) => m(k)) });
  assert.equal(list[0].members.length, 6);
  assert.throws(() => spaces.upsert([], { name: '  ', members: [m('a')] }));
  assert.throws(() => spaces.upsert([], { name: 'Y', members: [] }));
});

test('rename and remove', () => {
  let list = spaces.upsert([], { name: 'A', members: [m('a')] });
  list = spaces.upsert(list, { name: 'B', members: [m('b')] });
  list = spaces.rename(list, list[0].id, 'Yeni');
  assert.deepEqual(list.map((x) => x.name), ['Yeni', 'B']);
  list = spaces.remove(list, list[1].id);
  assert.deepEqual(list.map((x) => x.name), ['Yeni']);
});

test('members follow their live sessions (new conversation id after resume, model, worktree folder)', () => {
  const list = spaces.upsert([], { name: 'A', members: [m('a'), m('b')] });
  const live = [{ id: 'a', claudeId: 'a2', cwd: '/p/a', liveCwd: '/p/a/wt', worktree: 'wt', name: 'a ⎇ wt', model: 'opus', effort: 'high' }];
  const out = spaces.sync(list, live);
  assert.deepEqual(out[0].members[0], { id: 'a', claudeId: 'a2', cwd: '/p/a', liveCwd: '/p/a/wt', worktree: 'wt', name: 'a ⎇ wt', model: 'opus', effort: 'high' });
  assert.deepEqual(out[0].members[1], list[0].members[1]);
});

test('finding the live session of a member: by id, then by conversation id', () => {
  const live = [{ id: 'x', claudeId: 'c1' }, { id: 'y', claudeId: 'c2' }];
  assert.equal(spaces.findLive(live, { id: 'y', claudeId: 'zz' }).id, 'y');
  assert.equal(spaces.findLive(live, { id: 'gone', claudeId: 'c1' }).id, 'x');
  assert.equal(spaces.findLive(live, { id: 'gone', claudeId: 'none' }), null);
});

// ---- hooks -----------------------------------------------------------------------------------------

test('settings forward PermissionRequest so the asking tool is known before the notification', () => {
  const s = buildSettings('/h.sh');
  assert.match(s.hooks.PermissionRequest[0].hooks[0].command, /permreq$/);
});

// ---- diff ------------------------------------------------------------------------------------------

test('a unified diff is split per file with added and removed counts', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js',
    'index 1..2 100644',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,2 +1,2 @@',
    '-old',
    '+new',
    '+more',
    ' same',
    'diff --git a/b.txt b/b.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/b.txt',
    '@@ -0,0 +1 @@',
    '+hello',
  ].join('\n');
  const files = parseDiff(diff);
  assert.deepEqual(files.map((f) => [f.path, f.added, f.removed]), [['src/a.js', 2, 1], ['b.txt', 1, 0]]);
  assert.equal(files[0].lines[0], 'diff --git a/src/a.js b/src/a.js');
});

// ---- limit messages -------------------------------------------------------------------------------

const { parseLimit } = require('../src/main/text');
const { searchConversations, snippet } = require('../src/main/search');

test('limit messages: reset time from the status line when known, else from the clock time in the text', () => {
  const now = new Date(2026, 10, 27, 13, 0, 0).getTime();
  const five = { five_hour: { used_percentage: 100, resets_at: Math.floor(now / 1000) + 3600 } };
  assert.deepEqual(parseLimit("You've hit your session limit · resets 2:10pm (Europe/Istanbul)", five, now), { kind: 'session', resetsAt: now + 3600 * 1000 });
  const p = parseLimit("You've hit your session limit · resets 2:10pm (Europe/Istanbul)", null, now);
  assert.equal(new Date(p.resetsAt).getHours(), 14);
  assert.equal(new Date(p.resetsAt).getMinutes(), 10);
  const w = parseLimit("You've hit your weekly limit · resets 3pm (Europe/Istanbul)", null, new Date(2026, 10, 27, 16, 0).getTime());
  assert.equal(w.kind, 'weekly');
  assert.equal(new Date(w.resetsAt).getDate(), 28, 'a time already past today means tomorrow');
  assert.equal(parseLimit('Testler geçti.', five, now), null);
});

// ---- conversation search ---------------------------------------------------------------------------

test('search finds typed messages and answers, skips tool noise, newest first', async () => {
  const fs2 = require('fs');
  const os2 = require('os');
  const path2 = require('path');
  const root = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ork-search-'));
  fs2.mkdirSync(path2.join(root, '-p-a'));
  const line = (o) => JSON.stringify(o) + '\n';
  fs2.writeFileSync(
    path2.join(root, '-p-a', 'c1.jsonl'),
    line({ type: 'user', cwd: '/p/a', message: { content: 'Migration dosyasını yaz' } }) +
      line({ type: 'assistant', cwd: '/p/a', message: { content: [{ type: 'text', text: 'Yeni migration 0042_users eklendi.' }] } }) +
      line({ type: 'user', cwd: '/p/a', message: { content: [{ type: 'tool_result', content: 'migration log' }] } }),
  );
  fs2.writeFileSync(path2.join(root, '-p-a', 'c2.jsonl'), line({ type: 'user', cwd: '/p/a', message: { content: 'başka iş' } }));
  const r = await searchConversations('MIGRATION', { root });
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 'c1');
  assert.equal(r[0].cwd, '/p/a');
  assert.deepEqual(r[0].hits.map((h) => h.role), ['user', 'assistant']);
  assert.equal((await searchConversations('x', { root })).length, 0, 'too short');
  const s = snippet('aaa bbb ccc', 'BBB', 2);
  assert.equal(s.text.slice(s.at, s.at + s.len), 'bbb');
});

// ---- queue ------------------------------------------------------------------------------------------

test('a slash command with no hooks after it settles back to idle; a background job keeps it running', () => {
  assert.equal(run({ state: 'running' }, { type: 'settle' }).state, 'idle');
  assert.equal(run({ state: 'running', bg: [{ type: 'shell' }] }, { type: 'settle' }).state, 'running');
  assert.equal(transition({ state: 'done' }, { type: 'settle' }), null);
});

test('queue: sends one message at a time, only when the session is free, honouring pause and due time', () => {
  const { SessionManager } = require('../src/main/sessions');
  const typed = [];
  const m = new SessionManager({ claude: '/usr/bin/true', PATH: process.env.PATH, settingsPath: '/dev/null', inboxDir: '/tmp' });
  clearInterval(m.gitTimer);
  clearInterval(m.remoteTimer);
  const s = m._newRecord({ id: 'q1', cwd: '/tmp' });
  s.pty = { write: (d) => typed.push(d) };
  m.sessions.set('q1', s);
  m.order.push('q1');
  m.enqueue('q1', 'birinci iş');
  m.enqueue('q1', '/compact');
  s.state = 'running';
  assert.equal(m.sendQueued('q1').ok, false, 'busy');
  s.state = 'done';
  assert.equal(m.sendQueued('q1').ok, true);
  assert.equal(typed[0], '\x1b[200~birinci iş\x1b[201~');
  assert.equal(s.state, 'running');
  s.state = 'idle';
  m.pauseQueue('q1', true);
  assert.equal(m.sendQueued('q1').ok, false, 'paused');
  assert.equal(m.sendQueued('q1', { force: true }).ok, true, 'send now ignores pause');
  assert.equal(typed[1], '/compact', 'slash commands are typed, not pasted');
  assert.ok(s.slashAt > 0);
  // a usage limit puts a "continue" first, due after the reset
  s.state = 'done';
  m.limits = { five_hour: { used_percentage: 100, resets_at: Math.floor(Date.now() / 1000) + 600 } };
  m.handleEvent({ session: 'q1', kind: 'stopfail', data: { error: 'rate_limit', last_assistant_message: "You've hit your session limit · resets 2:10pm (Europe/Istanbul)" } });
  assert.equal(s.queue[0].kind, 'resume');
  assert.equal(s.limitHit.kind, 'session');
  m.pauseQueue('q1', false);
  assert.equal(m.sendQueued('q1').ok, false, 'not due yet');
  assert.equal(m.sendQueued('q1', { now: Date.now() + 11 * 60 * 1000 }).ok, true, 'due after reset + 1 min');
  assert.equal(s.limitHit, null);
  clearTimeout(m._pending);
});
