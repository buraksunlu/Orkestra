'use strict';
// The hook script drops one JSON file per event into the inbox folder; this module picks them up in order.
// File name: <unix-ms>_<pid>_<random>__<orkestra-session-id>__<kind>.json
const fs = require('fs');
const path = require('path');

function parseName(name) {
  if (name.startsWith('.') || !name.endsWith('.json')) return null;
  const parts = name.slice(0, -'.json'.length).split('__');
  if (parts.length !== 3) return null;
  const [stamp, session, kind] = parts;
  const ts = Number(stamp.split('_')[0]);
  if (!session || !kind || !Number.isFinite(ts)) return null;
  return { ts, session, kind };
}

class Inbox {
  constructor(dir, onEvent) {
    this.dir = dir;
    this.onEvent = onEvent;
    this.busy = false;
    this.again = false;
    fs.mkdirSync(dir, { recursive: true });
  }

  start() {
    // Leftovers from a previous run belong to sessions that no longer exist.
    for (const f of fs.readdirSync(this.dir)) fs.rmSync(path.join(this.dir, f), { force: true });
    try {
      this.watcher = fs.watch(this.dir, () => this.sweep());
    } catch {}
    // FSEvents can coalesce or drop notifications; a slow sweep makes sure nothing is missed.
    this.timer = setInterval(() => this.sweep(), 1000);
  }

  stop() {
    if (this.watcher) this.watcher.close();
    clearInterval(this.timer);
  }

  sweep() {
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    try {
      let names;
      try {
        names = fs.readdirSync(this.dir);
      } catch {
        return;
      }
      const items = names
        .map((n) => ({ n, p: parseName(n) }))
        .filter((x) => x.p)
        .sort((a, b) => a.p.ts - b.p.ts || (a.n < b.n ? -1 : 1));
      for (const { n, p } of items) {
        const full = path.join(this.dir, n);
        let data = null;
        try {
          const raw = fs.readFileSync(full, 'utf8');
          data = raw.trim() ? JSON.parse(raw) : {};
        } catch {
          data = {};
        }
        fs.rmSync(full, { force: true });
        try {
          this.onEvent({ ...p, data });
        } catch (e) {
          console.error('[orkestra] inbox event failed', e);
        }
      }
    } finally {
      this.busy = false;
      if (this.again) {
        this.again = false;
        setImmediate(() => this.sweep());
      }
    }
  }
}

module.exports = { Inbox, parseName };
