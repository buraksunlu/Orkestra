'use strict';
const { app, BrowserWindow, ipcMain, Menu, Notification, dialog, clipboard, shell, Tray, nativeImage, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const claudeEnv = require('./claudeEnv');
const { SessionManager } = require('./sessions');
const { Inbox } = require('./inbox');
const { listConversations } = require('./history');
const { nextWaiting, isWaiting } = require('./states');
const workspace = require('./workspace');
const catalog = require('./catalog');
const spaces = require('./spaces');
const { gitDiff } = require('./git');
const { searchConversations } = require('./search');

// User preferences (saved in workspace.json). warnCtx: context % at which the compact button warns.
const PREF_DEFAULTS = { warnCtx: 50, autoResume: true, keepAwake: true };
const pref = (k) => (ws.prefs && k in ws.prefs ? ws.prefs[k] : PREF_DEFAULTS[k]);

app.setName('Orkestra');
// Development aid (ORKESTRA_SNAPSHOT): keep painting while the test window sits behind other windows.
if (process.env.ORKESTRA_SNAPSHOT) {
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
}
const DATA = process.env.ORKESTRA_DATA || app.getPath('userData');
const WS_FILE = path.join(DATA, 'workspace.json');
const PROJECTS_DIR = path.join(os.homedir(), 'Projects');

let win = null;
let mgr = null;
let inbox = null;
let ws = { sessions: [], ui: {}, recent: [], spaces: [] };
let tray = null;
let view = { visible: [], focused: null }; // what the renderer shows right now
let quitConfirmed = false;

// ---------------------------------------------------------------- window

function createWindow() {
  const b = ws.ui.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1500,
    height: b.height || 920,
    x: b.x,
    y: b.y,
    minWidth: 900,
    minHeight: 500,
    title: 'Orkestra',
    backgroundColor: '#0b0d10',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The queue and the limit auto-continue run in the page: keep its timers going while the window is hidden.
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.env.ORKESTRA_DEBUG) {
    win.webContents.on('console-message', (e) => console.log('[renderer]', e.level, e.message, e.sourceId ? `${path.basename(e.sourceId)}:${e.lineNumber}` : ''));
    win.webContents.on('render-process-gone', (_e, d) => console.log('[renderer gone]', JSON.stringify(d)));
    win.webContents.on('did-start-navigation', (d) => console.log('[nav]', d.url));
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  win.on('close', (e) => {
    if (!confirmQuit()) e.preventDefault();
    else saveWorkspace();
  });
  win.on('focus', () => updateBadge());
  win.on('closed', () => {
    win = null;
  });
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

// ---------------------------------------------------------------- quit

function confirmQuit() {
  if (quitConfirmed) return true;
  const busy = mgr ? mgr.busy() : [];
  if (busy.length) {
    const names = busy.map((s) => `• ${s.name} (${s.state === 'ask' ? 'izin bekliyor' : s.bg && s.bg.length ? 'arka planda iş sürüyor' : 'çalışıyor'})`).join('\n');
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Kapat', 'Vazgeç'],
      defaultId: 1,
      cancelId: 1,
      message: 'Çalışan oturumlar var',
      detail: `${names}\n\nUygulama kapanınca bu işler yarıda kalır. Konuşmalar bir sonraki açılışta kaldığı yerden devam eder.`,
    });
    if (r !== 0) return false;
  }
  quitConfirmed = true;
  return true;
}

app.on('before-quit', (e) => {
  if (!confirmQuit()) {
    e.preventDefault();
    return;
  }
  saveWorkspace();
});

app.on('will-quit', () => {
  if (inbox) inbox.stop();
  if (mgr) mgr.killAll();
});

app.on('window-all-closed', () => app.quit());

// ---------------------------------------------------------------- workspace

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveWorkspace, 800);
}

function saveWorkspace() {
  if (!mgr) return;
  if (win && !win.isDestroyed()) ws.ui.bounds = win.getBounds();
  ws.sessions = mgr.saved();
  ws.spaces = spaces.sync(ws.spaces || [], mgr.list());
  ws.ui.visible = view.visible;
  ws.ui.focused = view.focused;
  if (mgr.limits) ws.limits = mgr.limits;
  if (view.layout) ws.ui.layout = view.layout;
  try {
    workspace.save(WS_FILE, ws);
  } catch (e) {
    console.error('[orkestra] workspace save failed', e);
  }
}

