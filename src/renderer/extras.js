'use strict';
// Loaded after app.js and uses its globals (S, terms, el, $, show, toast, renderGrid, ...).
//   - last message of a finished session, under its row
//   - answering a permission prompt from the sidebar
//   - diff pane (uncommitted changes of a session's folder), placed and sized like a terminal pane
//   - workspaces: named sets of up to four sessions brought on screen with one click

// ------------------------------------------------------------------ permission prompts

// True when Claude Code's allow/deny dialog is on the terminal screen right now:
// "1. Yes" ... "N. No" ... "Esc to cancel". Read from the live screen, not the scrollback.
function permissionDialogOnScreen(id) {
  const t = terms.get(id);
  if (!t) return false;
  const b = t.term.buffer.active;
  let yes = false;
  let no = false;
  let esc = false;
  for (let y = b.baseY; y < b.baseY + t.term.rows; y++) {
    const l = b.getLine(y);
    if (!l) continue;
    const x = l.translateToString(true);
    if (/^\s*(❯\s*)?1\.\s+Yes\b/.test(x)) yes = true;
    else if (/^\s*(❯\s*)?\d\.\s+No\b/.test(x)) no = true;
    if (/Esc to cancel/i.test(x)) esc = true;
  }
  return yes && no && esc;
}

async function answerPermission(id, allow) {
  const s = S.byId.get(id);
  if (!s || s.state !== 'ask' || s.askKind !== 'permission') return;
  if (!permissionDialogOnScreen(id)) {
    toast('İzin penceresi ekranda bulunamadı; güvenlik için bölmeden cevapla.', 5000);
    show(id);
    return;
  }
  const r = await ork.call('answer', id, allow);
  if (!r.ok) return toast(r.reason || 'Cevap gönderilemedi.', 5000);
  toast(allow ? `✓ ${s.name}: izin verildi` : `✕ ${s.name}: reddedildi, Claude ne yapacağını soruyor`);
}

function pendingText(s) {
  const p = s.pending;
  if (!p) return '';
  return p.text ? `${p.tool}: ${p.text}` : p.tool;
}

// Extra lines under a session row: what is asking for permission (with answers), or the last message.
function rowExtras(row, s) {
  if (s.state === 'ask' && s.pending) {
    const line = el('div', 'pend', pendingText(s));
    line.title = pendingText(s);
    row.appendChild(line);
    if (s.askKind === 'permission') {
      const acts = el('div', 'pacts');
      if (permissionDialogOnScreen(s.id)) {
        const ok = el('button', 'pbtn ok', '✓ Onayla');
        ok.title = 'Bu seferlik izin ver (Claude Code penceresindeki "1. Yes")';
        ok.onclick = (e) => {
          e.stopPropagation();
          answerPermission(s.id, true);
        };
        const no = el('button', 'pbtn no', '✕ Reddet');
        no.title = 'Reddet (Esc): Claude durur ve ne yapacağını sorar';
        no.onclick = (e) => {
          e.stopPropagation();
          answerPermission(s.id, false);
        };
        acts.append(ok, no);
      } else {
        acts.appendChild(el('span', 'muted', 'cevaplamak için bölmeyi aç'));
      }
      row.appendChild(acts);
    }
    return;
  }
  if ((s.state === 'done' || s.state === 'idle') && s.lastMsg) {
    const m = el('div', 'last', s.lastMsg);
    m.title = s.lastMsg;
    row.appendChild(m);
  }
}

// Re-draw rows when a dialog appears on a parked terminal before the notification arrives.
setInterval(() => {
  if (S.sessions.some((s) => s.state === 'ask' && s.askKind === 'permission')) renderList();
}, 2000);

// ------------------------------------------------------------------ diff pane
// A pane like a terminal: it can be moved, resized, zoomed (⌘+ / ⌘- or A− A+) and closed. It shows the
// uncommitted changes of one session's folder and reloads itself when that session finishes or its files change.

const diffs = new Map(); // key -> { loading, data, sig }

function diffPaneFor(key) {
  let p = panes.get(key);
  if (p) return p;
  p = el('div', 'pane diff-pane');
  p.dataset.id = key;
  const head = el('div', 'pane-head');
  const body = el('div', 'pane-body diff-body');
  p.append(head, body);
  wirePane(p, key);
  panes.set(key, p);
  return p;
}

