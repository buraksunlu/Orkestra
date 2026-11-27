'use strict';
// The project list of the "new session" picker: user categories, renamed or moved projects, extra folders,
// and folders hidden from the list. Pure functions over a plain object kept in workspace.json.
//
// catalog = {
//   categories: [{ id, name }],                       // in display order
//   items: [{ path, name?, category? }],             // projects with a custom name/category, or added by hand
//   hidden: [path],                                  // auto-found ~/Projects folders removed from the list
// }
const path = require('path');

function normalize(c) {
  const out = { categories: [], items: [], hidden: [] };
  if (!c || typeof c !== 'object') return out;
  if (Array.isArray(c.categories)) {
    for (const k of c.categories) if (k && k.id && typeof k.name === 'string') out.categories.push({ id: String(k.id), name: k.name });
  }
  const catIds = new Set(out.categories.map((k) => k.id));
  const seen = new Set();
  if (Array.isArray(c.items)) {
    for (const it of c.items) {
      if (!it || typeof it.path !== 'string' || seen.has(it.path)) continue;
      seen.add(it.path);
      const item = { path: it.path };
      if (typeof it.name === 'string' && it.name.trim()) item.name = it.name.trim();
      if (it.category && catIds.has(it.category)) item.category = it.category;
      if (it.added === true) item.added = true;
      out.items.push(item);
    }
  }
  if (Array.isArray(c.hidden)) out.hidden = [...new Set(c.hidden.filter((p) => typeof p === 'string'))];
  return out;
}

function clone(c) {
  return normalize(JSON.parse(JSON.stringify(c || {})));
}

function upsert(c, p) {
  let it = c.items.find((x) => x.path === p);
  if (!it) {
    it = { path: p };
    c.items.push(it);
  }
  c.hidden = c.hidden.filter((h) => h !== p);
  return it;
}

function addCategory(c0, name) {
  const c = clone(c0);
  const n = String(name || '').trim();
  if (!n) return { catalog: c, id: null };
  const existing = c.categories.find((k) => k.name.toLocaleLowerCase('tr') === n.toLocaleLowerCase('tr'));
  if (existing) return { catalog: c, id: existing.id };
  const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  c.categories.push({ id, name: n });
  return { catalog: c, id };
}

function renameCategory(c0, id, name) {
  const c = clone(c0);
  const n = String(name || '').trim();
  const k = c.categories.find((x) => x.id === id);
  if (k && n) k.name = n;
  return c;
}

// Projects in a deleted category go back to the uncategorized list; nothing else is lost.
function deleteCategory(c0, id) {
  const c = clone(c0);
  c.categories = c.categories.filter((k) => k.id !== id);
  for (const it of c.items) if (it.category === id) delete it.category;
  return prune(c);
}

function moveCategory(c0, id, toIndex) {
  const c = clone(c0);
  const i = c.categories.findIndex((k) => k.id === id);
  if (i < 0) return c;
  const [k] = c.categories.splice(i, 1);
  c.categories.splice(Math.max(0, Math.min(toIndex, c.categories.length)), 0, k);
  return c;
}

function setCategory(c0, p, catId) {
  const c = clone(c0);
  const it = upsert(c, p);
  if (catId && c.categories.some((k) => k.id === catId)) it.category = catId;
  else delete it.category;
  return prune(c);
}

function addFolder(c0, p, catId = null) {
  const c = clone(c0);
  const it = upsert(c, p);
  it.added = true;
  if (catId && c.categories.some((k) => k.id === catId)) it.category = catId;
  return c;
}

// New name and/or path for a project. A moved auto-found folder is hidden at its old place.
function editItem(c0, oldPath, { name, path: newPath }, { wasDiscovered = false } = {}) {
  const c = clone(c0);
  const it = upsert(c, oldPath);
  const target = newPath && newPath !== oldPath ? newPath : oldPath;
  if (target !== oldPath) {
    const other = c.items.find((x) => x.path === target);
    if (other && other !== it) {
      // merge into the entry that already has that path
      if (!other.category && it.category) other.category = it.category;
      if (!other.name && it.name) other.name = it.name;
      c.items = c.items.filter((x) => x !== it);
    } else {
      it.path = target;
      it.added = true;
    }
    if (wasDiscovered) c.hidden.push(oldPath);
    c.hidden = c.hidden.filter((h) => h !== target);
  }
  const entry = c.items.find((x) => x.path === target);
  const n = typeof name === 'string' ? name.trim() : undefined;
  if (n !== undefined) {
    if (!n || n === path.basename(target)) delete entry.name;
    else entry.name = n;
  }
  c.hidden = [...new Set(c.hidden)];
  return prune(c);
}

function hide(c0, p, { wasDiscovered = false } = {}) {
  const c = clone(c0);
  c.items = c.items.filter((x) => x.path !== p);
  if (wasDiscovered) c.hidden = [...new Set([...c.hidden, p])];
  return c;
}

// Drops entries that carry nothing (auto-found, no custom name, no category).
function prune(c) {
  c.items = c.items.filter((it) => it.name || it.category || it.added);
  return c;
}

// Sections for the picker, in display order.
function sections(c0, { discovered = [], recent = [], home = null, exists = () => true } = {}) {
  const c = normalize(c0);
  const hidden = new Set(c.hidden);
  const byPath = new Map();
  for (const p of discovered) {
    if (!hidden.has(p)) byPath.set(p, { path: p, name: path.basename(p), category: null, discovered: true });
  }
  for (const it of c.items) {
    const base = byPath.get(it.path) || { path: it.path, name: path.basename(it.path), category: null, discovered: false };
    byPath.set(it.path, { ...base, name: it.name || base.name, category: it.category || null, custom: true });
  }
  for (const v of byPath.values()) v.missing = !exists(v.path);
  const sortByName = (a, b) => a.name.localeCompare(b.name, 'tr');
  const out = [];
  const rec = recent
    .map((p) => byPath.get(p) || { path: p, name: path.basename(p), category: null, discovered: false })
    .filter((x) => !x.missing && exists(x.path));
  if (rec.length) out.push({ key: 'recent', title: 'Son kullanılanlar', items: rec });
  for (const k of c.categories) {
    out.push({ key: k.id, title: k.name, catId: k.id, items: [...byPath.values()].filter((v) => v.category === k.id).sort(sortByName) });
  }
  out.push({ key: 'none', title: 'Projeler', catId: null, items: [...byPath.values()].filter((v) => !v.category).sort(sortByName) });
  if (home) out.push({ key: 'home', title: 'Diğer', items: [{ path: home, name: path.basename(home) || home, category: null, discovered: false }] });
  return out;
}

// Category of a session's folder: the project entry with the longest path that contains it.
function categoryOf(c0, dir) {
  const c = normalize(c0);
  let best = null;
  for (const it of c.items) {
    if (!it.category) continue;
    if (dir === it.path || dir.startsWith(it.path.endsWith('/') ? it.path : it.path + '/')) {
      if (!best || it.path.length > best.path.length) best = it;
    }
  }
  return best ? best.category : null;
}

module.exports = { categoryOf, normalize, addCategory, renameCategory, deleteCategory, moveCategory, setCategory, addFolder, editItem, hide, sections };