function spacesChanged() {
  scheduleSave();
  send('state', stateSnapshot());
  menu();
  updateTray();
}

// ---------------------------------------------------------------- menu bar (tray)
// The conductor silhouette in the macOS menu bar. Its title shows what waits for the user and the 5h limit;
// clicking it lists the sessions and workspaces.

const STATE_ICON = { done: '🟢', ask: '🟠', running: '🟡', idle: '⚪️', exited: '⚫️' };
const STATE_WORD = { done: 'bitti', ask: 'izin bekliyor', running: 'çalışıyor', idle: 'boşta', exited: 'kapalı' };

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function trayTitle() {
  const list = mgr ? mgr.list() : [];
  const done = list.filter((s) => s.state === 'done').length;
  const ask = list.filter((s) => s.state === 'ask').length;
  const parts = [];
  if (ask) parts.push(`🟠${ask}`);
  if (done) parts.push(`🟢${done}`);
  const five = mgr && mgr.limits && mgr.limits.five_hour;
  if (five && typeof five.used_percentage === 'number' && !(five.resets_at && five.resets_at * 1000 <= Date.now())) {
    parts.push(`${Math.floor(five.used_percentage)}%`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function trayMenu() {
  const items = [];
  const five = mgr && mgr.limits && mgr.limits.five_hour;
  if (five && typeof five.used_percentage === 'number') {
    const at = five.resets_at ? new Date(five.resets_at * 1000).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : '';
    items.push({ label: `5h limit: ${Math.floor(five.used_percentage)}%${at ? ` · ↻ ${at}` : ''}`, enabled: false }, { type: 'separator' });
  }
  const list = mgr ? mgr.list() : [];
  if (!list.length) items.push({ label: 'Açık oturum yok', enabled: false });
  for (const s of list) {
    let word = STATE_WORD[s.state] || '';
    if (s.state === 'running' && s.bg && s.bg.length) word = 'arka planda iş sürüyor';
    items.push({
      label: `${STATE_ICON[s.state] || '⚪️'}  ${s.name} — ${word}`,
      click: () => {
        showWindow();
        send('focus-session', s.id);
      },
    });
  }
  const sp = ws.spaces || [];
  if (sp.length) {
    items.push({ type: 'separator' }, { label: 'Çalışma alanları', enabled: false });
    for (const x of sp) {
      items.push({
        label: `   ${x.name} (${x.members.length})`,
        click: () => {
          showWindow();
          send('command', 'openSpace', x.id);
        },
      });
    }
  }
  items.push(
    { type: 'separator' },
    { label: awakeId !== null ? '☕ Claude çalışıyor: Mac uyumuyor' : '☕ Uyku engeli: şu an gerek yok', enabled: false },
    { label: 'Claude çalışırken uykuyu engelle', type: 'checkbox', checked: pref('keepAwake'), click: (m) => calls.setPref('keepAwake', m.checked) },
    { label: 'Limit dolunca sıfırlanınca devam et', type: 'checkbox', checked: pref('autoResume'), click: (m) => calls.setPref('autoResume', m.checked) },
    { type: 'separator' },
    { label: 'Orkestra’yı göster', click: showWindow },
    {
      label: 'Yeni oturum…',
      click: () => {
        showWindow();
        send('command', 'newSession');
      },
    },
    { type: 'separator' },
    { label: 'Çık', click: () => app.quit() },
  );
  return Menu.buildFromTemplate(items);
}

function setupTray() {
  const file = path.join(__dirname, '..', 'assets', 'trayTemplate.png');
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) return;
  img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('Orkestra');
  tray.on('click', () => tray.popUpContextMenu(trayMenu()));
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
  updateTray();
}

let lastTrayTitle = null;
function updateTray() {
  if (!tray) return;
  const t = trayTitle();
  if (t !== lastTrayTitle) {
    tray.setTitle(t, { fontType: 'monospacedDigit' });
    lastTrayTitle = t;
    if (process.env.ORKESTRA_DEBUG) console.log('[orkestra] tray title', JSON.stringify(t));
  }
}

// ---------------------------------------------------------------- notifications and badge

function waitingCount() {
  return mgr ? mgr.list().filter((s) => isWaiting(s.state)).length : 0;
}

function notifyInfo(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
}

// ---------------------------------------------------------------- keep the Mac awake while Claude works
let awakeId = null;
function updateAwake() {
  const busy = mgr && mgr.list().some((s) => s.pty && (s.state === 'running' || s.state === 'ask'));
  const want = busy && pref('keepAwake');
  if (want && awakeId === null) awakeId = powerSaveBlocker.start('prevent-app-suspension');
  if (!want && awakeId !== null) {
    powerSaveBlocker.stop(awakeId);
    awakeId = null;
  }
}

function updateBadge() {
  const n = waitingCount();
  if (app.dock) app.dock.setBadge(n ? String(n) : '');
}

function onWaiting(s) {
  updateBadge();
  const onScreen = view.visible.includes(s.id);
  const focused = win && !win.isDestroyed() && win.isFocused();
  if (focused && onScreen) return;
  if (!Notification.isSupported()) return;
  const title = s.state === 'ask' ? `⏳ ${s.name}: girdi bekliyor` : `✔ ${s.name}: iş bitti`;
  const asking = s.pending && (s.pending.text ? `${s.pending.tool}: ${s.pending.text}` : s.pending.tool);
  const body =
    s.state === 'ask'
      ? (s.askKind === 'permission' && asking ? `İzin istiyor · ${asking}` : asking) || s.askMsg || 'Claude izin ya da cevap bekliyor'
      : s.lastMsg
        ? s.lastMsg.slice(0, 220)
        : 'Sıra sende.';
  const permission = s.state === 'ask' && s.askKind === 'permission';
  const n = new Notification({
    title,
    body,
    silent: false,
    sound: s.state === 'ask' ? 'Glass' : 'Tink',
    // Answer without opening the window: approve/deny a permission prompt, or reply to a finished session.
    actions: permission ? [{ type: 'button', text: '✓ Onayla' }, { type: 'button', text: '✕ Reddet' }] : [],
    hasReply: s.state === 'done',
    replyPlaceholder: 'Claude’a cevap yaz…',
  });
  n.on('click', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    send('focus-session', s.id);
  });
  // The renderer checks that the dialog is really on the terminal screen before pressing anything.
  n.on('action', (_e, index) => send('command', 'answerPermission', { id: s.id, allow: index === 0 }));
  n.on('reply', (_e, text) => {
    const r = mgr.sendOrQueue(s.id, text);
    if (r.queued) notifyInfo(`${s.name}: mesaj kuyruğa eklendi`, 'Claude şu an meşgul, sırası gelince gönderilecek.');
  });
  n.show();
}

// ---------------------------------------------------------------- pty data batching

const outBuf = new Map();
let flushTimer = null;
function queueData(id, data) {
  outBuf.set(id, (outBuf.get(id) || '') + data);
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      for (const [k, v] of outBuf) send('pty-data', k, v);
      outBuf.clear();
    }, 8);
  }
}