// Opens (or focuses) the diff pane of a session, beside the session's own pane when it is on screen.
function openDiff(id) {
  const s = id && S.byId.get(id);
  if (!s) return toast('Önce bir oturuma odaklan.');
  const key = 'diff:' + id;
  if (!Layout.has(S.tree, key)) {
    const keys = Layout.leaves(S.tree);
    if (keys.length >= MAX_PANES) {
      const target = keys.includes(S.focusedKey) ? S.focusedKey : keys[keys.length - 1];
      setTree(Layout.replace(S.tree, target, key));
    } else {
      const target = keys.includes(id) ? id : keys.includes(S.focusedKey) ? S.focusedKey : keys[keys.length - 1];
      setTree(Layout.insert(S.tree, target, key, sideFor(target)));
    }
    renderGrid();
    pushView();
  }
  focusKey(key);
  loadDiff(key);
}

function closeDiff(id) {
  hidePane('diff:' + id);
}

async function loadDiff(key) {
  const st = diffs.get(key) || {};
  st.loading = true;
  diffs.set(key, st);
  renderDiffPane(key);
  const data = await ork.call('diff', diffSession(key));
  st.loading = false;
  st.data = data;
  st.sel = null;
  renderDiffPane(key);
}

// Changes when the session finishes a turn or its changed-file count moves: time to reload.
function diffSig(id) {
  const s = S.byId.get(id);
  return s ? `${s.state}|${s.git ? s.git.changed : ''}` : '';
}

function renderDiffHead(key) {
  const p = panes.get(key);
  if (!p) return;
  const id = diffSession(key);
  const s = S.byId.get(id);
  const st = diffs.get(key) || {};
  const d = st.data;
  p.classList.toggle('focused', S.focusedKey === key);
  const head = p.querySelector('.pane-head');
  head.textContent = '';
  const left = el('div', 'hleft');
  left.appendChild(el('span', 'pname', `Δ ${s ? s.name : ''}`));
  if (d && d.branch) left.appendChild(el('span', 'g', `🌿 ${d.branch}`));
  if (d && d.files) {
    const add = d.files.reduce((a, f) => a + f.added, 0);
    const del = d.files.reduce((a, f) => a + f.removed, 0);
    left.appendChild(el('span', '', `${d.files.length} dosya`));
    if (add) left.appendChild(el('span', 'g', `+${add}`));
    if (del) left.appendChild(el('span', 'r', `−${del}`));
  }
  if (st.loading) left.appendChild(el('span', 'muted', 'okunuyor…'));
  const right = el('div', 'hright');
  const btn = (txt, title, fn) => {
    const b = el('button', 'hbtn', txt);
    b.title = title;
    b.onclick = (e) => {
      e.stopPropagation();
      fn();
    };
    right.appendChild(b);
  };
  btn('A−', 'Küçült (⌘-)', () => zoomPane(key, -1));
  btn('A+', 'Büyüt (⌘+)', () => zoomPane(key, +1));
  btn('⟳', 'Yenile', () => loadDiff(key));
  btn('–', 'Kapat (⌘W)', () => hidePane(key));
  head.append(left, right);
}

const MAX_LINES_PER_FILE = 4000;

