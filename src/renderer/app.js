'use strict';
/* global Terminal, FitAddon, WebglAddon, Unicode11Addon, WebLinksAddon, ork */

const MAX_PANES = 6;
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// ------------------------------------------------------------------ state

const S = {
  sessions: [], // snapshot from main, in list order
  byId: new Map(),
  limits: null,
  visible: [], // ids on screen, max 4
  focused: null,
  selected: new Set(), // for broadcast
  tree: null, // pane layout: split tree (layout.js)
  focusedKey: null, // the active pane: a session id or 'diff:<session id>'
  fontSize: Number(localStorage.getItem('fontSize')) || 13,
};

const terms = new Map(); // id -> { term, fit, host, webgl, cols, rows }
const panes = new Map(); // id -> pane element

const THEME = {
  background: '#0f1216',
  foreground: '#dce3ed',
  cursor: '#85df5e',
  cursorAccent: '#0f1216',
  selectionBackground: '#2f4a66',
  black: '#1b1f24', red: '#ff6366', green: '#85df5e', yellow: '#f1c655',
  blue: '#5fb9ff', magenta: '#cea5ff', cyan: '#3addc4', white: '#dce3ed',
  brightBlack: '#5c6675', brightRed: '#ff8a8c', brightGreen: '#b0ee94', brightYellow: '#f7d987',
  brightBlue: '#8fd0ff', brightMagenta: '#ddbfff', brightCyan: '#7beedb', brightWhite: '#ffffff',
};

// ------------------------------------------------------------------ terminals

function getTerm(id) {
  let t = terms.get(id);
  if (t) return t;
  const host = el('div', 'term-host');
  $('#park').appendChild(host);
  const term = new Terminal({
    fontFamily: "Menlo, 'SF Mono', monospace",
    fontSize: fontFor(id),
    lineHeight: 1.1,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 8000,
    macOptionIsMeta: false, // Turkish keyboard: Option types @ # $ { [ ...
    macOptionClickForcesSelection: true,
    theme: THEME,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  const uni = new Unicode11Addon.Unicode11Addon();
  term.loadAddon(uni);
  term.unicode.activeVersion = '11';
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => window.open(uri)));
  term.open(host);
  t = { term, fit, host, webgl: null, cols: 0, rows: 0 };
  try {
    const gl = new WebglAddon.WebglAddon();
    gl.onContextLoss(() => {
      gl.dispose();
      t.webgl = null;
    });
    term.loadAddon(gl);
    t.webgl = gl;
  } catch {}

  term.onData((d) => ork.write(id, d));
  // Keyboard only (not mouse reports): typing into a waiting session counts as looking at it.
  term.onKey(({ domEvent }) => {
    const s = S.byId.get(id);
    // Esc on a prompt cancels it and Claude stops without a Stop hook: the session is idle, not working.
    if (s && s.state === 'ask' && domEvent && domEvent.key === 'Escape') ork.ui(id, 'deny');
    else if (s && (s.state === 'done' || s.state === 'ask')) ork.ui(id, 'input');
  });
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      ork.write(id, '\x1b\r'); // newline in Claude Code's prompt
      return false;
    }
    if (e.metaKey) return false; // ⌘ shortcuts belong to the app menu
    return true;
  });
  term.textarea && term.textarea.addEventListener('focus', () => setFocused(id, { fromTerm: true }));
  terms.set(id, t);
  return t;
}

function fitTerm(id) {
  const t = terms.get(id);
  if (!t || !t.host.isConnected || t.host.parentElement === $('#park')) return;
  const r = t.host.getBoundingClientRect();
  if (r.width < 20 || r.height < 20) return;
  try {
    t.fit.fit();
  } catch {
    return;
  }
  const { cols, rows } = t.term;
  if (cols !== t.cols || rows !== t.rows) {
    t.cols = cols;
    t.rows = rows;
    ork.resize(id, cols, rows);
  }
}

function disposeTerm(id) {
  const t = terms.get(id);
  if (!t) return;
  try {
    t.term.dispose();
  } catch {}
  t.host.remove();
  terms.delete(id);
}

const ro = new ResizeObserver((entries) => {
  for (const en of entries) {
    const id = en.target.dataset.id;
    if (id) requestAnimationFrame(() => fitTerm(id));
  }
});

// ------------------------------------------------------------------ helpers

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'az önce';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} dk`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} sa ${m % 60} dk`;
  return `${Math.floor(h / 24)} gün`;
}

function color(p) {
  return p >= 80 ? 'r' : p >= 50 ? 'y' : 'g';
}

function dirLabel(s) {
  const root = s.liveCwd || s.cwd;
  const cur = (s.status && s.status.dir) || root;
  if (cur === root) return cur.split('/').pop() || cur;
  if (cur.startsWith(root + '/')) return cur.slice(root.length + 1);
  return cur.replace(/^\/Users\/[^/]+/, '~');
}

// Background work Claude left running when its turn ended, e.g. "1 komut, 1 ajan".
function bgText(s) {
  if (!s.bg || !s.bg.length) return '';
  const n = {};
  for (const t of s.bg) {
    const k = t.type === 'shell' ? 'komut' : t.type === 'agent' ? 'ajan' : 'iş';
    n[k] = (n[k] || 0) + 1;
  }
  return Object.entries(n).map(([k, c]) => `${c} ${k}`).join(', ');
}

function bgTitle(s) {
  if (!s.bg || !s.bg.length) return '';
  return 'Claude arka planda çalışan işin bitmesini bekliyor; bitince kendiliğinden devam eder:\n' +
    s.bg.map((t) => `• ${t.description || t.type}`).join('\n');
}

function stateText(s) {
  switch (s.state) {
    case 'running':
      if (s.bg && s.bg.length) return `◌ arka planda ${bgText(s)} sürüyor · ${ago(s.since)}`;
      return `● ${ago(s.since)}'dır çalışıyor`;
    case 'done': {
      const a = ago(s.since);
      return a === 'az önce' ? '✔ az önce bitti' : `✔ ${a} önce bitti`;
    }
    case 'ask':
      if (s.askKind === 'question') return '? soru soruyor';
      if (s.pending) return `? izin istiyor · ${s.pending.tool}`;
      return `? ${askText(s.askMsg)}`;
    case 'exited': return 'kapandı';
    default: return 'boşta';
  }
}

// Claude Code's notification text, shortened and in Turkish where the pattern is known.
function askText(msg) {
  if (!msg) return 'girdi bekliyor';
  const m = msg.match(/permission to use (.+)$/i);
  if (m) return `izin: ${m[1]}`;
  if (/needs your permission/i.test(msg)) return 'izin bekliyor';
  if (/question|input/i.test(msg)) return 'soru soruyor';
  return msg;
}

function chipText(s) {
  if (s.state === 'running' && s.bg && s.bg.length) return `arka planda: ${bgText(s)}`;
  return { done: 'bitti', ask: 'izin bekliyor', running: 'çalışıyor', exited: 'kapandı' }[s.state] || '';
}

function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

// ------------------------------------------------------------------ list (sidebar)

let dragId = null;
const collapsed = new Set(JSON.parse(localStorage.getItem('collapsedGroups') || '[]'));

// Sessions grouped by their project's category (set in the ⌘N picker). No categories in use: one flat group.
function sessionGroups() {
  const cats = S.categories || [];
  const used = S.sessions.some((s) => s.category && cats.some((k) => k.id === s.category));
  if (!used) return [{ key: null, title: null, items: S.sessions }];
  const groups = [];
  for (const k of cats) {
    const items = S.sessions.filter((s) => s.category === k.id);
    if (items.length) groups.push({ key: k.id, title: k.name, items });
  }
  const rest = S.sessions.filter((s) => !s.category || !cats.some((k) => k.id === s.category));
  if (rest.length) groups.push({ key: '__none', title: 'Diğer', items: rest });
  return groups;
}

