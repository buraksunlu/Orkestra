'use strict';
// Owns the Claude Code sessions: one pty per session, its state, and what the hooks report about it.
const { EventEmitter } = require('events');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const { transition, isWaiting } = require('./states');
const { mergeLimits } = require('./limits');
const { cleanMessage, summarizeTool, parseLimit } = require('./text');
const { transcriptExists } = require('./history');
const { gitInfo } = require('./git');

// Variables a parent Claude Code session (or another terminal) sets; a fresh claude must not inherit them.
const STRIP_ENV = [
  /^CLAUDECODE$/,
  /^CLAUDE_PID$/,
  /^CLAUDE_EFFORT$/,
  /^CLAUDE_CODE_(ENTRYPOINT|EXECPATH|MESSAGING_.*|SESSION_.*|CHILD_.*)$/,
  /^TERM_PROGRAM(_VERSION)?$/,
  /^TERM_SESSION_ID$/,
  /^ITERM_.*$/,
  /^ORKESTRA_.*$/,
];

function cleanEnv(base) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (STRIP_ENV.some((re) => re.test(k))) continue;
    env[k] = v;
  }
  return env;
}

class SessionManager extends EventEmitter {
  constructor(ctx) {
    super();
    this.ctx = ctx; // { claude, PATH, settingsPath, inboxDir }
    this.sessions = new Map();
    this.order = [];
    this.limits = null; // account-wide rate limits from the newest status line
    this.gitTimer = setInterval(() => this.refreshAllGit(), 8000);
    this.remoteTimer = setInterval(() => this.refreshRemote(), 2000);
  }

  // ---- creation ----------------------------------------------------------

  create({ cwd, worktree = null, resumeId = null, name = null, model = null, effort = null }) {
    if (resumeId) {
      const open = this.list().find((s) => s.claudeId === resumeId || s.id === resumeId);
      if (open) return open.id;
    }
    const id = resumeId || crypto.randomUUID();
    const s = this._newRecord({ id, claudeId: id, cwd, worktree, name, model, effort });
    this.sessions.set(id, s);
    this.order.push(id);
    this._spawn(s, resumeId ? 'resume' : 'new');
    return id;
  }

  // Brings back a saved session. Running ones are resumed; ones that had already ended stay ended.
  restore(saved) {
    const s = this._newRecord(saved);
    s.state = 'exited';
    this.sessions.set(s.id, s);
    this.order.push(s.id);
    if (saved.alive !== false) this._spawn(s, transcriptExists(s.claudeId) ? 'resume' : 'new');
    else this._changed();
    return s.id;
  }

  // Makes sure a saved workspace member is a running session: finds it (by id, then conversation id),
  // starts it again if its claude has ended, or brings it back with --resume if it was closed. Returns its id.
  ensure(m) {
    const live = this.list().find((s) => s.id === m.id) || this.list().find((s) => s.claudeId && s.claudeId === m.claudeId);
    if (live) {
      if (!live.pty) this.restart(live.id);
      return live.id;
    }
    const dir = m.liveCwd || m.cwd;
    if (!dir || !fs.existsSync(dir)) return null;
    return this.restore({ ...m, alive: true });
  }

  // Answers Claude Code's permission dialog: "1" picks "Yes", Esc cancels (Claude stops and waits).
  // Only while the session is on a permission prompt; never on Claude's own question dialog.
  answer(id, allow) {
    const s = this.sessions.get(id);
    if (!s || !s.pty) return { ok: false, reason: 'Oturum kapalı.' };
    if (s.state !== 'ask' || s.askKind !== 'permission') return { ok: false, reason: 'Bu oturum izin beklemiyor.' };
    s.pty.write(allow ? '1' : '\x1b');
    this._apply(s, { type: allow ? 'input' : 'deny' });
    return { ok: true };
  }

  // ---- queue ---------------------------------------------------------------

