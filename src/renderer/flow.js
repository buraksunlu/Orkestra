'use strict';
// Loaded after app.js and extras.js. Things that keep work moving without the user at the keyboard:
//   - per-session queue: messages sent one by one, each when the previous turn is finished
//   - continue after a usage limit (main puts a "continue" at the head of the queue, due after the reset)
//   - compact button in every terminal pane, with a context warning threshold
//   - search across every conversation (⌘⇧F)

const hhmm = (ms) => new Date(ms).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

// ------------------------------------------------------------------ queue loop
// Runs in the page because only the page can see whether the prompt box has unsent text in it.

const queueInFlight = new Map(); // session id -> time a send was asked

function queueDue(s, now = Date.now()) {
  const q = s.queue && s.queue[0];
  return !!q && !s.queuePaused && (!q.notBefore || q.notBefore <= now);
}

setInterval(async () => {
  const now = Date.now();
  for (const s of S.sessions) {
    if (!s.alive || !s.queue || !s.queue.length) continue;
    if (s.state !== 'done' && s.state !== 'idle') continue;
    if (!queueDue(s, now)) continue;
    if (queueInFlight.get(s.id) > now - 2500) continue;
    if (promptDraft(s.id)) continue; // never append to what the user is typing
    queueInFlight.set(s.id, now);
    const r = await ork.call('sendQueued', s.id, false);
    if (r && r.ok && r.item && r.item.kind === 'resume') toast(`▶ ${s.name}: limit sıfırlandı, devam ediyor`, 4000);
  }
}, 1500);

// ------------------------------------------------------------------ queue popover

function openQueue(id, anchor) {
  closeModelMenu();
  const s = S.byId.get(id);
  if (!s) return;
  const box = el('div', 'popover queue-pop');
  const render = () => {
    const cur = S.byId.get(id) || s;
    box.textContent = '';
    const title = el('div', 'pop-title', `Kuyruk · ${cur.name}`);
    box.appendChild(title);
    if (!cur.queue.length) box.appendChild(el('div', 'pop-note', 'Boş. Buraya yazdıkların sırayla, her biri bir önceki iş bitince gönderilir.'));
    cur.queue.forEach((q, i) => {
      const it = el('div', 'q-item');
      const txt = el('div', 'q-text', q.text);
      txt.title = q.text;
      const meta = el('div', 'q-meta');
      if (q.kind === 'resume') meta.appendChild(el('span', 'o', `⏰ ${hhmm(q.notBefore)} sonrası · limit sonrası devam`));
      else if (q.notBefore && q.notBefore > Date.now()) meta.appendChild(el('span', 'o', `⏰ ${hhmm(q.notBefore)}`));
      else meta.appendChild(el('span', 'muted', i === 0 ? (cur.queuePaused ? 'duraklatıldı' : 'sıradaki') : `${i + 1}.`));
      const acts = el('div', 'q-acts');
      const b = (t, title, fn, dis) => {
        const x = el('button', 'hbtn', t);
        x.title = title;
        x.disabled = !!dis;
        x.onclick = async (e) => {
          e.stopPropagation();
          await fn();
        };
        acts.appendChild(x);
      };
      b('↑', 'Yukarı', () => ork.call('moveQueued', id, q.id, -1), i === 0);
      b('↓', 'Aşağı', () => ork.call('moveQueued', id, q.id, +1), i === cur.queue.length - 1);
      b('×', 'Kuyruktan çıkar', () => ork.call('dequeue', id, q.id));
      it.append(txt, meta, acts);
      box.appendChild(it);
    });
    const ta = el('textarea', 'input q-input');
    ta.rows = 2;
    ta.placeholder = 'Sonraki iş… (Enter: ekle · ⇧Enter: yeni satır)';
    ta.onkeydown = async (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const t = ta.value.trim();
        if (!t) return;
        await ork.call('enqueue', id, t, false);
        ta.value = '';
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeModelMenu();
      }
    };
    box.appendChild(ta);
    const actions = el('div', 'pop-actions');
    const pause = el('button', 'btn ghost', cur.queuePaused ? '▶ Devam ettir' : '⏸ Duraklat');
    pause.onclick = () => ork.call('pauseQueue', id, !cur.queuePaused);
    const now = el('button', 'btn primary', 'Sıradakini şimdi gönder');
    now.disabled = !cur.queue.length;
    now.onclick = async () => {
      if (promptDraft(id)) return toast('Yazı kutusunda gönderilmemiş metin var; önce onu gönder ya da sil.');
      const r = await ork.call('sendQueued', id, true);
      if (!r.ok) toast(r.reason);
    };
    actions.append(pause, now);
    box.appendChild(actions);
    box.appendChild(el('div', 'pop-note', 'Claude bir işi bitirince (yeşil) sıradaki kendiliğinden gider. İzin beklerken ya da yazı kutusunda metin varken beklenir.'));
    return ta;
  };
  const ta = render();
  box._rerender = () => {
    const focused = document.activeElement && document.activeElement.classList.contains('q-input');
    const val = box.querySelector('.q-input') ? box.querySelector('.q-input').value : '';
    const t = render();
    t.value = val;
    if (focused) t.focus();
  };
  document.body.appendChild(box);
  const r = anchor.getBoundingClientRect();
  box.style.left = `${Math.max(8, Math.min(window.innerWidth - 380 - 8, r.right - 380))}px`;
  box.style.top = `${r.bottom + 6}px`;
  modelMenu = box;
  setTimeout(() => ta.focus(), 0);
}