function renderDiffPane(key) {
  const p = panes.get(key);
  if (!p) return;
  renderDiffHead(key);
  const body = p.querySelector('.pane-body');
  const keepScroll = body.querySelector('.dv-body');
  const scroll = keepScroll ? keepScroll.scrollTop : 0;
  body.textContent = '';
  body.style.fontSize = `${fontFor(key)}px`;
  const st = diffs.get(key) || {};
  const d = st.data;
  if (!d) {
    body.appendChild(el('div', 'dv-empty muted', st.loading ? 'Okunuyor…' : ''));
    if (!st.loading) loadDiff(key);
    return;
  }
  if (d.error) return body.appendChild(el('div', 'dv-empty muted', d.error));
  if (!d.files.length) return body.appendChild(el('div', 'dv-empty muted', 'Commit edilmemiş değişiklik yok.'));
  const view = el('div', 'dv');
  const files = el('div', 'dv-files');
  const main = el('div', 'dv-body');
  const sub = el('div', 'dv-sub muted', `${d.dir.replace(/^\/Users\/[^/]+/, '~')} · HEAD'e göre`);
  if (d.truncated) sub.appendChild(el('span', 'o', ' · çok büyük, bir kısmı gösteriliyor'));
  main.appendChild(sub);
  d.files.forEach((f, i) => {
    const item = el('div', 'dv-file');
    item.title = f.path;
    item.appendChild(el('span', 'dv-path', f.path));
    const n = el('span', 'dv-n');
    if (f.added) n.appendChild(el('span', 'g', `+${f.added}`));
    if (f.removed) n.appendChild(el('span', 'r', ` −${f.removed}`));
    if (f.note) n.appendChild(el('span', 'muted', 'yeni'));
    item.appendChild(n);
    item.onclick = () => {
      const sec = main.querySelector(`[data-i="${i}"]`);
      if (sec) main.scrollTop = sec.offsetTop - main.offsetTop;
    };
    files.appendChild(item);

    const sec = el('div', 'dv-sec');
    sec.dataset.i = String(i);
    const sh = el('div', 'dv-sec-head');
    sh.appendChild(el('span', '', f.path));
    if (f.added || f.removed) sh.appendChild(el('span', 'muted', `  +${f.added} −${f.removed}`));
    sec.appendChild(sh);
    if (f.note) sec.appendChild(el('div', 'dl muted', f.note));
    const lines = f.lines.slice(1); // the "diff --git" line repeats the header
    const shown = lines.slice(0, MAX_LINES_PER_FILE);
    // Line numbers from the hunk headers: new-file numbers for added and unchanged lines, old ones for removed.
    let oldNo = 0;
    let newNo = 0;
    let inHunk = false;
    shown.forEach((line, li) => {
      let cls = 'dl';
      let no = '';
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      if (hunk) {
        oldNo = Number(hunk[1]);
        newNo = Number(hunk[2]);
        inHunk = true;
        cls += ' hunk';
      } else if (!inHunk || line.startsWith('\\') || line.startsWith('+++') || line.startsWith('---')) cls += ' meta';
      else if (line.startsWith('+')) {
        cls += ' add';
        no = newNo++;
      } else if (line.startsWith('-')) {
        cls += ' del';
        no = oldNo++;
      } else {
        no = newNo++;
        oldNo++;
      }
      const row = el('div', cls);
      const ln = el('span', 'ln', no === '' ? '' : String(no));
      row.append(ln, el('span', 'lt', line || ' '));
      if (no !== '') {
        row.dataset.li = String(li);
        row.dataset.ln = String(no);
        ln.title = 'Bu satıra yorum yaz, Claude’a gönder (⇧-tık: aralık seç)';
        ln.onclick = (e) => {
          e.stopPropagation();
          selectDiffLine(key, i, li, e.shiftKey);
        };
      }
      sec.appendChild(row);
    });
    if (lines.length > shown.length) sec.appendChild(el('div', 'dl muted', `… ${lines.length - shown.length} satır daha`));
    main.appendChild(sec);
  });
  view.append(files, main);
  body.appendChild(view);
  main.scrollTop = scroll;
  if (st.sel) paintSelection(key);
}

// ---- comments on diff lines: select lines by their numbers, write, send to the session's Claude ----------

function selectDiffLine(key, f, li, extend) {
  const st = diffs.get(key);
  if (!st) return;
  if (extend && st.sel && st.sel.f === f) {
    st.sel.a = Math.min(st.sel.a, li);
    st.sel.b = Math.max(st.sel.b, li);
  } else st.sel = { f, a: li, b: li, text: st.sel ? st.sel.text : '' };
  paintSelection(key);
}

function paintSelection(key) {
  const p = panes.get(key);
  const st = diffs.get(key);
  if (!p || !st) return;
  p.querySelectorAll('.dl.sel').forEach((r) => r.classList.remove('sel'));
  const old = p.querySelector('.dc-box');
  if (old) {
    if (st.sel) st.sel.text = old.querySelector('textarea').value;
    old.remove();
  }
  if (!st.sel) return;
  const sec = p.querySelector(`.dv-sec[data-i="${st.sel.f}"]`);
  if (!sec) return;
  const rows = [...sec.querySelectorAll('.dl[data-li]')].filter((r) => {
    const li = Number(r.dataset.li);
    return li >= st.sel.a && li <= st.sel.b;
  });
  rows.forEach((r) => r.classList.add('sel'));
  const last = rows[rows.length - 1];
  if (!last) return;
  const box = el('div', 'dc-box');
  const from = rows[0].dataset.ln;
  const to = last.dataset.ln;
  const file = st.data.files[st.sel.f];
  box.appendChild(el('div', 'dc-title muted', `${file.path} · satır ${from === to ? from : `${from}–${to}`}`));
  const ta = el('textarea', 'input dc-text');
  ta.rows = 3;
  ta.placeholder = 'Claude’a ne yapmasını istediğini yaz…  (⌘Enter gönder · Esc vazgeç)';
  ta.value = st.sel.text || '';
  const acts = el('div', 'dc-acts');
  const cancel = el('button', 'btn ghost', 'Vazgeç');
  const sendB = el('button', 'btn primary', 'Claude’a gönder');
  cancel.onclick = () => {
    st.sel = null;
    paintSelection(key);
  };
  sendB.onclick = () => sendDiffComment(key, ta.value);
  ta.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && e.metaKey) {
      e.preventDefault();
      sendDiffComment(key, ta.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel.onclick();
    }
  };
  acts.append(cancel, sendB);
  box.append(ta, acts);
  last.after(box);
  setTimeout(() => ta.focus(), 0);
}

