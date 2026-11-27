'use strict';
// Quick switcher under the ORKESTRA title (⌘K): one box to reach a workspace, a session, a project,
// or a search through every conversation. Loaded after app.js, extras.js and flow.js.

const finder = { items: [], active: 0, projects: null, projectsAt: 0 };

// Turkish and English case folding (I/ı/İ/i all alike, length kept).
const ffold = (s) => String(s || '').toLocaleLowerCase('tr').replace(/ı/g, 'i');

// How well `q` fits `text`: whole-word start > anywhere > letters in order (vkb -> backend-api). 0 = no match.
// Letters-in-order only for short names: on long paths it matches nearly anything.
function fscore(text, q, fuzzy = true) {
  const t = ffold(text);
  if (!q) return 1;
  if (!t) return 0;
  const i = t.indexOf(q);
  if (i === 0) return 4;
  if (i > 0) return /[\s/_.\-⎇]/.test(t[i - 1]) ? 3 : 2;
  if (!fuzzy || q.length < 2) return 0;
  let k = 0;
  for (const ch of t) if (ch === q[k]) k++;
  return k === q.length ? 1 : 0;
}

async function loadProjects() {
  if (finder.projects && Date.now() - finder.projectsAt < 30000) return finder.projects;
  const data = await ork.call('folders');
  const seen = new Map();
  for (const sec of (data && data.sections) || []) {
    for (const it of sec.items || []) if (!it.missing && !seen.has(it.path)) seen.set(it.path, { ...it, recent: sec.key === 'recent' });
  }
  finder.projects = [...seen.values()];
  finder.projectsAt = Date.now();
  return finder.projects;
}

const STATE_ORDER = { ask: 0, done: 1, running: 2, idle: 3, exited: 4 };

function finderResults(raw) {
  const q = ffold(raw.trim());
  const groups = { space: [], session: [], project: [] };
  for (const sp of S.spaces || []) {
    // its own name counts fully; a member's name only a little (so "web" finds the session first)
    const sc = Math.max(fscore(sp.name, q), ...sp.members.map((m) => (fscore(m.name, q, false) ? 0.5 : 0)));
    if (sc > 0) groups.space.push({ kind: 'space', sp, sc });
  }
  for (const s of S.sessions) {
    const sc = Math.max(fscore(s.name, q), fscore(s.git && s.git.branch, q), fscore(dirLabel(s), q, false), fscore(s.cwd, q, false) * 0.6);
    if (sc > 0) groups.session.push({ kind: 'session', s, sc: sc + (q ? 0 : 0.01 * (4 - (STATE_ORDER[s.state] || 0))) });
  }
  for (const p of finder.projects || []) {
    const sc = q ? Math.max(fscore(p.name, q), fscore(p.path, q, false) * 0.6) : p.recent ? 1 : 0;
    if (sc > 0) groups.project.push({ kind: 'project', p, sc: sc - 0.05 });
  }
  const limit = { space: 5, session: 8, project: q ? 6 : 4 };
  const order = ['space', 'session', 'project']
    .map((k) => ({ k, list: groups[k].sort((a, b) => b.sc - a.sc).slice(0, limit[k]) }))
    .filter((g) => g.list.length)
    // with a query, the group holding the best match comes first; without one: spaces, sessions, projects
    .sort((a, b) => (q ? b.list[0].sc - a.list[0].sc : 0));
  const out = order.flatMap((g) => g.list);
  if (q.length >= 2) out.push({ kind: 'search', q: raw.trim() });
  return out;
}

