'use strict';
// Workspaces: a named set of up to six sessions shown together, with their split layout (a tree).
// "Backend" = these four conversations side by side. Opening one brings the sessions on screen, and
// starts (resumes) the ones that are closed. Pure functions over the saved list.
const crypto = require('crypto');

const MAX = 6; // panes on screen at most (renderer MAX_PANES)
const FIELDS = ['id', 'claudeId', 'cwd', 'liveCwd', 'worktree', 'name', 'model', 'effort'];

function member(s) {
  const out = {};
  for (const k of FIELDS) out[k] = s[k] == null ? null : s[k];
  return out;
}

const key = (name) => name.trim().toLocaleLowerCase('tr');

// Adds a workspace, or replaces the members and layout of the one with the same name.
function upsert(list, { name, members, layout = null }) {
  const n = String(name || '').trim();
  if (!n) throw new Error('Çalışma alanının adı boş olamaz.');
  if (!members || !members.length) throw new Error('Ekranda en az bir oturum olmalı.');
  const ms = members.slice(0, MAX).map(member);
  const i = list.findIndex((x) => key(x.name) === key(n));
  if (i >= 0) {
    const out = list.slice();
    out[i] = { ...list[i], name: n, members: ms, layout };
    return out;
  }
  return [...list, { id: crypto.randomUUID(), name: n, members: ms, layout }];
}

function rename(list, id, name) {
  const n = String(name || '').trim();
  if (!n) return list;
  return list.map((x) => (x.id === id ? { ...x, name: n } : x));
}

function remove(list, id) {
  return list.filter((x) => x.id !== id);
}

function findLive(live, m) {
  return live.find((s) => s.id === m.id) || live.find((s) => s.claudeId && s.claudeId === m.claudeId) || null;
}

// Keeps members in step with their running sessions (conversation id after a resume, model, worktree folder).
function sync(list, live) {
  return list.map((sp) => ({
    ...sp,
    members: sp.members.map((m) => {
      const s = findLive(live, m);
      return s ? member({ ...s, id: m.id }) : m;
    }),
  }));
}

module.exports = { upsert, rename, remove, sync, findLive, member, MAX };