async function sendDiffComment(key, comment) {
  const st = diffs.get(key);
  const text = (comment || '').trim();
  if (!st || !st.sel || !text) return toast('Önce yorumu yaz.');
  const sid = diffSession(key);
  const s = S.byId.get(sid);
  if (!s || !s.alive) return toast('Oturum kapalı.');
  const file = st.data.files[st.sel.f];
  const rows = file.lines.slice(1).slice(st.sel.a, st.sel.b + 1);
  const p = panes.get(key);
  const sel = p ? [...p.querySelectorAll('.dl.sel')] : [];
  const from = sel.length ? sel[0].dataset.ln : '';
  const to = sel.length ? sel[sel.length - 1].dataset.ln : '';
  const where = from === to ? `satır ${from}` : `satır ${from}-${to}`;
  const msg = `Diff yorumu: ${file.path} ${where} (commit edilmemiş değişiklik)\n\n\`\`\`diff\n${rows.join('\n')}\n\`\`\`\n\n${text}`;
  let r;
  if ((s.state === 'done' || s.state === 'idle') && promptDraft(sid)) {
    await ork.call('enqueue', sid, msg, false);
    r = { queued: true, draft: true };
  } else r = await ork.call('sendOrQueue', sid, msg, false);
  if (r && r.ok === false) return toast(r.reason || 'Gönderilemedi.');
  st.sel = null;
  paintSelection(key);
  toast(r.sent ? `💬 ${s.name}: yorum gönderildi` : r.draft ? `💬 ${s.name}: yazı kutusu dolu, yorum kuyruğa eklendi` : `💬 ${s.name}: Claude meşgul, yorum kuyruğa eklendi (${r.position}.)`, 4000);
}

// ⌘-scroll / pinch inside a diff pane zooms it, like a browser page.
document.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    const p = e.target.closest && e.target.closest('.diff-pane');
    if (!p) return;
    e.preventDefault();
    zoomPane(p.dataset.id, e.deltaY < 0 ? +1 : -1);
  },
  { passive: false },
);

// ------------------------------------------------------------------ workspaces

// The live session of a saved member: by id, then by conversation id.
function liveOf(m) {
  return S.sessions.find((s) => s.id === m.id) || S.sessions.find((s) => s.claudeId && s.claudeId === m.claudeId) || null;
}

function spaceIsOnScreen(sp) {
  const ids = sp.members.map((m) => liveOf(m)).map((s) => s && s.id);
  return ids.length === S.visible.length && ids.every((id) => id && S.visible.includes(id));
}

function renderSpaces() {
  const box = $('#spaces');
  if (!box) return;
  box.textContent = '';
  const list = S.spaces || [];
  const head = el('div', 'sp-head');
  head.appendChild(el('span', '', 'Çalışma alanları'));
  const add = el('button', 'sp-add', '＋');
  add.title = 'Ekrandaki oturumları çalışma alanı olarak kaydet (⌘⇧S)';
  add.onclick = () => modalSpace.show();
  head.appendChild(add);
  box.appendChild(head);
  if (!list.length) {
    const hint = el('div', 'sp-hint muted', 'Ekrandaki 1-4 oturumu kaydet, sonra tek tıkla geri getir.');
    hint.onclick = () => modalSpace.show();
    box.appendChild(hint);
    return;
  }
  const chips = el('div', 'sp-chips');
  list.forEach((sp, i) => {
    const c = el('button', `sp-chip${spaceIsOnScreen(sp) ? ' on' : ''}`);
    c.appendChild(el('span', 'sp-name', sp.name));
    const dots = el('span', 'sp-dots');
    let ask = false;
    let done = false;
    for (const m of sp.members) {
      const s = liveOf(m);
      const st = s ? s.state : 'closed';
      if (st === 'ask') ask = true;
      if (st === 'done') done = true;
      dots.appendChild(el('i', `st-${st}`));
    }
    c.appendChild(dots);
    if (ask) c.classList.add('st-ask');
    else if (done) c.classList.add('st-done');
    c.title = `${sp.members.map((m) => {
      const s = liveOf(m);
      return `• ${m.name}${s ? '' : ' (kapalı, açınca devam eder)'}`;
    }).join('\n')}\n\nTıkla: ekrana getir${i < 9 ? ` (⌘⌥${i + 1})` : ''} · Sağ tık: güncelle, yeniden adlandır, sil`;
    c.onclick = () => openSpace(sp.id);
    c.oncontextmenu = (e) => {
      e.preventDefault();
      spaceMenu(sp, c);
    };
    chips.appendChild(c);
  });
  box.appendChild(chips);
}