function groupHeader(g) {
  const isCollapsed = collapsed.has(g.key);
  const n = { done: 0, ask: 0, running: 0 };
  for (const s of g.items) if (n[s.state] != null) n[s.state]++;
  const h = el('div', `grp${isCollapsed ? ' collapsed' : ''}${isCollapsed && n.ask ? ' st-ask' : isCollapsed && n.done ? ' st-done' : ''}`);
  h.appendChild(el('span', 'caret', isCollapsed ? '▸' : '▾'));
  h.appendChild(el('span', 'gname', g.title));
  h.appendChild(el('span', 'gcount', String(g.items.length)));
  const sum = el('span', 'gsum');
  if (n.ask) sum.appendChild(el('span', 'o', ` ${n.ask} izin`));
  if (n.done) sum.appendChild(el('span', 'g', ` ${n.done} bitti`));
  if (n.running) sum.appendChild(el('span', 'y', ` ${n.running} çalışıyor`));
  h.appendChild(sum);
  h.title = isCollapsed ? 'Genişlet' : 'Daralt';
  h.onclick = () => {
    if (collapsed.has(g.key)) collapsed.delete(g.key);
    else collapsed.add(g.key);
    localStorage.setItem('collapsedGroups', JSON.stringify([...collapsed]));
    renderList();
  };
  return h;
}

function sessionRow(s, num) {
  const row = el('div', `row st-${s.state}`);
  if (S.visible.includes(s.id)) row.classList.add('onscreen');
  if (S.focused === s.id) row.classList.add('focused');
  if (S.selected.has(s.id)) row.classList.add('selected');
  row.draggable = true;
  row.dataset.id = s.id;
  row.appendChild(el('span', 'dot'));
  row.appendChild(el('div', 'name', `${num <= 9 ? num + '  ' : ''}${s.name}`));
  const badge = { done: 'bitti', ask: 'izin' }[s.state];
  if (badge) row.appendChild(el('span', 'badge', badge));
  const g = s.git;
  let l2 = g ? `🌿 ${g.branch}${g.changed ? `  ✏️ ${g.changed}` : ''}` : `📁 ${dirLabel(s)}`;
  if (s.remote) l2 += '  📡';
  const l2el = el('div', 'l2', l2);
  if (g && g.changed) {
    l2el.classList.add('has-diff');
    l2el.title = 'Değişiklikleri göster (⌘⇧D)';
    l2el.onclick = (e) => {
      e.stopPropagation();
      openDiff(s.id);
    };
  }
  row.appendChild(l2el);
  const l3 = el('div', 'l3', stateText(s));
  if (s.bg && s.bg.length) l3.title = bgTitle(s);
  row.appendChild(l3);
  if (typeof rowExtras === 'function') rowExtras(row, s);
  if (typeof rowFlow === 'function') rowFlow(row, s); // queue and limit lines (flow.js)
  if (s.state === 'exited') {
    const b = el('button', 'restart', '↻ yeniden başlat');
    b.onclick = (e) => {
      e.stopPropagation();
      ork.call('restart', s.id);
      show(s.id);
    };
    row.appendChild(b);
  }
  const x = el('button', 'x', '×');
  x.title = 'Oturumu kapat';
  x.onclick = (e) => {
    e.stopPropagation();
    closeSession(s.id);
  };
  row.appendChild(x);

  row.oncontextmenu = (e) => {
    e.preventDefault();
    renameSessionMenu(s.id, row);
  };
  row.onclick = (e) => {
    if (e.metaKey) {
      if (S.selected.has(s.id)) S.selected.delete(s.id);
      else S.selected.add(s.id);
      renderList();
      return;
    }
    show(s.id);
  };
  row.ondragstart = (e) => {
    dragId = s.id;
    e.dataTransfer.setData('text/plain', s.id);
    e.dataTransfer.effectAllowed = 'move';
  };
  row.ondragend = () => {
    dragId = null;
    document.querySelectorAll('.drop-before,.drop-target').forEach((n) => n.classList.remove('drop-before', 'drop-target'));
  };
  row.ondragover = (e) => {
    if (!dragId || dragId === s.id) return;
    e.preventDefault();
    row.classList.add('drop-before');
  };
  row.ondragleave = () => row.classList.remove('drop-before');
  row.ondrop = (e) => {
    e.preventDefault();
    row.classList.remove('drop-before');
    if (!dragId || dragId === s.id) return;
    // reorder in the global list: put the dragged session right before this one
    const from = S.sessions.findIndex((x) => x.id === dragId);
    let to = S.sessions.findIndex((x) => x.id === s.id);
    if (from < to) to -= 1;
    ork.call('move', dragId, to);
  };
  return row;
}

function renderList() {
  const list = $('#list');
  const scroll = list.scrollTop;
  list.textContent = '';
  const groups = sessionGroups();
  S.displayOrder = [];
  for (const g of groups) {
    if (g.title) list.appendChild(groupHeader(g));
    for (const s of g.items) {
      S.displayOrder.push(s.id);
      if (g.title && collapsed.has(g.key)) continue;
      list.appendChild(sessionRow(s, S.displayOrder.length));
    }
  }
  list.scrollTop = scroll;
  if (typeof renderSpaces === 'function') renderSpaces();
  const waiting = S.sessions.filter((s) => s.state === 'done' || s.state === 'ask').length;
  $('#side-count').textContent = S.sessions.length ? (waiting ? `${S.sessions.length} · ${waiting} bekliyor` : `${S.sessions.length} oturum`) : '';
}

// ------------------------------------------------------------------ panes (stage)

function paneFor(id) {
  let p = panes.get(id);
  if (p) return p;
  p = el('div', 'pane');
  p.dataset.id = id;
  const head = el('div', 'pane-head');
  const body = el('div', 'pane-body');
  body.dataset.id = id;
  p.append(head, body);
  wirePane(p, id);
  panes.set(id, p);
  return p;
}

// ---- dropping files (screenshots, images, any file) onto a terminal ------------------------------------

function isFileDrag(e) {
  const t = e.dataTransfer && e.dataTransfer.types;
  return !!t && [...t].some((x) => x === 'Files' || x === 'text/uri-list');
}

// Types the dropped files' paths into the session, like Terminal.app. Files without a lasting path on disk
// (a screenshot thumbnail can hand over a temporary file or none) are copied into the app's folder first.
async function dropFiles(id, dt) {
  const paths = [];
  const files = [...(dt.files || [])];
  for (const f of files) {
    let p = ork.pathForFile(f);
    const temporary = !p || /^\/(private\/)?var\/folders\//.test(p) || !(await ork.call('fileExists', p));
    if (temporary) {
      try {
        p = await ork.call('saveDrop', f.name || (DropPaths.isImageName(f.name) ? 'görsel.png' : 'dosya'), new Uint8Array(await f.arrayBuffer()));
      } catch {
        p = null;
      }
    }
    if (p) paths.push(p);
  }
  if (!files.length) paths.push(...DropPaths.pathsFromUriList(dt.getData('text/uri-list')));
  const text = DropPaths.dropText(paths);
  if (!text) return toast('Bırakılan dosyanın yolu alınamadı.');
  const t = getTerm(id);
  setFocused(id);
  t.term.paste(text);
  const imgs = paths.filter((p) => DropPaths.isImageName(p)).length;
  toast(imgs ? `🖼 ${imgs} görsel eklendi` : `📄 ${paths.length} dosya yolu eklendi`, 2500);
}

// Dropping a file anywhere else must not make the window open it.
window.addEventListener('dragover', (e) => {
  if (isFileDrag(e)) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  if (isFileDrag(e)) e.preventDefault();
});

