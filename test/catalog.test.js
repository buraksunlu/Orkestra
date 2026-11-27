'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/main/catalog');

const P = '/Users/x/Projects';
const discovered = [`${P}/Gamma`, `${P}/Alpha`, `${P}/Beta`];
const titles = (secs) => secs.map((s) => `${s.title}: ${s.items.map((i) => i.name).join(',')}`);

test('auto-found projects start uncategorized', () => {
  const secs = C.sections({}, { discovered });
  assert.deepEqual(titles(secs), ['Projeler: Alpha,Beta,Gamma']);
});

test('create a category and move projects into it', () => {
  let { catalog, id } = C.addCategory({}, 'İş');
  catalog = C.setCategory(catalog, `${P}/Gamma`, id);
  catalog = C.setCategory(catalog, `${P}/Beta`, id);
  assert.deepEqual(titles(C.sections(catalog, { discovered })), ['İş: Beta,Gamma', 'Projeler: Alpha']);
  // back to uncategorized leaves no empty entry behind
  catalog = C.setCategory(catalog, `${P}/Beta`, null);
  assert.equal(catalog.items.length, 1);
});

test('adding a category with an existing name returns the same one', () => {
  const a = C.addCategory({}, 'Kişisel');
  const b = C.addCategory(a.catalog, 'kişisel');
  assert.equal(a.id, b.id);
  assert.equal(b.catalog.categories.length, 1);
});

test('deleting a category keeps its projects', () => {
  let { catalog, id } = C.addCategory({}, 'Staj');
  catalog = C.setCategory(catalog, `${P}/Alpha`, id);
  catalog = C.deleteCategory(catalog, id);
  assert.deepEqual(titles(C.sections(catalog, { discovered })), ['Projeler: Alpha,Beta,Gamma']);
});

test('rename and reorder categories', () => {
  let a = C.addCategory({}, 'A');
  let b = C.addCategory(a.catalog, 'B');
  let c = C.renameCategory(b.catalog, a.id, 'Alfa');
  c = C.moveCategory(c, b.id, 0);
  assert.deepEqual(c.categories.map((k) => k.name), ['B', 'Alfa']);
});

test('edit a project path: moved folder shows at the new path only, keeps name and category', () => {
  let { catalog, id } = C.addCategory({}, 'İş');
  catalog = C.setCategory(catalog, `${P}/Gamma`, id);
  catalog = C.editItem(catalog, `${P}/Gamma`, { name: 'Gamma', path: '/Volumes/SSD/Gamma' }, { wasDiscovered: true });
  const secs = C.sections(catalog, { discovered });
  assert.deepEqual(titles(secs), ['İş: Gamma', 'Projeler: Alpha,Beta']);
  assert.equal(secs[0].items[0].path, '/Volumes/SSD/Gamma');
});

test('a name equal to the folder name is not stored', () => {
  const c = C.editItem({}, `${P}/Beta`, { name: 'Beta' });
  assert.equal(c.items.length, 0);
});

test('hand-added folder stays in the list; hidden auto-found folder disappears', () => {
  let c = C.addFolder({}, '/Users/x/Desktop/SideProject');
  c = C.hide(c, `${P}/Beta`, { wasDiscovered: true });
  assert.deepEqual(titles(C.sections(c, { discovered })), ['Projeler: Alpha,Gamma,SideProject']);
  c = C.hide(c, '/Users/x/Desktop/SideProject');
  assert.deepEqual(titles(C.sections(c, { discovered })), ['Projeler: Alpha,Gamma']);
});

test('recent and home sections; missing folders are flagged', () => {
  const c = C.addFolder({}, '/gone');
  const secs = C.sections(c, { discovered, recent: [`${P}/Beta`], home: '/Users/x', exists: (p) => p !== '/gone' });
  assert.deepEqual(secs.map((s) => s.title), ['Son kullanılanlar', 'Projeler', 'Diğer']);
  assert.equal(secs[1].items.find((i) => i.path === '/gone').missing, true);
});

test('normalize drops broken entries and unknown categories', () => {
  const c = C.normalize({ categories: [{ id: 'x', name: 'X' }, { name: 'no id' }], items: [{ path: '/a', category: 'nope' }, { nope: 1 }], hidden: [1, '/h'] });
  assert.deepEqual(c, { categories: [{ id: 'x', name: 'X' }], items: [{ path: '/a' }], hidden: ['/h'] });
});

test('a hand-added folder survives later edits of other projects', () => {
  let c = C.addFolder({}, '/Users/x/Desktop/SideProject');
  const { catalog, id } = C.addCategory(c, 'İş');
  c = C.setCategory(catalog, `${P}/Beta`, id);
  c = C.setCategory(c, `${P}/Beta`, null);
  c = C.normalize(JSON.parse(JSON.stringify(c))); // saved and loaded again
  assert.ok(C.sections(c, { discovered }).at(-1).items.some((i) => i.path === '/Users/x/Desktop/SideProject'));
});

test('category of a session folder: the project itself, a subfolder, a worktree inside it; nothing outside', () => {
  let { catalog, id } = C.addCategory({}, 'İş');
  catalog = C.setCategory(catalog, `${P}/Gamma`, id);
  assert.equal(C.categoryOf(catalog, `${P}/Gamma`), id);
  assert.equal(C.categoryOf(catalog, `${P}/Gamma/.claude/worktrees/is-ab12`), id);
  assert.equal(C.categoryOf(catalog, `${P}/Gamma-copy`), null);
  assert.equal(C.categoryOf(catalog, `${P}/Alpha`), null);
});

test('the deepest project decides when projects are nested', () => {
  let a = C.addCategory({}, 'Dış');
  let b = C.addCategory(a.catalog, 'İç');
  let c = C.setCategory(b.catalog, `${P}/mono`, a.id);
  c = C.setCategory(c, `${P}/mono/apps/web`, b.id);
  assert.equal(C.categoryOf(c, `${P}/mono/apps/web/src`), b.id);
  assert.equal(C.categoryOf(c, `${P}/mono/apps/api`), a.id);
});