// keep an open queue popover in step with the queue
ork.on('state', () => {
  if (modelMenu && modelMenu._rerender) modelMenu._rerender();
});

// ------------------------------------------------------------------ compact

// Two arrows pressing a bar from above and below: "compact".
const COMPACT_ICON =
  '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" style="vertical-align:-1px"><path d="M6 0.5v3.2M3.8 1.9 6 3.9l2.2-2M6 11.5V8.3M3.8 10.1 6 8.1l2.2 2M1 6h10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function ctxWarn() {
  const w = S.prefs && S.prefs.warnCtx;
  return typeof w === 'number' ? w : 50;
}

async function compactSession(id) {
  const s = S.byId.get(id);
  if (!s || !s.alive) return toast('Oturum kapalı.');
  if (s.state === 'ask') return toast('Önce izin sorusunu cevapla.');
  if (s.compacting) return toast('Zaten sıkıştırılıyor.');
  if ((s.state === 'done' || s.state === 'idle') && promptDraft(id)) return toast('Yazı kutusunda gönderilmemiş metin var; önce onu gönder ya da sil.', 5000);
  const r = await ork.call('sendOrQueue', id, '/compact', true);
  if (!r.ok) return toast(r.reason || 'Sıkıştırılamadı.');
  toast(r.sent ? `🗜 ${s.name}: sıkıştırılıyor…` : `🗜 ${s.name}: Claude şu işi bitirince sıkıştırılacak (kuyrukta ilk).`, 4000);
}

function compactMenu(anchor) {
  closeModelMenu();
  const box = el('div', 'popover');
  box.appendChild(el('div', 'pop-title', 'Context uyarı eşiği'));
  for (const v of [30, 50, 75, 0]) {
    const it = el('div', `pop-item${ctxWarn() === v ? ' sel' : ''}`);
    it.append(el('div', 'pi-name', v ? `%${v} ve üstü` : 'Uyarma'), el('div', 'pi-sub', v === 30 ? 'erken: uzun oturumlarda sık uyarır' : v === 50 ? 'varsayılan' : v === 75 ? 'geç' : 'düğme hep sakin durur'));
    it.onclick = () => {
      ork.call('setPref', 'warnCtx', v);
      closeModelMenu();
    };
    box.appendChild(it);
  }
  box.appendChild(el('div', 'pop-note', 'Bağlam doldukça model eski ayrıntıları daha zor takip eder. Eşiği geçince düğme turuncu yanar; tıklayınca /compact atılır (Claude çalışıyorsa iş bitince).'));
  document.body.appendChild(box);
  const r = anchor.getBoundingClientRect();
  box.style.left = `${Math.max(8, Math.min(window.innerWidth - 300 - 8, r.left))}px`;
  box.style.top = `${r.bottom + 6}px`;
  modelMenu = box;
}

// Buttons on the right of a terminal pane's title bar: compact (with context %) and the queue.
function headExtras(head, s) {
  if (!s.alive) return;
  const st = s.status || {};
  const warn = ctxWarn();
  const ctx = st.ctx;
  let cls = 'cbtn';
  if (s.compacting) cls += ' busy';
  else if (ctx != null && warn && ctx >= warn) cls += ctx >= Math.max(80, warn + 25) ? ' hot' : ' warm';
  const c = el('button', cls);
  c.innerHTML = COMPACT_ICON; // static markup, no data in it
  c.appendChild(document.createTextNode(s.compacting ? ' …' : ctx != null ? ` ${ctx}%` : ''));
  c.title = `Sıkıştır (/compact) · ⌘⇧K\nContext: ${ctx != null ? ctx + '%' : 'bilinmiyor'} · uyarı eşiği: ${warn ? '%' + warn : 'kapalı'}\nSağ tık: eşiği değiştir`;
  c.onclick = (e) => {
    e.stopPropagation();
    compactSession(s.id);
  };
  c.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    compactMenu(c);
  };
  head.appendChild(c);
  const n = s.queue ? s.queue.length : 0;
  const q = el('button', `qbtn${n ? ' has' : ''}${s.queuePaused && n ? ' paused' : ''}`, n ? `≡ ${n}` : '≡');
  q.title = n ? `Kuyrukta ${n} iş${s.queuePaused ? ' (duraklatıldı)' : ''} · ⌘⇧L` : 'Kuyruk: Claude bitirince sırayla gönderilecek işler · ⌘⇧L';
  q.onclick = (e) => {
    e.stopPropagation();
    openQueue(s.id, q);
  };
  head.appendChild(q);
}

