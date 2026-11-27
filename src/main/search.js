'use strict';
// Full-text search over every Claude Code conversation on disk (~/.claude/projects/*/*.jsonl).
// grep finds the files that mention the text (fast over hundreds of MB); only those are read and parsed.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { PROJECTS, summarize } = require('./history');

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

function allTranscripts(root) {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const d of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(root, d));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(root, d, f);
      try {
        out.push({ full, id: f.slice(0, -6), mtime: fs.statSync(full).mtimeMs });
      } catch {}
    }
  }
  return out;
}

function grepFiles(query, files) {
  if (!files.length) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('/usr/bin/grep', ['-l', '-i', '-F', '--', query, ...files], { maxBuffer: 8 * 1024 * 1024, timeout: 30000 }, (err, out) => {
      // exit 1 = no match
      resolve(out ? out.split('\n').filter(Boolean) : []);
    });
  });
}

// Case folding that works for Turkish and English alike: I/ı/İ/i all match each other (same length kept).
const fold = (s) => s.toLocaleLowerCase('tr').replace(/ı/g, 'i');

function snippet(text, q, width = 90) {
  const flat = text.replace(/\s+/g, ' ');
  const i = fold(flat).indexOf(fold(q));
  if (i < 0) return null;
  const a = Math.max(0, i - width);
  const b = Math.min(flat.length, i + q.length + width);
  return { text: (a > 0 ? '…' : '') + flat.slice(a, b) + (b < flat.length ? '…' : ''), at: i - a + (a > 0 ? 1 : 0), len: q.length };
}

// Conversations that contain `query` in a typed message or in Claude's answers, newest first.
async function searchConversations(query, { root = PROJECTS, limit = 30, hitsPer = 3 } = {}) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const files = allTranscripts(root);
  const byPath = new Map(files.map((f) => [f.full, f]));
  const found = (await grepFiles(q, files.map((f) => f.full))).map((p) => byPath.get(p)).filter(Boolean);
  found.sort((a, b) => b.mtime - a.mtime);
  const ql = fold(q);
  const out = [];
  for (const f of found.slice(0, limit)) {
    let raw;
    try {
      raw = fs.readFileSync(f.full, 'utf8');
    } catch {
      continue;
    }
    let cwd = null;
    const hits = [];
    for (const line of raw.split('\n')) {
      if (!cwd) {
        const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line);
        if (m) cwd = JSON.parse(`"${m[1]}"`);
      }
      if (hits.length >= hitsPer || !fold(line).includes(ql)) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if ((o.type !== 'user' && o.type !== 'assistant') || o.isMeta || !o.message) continue;
      const t = textOf(o.message.content);
      if (!t || (o.type === 'user' && t.trimStart().startsWith('<'))) continue;
      const s = snippet(t, q);
      if (s) hits.push({ role: o.type, ...s, ts: o.timestamp || null });
    }
    if (!hits.length) continue;
    const sum = summarize(f.full) || {};
    out.push({ id: f.id, cwd, mtime: f.mtime, title: sum.title || null, first: sum.first ? sum.first.slice(0, 160) : null, hits });
  }
  return out;
}

module.exports = { searchConversations, snippet };