function renderHead(id) {
  const s = S.byId.get(id);
  const p = panes.get(id);
  if (!s || !p) return;
  p.className = `pane st-${s.state}${S.focusedKey === id ? ' focused' : ''}`;
  const head = p.querySelector('.pane-head');
  head.textContent = '';
  const pn = el('span', 'pname', s.name);
  pn.title = 'Çift tık: yeniden adlandır';
  pn.ondblclick = (e) => {
    e.stopPropagation();
    renameSessionMenu(id, pn);
  };
  head.appendChild(pn);
  if (s.git) {
    const b = el('span', 'g', `🌿 ${s.git.branch}`);
    head.appendChild(b);
    if (s.git.changed) {
      const d = el('button', 'dchip', `✏️ ${s.git.changed}`);
      d.title = 'Değişiklikleri göster (⌘⇧D)';
      d.onclick = (e) => {
        e.stopPropagation();
        openDiff(id);
      };
      head.appendChild(d);
    }
  }
  const dl = dirLabel(s);
  if (dl !== s.name.split(' ⎇ ')[0] || s.worktree) head.appendChild(el('span', '', `📁 ${dl}`));
  const st = s.status || {};
  if (st.model || s.model) {
    const mb = el('button', `mchip${s.model || s.effort ? ' custom' : ''}`, `🤖 ${st.model || modelLabel(s.model)}${st.effort || s.effort ? ' · ' + (st.effort || s.effort) : ''} ▾`);
    mb.title = 'Bu sohbetin modeli ve effort seviyesi';
    mb.onclick = (e) => {
      e.stopPropagation();
      openModelMenu(id, mb);
    };
    head.appendChild(mb);
  }
  const chip = chipText(s);
  if (chip) {
    const c = el('span', 'chip', chip);
    if (s.bg && s.bg.length) c.title = bgTitle(s);
    head.appendChild(c);
  }
  head.appendChild(el('span', 'spacer'));
  if (typeof headExtras === 'function') headExtras(head, s); // compact button, queue (flow.js)
  if (s.alive) {
    // An antenna only; the state is in its look: grey = off, coloured with a green dot = on, blinking = switching.
    const rc = el('button', `rc${s.remote ? ' on' : ''}${s.rcBusy ? ' busy' : ''}`, '📡');
    rc.setAttribute('aria-label', s.remote ? 'Remote Control açık' : 'Remote Control kapalı');
    rc.title = s.remote
      ? `Remote Control açık: claude.ai/code/${s.remote}\nKapatmak için tıkla. ⌥-tık: tarayıcıda aç.`
      : s.rcBusy
        ? 'Remote Control değiştiriliyor…'
        : 'Remote Control kapalı. Açmak için tıkla (bu projede hatırlanır).';
    rc.onclick = (e) => {
      e.stopPropagation();
      if (e.altKey && s.remote) return window.open(`https://claude.ai/code/${s.remote}`);
      toggleRemote(id);
    };
    head.appendChild(rc);
  }
  const hide = el('button', 'hbtn', '–');
  hide.title = 'Ekrandan kaldır (⌘W)';
  hide.onclick = (e) => {
    e.stopPropagation();
    hidePane(id);
  };
  head.appendChild(hide);
  // info on the left may shrink and clip; the buttons on the right always stay visible
  const left = el('div', 'hleft');
  const right = el('div', 'hright');
  let side = left;
  for (const n of [...head.childNodes]) {
    if (n.classList && n.classList.contains('spacer')) {
      side = right;
      n.remove();
      continue;
    }
    side.appendChild(n);
  }
  const stateChip = left.querySelector('.chip');
  if (stateChip) right.prepend(stateChip); // the state label must never be clipped
  head.append(left, right);

  const body = p.querySelector('.pane-body');
  let ex = body.querySelector('.pane-exited');
  if (s.state === 'exited') {
    if (!ex) {
      ex = el('div', 'pane-exited');
      ex.appendChild(el('span', 'muted', 'Claude oturumu kapandı.'));
      const b = el('button', 'btn primary', '↻ Yeniden başlat');
      b.onclick = () => ork.call('restart', id);
      ex.appendChild(b);
      body.appendChild(ex);
    }
  } else if (ex) ex.remove();
}

// Text typed in Claude Code's prompt box but not sent yet. Read from the screen: the line that starts with ❯
// right under the prompt's top border. The grey placeholder ("Try ...") counts as empty.
function promptDraft(id) {
  const t = terms.get(id);
  if (!t) return '';
  const b = t.term.buffer.active;
  const lines = [];
  for (let y = b.viewportY; y < b.viewportY + t.term.rows; y++) {
    const l = b.getLine(y);
    lines.push(l ? l.translateToString(true) : '');
  }
  for (let i = lines.length - 1; i > 0; i--) {
    const m = lines[i].match(/^\s*❯\s?(.*)$/);
    if (m && /^\s*─{6,}/.test(lines[i - 1])) {
      const text = m[1].trim();
      return /^Try "/.test(text) ? '' : text;
    }
  }
  return '';
}

async function toggleRemote(id) {
  const s = S.byId.get(id);
  if (!s || s.rcBusy) return;
  const on = !s.remote;
  if (promptDraft(id)) {
    toast('Yazı kutusunda gönderilmemiş bir metin var. Önce gönder ya da sil, sonra tekrar dene.', 5000);
    return;
  }
  const r = await ork.call('toggleRemote', id, on);
  if (!r.ok) toast(r.reason || 'Remote Control değiştirilemedi.', 5000);
  else toast(on ? `● ${s.name}: Remote Control açık. Bu projede yeni oturumlar da açık başlayacak.` : `○ ${s.name}: Remote Control kapalı.`);
}

// ---- model / effort menu (per conversation) --------------------------------

const MODELS = [
  { alias: null, label: 'Varsayılan', sub: 'Claude ayarlarındaki model' },
  { alias: 'fable', label: 'Fable', sub: 'En zor işler için' },
  { alias: 'opus', label: 'Opus', sub: 'Karmaşık ve günlük işler' },
  { alias: 'sonnet', label: 'Sonnet', sub: 'Daha basit işler, verimli' },
  { alias: 'haiku', label: 'Haiku', sub: 'En hızlı cevaplar' },
];
const EFFORTS = [null, 'low', 'medium', 'high', 'xhigh', 'max'];

function modelLabel(alias) {
  const m = MODELS.find((x) => x.alias === alias);
  return m ? m.label : alias || '';
}

// Alias of the model a session is really running, read from its status line.
function runningAlias(s) {
  const name = ((s.status && s.status.model) || '').toLowerCase();
  return ['fable', 'opus', 'sonnet', 'haiku'].find((a) => name.includes(a)) || null;
}

let modelMenu = null;
function closeModelMenu() {
  if (modelMenu) modelMenu.remove();
  modelMenu = null;
}
document.addEventListener('mousedown', (e) => {
  if (modelMenu && !modelMenu.contains(e.target)) closeModelMenu();
});