function spaceMenu(sp, anchor) {
  closeModelMenu();
  const box = el('div', 'popover');
  const item = (label, sub, fn) => {
    const it = el('div', 'pop-item');
    it.append(el('div', 'pi-name', label), el('div', 'pi-sub', sub));
    it.onclick = () => {
      closeModelMenu();
      fn();
    };
    box.appendChild(it);
  };
  box.appendChild(el('div', 'pop-title', sp.name));
  item('Ekrandakiyle güncelle', `${S.visible.length} oturum ve şu anki bölme düzeni kaydedilir`, async () => {
    if (!S.visible.length) return toast('Ekranda oturum yok.');
    const r = await ork.call('saveSpace', sp.name, S.visible, layoutFor());
    if (r && r.error) toast(r.error);
    else toast(`“${sp.name}” güncellendi.`);
  });
  item('Yeniden adlandır', 'Oturumlar aynı kalır', () => modalSpace.show({ rename: sp }));
  item('Sil', 'Sadece kayıt silinir, oturumlar açık kalır', async () => {
    if (!window.confirm(`“${sp.name}” çalışma alanı silinsin mi? Oturumlar kapanmaz.`)) return;
    await ork.call('deleteSpace', sp.id);
  });
  document.body.appendChild(box);
  const r = anchor.getBoundingClientRect();
  box.style.left = `${Math.max(8, Math.min(window.innerWidth - 300 - 8, r.left))}px`;
  box.style.top = `${r.bottom + 6}px`;
  modelMenu = box; // shares the outside-click and Esc handling of the model menu
}

let pendingView = null;

// Shows a workspace: its saved split tree with member ids mapped to the live sessions (`map`: saved id -> live
// id). Older saves without a tree get the default arrangement.
function applyView(ids, layout, map = {}) {
  const go = () => {
    const live = (sid) => map[sid] || (ids.includes(sid) ? sid : null);
    let tree = layout && layout.tree ? Layout.valid(layout.tree) : null;
    if (tree) tree = Layout.map(tree, (k) => (isDiff(k) ? (live(diffSession(k)) ? 'diff:' + live(diffSession(k)) : null) : live(k)));
    if (!tree) tree = Layout.build(ids.slice(0, MAX_PANES));
    for (const id of ids) if (!Layout.has(tree, id) && Layout.leaves(tree).length < MAX_PANES) tree = Layout.insert(tree, Layout.leaves(tree).slice(-1)[0], id, 'right');
    setTree(tree);
    renderGrid();
    setFocused(S.visible[0]);
    renderList();
    pushView();
  };
  if (ids.every((id) => S.byId.has(id))) go();
  else pendingView = { ids, go };
}

ork.on('state', () => {
  if (pendingView && pendingView.ids.every((id) => S.byId.has(id))) {
    const p = pendingView;
    pendingView = null;
    p.go();
  }
  // diff panes reload when their session finishes a turn or its changed files move
  for (const key of Layout.leaves(S.tree).filter(isDiff)) {
    const st = diffs.get(key);
    const sig = diffSig(diffSession(key));
    if (st && st.data && !st.loading && !st.sel && st.sig !== undefined && st.sig !== sig) loadDiff(key);
    if (st) st.sig = sig;
  }
});

