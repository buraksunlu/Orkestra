'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/renderer/layout');

const shape = (n) => (n.k === 'leaf' ? n.id : `${n.dir}(${n.kids.map(shape).join(',')})`);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('default arrangements: side by side up to three, 2x2 for four, two rows for five and six', () => {
  assert.equal(L.build([]), null);
  assert.equal(shape(L.build(['a'])), 'a');
  assert.equal(shape(L.build(['a', 'b', 'c'])), 'row(a,b,c)');
  assert.equal(shape(L.build(['a', 'b', 'c', 'd'])), 'col(row(a,b),row(c,d))');
  assert.equal(shape(L.build(['a', 'b', 'c', 'd', 'e'])), 'col(row(a,b,c),row(d,e))');
  assert.deepEqual(L.leaves(L.build(['a', 'b', 'c', 'd'])), ['a', 'b', 'c', 'd']);
});

test('inserting beside a pane splits it, or joins a split of the same direction', () => {
  let t = L.build(['a', 'b']);
  t = L.insert(t, 'b', 'c', 'bottom');
  assert.equal(shape(t), 'row(a,col(b,c))');
  t = L.insert(t, 'a', 'd', 'left');
  assert.equal(shape(t), 'row(d,a,col(b,c))');
  close(t.sizes[0], 0.25);
  close(t.sizes[1], 0.25);
  close(t.sizes[2], 0.5);
  assert.equal(shape(L.insert(null, 'x', 'a', 'right')), 'a');
});

test('removing a pane collapses splits with one child left', () => {
  let t = L.insert(L.build(['a', 'b']), 'b', 'c', 'bottom');
  t = L.remove(t, 'c');
  assert.equal(shape(t), 'row(a,b)');
  t = L.remove(t, 'a');
  assert.equal(shape(t), 'b');
  assert.equal(L.remove(t, 'b'), null);
});

test('moving a pane: onto the middle swaps, onto an edge moves it there', () => {
  const t = L.build(['a', 'b', 'c', 'd']);
  assert.equal(shape(L.move(t, 'a', 'd', 'center')), 'col(row(d,b),row(c,a))');
  assert.equal(shape(L.move(t, 'a', 'd', 'bottom')), 'col(b,row(c,col(d,a)))');
  assert.equal(shape(L.move(L.build(['a', 'b']), 'a', 'b', 'top')), 'col(a,b)');
  assert.equal(L.move(t, 'a', 'a', 'left'), t);
});

test('resizing keeps a minimum per pane and sums to one', () => {
  const t = L.build(['a', 'b', 'c', 'd']);
  const r = L.resize(t, [0], [0.99, 0.01]);
  close(r.kids[0].sizes[0] + r.kids[0].sizes[1], 1);
  assert.ok(r.kids[0].sizes[1] > 0.05);
  assert.equal(L.resize(t, [5], [1]), t, 'a bad path changes nothing');
  close(t.kids[0].sizes[0], 0.5, 'the original is not changed');
});

test('ids can be renamed or dropped (workspace members coming back under new ids)', () => {
  const t = L.insert(L.build(['a', 'b']), 'a', 'diff:a', 'bottom');
  const m = { a: 'x', b: 'y' };
  const out = L.map(t, (id) => (id.startsWith('diff:') ? (m[id.slice(5)] ? 'diff:' + m[id.slice(5)] : null) : m[id] || null));
  assert.equal(shape(out), 'row(col(x,diff:x),y)');
  assert.equal(shape(L.prune(t, (id) => id !== 'b')), 'col(a,diff:a)');
});

test('trees from disk are checked', () => {
  assert.equal(L.valid(null), null);
  assert.equal(L.valid({ k: 'split', dir: 'diag', kids: [] }), null);
  const v = L.valid({ k: 'split', dir: 'row', sizes: [3, 1], kids: [{ k: 'leaf', id: 'a' }, { k: 'leaf', id: '' }, { k: 'leaf', id: 'b' }] });
  assert.equal(shape(v), 'row(a,b)');
  assert.equal(shape(L.valid({ k: 'split', dir: 'row', kids: [{ k: 'leaf', id: 'a' }] })), 'a');
});
