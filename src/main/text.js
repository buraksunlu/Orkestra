'use strict';
// Short, plain texts for the sidebar and notifications.

// Claude's last message (markdown) as one readable line.
function cleanMessage(md, max = 600) {
  if (!md) return '';
  let t = String(md)
    .replace(/```[^\n]*\n?/g, ' ') // code fence markers (the code itself stays)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links and images: keep the text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '') // list markers
    .replace(/^\s*>\s?/gm, '') // quotes
    .replace(/(\*\*|__|\*|~~)(?=\S)([^\n]*?\S)\1/g, '$2') // bold, italic, strike
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > max) t = t.slice(0, max - 1).trimEnd() + '…';
  return t;
}

function shortPath(p, home) {
  if (!p) return '';
  const h = home || process.env.HOME || '';
  return h && p.startsWith(h + '/') ? '~' + p.slice(h.length) : p;
}

// What a tool is about to do, for the permission line: the command, the file, the URL...
function summarizeTool(name, input, home) {
  const i = input || {};
  let tool = name || 'araç';
  let text = '';
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(tool);
  if (mcp) tool = `${mcp[1]}: ${mcp[2]}`;
  else if (name === 'Bash') text = String(i.command || '').trim().split('\n').map((l) => l.trim()).filter(Boolean).join(' ⏎ ');
  else if (i.file_path || i.notebook_path) text = shortPath(i.file_path || i.notebook_path, home);
  else if (i.url) text = String(i.url);
  else if (i.query) text = String(i.query);
  else if (name === 'AskUserQuestion') text = (i.questions && i.questions[0] && i.questions[0].question) || '';
  else if (i.description) text = String(i.description);
  else if (i.skill) text = String(i.skill);
  else if (i.pattern) text = String(i.pattern);
  if (text.length > 300) text = text.slice(0, 299) + '…';
  return { tool, text };
}

// "You've hit your session limit · resets 2:10pm (Europe/Istanbul)" / "... weekly limit · resets 3pm ...".
// Returns { kind: 'session' | 'weekly', resetsAt (ms) } or null. The exact reset time comes from the status line
// limits (resets_at) when they agree; otherwise the clock time in the message, the next time it comes round.
function parseLimit(text, limits, now = Date.now()) {
  const m = /hit your (session|weekly|[a-z-]+) limit[^\n]*?resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(String(text || ''));
  if (!m) return null;
  const kind = /week/i.test(m[1]) ? 'weekly' : 'session';
  const win = limits && (kind === 'weekly' ? limits.seven_day : limits.five_hour);
  if (win && win.resets_at && win.resets_at * 1000 > now) return { kind, resetsAt: win.resets_at * 1000 };
  let h = Number(m[2]) % 12;
  if ((m[4] || '').toLowerCase() === 'pm') h += 12;
  if (!m[4] && Number(m[2]) >= 12) h = Number(m[2]);
  const d = new Date(now);
  d.setHours(h, Number(m[3] || 0), 0, 0);
  while (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return { kind, resetsAt: d.getTime() };
}

module.exports = { cleanMessage, summarizeTool, parseLimit };