function openModelMenu(id, anchor) {
  closeModelMenu();
  const s = S.byId.get(id);
  if (!s) return;
  let pick = { model: s.model, effort: s.effort };
  const box = el('div', 'popover');
  const render = () => {
    box.textContent = '';
    box.appendChild(el('div', 'pop-title', 'Bu sohbet için model'));
    const running = runningAlias(s);
    for (const m of MODELS) {
      const it = el('div', `pop-item${pick.model === m.alias ? ' sel' : ''}`);
      const name = el('div', 'pi-name', m.label);
      if (m.alias && m.alias === running) name.appendChild(el('span', 'pi-now', ' · şu an'));
      it.append(name, el('div', 'pi-sub', m.sub));
      it.onclick = () => {
        pick.model = m.alias;
        render();
      };
      box.appendChild(it);
    }
    box.appendChild(el('div', 'pop-title', 'Effort'));
    const seg = el('div', 'seg-ctl');
    for (const e of EFFORTS) {
      const nowEffort = s.status && s.status.effort;
      const b = el('button', `${pick.effort === e ? 'sel' : ''}${e && e === nowEffort ? ' now' : ''}`, e || 'varsayılan');
      if (e && e === nowEffort) b.title = 'şu an';
      b.onclick = () => {
        pick.effort = e;
        render();
      };
      seg.appendChild(b);
    }
    box.appendChild(seg);
    box.appendChild(el('div', 'pop-note', 'Sadece bu sohbete uygulanır, Claude ayarların değişmez. Oturum birkaç saniyede yeniden başlar ve konuşma kaldığı yerden devam eder.'));
    const actions = el('div', 'pop-actions');
    const cancel = el('button', 'btn ghost', 'Vazgeç');
    cancel.onclick = closeModelMenu;
    const apply = el('button', 'btn primary', 'Uygula');
    apply.disabled = pick.model === s.model && pick.effort === s.effort;
    apply.onclick = () => applyModel(id, pick);
    actions.append(cancel, apply);
    box.appendChild(actions);
  };
  render();
  document.body.appendChild(box);
  const r = anchor.getBoundingClientRect();
  const w = 300;
  box.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left))}px`;
  box.style.top = `${r.bottom + 6}px`;
  modelMenu = box;
}

async function applyModel(id, pick) {
  const s = S.byId.get(id);
  if (!s) return;
  if (s.alive && promptDraft(id)) {
    toast('Yazı kutusunda gönderilmemiş bir metin var. Önce gönder ya da sil, sonra tekrar dene.', 5000);
    return;
  }
  closeModelMenu();
  const r = await ork.call('setModel', id, pick);
  if (!r.ok) return toast(r.reason || 'Model değiştirilemedi.', 5000);
  const parts = [pick.model ? modelLabel(pick.model) : 'varsayılan model', pick.effort ? `effort ${pick.effort}` : 'varsayılan effort'];
  toast(`🤖 ${s.name}: ${parts.join(' · ')}. Oturum yeniden başlıyor…`);
}

// ------------------------------------------------------------------ layout: split tree (see layout.js)
// S.tree is the truth: any number of nested row/column splits, up to MAX_PANES panes. A pane is a session
// terminal or a diff view ('diff:<session id>'). S.visible (sessions on screen, reading order) follows it.

const isDiff = (key) => typeof key === 'string' && key.startsWith('diff:');
const diffSession = (key) => key.slice(5);

function setTree(t) {
  S.tree = t;
  S.visible = Layout.leaves(t).filter((k) => !isDiff(k));
  if (S.focusedKey && !Layout.has(t, S.focusedKey)) S.focusedKey = null;
}

// What workspaces save as their layout.
function layoutFor() {
  return S.tree ? { tree: JSON.parse(JSON.stringify(S.tree)) } : null;
}

function renderGrid() {
  const grid = $('#grid');
  const keys = Layout.leaves(S.tree);
  // Terminals no longer on screen go back to the park, so they keep running and keep their size.
  for (const [id, t] of terms) {
    if (!keys.includes(id) && t.host.parentElement !== $('#park')) $('#park').appendChild(t.host);
  }
  for (const [key, p] of panes) {
    if (!keys.includes(key)) {
      const b = p.querySelector('.pane-body');
      if (b) ro.unobserve(b);
      p.remove();
      panes.delete(key);
    }
  }
  grid.textContent = '';
  $('#empty').hidden = keys.length > 0;
  if (!S.tree) return;
  grid.appendChild(buildNode(S.tree, []));
  for (const key of keys) {
    if (isDiff(key)) {
      renderDiffPane(key);
      continue;
    }
    const body = panes.get(key).querySelector('.pane-body');
    const t = getTerm(key);
    if (t.host.parentElement !== body) body.prepend(t.host);
    ro.observe(body);
    renderHead(key);
  }
  requestAnimationFrame(() => S.visible.forEach(fitTerm));
}

function buildNode(n, path) {
  if (n.k === 'leaf') {
    const p = isDiff(n.id) ? diffPaneFor(n.id) : paneFor(n.id);
    p.style.flex = '';
    return p;
  }
  const box = el('div', `split split-${n.dir}`); // not plain 'row': the sidebar rows own that class
  n.kids.forEach((c, i) => {
    if (i > 0) {
      const g = el('div', `gutter ${n.dir === 'row' ? 'v' : 'h'}`);
      g.onmousedown = (e) => startDrag(e, box, path, i - 1, n.dir);
      g.ondblclick = () => evenOut(path);
      g.title = 'Sürükle: boyutlandır · çift tık: eşitle';
      box.appendChild(g);
    }
    const child = buildNode(c, [...path, i]);
    child.style.flex = `${n.sizes[i]} 1 0px`;
    box.appendChild(child);
  });
  return box;
}

const GUTTER = 8;

function startDrag(e, box, path, k, dir) {
  e.preventDefault();
  const node = Layout.at(S.tree, path);
  if (!node || node.k !== 'split') return;
  const sizes = node.sizes.slice();
  const kids = [...box.children].filter((c) => !c.classList.contains('gutter'));
  const r = box.getBoundingClientRect();
  const total = (dir === 'row' ? r.width : r.height) - GUTTER * (kids.length - 1);
  const start = dir === 'row' ? e.clientX : e.clientY;
  const first = sizes[k];
  const pair = sizes[k] + sizes[k + 1];
  const min = Math.min(pair / 2, 90 / Math.max(total, 1)); // ~90px per pane at least
  const cover = $('#drag-cover');
  cover.hidden = false;
  cover.classList.toggle('rows', dir === 'col');
  const move = (ev) => {
    const d = ((dir === 'row' ? ev.clientX : ev.clientY) - start) / total;
    const f = Math.max(min, Math.min(pair - min, first + d));
    sizes[k] = f;
    sizes[k + 1] = pair - f;
    kids[k].style.flex = `${sizes[k]} 1 0px`;
    kids[k + 1].style.flex = `${sizes[k + 1]} 1 0px`;
  };
  const up = () => {
    cover.hidden = true;
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    setTree(Layout.resize(S.tree, path, sizes, 0));
    S.visible.forEach(fitTerm);
    pushView();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function evenOut(path) {
  const node = Layout.at(S.tree, path);
  if (!node || node.k !== 'split') return;
  setTree(Layout.resize(S.tree, path, node.kids.map(() => 1), 0));
  renderGrid();
  pushView();
}

// ---- moving panes: drag a pane by its title bar (or a session from the list) onto another pane ----------

let paneDrag = null; // key of the pane being dragged by its title bar

// Where on the target a drop lands: an edge splits the target there, the middle swaps (or replaces).
function dropZone(e, p) {
  const r = p.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  const m = Math.min(x, 1 - x, y, 1 - y);
  if (m > 0.22) return 'center';
  if (m === x) return 'left';
  if (m === 1 - x) return 'right';
  if (m === y) return 'top';
  return 'bottom';
}

function showDropHint(p, zone, src) {
  let h = p.querySelector(':scope > .drop-hint');
  if (!h) {
    h = el('div', 'drop-hint');
    p.appendChild(h);
  }
  h.className = `drop-hint z-${zone}`;
  const onScreen = Layout.has(S.tree, src);
  h.textContent = zone === 'center' ? (onScreen ? '⇄ yer değiştir' : '↧ buraya aç') : '＋ buraya yerleştir';
}

function clearDropHints() {
  document.querySelectorAll('.drop-hint').forEach((n) => n.remove());
  document.querySelectorAll('.pane.dragging').forEach((n) => n.classList.remove('dragging'));
}

// Wires focus, title-bar dragging and dropping for any pane (terminal or diff).
function wirePane(p, key) {
  p.addEventListener('mousedown', () => focusKey(key), true);
  const head = p.querySelector('.pane-head');
  head.draggable = true;
  head.title = 'Başlıktan sürükle: başka bir bölmenin kenarına bırak ya da ortasına bırakıp yer değiştir';
  head.ondragstart = (e) => {
    if (e.target.closest && e.target.closest('button')) return e.preventDefault();
    paneDrag = key;
    e.dataTransfer.setData('application/x-orkestra-pane', key);
    e.dataTransfer.effectAllowed = 'move';
    p.classList.add('dragging');
  };
  head.ondragend = () => {
    paneDrag = null;
    clearDropHints();
  };
  p.ondragover = (e) => {
    const src = paneDrag || dragId;
    const files = !src && !isDiff(key) && isFileDrag(e);
    if (!src && !files) return;
    if (src === key) return;
    e.preventDefault();
    if (files) {
      e.dataTransfer.dropEffect = 'copy';
      p.classList.add('drop-file');
      return;
    }
    e.dataTransfer.dropEffect = 'move';
    showDropHint(p, dropZone(e, p), src);
  };
  p.ondragleave = (e) => {
    if (e.relatedTarget && p.contains(e.relatedTarget)) return;
    p.classList.remove('drop-target', 'drop-file');
    const h = p.querySelector(':scope > .drop-hint');
    if (h) h.remove();
  };
  p.ondrop = (e) => {
    e.preventDefault();
    p.classList.remove('drop-target', 'drop-file');
    const src = paneDrag || dragId;
    clearDropHints();
    if (src && src !== key) return dropOnPane(src, key, dropZone(e, p));
    if (!src && !isDiff(key) && isFileDrag(e)) dropFiles(key, e.dataTransfer);
  };
}

function dropOnPane(src, target, zone) {
  if (Layout.has(S.tree, src)) setTree(Layout.move(S.tree, src, target, zone));
  else if (zone === 'center') setTree(Layout.replace(S.tree, target, src));
  else {
    if (Layout.leaves(S.tree).length >= MAX_PANES) return toast(`En fazla ${MAX_PANES} bölme. Ortasına bırakırsan yerine açılır.`);
    setTree(Layout.insert(S.tree, target, src, zone));
  }
  renderGrid();
  focusKey(src);
  renderList();
  pushView();
}

// ------------------------------------------------------------------ focus & placement

function pushView() {
  ork.view({ visible: S.visible, focused: S.focused, layout: layoutFor() });
}

function markFocus() {
  for (const [key, p] of panes) p.classList.toggle('focused', S.focusedKey === key);
}

// Focus any pane: a session terminal, or a diff view.
function focusKey(key) {
  if (!key) return;
  if (!isDiff(key)) return setFocused(key);
  if (S.focusedKey === key) return;
  S.focusedKey = key;
  markFocus();
}

function setFocused(id, { fromTerm = false } = {}) {
  if (!S.byId.has(id)) return;
  const changed = S.focused !== id || S.focusedKey !== id;
  S.focused = id;
  S.focusedKey = id;
  const s = S.byId.get(id);
  if (s.state === 'done') ork.ui(id, 'ack');
  if (!fromTerm) {
    const t = terms.get(id);
    if (t) setTimeout(() => t.term.focus(), 0);
  }
  if (changed) {
    for (const vid of S.visible) renderHead(vid);
    markFocus();
    renderList();
    pushView();
  }
}

// Which side a new pane opens on next to `key`: beside a wide pane, under a tall one.
function sideFor(key) {
  const p = panes.get(key);
  if (!p) return 'right';
  const r = p.getBoundingClientRect();
  return r.width >= r.height * 1.1 ? 'right' : 'bottom';
}

// Puts a session on screen: as a new pane next to the focused one while there is room, otherwise in its place.
function show(id) {
  if (!S.byId.has(id)) return;
  if (!Layout.has(S.tree, id)) {
    const keys = Layout.leaves(S.tree);
    const target = keys.includes(S.focusedKey) ? S.focusedKey : keys[keys.length - 1];
    if (!keys.length || keys.length < MAX_PANES) setTree(Layout.insert(S.tree, target, id, sideFor(target)));
    else setTree(Layout.replace(S.tree, target, id));
    renderGrid();
  }
  setFocused(id);
  renderList();
  pushView();
}

// Shows a session in place of the focused pane (used by ⌘J and notifications).
function showInFocused(id) {
  if (!S.byId.has(id)) return;
  if (!Layout.has(S.tree, id)) {
    const keys = Layout.leaves(S.tree);
    if (keys.includes(S.focusedKey)) setTree(Layout.replace(S.tree, S.focusedKey, id));
    else return show(id);
    renderGrid();
  }
  setFocused(id);
  renderList();
  pushView();
}

// Takes a pane off the screen (the session keeps running).
function hidePane(key) {
  if (!Layout.has(S.tree, key)) return;
  const keys = Layout.leaves(S.tree);
  const i = keys.indexOf(key);
  setTree(Layout.remove(S.tree, key));
  const left = Layout.leaves(S.tree);
  if (S.focused === key) S.focused = S.visible[Math.min(i, S.visible.length - 1)] || S.visible[0] || null;
  renderGrid();
  const next = left[Math.min(i, left.length - 1)];
  if (next) focusKey(next);
  renderList();
  pushView();
}

async function closeSession(id) {
  const ok = await ork.call('closeSession', id);
  if (ok) {
    S.selected.delete(id);
    if (Layout.has(S.tree, 'diff:' + id)) setTree(Layout.remove(S.tree, 'diff:' + id));
    hidePane(id);
  }
}

// ------------------------------------------------------------------ shared bar

function renderBar() {
  const bar = $('#bar');
  bar.textContent = '';
  const seg = (html) => {
    const d = el('div', 'seg');
    d.append(...html);
    bar.appendChild(d);
  };
  const span = (cls, t) => el('span', cls, t);
  const meter = (p) => {
    const m = el('span', 'meter');
    const i = el('i');
    i.style.width = `${Math.min(100, p)}%`;
    i.style.background = `var(--${{ g: 'green', y: 'yellow', r: 'red' }[color(p)]})`;
    m.appendChild(i);
    return m;
  };
  const L = S.limits || {};
  const five = L.five_hour;
  if (five && five.resets_at && five.resets_at * 1000 <= Date.now()) {
    // The window has reset and no session has made a request since: the old number no longer applies.
    seg([span('', '⏳ 5h'), meter(0), span('g', '0%'), span('dim', '  ↻ sıfırlandı')]);
  } else if (five && typeof five.used_percentage === 'number') {
    const p = Math.floor(five.used_percentage);
    const parts = [span('', '⏳ 5h'), meter(p), span(color(p), `${p}%`)];
    if (five.resets_at) {
      const ms = five.resets_at * 1000;
      const left = Math.max(0, Math.round((ms - Date.now()) / 60000));
      const hh = new Date(ms).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
      parts.push(span('dim', `  ↻ ${hh} (${Math.floor(left / 60)}sa ${left % 60}dk)`));
    }
    seg(parts);
  } else seg([span('dim', '⏳ 5h limit: ilk mesajdan sonra görünür')]);
  const seven = L.seven_day;
  if (seven && typeof seven.used_percentage === 'number') {
    const p = seven.resets_at && seven.resets_at * 1000 <= Date.now() ? 0 : Math.floor(seven.used_percentage);
    seg([span('', '📅 7d'), meter(p), span(color(p), `${p}%`)]);
  }
  const cost = S.sessions.reduce((a, s) => a + ((s.status && s.status.cost) || 0), 0);
  seg([span('', `💰 $${cost.toFixed(2)}`), span('dim', ' açık oturumlar')]);
  const c = { running: 0, done: 0, ask: 0 };
  for (const s of S.sessions) if (c[s.state] != null) c[s.state]++;
  const parts = [span('', `🖥 ${S.sessions.length} oturum`)];
  if (c.running) parts.push(span('y', ` · ${c.running} çalışıyor`));
  if (c.done) parts.push(span('g', ` · ${c.done} bitti`));
  if (c.ask) parts.push(span('o', ` · ${c.ask} izin`));
  const rc = S.sessions.filter((s) => s.remote).length;
  if (rc) parts.push(span('g', ` · 📡 ${rc} uzaktan`));
  seg(parts);
  seg([span('', `🕐 ${new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}`)]);
}

// ------------------------------------------------------------------ state from main

function applySnapshot(snap) {
  S.sessions = snap.sessions;
  S.byId = new Map(snap.sessions.map((s) => [s.id, s]));
  S.limits = snap.limits;
  S.categories = snap.categories || [];
  S.spaces = snap.spaces || [];
  S.prefs = snap.prefs || {};
  S.awake = !!snap.awake;
  // forget sessions that are gone
  for (const id of [...terms.keys()]) if (!S.byId.has(id)) disposeTerm(id);
  const before = Layout.leaves(S.tree).length;
  setTree(Layout.prune(S.tree, (k) => S.byId.has(isDiff(k) ? diffSession(k) : k)));
  for (const id of [...S.selected]) if (!S.byId.has(id)) S.selected.delete(id);
  if (S.focused && !S.byId.has(S.focused)) S.focused = S.visible[0] || null;
  for (const s of S.sessions) getTerm(s.id);
  if (Layout.leaves(S.tree).length !== before) renderGrid();
  else {
    S.visible.forEach(renderHead);
    Layout.leaves(S.tree).filter(isDiff).forEach(renderDiffHead);
  }
  renderList();
  renderBar();
  if (modalNew.open) modalNew.refreshOpen();
}

// ------------------------------------------------------------------ new session modal

const shortPath = (p) => p.replace(/^\/Users\/[^/]+/, '~');

const modalNew = {
  open: false,
  data: { sections: [], categories: [] },
  q: '',
  flat: [], // items in display order, for arrow keys
  active: 0,
  detailDir: null,
  editing: false,
  addingCat: false,
  renamingCat: null,
  dragPath: null,

  async show() {
    this.open = true;
    $('#modal-new').hidden = false;
    $('#np-search').value = '';
    this.q = '';
    this.editing = false;
    this.addingCat = false;
    this.renamingCat = null;
    this.data = await ork.call('folders');
    this.active = 0;
    this.renderFolders();
    this.detail();
    $('#np-search').focus();
  },
  hide() {
    this.open = false;
    $('#modal-new').hidden = true;
    const t = S.focused && terms.get(S.focused);
    if (t) t.term.focus();
  },
  // New data from main after a change; keeps the same project selected when it is still listed.
  setData(data, selectPath) {
    if (!data || data.error) {
      if (data && data.error) toast(data.error, 5000);
      return false;
    }
    this.data = data;
    const keep = selectPath || this.detailDir;
    this.renderFolders();
    const i = this.flat.findIndex((x) => x.path === keep);
    this.active = i >= 0 ? i : Math.min(this.active, Math.max(0, this.flat.length - 1));
    this.renderFolders();
    this.detail();
    return true;
  },
  filter(q) {
    this.q = q.trim().toLocaleLowerCase('tr');
    this.active = 0;
    this.editing = false;
    this.renderFolders();
    this.detail();
  },
  matches(x) {
    if (!this.q) return true;
    return x.name.toLocaleLowerCase('tr').includes(this.q) || x.path.toLocaleLowerCase('tr').includes(this.q);
  },
  select(i) {
    this.active = i;
    this.editing = false;
    this.renderFolders();
    this.detail();
  },

  renderFolders() {
    const box = $('#np-folders');
    const scroll = box.scrollTop;
    box.textContent = '';
    this.flat = [];
    if (this.addingCat) box.appendChild(this.inlineInput('Yeni kategori adı', '', async (name) => {
      this.addingCat = false;
      const r = await ork.call('addCategory', name);
      this.setData(r);
    }, () => {
      this.addingCat = false;
      this.renderFolders();
    }));
    for (const sec of this.data.sections) {
      const items = sec.items.filter((x) => this.matches(x));
      const isCat = !!sec.catId;
      const droppable = sec.catId !== undefined; // a category, or "Projeler" (no category)
      if (!items.length && (this.q || sec.key === 'recent' || sec.key === 'home')) continue;
      if (!items.length && sec.key === 'none' && this.data.categories.length) {
        // uncategorized list is empty: keep a small drop target
      }
      // header
      if (isCat && this.renamingCat === sec.catId) {
        box.appendChild(this.inlineInput('Kategori adı', sec.title, async (name) => {
          this.renamingCat = null;
          this.setData(await ork.call('renameCategory', sec.catId, name));
        }, () => {
          this.renamingCat = null;
          this.renderFolders();
        }));
      } else {
        const h = el('div', `np-sec${isCat ? ' cat' : ''}`);
        h.appendChild(el('span', '', sec.title));
        h.appendChild(el('span', 'np-count', String(sec.items.length)));
        if (isCat) {
          const acts = el('span', 'np-cat-acts');
          const ren = el('button', 'np-ib', '✎');
          ren.title = 'Yeniden adlandır';
          ren.onclick = () => {
            this.renamingCat = sec.catId;
            this.renderFolders();
          };
          const del = el('button', 'np-ib', '×');
          del.title = 'Kategoriyi sil (projeler “Projeler” altına döner)';
          del.onclick = async () => this.setData(await ork.call('deleteCategory', sec.catId));
          acts.append(ren, del);
          h.appendChild(acts);
        }
        if (droppable) this.dropTarget(h, sec.catId);
        box.appendChild(h);
      }
      if (!items.length && isCat && !this.q) {
        const hint = el('div', 'np-empty', 'Boş. Bir projeyi buraya sürükle ya da sağdan kategori seç.');
        this.dropTarget(hint, sec.catId);
        box.appendChild(hint);
      }
      for (const x of items) {
        const i = this.flat.length;
        this.flat.push(x);
        const it = el('div', `np-item${i === this.active ? ' active' : ''}${x.missing ? ' missing' : ''}`);
        it.appendChild(el('span', 'n', x.name));
        it.appendChild(el('span', 'p', x.missing ? 'bulunamadı' : shortPath(x.path)));
        it.title = x.path;
        it.onclick = () => this.select(i);
        it.ondblclick = () => !x.missing && this.start(x.path);
        if (sec.key !== 'home') {
          it.draggable = true;
          it.ondragstart = (e) => {
            this.dragPath = x.path;
            e.dataTransfer.setData('text/plain', x.path);
            e.dataTransfer.effectAllowed = 'move';
          };
          it.ondragend = () => {
            this.dragPath = null;
            box.querySelectorAll('.drop-on').forEach((n) => n.classList.remove('drop-on'));
          };
        }
        box.appendChild(it);
      }
    }
    if (!this.flat.length) box.appendChild(el('div', 'muted np-empty', 'Eşleşen klasör yok.'));
    box.scrollTop = scroll;
    const act = box.querySelector('.np-item.active');
    if (act) act.scrollIntoView({ block: 'nearest' });
  },

  dropTarget(node, catId) {
    node.ondragover = (e) => {
      if (!this.dragPath) return;
      e.preventDefault();
      node.classList.add('drop-on');
    };
    node.ondragleave = () => node.classList.remove('drop-on');
    node.ondrop = async (e) => {
      e.preventDefault();
      node.classList.remove('drop-on');
      const p = this.dragPath;
      this.dragPath = null;
      if (p) this.setData(await ork.call('setCategory', p, catId || null), p);
    };
  },

  inlineInput(placeholder, value, onOk, onCancel) {
    const row = el('div', 'np-inline');
    const inp = el('input', 'input');
    inp.placeholder = placeholder;
    inp.value = value;
    inp.spellcheck = false;
    const ok = el('button', 'btn primary', 'Kaydet');
    const done = () => {
      const v = inp.value.trim();
      if (v) onOk(v);
      else onCancel();
    };
    ok.onclick = done;
    inp.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        done();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    row.append(inp, ok);
    setTimeout(() => {
      inp.focus();
      inp.select();
    }, 0);
    return row;
  },

  current() {
    return this.flat[this.active] || null;
  },

  async detail() {
    const x = this.current();
    const box = $('#np-detail');
    box.textContent = '';
    if (!x) return;
    this.detailDir = x.path;
    const isHome = this.data.sections.some((s) => s.key === 'home' && s.items[0] && s.items[0].path === x.path);

    // name / path, or the edit form
    if (this.editing) {
      box.appendChild(this.editForm(x));
    } else {
      const top = el('div', 'np-top');
      const nameBox = el('div', 'np-titles');
      nameBox.append(el('div', 'np-name', x.name), el('div', 'np-path', x.path));
      top.appendChild(nameBox);
      if (!isHome) {
        const ed = el('button', 'btn ghost small', '✎ Düzenle');
        ed.title = 'Adı ve klasör yolunu değiştir';
        ed.onclick = () => {
          this.editing = true;
          this.detail();
        };
        top.appendChild(ed);
      }
      box.appendChild(top);
    }

    // category + remove
    if (!isHome) {
      const crow = el('div', 'np-row np-catrow');
      crow.appendChild(el('span', 'muted', 'Kategori'));
      const sel = el('select', 'input');
      const none = el('option', '', 'Kategorisiz');
      none.value = '';
      sel.appendChild(none);
      for (const k of this.data.categories) {
        const o = el('option', '', k.name);
        o.value = k.id;
        sel.appendChild(o);
      }
      const nw = el('option', '', '＋ Yeni kategori…');
      nw.value = '__new__';
      sel.appendChild(nw);
      sel.value = x.category || '';
      sel.onchange = async () => {
        if (sel.value === '__new__') {
          const holder = el('div');
          holder.appendChild(this.inlineInput('Yeni kategori adı', '', async (name) => {
            const r = await ork.call('addCategory', name);
            if (r && r.id) this.setData(await ork.call('setCategory', x.path, r.id), x.path);
          }, () => this.detail()));
          crow.replaceWith(holder);
          return;
        }
        this.setData(await ork.call('setCategory', x.path, sel.value || null), x.path);
      };
      const rm = el('button', 'btn ghost small', 'Listeden kaldır');
      rm.title = 'Sadece bu listeden kalkar, klasör silinmez.';
      rm.onclick = async () => this.setData(await ork.call('hideFolder', x.path));
      crow.append(sel, rm);
      box.appendChild(crow);
    }

    if (x.missing) {
      box.appendChild(el('div', 'np-warn', 'Bu klasör bulunamadı. Taşındıysa “Düzenle” ile yeni yolunu gir.'));
      return;
    }

    const row = el('div', 'np-row');
    const go = el('button', 'btn primary', 'Yeni oturum  ↵');
    go.onclick = () => this.start(x.path);
    row.appendChild(go);
    const rcLabel = el('label', 'np-rc');
    const rcBox = el('input');
    rcBox.type = 'checkbox';
    rcBox.id = 'np-rc';
    rcLabel.append(rcBox, el('span', '', ' 📡 Remote Control ile başlat'));
    row.appendChild(rcLabel);
    box.appendChild(row);
    const mrow = el('div', 'np-row np-model');
    const msel = el('select', 'input');
    msel.id = 'np-model';
    for (const m of MODELS) {
      const o = el('option', '', m.alias ? `🤖 ${m.label}` : '🤖 Varsayılan model');
      o.value = m.alias || '';
      msel.appendChild(o);
    }
    const esel = el('select', 'input');
    esel.id = 'np-effort';
    for (const e of EFFORTS) {
      const o = el('option', '', e ? `effort: ${e}` : 'Varsayılan effort');
      o.value = e || '';
      esel.appendChild(o);
    }
    mrow.append(msel, esel);
    box.appendChild(mrow);
    ork.call('remotePref', x.path).then((v) => (rcBox.checked = v));
    const info = await ork.call('folderInfo', x.path);
    if (this.detailDir !== x.path || this.editing) return;
    if (info.git) {
      const wr = el('div', 'np-row');
      const inp = el('input', 'input');
      inp.placeholder = 'worktree adı';
      inp.value = `is-${Math.random().toString(36).slice(2, 6)}`;
      inp.spellcheck = false;
      const b = el('button', 'btn', '⎇ Yeni worktree’de aç');
      const goWt = () => {
        const name = inp.value.trim().replace(/[^a-zA-Z0-9._-]/g, '-');
        if (name) this.start(x.path, { worktree: name });
      };
      b.onclick = goWt;
      inp.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          goWt();
        }
      };
      wr.append(inp, b);
      box.appendChild(wr);
    }
    box.appendChild(el('div', 'np-sec', `Eski konuşmalar (${info.conversations.length})`));
    const list = el('div', 'np-convs');
    if (!info.conversations.length) list.appendChild(el('div', 'conv muted', 'Bu klasörde kayıtlı konuşma yok.'));
    for (const c of info.conversations) {
      const d = el('div', 'conv');
      d.dataset.id = c.id;
      d.appendChild(el('span', 'd', ago(c.mtime)));
      d.appendChild(el('div', 't', c.title || c.first || c.id));
      if (c.title && c.first) d.appendChild(el('div', 'f', c.first));
      d.onclick = () => this.start(x.path, { resumeId: c.id });
      list.appendChild(d);
    }
    box.appendChild(list);
    this.refreshOpen();
  },

  editForm(x) {
    const f = el('div', 'np-edit');
    f.appendChild(el('div', 'np-name', 'Projeyi düzenle'));
    const nameIn = el('input', 'input');
    nameIn.value = x.name;
    nameIn.placeholder = 'Görünen ad';
    nameIn.spellcheck = false;
    const pathIn = el('input', 'input mono');
    pathIn.value = x.path;
    pathIn.placeholder = '/Users/…/Projects/proje';
    pathIn.spellcheck = false;
    const browse = el('button', 'btn', 'Gözat…');
    browse.onclick = async () => {
      const dir = await ork.call('pickFolder');
      if (dir) pathIn.value = dir;
    };
    const l1 = el('label', 'np-field');
    l1.append(el('span', 'muted', 'Ad'), nameIn);
    const prow = el('div', 'np-row');
    prow.append(pathIn, browse);
    const l2 = el('label', 'np-field');
    l2.append(el('span', 'muted', 'Klasör yolu'), prow);
    const note = el('div', 'np-note muted', 'Yol değişirse son kullanılanlar ve Remote Control tercihi yeni yola taşınır. Kapalı oturumlar yeni yolda açılır; çalışan oturumlar yeniden başlatılınca taşınır.');
    const actions = el('div', 'modal-actions');
    const cancel = el('button', 'btn ghost', 'Vazgeç');
    cancel.onclick = () => {
      this.editing = false;
      this.detail();
    };
    const save = el('button', 'btn primary', 'Kaydet');
    const doSave = async () => {
      const r = await ork.call('editFolder', x.path, { name: nameIn.value, path: pathIn.value });
      if (r && r.error) return toast(r.error, 5000);
      this.editing = false;
      this.setData(r, r.path);
      toast('Proje güncellendi.');
    };
    save.onclick = doSave;
    for (const inp of [nameIn, pathIn]) {
      inp.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          doSave();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancel.onclick();
        }
      };
    }
    actions.append(cancel, save);
    f.append(l1, l2, note, actions);
    setTimeout(() => nameIn.focus(), 0);
    return f;
  },

  refreshOpen() {
    const open = new Set(S.sessions.map((s) => s.id));
    document.querySelectorAll('.conv[data-id]').forEach((d) => d.classList.toggle('open', open.has(d.dataset.id)));
  },
  async start(dir, opts = {}) {
    const rcBox = document.getElementById('np-rc');
    if (rcBox && this.detailDir === dir) opts.remote = rcBox.checked;
    const msel = document.getElementById('np-model');
    const esel = document.getElementById('np-effort');
    if (msel && this.detailDir === dir) {
      opts.model = msel.value || null;
      opts.effort = esel.value || null;
    }
    const id = await ork.call('newSession', { cwd: dir, ...opts });
    this.hide();
    if (!id) return toast('Klasör bulunamadı.');
    pendingShow = id;
    if (S.byId.has(id)) {
      pendingShow = null;
      showInFocusedOrAdd(id);
    }
  },
};

let pendingShow = null;
// ＋ at the top / ⌘⇧N: Claude on the Desktop right away, without the project picker.
async function quickSession() {
  const id = await ork.call('quickSession');
  if (!id) return toast('Masaüstü klasörü bulunamadı.');
  pendingShow = id;
  if (S.byId.has(id)) {
    pendingShow = null;
    showInFocusedOrAdd(id);
  }
}
function showInFocusedOrAdd(id) {
  // a new session goes into the focused pane (design), or a new pane when the screen is empty
  showInFocused(id);
}

$('#np-search').addEventListener('input', (e) => modalNew.filter(e.target.value));
$('#np-search').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    modalNew.select(Math.min(modalNew.flat.length - 1, modalNew.active + 1));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    modalNew.select(Math.max(0, modalNew.active - 1));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const x = modalNew.current();
    if (x && !x.missing) modalNew.start(x.path);
  }
});
$('#np-pick').onclick = async () => {
  const dir = await ork.call('pickFolder');
  if (dir) modalNew.setData(await ork.call('addFolder', dir, null), dir);
};
$('#np-newcat').onclick = () => {
  modalNew.addingCat = true;
  modalNew.renderFolders();
  $('#np-folders').scrollTop = 0;
};
$('#modal-new').addEventListener('mousedown', (e) => {
  if (e.target.id === 'modal-new') modalNew.hide();
});

// ------------------------------------------------------------------ broadcast modal

const modalBc = {
  open: false,
  targets: [],
  show() {
    this.targets = S.selected.size ? S.sessions.filter((s) => S.selected.has(s.id)).map((s) => s.id) : [...S.visible];
    if (!this.targets.length) return toast('Önce listeden ⌘-tık ile oturum seç ya da ekrana oturum aç.');
    this.open = true;
    $('#modal-bc').hidden = false;
    this.renderTargets();
    $('#bc-text').focus();
  },
  renderTargets() {
    const box = $('#bc-targets');
    box.textContent = '';
    for (const id of this.targets) {
      const s = S.byId.get(id);
      if (!s) continue;
      const skip = s.state === 'ask' || s.state === 'exited';
      const c = el('span', `chip2${skip ? ' skip' : ''}`, s.name);
      if (skip) c.title = s.state === 'ask' ? 'izin bekliyor, atlanacak' : 'kapalı, atlanacak';
      box.appendChild(c);
    }
  },
  hide() {
    this.open = false;
    $('#modal-bc').hidden = true;
    const t = S.focused && terms.get(S.focused);
    if (t) t.term.focus();
  },
  async send() {
    const text = $('#bc-text').value.trim();
    if (!text) return;
    const r = await ork.call('broadcast', this.targets, text);
    $('#bc-text').value = '';
    this.hide();
    S.selected.clear();
    renderList();
    let msg = `${r.sent.length} oturuma gönderildi`;
    if (r.skipped.length) msg += ` · atlandı: ${r.skipped.map((x) => `${x.name} (${x.reason})`).join(', ')}`;
    toast(msg, 5000);
  },
};
$('#bc-send').onclick = () => modalBc.send();
$('#bc-cancel').onclick = () => modalBc.hide();
$('#bc-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    modalBc.send();
  }
});
$('#modal-bc').addEventListener('mousedown', (e) => {
  if (e.target.id === 'modal-bc') modalBc.hide();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // inline inputs (category name, project edit form) cancel themselves first
  if (e.target && e.target.closest && e.target.closest('.np-inline, .np-edit')) return;
  if (modelMenu) {
    e.preventDefault();
    closeModelMenu();
    return;
  }
  if (modalNew.open) {
    e.preventDefault();
    modalNew.hide();
  } else if (modalBc.open) {
    e.preventDefault();
    modalBc.hide();
  }
}, true);

// ------------------------------------------------------------------ menu commands

function inTextField() {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && !a.classList.contains('xterm-helper-textarea');
}

// ---- zoom: every pane (terminal or diff) has its own text size; ⌘+ / ⌘- / ⌘0 act on the focused one.
const paneFont = JSON.parse(localStorage.getItem('paneFont') || '{}');

function fontFor(key) {
  return paneFont[key] || S.fontSize;
}

function zoomPane(key, delta) {
  if (!key) return;
  const size = delta === 0 ? S.fontSize : Math.max(8, Math.min(28, fontFor(key) + delta));
  if (size === S.fontSize) delete paneFont[key];
  else paneFont[key] = size;
  localStorage.setItem('paneFont', JSON.stringify(paneFont));
  if (isDiff(key)) return renderDiffPane(key);
  const t = terms.get(key);
  if (t) {
    t.term.options.fontSize = size;
    fitTerm(key);
  }
  toast(`Yazı boyutu: ${size}`, 1200);
}

const commands = {
  newSession: () => modalNew.show(),
  quickSession: () => quickSession(),
  broadcast: () => modalBc.show(),
  modelMenu() {
    const p = S.focused && panes.get(S.focused);
    const b = p && p.querySelector('.mchip');
    if (b) openModelMenu(S.focused, b);
    else toast('Önce bir oturuma odaklan; model bilgisi ilk açılışta birkaç saniye sonra gelir.');
  },
  async nextWaiting() {
    const id = await ork.call('nextWaiting', S.focused);
    if (!id) return toast('Bekleyen oturum yok.');
    showInFocused(id);
  },
  hidePane: () => (S.focusedKey || S.focused) && hidePane(S.focusedKey || S.focused),
  closeSession: () => S.focused && closeSession(S.focused),
  focusIndex: (i) => {
    // numbers follow the order on screen (grouped by category)
    const id = (S.displayOrder && S.displayOrder[i]) || (S.sessions[i] && S.sessions[i].id);
    if (id) show(id);
  },
  copy() {
    if (inTextField()) return document.execCommand('copy');
    const t = S.focused && terms.get(S.focused);
    if (t && t.term.hasSelection()) ork.clipboardWrite(t.term.getSelection());
  },
  async paste() {
    const clip = await ork.clipboardRead();
    const text = clip && clip.text;
    if (inTextField()) return text && document.execCommand('insertText', false, text);
    const t = S.focused && terms.get(S.focused);
    if (!t) return toast('Yapıştırmak için önce bir oturuma tıkla.');
    if (text) return t.term.paste(text);
    if (!clip || !clip.image) return;
    // An image on the clipboard (e.g. ⌃⇧⌘4): save it as a PNG and paste its path, like a dropped file.
    const p = await ork.call('saveClipboardImage').catch(() => null);
    if (!p) return toast('Panodaki görsel okunamadı.');
    t.term.paste(DropPaths.dropText([p]));
    toast('🖼 Görsel eklendi', 2500);
  },
  selectAll() {
    if (inTextField()) return document.activeElement.select();
    const t = S.focused && terms.get(S.focused);
    if (t) t.term.selectAll();
  },
  fontBigger: () => zoomPane(S.focusedKey || S.focused, +1),
  fontSmaller: () => zoomPane(S.focusedKey || S.focused, -1),
  fontReset: () => zoomPane(S.focusedKey || S.focused, 0),
  toggleSidebar() {
    $('#app').classList.toggle('no-sidebar');
    localStorage.setItem('sidebar', $('#app').classList.contains('no-sidebar') ? 'off' : 'on');
    sidebarButtonTitle();
    requestAnimationFrame(() => S.visible.forEach(fitTerm));
  },
};

ork.on('command', (name, arg) => {
  const fn = commands[name];
  if (fn) fn(arg);
});

// ------------------------------------------------------------------ wiring

ork.on('pty-data', (id, data) => getTerm(id).term.write(data));
ork.on('pty-reset', (id) => {
  const t = terms.get(id);
  if (t) t.term.reset();
});
let restored = false;
ork.on('state', (snap) => {
  applySnapshot(snap);
  if (pendingShow && S.byId.has(pendingShow)) {
    const id = pendingShow;
    pendingShow = null;
    showInFocusedOrAdd(id);
  }
  if (!restored) restoreView();
});
ork.on('focus-session', (id) => showInFocused(id));
ork.on('init', (info) => {
  if (!info.claudeFound) toast('claude komutu bulunamadı. Terminalde `which claude` çalışıyor mu?', 10000);
  savedUi = info.ui || savedUi;
  restoreView();
});

let savedUi = null;
function restoreView() {
  if (restored || !savedUi || !S.sessions.length) return;
  restored = true;
  if (S.tree) return; // something was opened before the saved view arrived
  const known = (k) => S.byId.has(isDiff(k) ? diffSession(k) : k);
  let tree = savedUi.layout && savedUi.layout.tree ? Layout.prune(Layout.valid(savedUi.layout.tree), known) : null;
  // older saves: a plain list of up to four sessions
  if (!tree) tree = Layout.build((savedUi.visible || []).filter((id) => S.byId.has(id)).slice(0, MAX_PANES));
  if (!tree && S.sessions.length) tree = Layout.leaf(S.sessions[0].id);
  setTree(tree);
  S.focused = S.byId.has(savedUi.focused) ? savedUi.focused : S.visible[0] || null;
  renderGrid();
  if (S.focused) setFocused(S.focused);
  renderList();
  pushView();
}

function sidebarButtonTitle() {
  const t = $('#app').classList.contains('no-sidebar') ? 'Kenar çubuğunu göster (⌘B)' : 'Kenar çubuğunu gizle (⌘B)';
  document.querySelectorAll('.side-toggle').forEach((b) => (b.title = t));
}
document.querySelectorAll('.side-toggle').forEach((b) => (b.onclick = () => commands.toggleSidebar()));
$('#btn-new').onclick = () => modalNew.show();
$('#btn-quick').onclick = () => quickSession();
$('#btn-new-2').onclick = () => modalNew.show();
window.addEventListener('resize', () => requestAnimationFrame(() => S.visible.forEach(fitTerm)));
setInterval(() => {
  renderBar();
  renderList();
}, 15000);

// Starts after every script (layout.js, extras.js) has loaded: the first snapshot may need their functions.
async function boot() {
  if (localStorage.getItem('sidebar') === 'off') $('#app').classList.add('no-sidebar');
  sidebarButtonTitle();
  const init = await ork.call('initial');
  savedUi = init.ui || {};
  if (!init.savedCount) restored = true;
  applySnapshot(await ork.call('snapshot'));
  renderGrid();
  restoreView();
  if (!S.sessions.length) renderBar();
}
window.addEventListener('DOMContentLoaded', boot);