async function openSpace(id) {
  const r = await ork.call('openSpace', id);
  if (!r || r.error) return toast((r && r.error) || 'Çalışma alanı açılamadı.');
  if (!r.ids.length) return toast('Bu çalışma alanındaki oturumların klasörleri bulunamadı.', 5000);
  applyView(r.ids, r.layout, r.map);
  if (r.missing && r.missing.length) toast(`Klasörü bulunamadığı için açılamadı: ${r.missing.join(', ')}`, 6000);
}

const modalSpace = {
  open: false,
  rename: null,
  show(opts = {}) {
    this.rename = opts.rename || null;
    if (!this.rename && !S.visible.length) return toast('Önce kaydetmek istediğin oturumları ekrana getir.');
    this.open = true;
    $('#modal-space').hidden = false;
    $('#sp-title').textContent = this.rename ? 'Çalışma alanını yeniden adlandır' : 'Ekrandakileri çalışma alanı olarak kaydet';
    const box = $('#sp-targets');
    box.textContent = '';
    if (!this.rename) {
      for (const id of S.visible) {
        const s = S.byId.get(id);
        if (s) box.appendChild(el('span', 'chip2', s.name));
      }
    }
    box.hidden = !!this.rename;
    const input = $('#sp-name');
    input.value = this.rename ? this.rename.name : '';
    this.hint();
    input.focus();
    input.select();
  },
  hint() {
    const v = $('#sp-name').value.trim().toLocaleLowerCase('tr');
    const same = !this.rename && (S.spaces || []).find((x) => x.name.toLocaleLowerCase('tr') === v);
    $('#sp-note').textContent = same ? `“${same.name}” zaten var: üzerine yazılacak.` : this.rename ? '' : 'Bölme düzeni de kaydedilir. Kapalı oturumlar açılırken kaldığı yerden devam eder.';
  },
  hide() {
    this.open = false;
    $('#modal-space').hidden = true;
    const t = S.focused && terms.get(S.focused);
    if (t) t.term.focus();
  },
  async save() {
    const name = $('#sp-name').value.trim();
    if (!name) return;
    let r;
    if (this.rename) r = await ork.call('renameSpace', this.rename.id, name);
    else r = await ork.call('saveSpace', name, S.visible, layoutFor());
    if (r && r.error) return toast(r.error);
    this.hide();
    toast(this.rename ? 'Yeniden adlandırıldı.' : `“${name}” kaydedildi. Sol üstten ya da Çalışma alanları menüsünden aç.`, 4500);
  },
};
$('#sp-save').onclick = () => modalSpace.save();
$('#sp-cancel').onclick = () => modalSpace.hide();
$('#sp-name').addEventListener('input', () => modalSpace.hint());
$('#sp-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    modalSpace.save();
  }
});
$('#modal-space').addEventListener('mousedown', (e) => {
  if (e.target.id === 'modal-space') modalSpace.hide();
});

// ------------------------------------------------------------------ wiring

document.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'Escape' || modelMenu) return;
    if (modalSpace.open) {
      e.preventDefault();
      modalSpace.hide();
      return;
    }
  },
  true,
);

Object.assign(commands, {
  diff: () => (S.focused && Layout.has(S.tree, 'diff:' + S.focused) ? closeDiff(S.focused) : openDiff(S.focused)),
  saveSpace: () => modalSpace.show(),
  openSpace: (id) => openSpace(id),
});

// Rename a session: a small box under the row or pane title. Enter saves, Esc cancels, empty = folder name.
function renameSessionMenu(id, anchor) {
  const s = S.byId.get(id);
  if (!s) return;
  closeModelMenu();
  const box = el('div', 'popover');
  box.appendChild(el('div', 'pop-title', 'Oturumu yeniden adlandır'));
  const input = el('input', 'input');
  input.value = s.name;
  input.spellcheck = false;
  input.placeholder = 'Boş bırakırsan klasör adı kullanılır';
  box.appendChild(input);
  box.appendChild(el('div', 'pop-note', 'Enter kaydet · Esc vazgeç'));
  const save = async () => {
    const name = input.value;
    closeModelMenu();
    if (name.trim() === s.name) return;
    const r = await ork.call('renameSession', id, name);
    if (r) toast(`✎ Adı “${r}” oldu.`, 2500);
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeModelMenu();
    }
  };
  document.body.appendChild(box);
  const r = anchor.getBoundingClientRect();
  box.style.left = `${Math.max(8, Math.min(window.innerWidth - 300 - 8, r.left))}px`;
  box.style.top = `${Math.min(window.innerHeight - 140, r.bottom + 6)}px`;
  modelMenu = box;
  input.focus();
  input.select();
}