// Lines under a session row: limit pause, queue.
function rowFlow(row, s) {
  const q = s.queue || [];
  const resume = q.find((x) => x.kind === 'resume');
  if (resume) {
    row.appendChild(el('div', 'qline o', `⏸ limit doldu · ${hhmm(resume.notBefore)} sonrası devam edecek`));
  } else if (s.limitHit) {
    row.appendChild(el('div', 'qline o', `⏸ limit doldu · sıfırlanma ${hhmm(s.limitHit.resetsAt)}`));
  }
  const rest = q.filter((x) => x.kind !== 'resume').length;
  if (rest) {
    const t = s.queuePaused ? `⏸ kuyrukta ${rest} iş (duraklatıldı)` : `≡ kuyrukta ${rest} iş`;
    const l = el('div', 'qline', t);
    l.title = q.map((x, i) => `${i + 1}. ${x.text}`).join('\n');
    row.appendChild(l);
  }
  const st = s.status || {};
  const warn = ctxWarn();
  if (s.alive && warn && st.ctx != null && st.ctx >= warn) {
    const l = el('div', 'qline o', `⇲ context %${st.ctx} · sıkıştırmak için tıkla`);
    l.onclick = (e) => {
      e.stopPropagation();
      compactSession(s.id);
    };
    l.style.cursor = 'pointer';
    row.appendChild(l);
  }
}

// ------------------------------------------------------------------ search every conversation (⌘⇧F)

const modalSearch = {
  open: false,
  seq: 0,
  timer: null,
  show() {
    this.open = true;
    $('#modal-search').hidden = false;
    const q = $('#sr-q');
    q.focus();
    q.select();
    if (q.value.trim().length >= 2) this.run();
    else $('#sr-status').textContent = 'Yazdığın mesajlarda ve Claude’un cevaplarında arar (açık ve kapalı bütün konuşmalar).';
  },
  hide() {
    this.open = false;
    $('#modal-search').hidden = true;
    const t = S.focused && terms.get(S.focused);
    if (t) t.term.focus();
  },
  later() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), 350);
  },
  async run() {
    const q = $('#sr-q').value.trim();
    const box = $('#sr-results');
    if (q.length < 2) {
      box.textContent = '';
      $('#sr-status').textContent = 'En az 2 harf.';
      return;
    }
    const my = ++this.seq;
    $('#sr-status').textContent = 'Aranıyor…';
    const res = await ork.call('search', q);
    if (my !== this.seq) return;
    $('#sr-status').textContent = res.length ? `${res.length} konuşma` : 'Bulunamadı.';
    box.textContent = '';
    for (const r of res) box.appendChild(this.item(r));
  },
  item(r) {
    const it = el('div', 'sr-item');
    const open = S.sessions.find((s) => s.claudeId === r.id || s.id === r.id);
    const head = el('div', 'sr-head');
    head.appendChild(el('span', 'sr-proj', r.cwd ? shortPath(r.cwd) : '?'));
    head.appendChild(el('span', 'sr-title', r.title || r.first || r.id.slice(0, 8)));
    head.appendChild(el('span', 'sr-date muted', new Date(r.mtime).toLocaleString('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })));
    if (open) head.appendChild(el('span', 'sr-open g', '● açık'));
    it.appendChild(head);
    for (const h of r.hits) {
      const line = el('div', 'sr-hit');
      line.appendChild(el('span', `sr-role ${h.role}`, h.role === 'user' ? 'sen' : 'Claude'));
      const t = el('span', 'sr-text');
      t.append(document.createTextNode(h.text.slice(0, h.at)), el('mark', '', h.text.slice(h.at, h.at + h.len)), document.createTextNode(h.text.slice(h.at + h.len)));
      line.appendChild(t);
      it.appendChild(line);
    }
    it.onclick = async () => {
      this.hide();
      if (open) return show(open.id);
      if (!r.cwd) return toast('Bu konuşmanın klasörü bilinmiyor.');
      const id = await ork.call('newSession', { cwd: r.cwd, resumeId: r.id });
      if (!id) return toast('Konuşma açılamadı (klasör taşınmış olabilir).', 5000);
      if (S.byId.has(id)) show(id);
      else pendingShow = id;
      toast('Konuşma kaldığı yerden açılıyor…');
    };
    return it;
  },
};
$('#sr-q').addEventListener('input', () => modalSearch.later());
$('#sr-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const first = $('#sr-results .sr-item');
    if (first) first.click();
  }
});
$('#modal-search').addEventListener('mousedown', (e) => {
  if (e.target.id === 'modal-search') modalSearch.hide();
});
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape' && modalSearch.open) {
      e.preventDefault();
      modalSearch.hide();
    }
  },
  true,
);

// ------------------------------------------------------------------ commands

Object.assign(commands, {
  queue() {
    const p = S.focused && panes.get(S.focused);
    const b = p && p.querySelector('.qbtn');
    if (b) openQueue(S.focused, b);
    else toast('Önce bir oturuma odaklan.');
  },
  compact: () => (S.focused ? compactSession(S.focused) : toast('Önce bir oturuma odaklan.')),
  search: () => modalSearch.show(),
  // from a notification's ✓ / ✕ buttons
  answerPermission: (a) => a && answerPermission(a.id, a.allow),
});