  // "You've hit your session limit · resets 2:10pm": put a "continue" at the head of the queue, due a minute
  // after the reset. The renderer's queue loop sends it then.
  _checkLimit(s, text) {
    const hit = parseLimit(text, this.limits);
    if (!hit) return;
    s.limitHit = hit;
    if (!this.ctx.autoResume || this.ctx.autoResume()) {
      s.queue = s.queue.filter((q) => q.kind !== 'resume');
      s.queue.unshift({ id: crypto.randomUUID(), text: 'Kullanım limiti sıfırlandı. Kaldığın yerden devam et.', notBefore: hit.resetsAt + 60 * 1000, kind: 'resume' });
    }
    this.emit('limit', s, hit);
    this._changed();
  }

  // A name of the user's choosing; an empty one goes back to the folder name.
  rename(id, name) {
    const s = this.sessions.get(id);
    if (!s) return null;
    s.name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80) || path.basename(s.cwd) || s.cwd;
    this._changed();
    return s.name;
  }

  enqueue(id, text, { front = false } = {}) {
    const s = this.sessions.get(id);
    const t = String(text || '').trim();
    if (!s || !t) return null;
    const item = { id: crypto.randomUUID(), text: t };
    if (front) s.queue.unshift(item);
    else s.queue.push(item);
    this._changed();
    return item.id;
  }

  dequeue(id, itemId) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.queue = s.queue.filter((q) => q.id !== itemId);
    this._changed();
  }

  moveQueued(id, itemId, delta) {
    const s = this.sessions.get(id);
    if (!s) return;
    const i = s.queue.findIndex((q) => q.id === itemId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= s.queue.length) return;
    [s.queue[i], s.queue[j]] = [s.queue[j], s.queue[i]];
    this._changed();
  }

  pauseQueue(id, paused) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.queuePaused = !!paused;
    this._changed();
  }

  // Types one message and presses Enter. Slash commands go as typed keys so Claude Code runs them.
  _type(s, text) {
    const p = s.pty;
    if (/^\/[\w:-]+(\s[^\n]*)?$/.test(text)) p.write(text);
    else p.write(`\x1b[200~${text}\x1b[201~`);
    setTimeout(() => {
      if (s.pty === p) p.write('\r');
    }, 200);
  }

  // Sends the next queued message if the session is free for it. `force` ignores pause and notBefore
  // ("Şimdi gönder"). Returns what happened.
  sendQueued(id, { force = false, now = Date.now() } = {}) {
    const s = this.sessions.get(id);
    if (!s || !s.queue.length) return { ok: false, reason: 'Kuyruk boş.' };
    if (!s.pty) return { ok: false, reason: 'Oturum kapalı.' };
    if (s.state !== 'done' && s.state !== 'idle') return { ok: false, reason: 'Claude meşgul.' };
    const item = s.queue[0];
    if (!force && (s.queuePaused || (item.notBefore && item.notBefore > now))) return { ok: false, reason: 'Bekliyor.' };
    s.queue.shift();
    if (item.kind === 'resume') s.limitHit = null;
    this._type(s, item.text);
    // Slash commands send no UserPromptSubmit: mark the session busy now, and if no hook at all follows
    // (most built-in commands), settle back to idle after a few seconds.
    if (item.text.startsWith('/')) s.slashAt = now;
    this._apply(s, { type: 'prompt' });
    return { ok: true, item };
  }

  // Sends now when the session is free, otherwise queues it (front of the queue when `urgent`).
  sendOrQueue(id, text, { urgent = false } = {}) {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, reason: 'Oturum bulunamadı.' };
    const qid = this.enqueue(id, text, { front: urgent });
    if (!qid) return { ok: false, reason: 'Boş mesaj.' };
    if (s.queue[0].id === qid && !s.queuePaused) {
      const r = this.sendQueued(id, { force: true });
      if (r.ok) return { ok: true, sent: true };
    }
    return { ok: true, queued: true, position: s.queue.findIndex((q) => q.id === qid) + 1 };
  }

  // Folder whose git state the session shows.
  dirOf(s) {
    return (s.status && s.status.dir) || s.liveCwd || s.cwd;
  }

  restart(id) {
    const s = this.sessions.get(id);
    if (!s || s.pty) return;
    this._spawn(s, transcriptExists(s.claudeId) ? 'resume' : 'new');
  }

  _newRecord({ id, claudeId, cwd, liveCwd = null, worktree = null, name = null, model = null, effort = null, lastMsg = null, lastAt = null, queue = null, queuePaused = false }) {
    return {
      id,
      claudeId: claudeId || id,
      cwd,
      liveCwd: liveCwd || null,
      worktree,
      name: name || path.basename(cwd) || cwd,
      state: 'idle',
      since: Date.now(),
      askMsg: null,
      exitCode: null,
      status: null,
      git: null,
      pty: null,
      spawnedAt: 0,
      model: model || null, // per-conversation model alias (fable, opus, sonnet, haiku); null = user's default
      effort: effort || null, // per-conversation effort level; null = user's default
      remote: null, // Remote Control session id (session_...) while connected
      rcBusy: false,
      lastMsg: lastMsg || null, // Claude's last message, flattened (from the Stop hook)
      lastAt: lastAt || null,
      // Messages waiting to be sent one by one, each when the previous turn has finished.
      // { id, text, notBefore? (ms), kind? ('resume' = continue after a usage limit) }
      queue: Array.isArray(queue) ? queue.filter((q) => q && typeof q.text === 'string') : [],
      queuePaused: !!queuePaused,
      limitHit: null, // { kind, resetsAt } after "You've hit your … limit"
    };
  }

  _spawn(s, mode) {
    const { claude, PATH, settingsPath, inboxDir } = this.ctx;
    if (!claude) {
      this.emit('data', s.id, '\r\n\x1b[31mclaude bulunamadı. PATH içinde `claude` olmalı.\x1b[0m\r\n');
      this._apply(s, { type: 'exit', code: -1 });
      return;
    }
    if (s.pendingCwd) {
      s.cwd = s.pendingCwd;
      s.liveCwd = null;
      s.pendingCwd = null;
    }
    const args = [];
    let cwd = s.liveCwd || s.cwd;
    if (mode === 'resume') {
      args.push('--resume', s.claudeId);
    } else {
      args.push('--session-id', s.claudeId);
      // A worktree is only created on the very first start; later starts run inside it.
      if (s.worktree && !s.liveCwd) {
        args.push('--worktree', s.worktree);
        cwd = s.cwd;
      }
    }
    args.push('--settings', settingsPath, ...(this.ctx.extraArgs || []));
    // Command-line flags apply to this session only; /model and /effort would save a new global default.
    if (s.model) args.push('--model', s.model);
    if (s.effort) args.push('--effort', s.effort);
    // Remote Control is remembered per project: start connected when the project has it on.
    if (this.ctx.remoteFor && this.ctx.remoteFor(s.cwd)) args.push('--remote-control', s.name);

    const env = cleanEnv(process.env);
    Object.assign(env, {
      PATH,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: env.LANG || 'en_US.UTF-8',
      ORKESTRA_SESSION: s.id,
      ORKESTRA_INBOX: inboxDir,
    });

    let p;
    try {
      p = pty.spawn(claude, args, { name: 'xterm-256color', cols: s.cols || 120, rows: s.rows || 32, cwd, env });
    } catch (e) {
      this.emit('data', s.id, `\r\n\x1b[31mclaude başlatılamadı: ${e.message}\x1b[0m\r\n`);
      this._apply(s, { type: 'exit', code: -1 });
      return;
    }
    s.pty = p;
    s.spawnedAt = Date.now();
    s.bootOut = '';
    this.emit('reset', s.id);
    this._apply(s, { type: 'spawn' });
    p.onData((d) => {
      if (s.tap) s.tap(d);
      if (s.bootOut !== null && s.bootOut.length < 4000) s.bootOut += d;
      this.emit('data', s.id, d);
    });
    p.onExit(({ exitCode }) => {
      if (s.pty !== p) return;
      s.pty = null;
      s.remote = null;
      if (this.quitting) return;
      if (s.respawn) {
        const m = s.respawn;
        s.respawn = null;
        this._spawn(s, m);
        return;
      }
      // A session that never had a real message has a record but no conversation, so --resume refuses it.
      // Start it fresh with the same id instead.
      if (mode === 'resume' && Date.now() - s.spawnedAt < 15000 && /No conversation found/i.test(s.bootOut || '')) {
        s.bootOut = null;
        this._spawn(s, 'new');
        return;
      }
      this._apply(s, { type: 'exit', code: exitCode });
    });
    this.refreshGit(s);
  }

  // ---- terminal I/O ------------------------------------------------------

  write(id, data) {
    const s = this.sessions.get(id);
    if (s && s.pty) s.pty.write(data);
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (!s || !cols || !rows) return;
    s.cols = cols;
    s.rows = rows;
    if (s.pty) {
      try {
        s.pty.resize(cols, rows);
      } catch {}
    }
  }

  // Sends one message as if typed and submitted. Sessions waiting on a prompt are skipped so the text can
  // never answer a permission question by accident.
  broadcast(ids, text) {
    const sent = [];
    const skipped = [];
    for (const id of ids) {
      const s = this.sessions.get(id);
      if (!s) continue;
      if (!s.pty || s.state === 'ask' || s.state === 'exited') {
        skipped.push({ id, name: s.name, reason: s.state === 'ask' ? 'izin bekliyor' : 'kapalı' });
        continue;
      }
      s.pty.write(`\x1b[200~${text}\x1b[201~`);
      const p = s.pty;
      setTimeout(() => {
        if (s.pty === p) p.write('\r');
      }, 150);
      sent.push({ id, name: s.name });
    }
    return { sent, skipped };
  }

  // ---- state -------------------------------------------------------------

  ui(id, type) {
    const s = this.sessions.get(id);
    if (s) this._apply(s, { type });
  }

  _apply(s, ev) {
    const before = s.state;
    const change = transition(s, ev);
    if (change) Object.assign(s, change);
    // The tool that asked for permission is no longer waiting once the prompt is left or the turn moves on.
    // (PermissionRequest arrives seconds before the orange notification; a click in between must keep it.)
    if (change && s.state !== 'ask' && (before === 'ask' || ['prompt', 'stop', 'exit', 'spawn'].includes(ev.type))) s.pending = null;
    if (change && s.state !== before && isWaiting(s.state)) this.emit('waiting', s);
    if (ev.type === 'stop') this.refreshGit(s);
    this._changed();
  }

  // One event from the hook inbox.
  handleEvent({ session, kind, data }) {
    const s = this.sessions.get(session);
    if (!s) return;
    if (kind !== 'status') s.slashAt = 0; // a hook arrived: the slash command we typed is being handled
    if (data && data.session_id && data.session_id !== s.claudeId) s.claudeId = data.session_id;
    if (kind === 'status') {
      this._status(s, data || {});
      return;
    }
    if (data && data.cwd && kind === 'start') this._setLiveCwd(s, data.cwd);
    switch (kind) {
      case 'prompt':
      case 'posttool':
        this._apply(s, { type: kind });
        break;
      case 'stop':
        if (data && typeof data.last_assistant_message === 'string') {
          s.lastMsg = cleanMessage(data.last_assistant_message);
          s.lastAt = Date.now();
          this._checkLimit(s, data.last_assistant_message);
        }
        this._apply(s, { type: 'stop', tasks: data && data.background_tasks });
        break;
      case 'stopfail': {
        // The turn ended on an API error (usage limit, network...). Claude is not working any more.
        const text = JSON.stringify(data || {});
        const msg = (data && (data.last_assistant_message || data.error_message || data.message)) || '';
        if (msg) {
          s.lastMsg = cleanMessage(String(msg));
          s.lastAt = Date.now();
        }
        this._checkLimit(s, text);
        this._apply(s, { type: 'stop' });
        break;
      }
      case 'precompact':
        s.compacting = true;
        if (data && data.trigger === 'manual') this._apply(s, { type: 'prompt' });
        else this._changed();
        break;
      case 'postcompact':
        s.compacting = false;
        // A manual /compact is a job of its own: done. An automatic one happens inside a running turn.
        if (data && data.trigger === 'manual') this._apply(s, { type: 'stop' });
        else this._changed();
        break;
      case 'permreq':
        s.pending = summarizeTool(data && data.tool_name, data && data.tool_input, os.homedir());
        this._changed();
        break;
      case 'notify': {
        const kind = data && data.notification_type === 'elicitation_dialog' ? 'question' : 'permission';
        const pending = s.pending;
        this._apply(s, { type: 'notify', message: data && data.message, askKind: kind });
        if (kind === 'permission') s.pending = pending;
        break;
      }
      case 'askq': {
        const pending = summarizeTool('AskUserQuestion', data && data.tool_input);
        this._apply(s, { type: 'askq', message: 'Claude bir soru soruyor' });
        s.pending = pending;
        break;
      }
      default:
        this._changed();
    }
  }

  _status(s, d) {
    const cw = d.context_window || {};
    s.status = {
      model: d.model && d.model.display_name,
      effort: d.effort && d.effort.level,
      ctx: typeof cw.used_percentage === 'number' ? Math.floor(cw.used_percentage) : null,
      cost: d.cost && typeof d.cost.total_cost_usd === 'number' ? d.cost.total_cost_usd : null,
      dir: (d.workspace && d.workspace.current_dir) || d.cwd || null,
      projectDir: (d.workspace && d.workspace.project_dir) || null,
    };
    if (d.rate_limits && (d.rate_limits.five_hour || d.rate_limits.seven_day)) {
      this.limits = mergeLimits(this.limits, d.rate_limits);
    }
    this._changed();
  }

  // The folder claude actually started in (differs from cwd for a new worktree). Later starts use it.
  _setLiveCwd(s, dir) {
    if (!dir || dir === s.liveCwd || dir === s.cwd) return;
    s.liveCwd = dir;
    this.refreshGit(s);
  }

  async refreshGit(s) {
    const dir = this.dirOf(s);
    const g = await gitInfo(dir);
    const prev = JSON.stringify(s.git);
    s.git = g;
    if (JSON.stringify(g) !== prev) this._changed();
  }

  refreshAllGit() {
    for (const s of this.sessions.values()) if (s.pty) this.refreshGit(s);
  }

  _changed() {
    if (this._pending) return;
    this._pending = setTimeout(() => {
      this._pending = null;
      this.emit('change');
    }, 60);
  }

  // A project folder moved: sessions that are not running start in the new place next time.
  // Running sessions keep their process; they pick up the new folder when restarted.
  relocate(oldDir, newDir) {
    for (const s of this.sessions.values()) {
      if (s.cwd !== oldDir) continue;
      s.pendingCwd = newDir;
      if (!s.pty) {
        s.cwd = newDir;
        s.liveCwd = null;
        s.pendingCwd = null;
      }
    }
    this._changed();
  }

  // ---- model and effort --------------------------------------------------

  // Restarts the conversation with a new model and/or effort; the conversation itself continues (--resume).
  setModel(id, { model, effort }) {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, reason: 'Oturum bulunamadı.' };
    if (s.state === 'running' || s.state === 'ask') return { ok: false, reason: 'Claude çalışırken değiştirilemez, bitmesini bekle.' };
    s.model = model || null;
    s.effort = effort || null;
    const mode = transcriptExists(s.claudeId) ? 'resume' : 'new';
    if (s.pty) {
      s.respawn = mode;
      try {
        s.pty.kill();
      } catch {}
    } else {
      this._spawn(s, mode);
    }
    this._changed();
    return { ok: true };
  }

  // ---- Remote Control ----------------------------------------------------

  // Claude Code writes ~/.claude/sessions/<pid>.json; bridgeSessionId is set while Remote Control is connected.
  readRemote(s) {
    if (!s.pty) return null;
    try {
      const f = path.join(os.homedir(), '.claude', 'sessions', `${s.pty.pid}.json`);
      return JSON.parse(fs.readFileSync(f, 'utf8')).bridgeSessionId || null;
    } catch {
      return null;
    }
  }

  refreshRemote() {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (s.slashAt && now - s.slashAt > 8000) {
        s.slashAt = 0;
        this._apply(s, { type: 'settle' });
      }
    }
    let changed = false;
    for (const s of this.sessions.values()) {
      const r = this.readRemote(s);
      if (r !== s.remote) {
        s.remote = r;
        changed = true;
      }
    }
    if (changed) this._changed();
  }

  async _waitFor(fn, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (fn()) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return fn();
  }

  // Turns Remote Control on or off in a running session by typing Claude Code's own /remote-control command.
  // Off: the command opens a menu (Disconnect this session / Show QR code / Continue, cursor on Continue).
  async toggleRemote(id, on) {
    const s = this.sessions.get(id);
    if (!s || !s.pty) return { ok: false, reason: 'Oturum kapalı.' };
    if (s.rcBusy) return { ok: false, reason: 'Zaten değiştiriliyor.' };
    if (s.state === 'running' || s.state === 'ask') return { ok: false, reason: 'Claude çalışırken değiştirilemez, bitmesini bekle.' };
    s.remote = this.readRemote(s);
    if (!!s.remote === on) return { ok: true };
    s.rcBusy = true;
    this._changed();
    const p = s.pty;
    let out = '';
    s.tap = (d) => (out += d.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, ' '));
    try {
      p.write('/remote-control');
      await new Promise((r) => setTimeout(r, 300));
      p.write('\r');
      if (on) {
        await this._waitFor(() => !!this.readRemote(s), 15000);
      } else {
        const menu = await this._waitFor(() => /Disconnect\s*this\s*session/.test(out), 5000);
        if (!menu) return { ok: false, reason: 'Remote Control menüsü açılmadı.' };
        p.write('\x1b[A');
        await new Promise((r) => setTimeout(r, 150));
        p.write('\x1b[A');
        await new Promise((r) => setTimeout(r, 150));
        p.write('\r');
        await this._waitFor(() => !this.readRemote(s), 6000);
      }
      s.remote = this.readRemote(s);
      const ok = !!s.remote === on;
      return ok ? { ok: true } : { ok: false, reason: on ? 'Remote Control açılamadı (claude.ai girişi gerekli olabilir).' : 'Remote Control kapatılamadı.' };
    } finally {
      s.tap = null;
      s.rcBusy = false;
      this._changed();
    }
  }

  // ---- list --------------------------------------------------------------

  list() {
    return this.order.map((id) => this.sessions.get(id)).filter(Boolean);
  }

  move(id, toIndex) {
    const i = this.order.indexOf(id);
    if (i < 0) return;
    this.order.splice(i, 1);
    this.order.splice(Math.max(0, Math.min(toIndex, this.order.length)), 0, id);
    this._changed();
  }

  remove(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.pty) {
      const p = s.pty;
      s.pty = null;
      try {
        p.kill();
      } catch {}
    }
    this.sessions.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this._changed();
  }

  busy() {
    return this.list().filter((s) => s.pty && (s.state === 'running' || s.state === 'ask'));
  }

  killAll() {
    this.quitting = true;
    clearInterval(this.gitTimer);
    clearInterval(this.remoteTimer);
    for (const s of this.sessions.values()) {
      if (s.pty) {
        try {
          s.pty.kill();
        } catch {}
      }
    }
  }

  snapshot() {
    const sessions = this.list().map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      liveCwd: s.liveCwd,
      worktree: s.worktree,
      state: s.state,
      since: s.since,
      askMsg: s.askMsg,
      askKind: s.askKind || null,
      pending: s.pending || null,
      lastMsg: s.lastMsg || null,
      lastAt: s.lastAt || null,
      queue: s.queue,
      queuePaused: s.queuePaused,
      limitHit: s.limitHit,
      compacting: !!s.compacting,
      bg: s.bg || null,
      exitCode: s.exitCode,
      status: s.status,
      git: s.git,
      alive: !!s.pty,
      remote: s.remote,
      rcBusy: s.rcBusy,
      model: s.model,
      effort: s.effort,
    }));
    return { sessions, limits: this.limits };
  }

  // What the workspace file keeps.
  saved() {
    return this.list().map((s) => ({
      id: s.id,
      claudeId: s.claudeId,
      cwd: s.cwd,
      liveCwd: s.liveCwd,
      worktree: s.worktree,
      name: s.name,
      model: s.model,
      effort: s.effort,
      lastMsg: s.lastMsg || null,
      lastAt: s.lastAt || null,
      queue: s.queue,
      queuePaused: s.queuePaused,
      alive: !!s.pty || s.state !== 'exited',
    }));
  }
}

module.exports = { SessionManager, cleanEnv };
