'use strict';
// Reads Claude Code's own conversation records in ~/.claude/projects to list past conversations.
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

// Claude Code names a project's folder after its path, with every non-alphanumeric character turned into '-'.
function encodeProjectDir(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function transcriptExists(sessionId, root = PROJECTS) {
  let dirs;
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return false;
  }
  return dirs.some((d) => fs.existsSync(path.join(root, d, `${sessionId}.jsonl`)));
}

function readHead(file, bytes = 256 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = content.find((c) => c && c.type === 'text' && typeof c.text === 'string');
    return t ? t.text : '';
  }
  return '';
}

// Title and first typed message of one transcript.
function summarize(file) {
  let title = null;
  let first = null;
  let head;
  try {
    head = readHead(file);
  } catch {
    return null;
  }
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === 'custom-title' && o.customTitle) title = o.customTitle;
    else if (o.type === 'ai-title' && o.aiTitle && !title) title = o.aiTitle;
    else if (!first && o.type === 'user' && !o.isMeta && o.message) {
      const t = textOf(o.message.content).trim();
      if (t && !t.startsWith('<')) first = t;
    }
  }
  if (!title && !first) return null;
  return { title, first };
}

// Past conversations for one folder, newest first.
function listConversations(cwd, { root = PROJECTS, limit = 40 } = {}) {
  const dir = path.join(root, encodeProjectDir(cwd));
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const items = files
    .map((f) => {
      const full = path.join(dir, f);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {}
      return { id: f.slice(0, -'.jsonl'.length), full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  const out = [];
  for (const it of items) {
    if (out.length >= limit) break;
    const s = summarize(it.full);
    if (!s) continue;
    out.push({ id: it.id, mtime: it.mtime, title: s.title, first: s.first ? s.first.slice(0, 200) : null });
  }
  return out;
}

module.exports = { encodeProjectDir, transcriptExists, listConversations, summarize, PROJECTS };