// ---------------------------------------------------------------- folder picker data

function listProjectFolders() {
  const out = [];
  try {
    for (const d of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
      if (d.isDirectory() && !d.name.startsWith('.')) out.push(path.join(PROJECTS_DIR, d.name));
    }
  } catch {}
  out.sort((a, b) => a.localeCompare(b, 'tr'));
  return out;
}

function folderList() {
  ws.catalog = catalog.normalize(ws.catalog);
  return {
    sections: catalog.sections(ws.catalog, {
      discovered: listProjectFolders(),
      recent: ws.recent,
      home: os.homedir(),
      exists: (p) => fs.existsSync(p),
    }),
    categories: ws.catalog.categories,
  };
}

function saveCatalog(c) {
  ws.catalog = c;
  scheduleSave();
  send('state', stateSnapshot()); // the sidebar groups sessions by these categories
  return folderList();
}

// Session list plus project categories, for the sidebar.
function stateSnapshot() {
  const snap = mgr.snapshot();
  const cat = catalog.normalize(ws.catalog);
  for (const s of snap.sessions) s.category = catalog.categoryOf(cat, s.cwd);
  snap.categories = cat.categories;
  snap.spaces = ws.spaces || [];
  snap.prefs = { ...PREF_DEFAULTS, ...(ws.prefs || {}) };
  snap.awake = awakeId !== null;
  return snap;
}

function isGitRepo(dir) {
  let cur = dir;
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(path.join(cur, '.git'))) return true;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return false;
}

