'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// Runs git; resolves with stdout, or null on failure. `okCodes` lists exit codes that still mean success
// (`git diff --no-index` exits 1 when the files differ).
function run(cwd, args, { okCodes = [0], maxBuffer = 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, '--no-optional-locks', ...args], { timeout: 8000, maxBuffer }, (err, out) => {
      if (!err) return resolve(out);
      if (err && okCodes.includes(err.code) && typeof out === 'string') return resolve(out);
      resolve(null);
    });
  });
}

// Branch and number of changed files for a folder; null when it is not a git repository.
async function gitInfo(cwd) {
  const branch = await run(cwd, ['branch', '--show-current']);
  if (branch === null) return null;
  const status = await run(cwd, ['status', '--porcelain']);
  const changed = status ? status.split('\n').filter((l) => l.trim()).length : 0;
  let name = branch.trim();
  if (!name) {
    const sha = await run(cwd, ['rev-parse', '--short', 'HEAD']);
    name = sha ? `@${sha.trim()}` : 'HEAD';
  }
  return { branch: name, changed };
}

// Splits a unified diff into files: { path, added, removed, lines }.
function parseDiff(text) {
  const files = [];
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.*)$/.exec(line);
      cur = { path: m ? m[1] : line.slice(11), added: 0, removed: 0, lines: [line] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.lines.push(line);
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) cur.added++;
    else if (line.startsWith('-')) cur.removed++;
  }
  for (const f of files) while (f.lines.length > 1 && f.lines[f.lines.length - 1] === '') f.lines.pop();
  return files;
}

const MAX_DIFF = 1.5 * 1024 * 1024;
const MAX_NEW_FILE = 200 * 1024;

// Uncommitted changes of a folder, against HEAD: tracked edits plus new (untracked) files.
async function gitDiff(cwd) {
  const info = await gitInfo(cwd);
  if (!info) return { error: 'Bu klasör bir git deposu değil.' };
  const opts = { maxBuffer: MAX_DIFF * 2 };
  const hasHead = (await run(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])) !== null;
  let diff = hasHead
    ? await run(cwd, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '-M'], opts)
    : ((await run(cwd, ['diff', '--cached', '--no-color', '--no-ext-diff'], opts)) || '') +
      ((await run(cwd, ['diff', '--no-color', '--no-ext-diff'], opts)) || '');
  diff = diff || '';
  const status = (await run(cwd, ['status', '--porcelain', '-uall'])) || '';
  const untracked = status
    .split('\n')
    .filter((l) => l.startsWith('?? '))
    .map((l) => l.slice(3).replace(/^"(.*)"$/, '$1'));
  const skipped = [];
  for (const f of untracked) {
    if (diff.length > MAX_DIFF) {
      skipped.push(f);
      continue;
    }
    let st = null;
    try {
      st = fs.statSync(path.join(cwd, f));
    } catch {}
    if (!st || !st.isFile() || st.size > MAX_NEW_FILE) {
      skipped.push(f);
      continue;
    }
    const d = await run(cwd, ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', '/dev/null', f], { okCodes: [1], ...opts });
    if (d) diff += (diff && !diff.endsWith('\n') ? '\n' : '') + d;
  }
  const truncated = diff.length > MAX_DIFF;
  if (truncated) diff = diff.slice(0, MAX_DIFF);
  const files = parseDiff(diff);
  for (const f of skipped) files.push({ path: f, added: 0, removed: 0, lines: [], note: 'yeni dosya (büyük ya da gösterilemiyor)' });
  return { branch: info.branch, dir: cwd, files, truncated };
}

module.exports = { gitInfo, gitDiff, parseDiff };