function renderFinder() {
  const box = $('#side-results');
  const raw = $('#side-q').value;
  finder.items = finderResults(raw);
  if (finder.active >= finder.items.length) finder.active = Math.max(0, finder.items.length - 1);
  box.textContent = '';
  if (!finder.items.length) {
    box.appendChild(el('div', 'fr-empty muted', raw.trim() ? 'Eşleşen yok.' : 'Oturum ya da çalışma alanı yok.'));
    box.hidden = false;
    return;
  }
  let lastKind = null;
  const titles = { space: 'Çalışma alanları', session: 'Oturumlar', project: raw.trim() ? 'Projeler · yeni oturum' : 'Son projeler · yeni oturum', search: '' };
  finder.items.forEach((it, i) => {
    if (it.kind !== lastKind && titles[it.kind]) box.appendChild(el('div', 'fr-group', titles[it.kind]));
    lastKind = it.kind;
    const row = el('div', `fr-item${i === finder.active ? ' active' : ''}`);
    if (it.kind === 'space') {
      const dots = el('span', 'sp-dots');
      for (const m of it.sp.members) {
        const s = liveOf(m);
        dots.appendChild(el('i', `st-${s ? s.state : 'closed'}`));
      }
      row.append(el('span', 'fr-ic', '▦'), el('span', 'fr-name', it.sp.name), dots, el('span', 'fr-sub', `${it.sp.members.length} oturum`));
    } else if (it.kind === 'session') {
      const s = it.s;
      row.classList.add(`st-${s.state}`);
      row.append(el('span', 'dot'), el('span', 'fr-name', s.name), el('span', 'fr-sub', s.git ? `🌿 ${s.git.branch}` : dirLabel(s)));
      const badge = { done: 'bitti', ask: 'izin', running: 'çalışıyor' }[s.state];
      if (badge) row.appendChild(el('span', `fr-badge ${s.state}`, badge));
    } else if (it.kind === 'project') {
      row.append(el('span', 'fr-ic', '📁'), el('span', 'fr-name', it.p.name), el('span', 'fr-sub', it.p.path.replace(/^\/Users\/[^/]+/, '~')));
    } else {
      row.append(el('span', 'fr-ic', '⌕'), el('span', 'fr-name', `Konuşmalarda ara: “${it.q}”`), el('span', 'fr-sub', '⌘⇧F'));
    }
    row.onmousedown = (e) => e.preventDefault(); // keep focus in the box until the action runs
    row.onclick = () => finderGo(i);
    row.onmousemove = () => {
      if (finder.active !== i) {
        finder.active = i;
        box.querySelectorAll('.fr-item').forEach((n, k) => n.classList.toggle('active', k === i));
      }
    };
    box.appendChild(row);
  });
  box.hidden = false;
  const act = box.querySelector('.fr-item.active');
  if (act) act.scrollIntoView({ block: 'nearest' });
}

function finderClose({ clear = true } = {}) {
  $('#side-results').hidden = true;
  if (clear) $('#side-q').value = '';
  finder.active = 0;
}

async function finderGo(i) {
  const it = finder.items[i];
  if (!it) return;
  finderClose();
  $('#side-q').blur();
  if (it.kind === 'space') return openSpace(it.sp.id);
  if (it.kind === 'session') return show(it.s.id);
  if (it.kind === 'project') {
    await modalNew.show();
    modalNew.setData(modalNew.data, it.p.path); // the project picked, with its options (resume, worktree…)
    return;
  }
  if (it.kind === 'search') {
    $('#sr-q').value = it.q;
    modalSearch.show();
  }
}

const sideQ = $('#side-q');
sideQ.addEventListener('focus', async () => {
  renderFinder();
  await loadProjects();
  if (document.activeElement === sideQ) renderFinder();
});
sideQ.addEventListener('input', () => {
  finder.active = 0;
  renderFinder();
});
sideQ.addEventListener('blur', () => setTimeout(() => finderClose({ clear: false }), 120));
sideQ.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = finder.items.length;
    if (!n) return;
    finder.active = (finder.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    renderFinder();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    finderGo(finder.active);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    finderClose();
    sideQ.blur();
    const t = S.focused && terms.get(S.focused);
    if (t) t.term.focus();
  }
});

// keep the list fresh while it is open (states change under it)
ork.on('state', () => {
  if (!$('#side-results').hidden) renderFinder();
});

Object.assign(commands, {
  finder() {
    if ($('#app').classList.contains('no-sidebar')) commands.toggleSidebar();
    sideQ.focus();
    sideQ.select();
  },
});