// ---------------------------------------------------------------- Remote Control preference (per project folder)

function setRemotePref(cwd, on) {
  if (on) ws.remoteProjects[cwd] = true;
  else delete ws.remoteProjects[cwd];
  scheduleSave();
}

// Copies of dropped files are kept for a week, long enough for Claude to read them.
function cleanDrops() {
  const dir = path.join(DATA, 'drops');
  const old = Date.now() - 7 * 24 * 3600 * 1000;
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).mtimeMs < old) fs.rmSync(p, { force: true });
    }
  } catch {}
}

// ---------------------------------------------------------------- IPC

const calls = {
  snapshot: () => stateSnapshot(),
  initial: () => ({ ui: ws.ui, home: os.homedir(), savedCount: ws.sessions.length }),
  folders: () => folderList(),
  addCategory: (name) => {
    const r = catalog.addCategory(ws.catalog, name);
    ws.catalog = r.catalog;
    scheduleSave();
    send('state', stateSnapshot());
    return { id: r.id, ...folderList() };
  },
  renameCategory: (id, name) => saveCatalog(catalog.renameCategory(ws.catalog, id, name)),
  deleteCategory: (id) => saveCatalog(catalog.deleteCategory(ws.catalog, id)),
  moveCategory: (id, index) => saveCatalog(catalog.moveCategory(ws.catalog, id, index)),
  setCategory: (dir, catId) => saveCatalog(catalog.setCategory(ws.catalog, dir, catId)),
  addFolder: (dir, catId) => {
    if (!dir || !fs.existsSync(dir)) return { error: 'Klasör bulunamadı.' };
    return saveCatalog(catalog.addFolder(ws.catalog, dir, catId));
  },
  hideFolder: (dir) => saveCatalog(catalog.hide(ws.catalog, dir, { wasDiscovered: listProjectFolders().includes(dir) })),
  // New name and/or path for a project. A new path must exist; projects-wide settings follow the move.
  editFolder: (oldDir, { name, path: newDir }) => {
    const target = (newDir || '').trim().replace(/\/+$/, '') || oldDir;
    if (target !== oldDir) {
      let st = null;
      try {
        st = fs.statSync(target);
      } catch {}
      if (!st || !st.isDirectory()) return { error: `Klasör bulunamadı: ${target}` };
    }
    ws.catalog = catalog.editItem(ws.catalog, oldDir, { name, path: target }, { wasDiscovered: listProjectFolders().includes(oldDir) });
    if (target !== oldDir) {
      ws.recent = ws.recent.map((d) => (d === oldDir ? target : d)).filter((d, i, a) => a.indexOf(d) === i);
      if (ws.remoteProjects[oldDir]) {
        ws.remoteProjects[target] = true;
        delete ws.remoteProjects[oldDir];
      }
      mgr.relocate(oldDir, target);
    }
    scheduleSave();
    send('state', stateSnapshot());
    return { path: target, ...folderList() };
  },
  folderInfo: (dir) => ({ git: isGitRepo(dir), conversations: listConversations(dir) }),
  pickFolder: async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: PROJECTS_DIR,
    });
    return r.canceled ? null : r.filePaths[0];
  },
  newSession: ({ cwd, worktree, resumeId, remote, model, effort }) => {
    if (!cwd || !fs.existsSync(cwd)) return null;
    if (typeof remote === 'boolean') setRemotePref(cwd, remote);
    const base = path.basename(cwd);
    const name = worktree ? `${base} ⎇ ${worktree}` : base;
    const id = mgr.create({ cwd, worktree: worktree || null, resumeId: resumeId || null, name, model, effort });
    ws.recent = workspace.addRecent(ws.recent, cwd);
    scheduleSave();
    return id;
  },
  // The ＋ at the top: a plain Claude on the Desktop, no project to pick.
  quickSession: () => {
    const cwd = app.getPath('desktop');
    if (!fs.existsSync(cwd)) return null;
    return mgr.create({ cwd, name: 'Masaüstü' });
  },
  restart: (id) => mgr.restart(id),
  renameSession: (id, name) => {
    const r = mgr.rename(id, name);
    scheduleSave();
    return r;
  },
  remotePref: (cwd) => !!ws.remoteProjects[cwd],
  setModel: (id, opts) => {
    const r = mgr.setModel(id, opts || {});
    scheduleSave();
    return r;
  },
  toggleRemote: async (id, on) => {
    const r = await mgr.toggleRemote(id, on);
    const s = mgr.sessions.get(id);
    if (r.ok && s) setRemotePref(s.cwd, on);
    return r;
  },
  closeSession: async (id) => {
    const s = mgr.sessions.get(id);
    if (!s) return false;
    if (s.pty) {
      const r = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Oturumu kapat', 'Vazgeç'],
        defaultId: 1,
        cancelId: 1,
        message: `“${s.name}” oturumu kapatılsın mı?`,
        detail: 'Claude süreci sonlanır. Konuşma kaybolmaz, ⌘N → eski konuşmalar ile geri açabilirsin.',
      });
      if (r.response !== 0) return false;
    }
    mgr.remove(id);
    scheduleSave();
    return true;
  },
  move: (id, index) => {
    mgr.move(id, index);
    scheduleSave();
  },
  broadcast: (ids, text) => mgr.broadcast(ids, text),
  answer: (id, allow) => mgr.answer(id, !!allow),
  // ---- queue
  enqueue: (id, text, front) => mgr.enqueue(id, text, { front: !!front }),
  dequeue: (id, itemId) => mgr.dequeue(id, itemId),
  moveQueued: (id, itemId, delta) => mgr.moveQueued(id, itemId, delta),
  pauseQueue: (id, paused) => mgr.pauseQueue(id, paused),
  sendQueued: (id, force) => mgr.sendQueued(id, { force: !!force }),
  sendOrQueue: (id, text, urgent) => mgr.sendOrQueue(id, text, { urgent: !!urgent }),
  // ---- search and preferences
  search: (q) => searchConversations(q),
  setPref: (k, v) => {
    if (!(k in PREF_DEFAULTS)) return;
    ws.prefs = { ...(ws.prefs || {}), [k]: v };
    scheduleSave();
    updateAwake();
    send('state', stateSnapshot());
    updateTray();
  },
  diff: async (id) => {
    const s = mgr.sessions.get(id);
    if (!s) return { error: 'Oturum bulunamadı.' };
    const r = await gitDiff(mgr.dirOf(s));
    mgr.refreshGit(s);
    return r;
  },
  // ---- workspaces
  saveSpace: (name, ids, layout) => {
    const members = (ids || []).map((id) => mgr.sessions.get(id)).filter(Boolean);
    try {
      ws.spaces = spaces.upsert(ws.spaces || [], { name, members, layout: layout || null });
    } catch (e) {
      return { error: e.message };
    }
    spacesChanged();
    return { ok: true };
  },
  renameSpace: (id, name) => {
    ws.spaces = spaces.rename(ws.spaces || [], id, name);
    spacesChanged();
  },
  deleteSpace: (id) => {
    ws.spaces = spaces.remove(ws.spaces || [], id);
    spacesChanged();
  },
  // Brings every member up (resuming closed ones) and returns their ids in screen order.
  openSpace: (id) => {
    const sp = (ws.spaces || []).find((x) => x.id === id);
    if (!sp) return { error: 'Çalışma alanı bulunamadı.' };
    const ids = [];
    const missing = [];
    const map = {}; // saved member id -> live session id (the layout tree uses the saved ids)
    for (const m of sp.members) {
      const sid = mgr.ensure(m);
      if (sid) {
        ids.push(sid);
        map[m.id] = sid;
      } else missing.push(m.name);
    }
    scheduleSave();
    return { ids, map, layout: sp.layout, name: sp.name, missing };
  },
  nextWaiting: (currentId) => nextWaiting(mgr.list(), currentId),
  clipboardRead: () => ({ text: clipboard.readText(), image: !clipboard.readImage().isEmpty() }),
  // An image on the clipboard (e.g. ⌃⇧⌘4) saved as a PNG in drops/, so it can be pasted as a path like a dropped
  // file. Claude Code's own clipboard read (Ctrl+V) does not reliably reach the image from inside the app.
  saveClipboardImage: () => {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    const dir = path.join(DATA, 'drops');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-pano.png`);
    fs.writeFileSync(file, img.toPNG());
    return file;
  },
  // A dropped file that has no usable path (or only a temporary one): keep our own copy and return its path.
  saveDrop: (name, bytes) => {
    const dir = path.join(DATA, 'drops');
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(name || 'dosya').replace(/[\/\0]/g, '_').slice(-120) || 'dosya';
    const file = path.join(dir, `${Date.now()}-${safe}`);
    fs.writeFileSync(file, Buffer.from(bytes));
    return file;
  },
  fileExists: (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
};

ipcMain.handle('call', (_e, name, ...args) => {
  const fn = calls[name];
  if (!fn) throw new Error(`unknown call ${name}`);
  return fn(...args);
});
ipcMain.on('pty-write', (_e, id, data) => mgr.write(id, data));
ipcMain.on('pty-resize', (_e, id, cols, rows) => mgr.resize(id, cols, rows));
ipcMain.on('session-ui', (_e, id, type) => {
  if (type === 'ack' || type === 'input' || type === 'deny') mgr.ui(id, type);
});
ipcMain.on('view', (_e, v) => {
  view = { visible: Array.isArray(v.visible) ? v.visible : [], focused: v.focused || null, layout: v.layout };
  scheduleSave();
});
ipcMain.on('clipboard-write', (_e, t) => clipboard.writeText(String(t || '')));

// ---------------------------------------------------------------- menu

function menu() {
  const cmd = (name, arg) => () => send('command', name, arg);
  const focusItems = [];
  for (let i = 1; i <= 9; i++) {
    focusItems.push({ label: `Oturum ${i}`, accelerator: `CmdOrCtrl+${i}`, click: cmd('focusIndex', i - 1) });
  }
  const template = [
    {
      label: 'Orkestra',
      submenu: [{ role: 'about', label: 'Orkestra hakkında' }, { type: 'separator' }, { role: 'hide', label: 'Gizle' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit', label: 'Çık' }],
    },
    {
      label: 'Oturum',
      submenu: [
        { label: 'Yeni oturum…', accelerator: 'CmdOrCtrl+N', click: cmd('newSession') },
        { label: 'Masaüstünde hızlı oturum', accelerator: 'CmdOrCtrl+Shift+N', click: cmd('quickSession') },
        { label: 'Sıradaki bekleyen', accelerator: 'CmdOrCtrl+J', click: cmd('nextWaiting') },
        { label: 'Toplu mesaj…', accelerator: 'CmdOrCtrl+Shift+B', click: cmd('broadcast') },
        { label: 'Model ve effort…', accelerator: 'CmdOrCtrl+Shift+M', click: cmd('modelMenu') },
        { label: 'Değişiklikler (diff)…', accelerator: 'CmdOrCtrl+Shift+D', click: cmd('diff') },
        { label: 'Kuyruk…', accelerator: 'CmdOrCtrl+Shift+L', click: cmd('queue') },
        { label: 'Sıkıştır (/compact)', accelerator: 'CmdOrCtrl+Shift+K', click: cmd('compact') },
        { label: 'Hızlı geçiş (ortam, oturum, proje)…', accelerator: 'CmdOrCtrl+K', click: cmd('finder') },
        { label: 'Bütün konuşmalarda ara…', accelerator: 'CmdOrCtrl+Shift+F', click: cmd('search') },
        { type: 'separator' },
        { label: 'Ekrandan kaldır', accelerator: 'CmdOrCtrl+W', click: cmd('hidePane') },
        { label: 'Oturumu kapat…', accelerator: 'CmdOrCtrl+Shift+W', click: cmd('closeSession') },
        { type: 'separator' },
        ...focusItems,
      ],
    },
    {
      label: 'Çalışma alanları',
      submenu: [
        { label: 'Ekrandakileri çalışma alanı olarak kaydet…', accelerator: 'CmdOrCtrl+Shift+S', click: cmd('saveSpace') },
        { type: 'separator' },
        ...((ws.spaces || []).length
          ? ws.spaces.map((x, i) => ({
              label: `${x.name}  (${x.members.length} oturum)`,
              accelerator: i < 9 ? `CmdOrCtrl+Alt+${i + 1}` : undefined,
              click: cmd('openSpace', x.id),
            }))
          : [{ label: 'Henüz kayıtlı çalışma alanı yok', enabled: false }]),
      ],
    },
    {
      label: 'Düzen',
      submenu: [
        { label: 'Kopyala', accelerator: 'CmdOrCtrl+C', click: cmd('copy') },
        { label: 'Yapıştır', accelerator: 'CmdOrCtrl+V', click: cmd('paste') },
        { label: 'Tümünü seç', accelerator: 'CmdOrCtrl+A', click: cmd('selectAll') },
        { type: 'separator' },
        { label: 'Yazıyı büyüt', accelerator: 'CmdOrCtrl+Plus', click: cmd('fontBigger') },
        { label: 'Yazıyı küçült', accelerator: 'CmdOrCtrl+-', click: cmd('fontSmaller') },
        { label: 'Yazı boyutunu sıfırla', accelerator: 'CmdOrCtrl+0', click: cmd('fontReset') },
      ],
    },
    {
      label: 'Görünüm',
      submenu: [
        { label: 'Kenar çubuğunu aç/kapat', accelerator: 'CmdOrCtrl+B', click: cmd('toggleSidebar') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Tam ekran' },
        { role: 'reload', label: 'Arayüzü yenile' },
        { role: 'toggleDevTools', label: 'Geliştirici araçları' },
      ],
    },
    { role: 'windowMenu', label: 'Pencere' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- start

app.whenReady().then(() => {
  // Packaged builds take the icon from icon.icns; in `npm start` the Dock would show Electron's own icon.
  if (!app.isPackaged && app.dock) {
    try {
      app.dock.setIcon(path.join(__dirname, '../../build/icon.png'));
    } catch {}
  }
  fs.mkdirSync(DATA, { recursive: true });
  const env = claudeEnv.prepare(DATA);
  ws = workspace.load(WS_FILE);
  env.remoteFor = (cwd) => !!ws.remoteProjects[cwd];

  env.autoResume = () => pref('autoResume');
  mgr = new SessionManager(env);
  if (ws.limits) mgr.limits = ws.limits; // last known values until a session reports fresh ones
  mgr.on('data', queueData);
  mgr.on('reset', (id) => send('pty-reset', id));
  mgr.on('change', () => {
    send('state', stateSnapshot());
    updateBadge();
    updateTray();
    updateAwake();
    scheduleSave();
  });
  mgr.on('waiting', onWaiting);
  mgr.on('limit', (s, hit) => {
    const at = new Date(hit.resetsAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    const what = hit.kind === 'weekly' ? 'Haftalık limit' : '5 saatlik limit';
    notifyInfo(`⏸ ${s.name}: ${what} doldu`, pref('autoResume') ? `${at} sonrasında kendiliğinden devam edecek.` : `Sıfırlanma: ${at}.`);
  });

  cleanDrops();
  inbox = new Inbox(env.inboxDir, (ev) => mgr.handleEvent(ev));
  inbox.start();

  menu();
  createWindow();
  setupTray();
  setInterval(updateTray, 30000); // a 5h window that has reset drops its number

  win.webContents.once('did-finish-load', () => {
    for (const saved of ws.sessions) {
      if (saved && saved.id && saved.cwd && fs.existsSync(saved.cwd)) mgr.restore(saved);
    }
    send('init', { ui: ws.ui, snapshot: stateSnapshot(), claudeFound: !!env.claude });
    // Development aid: ORKESTRA_SNAPSHOT=/path/shot.png saves a picture of the window after a delay.
    if (process.env.ORKESTRA_SNAPSHOT) {
      const delay = Number(process.env.ORKESTRA_SNAPSHOT_DELAY) || 12000;
      if (process.env.ORKESTRA_SNAPSHOT_CMD) setTimeout(() => send('command', process.env.ORKESTRA_SNAPSHOT_CMD), delay - 3000);
      const jsAt = Number(process.env.ORKESTRA_SNAPSHOT_JS_AT) || Math.max(1000, delay - 6000);
      if (process.env.ORKESTRA_SNAPSHOT_JS) setTimeout(() => win.webContents.executeJavaScript(process.env.ORKESTRA_SNAPSHOT_JS).catch((e) => console.log('[orkestra] js error', e.message)), jsAt);
      setTimeout(async () => {
        win.webContents.invalidate(); // a window behind others is not repainted until asked
        await new Promise((r) => setTimeout(r, 400));
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.ORKESTRA_SNAPSHOT, img.toPNG());
        console.log('[orkestra] snapshot saved');
        quitConfirmed = true;
        app.quit();
      }, delay);
    }
  });
});
