'use strict';
// The pane layout as a tree, like tmux or VS Code splits. Pure functions; used by the renderer and the tests.
//
//   leaf  { k: 'leaf', id }                          id = a session id, or 'diff:<session id>'
//   split { k: 'split', dir: 'row'|'col', sizes, kids }   row = side by side, col = stacked; sizes sum to 1
//
// A split always has 2+ children; removing a leaf collapses its parent when one child is left.

const Layout = (() => {
  const leaf = (id) => ({ k: 'leaf', id });
  const split = (dir, kids, sizes) => ({ k: 'split', dir, kids, sizes: sizes || kids.map(() => 1 / kids.length) });

  function leaves(n, out = []) {
    if (!n) return out;
    if (n.k === 'leaf') out.push(n.id);
    else for (const c of n.kids) leaves(c, out);
    return out;
  }

  const has = (n, id) => leaves(n).includes(id);

  function norm(sizes) {
    const t = sizes.reduce((a, b) => a + (b > 0 ? b : 0), 0);
    return t > 0 ? sizes.map((s) => (s > 0 ? s : 0) / t) : sizes.map(() => 1 / sizes.length);
  }

  // Collapses one-child splits and merges a child split into a parent of the same direction.
  function tidy(n) {
    if (!n || n.k === 'leaf') return n;
    let kids = [];
    let sizes = [];
    n.kids.forEach((c, i) => {
      const t = tidy(c);
      if (!t) return;
      if (t.k === 'split' && t.dir === n.dir) {
        t.kids.forEach((cc, j) => {
          kids.push(cc);
          sizes.push(n.sizes[i] * t.sizes[j]);
        });
      } else {
        kids.push(t);
        sizes.push(n.sizes[i]);
      }
    });
    if (!kids.length) return null;
    if (kids.length === 1) return kids[0];
    return split(n.dir, kids, norm(sizes));
  }

  // Default arrangement for a plain list: up to 3 side by side; 4 as 2x2; 5-6 as two rows.
  function build(ids) {
    const l = ids.map(leaf);
    if (!l.length) return null;
    if (l.length <= 3) return l.length === 1 ? l[0] : split('row', l);
    const top = Math.ceil(l.length / 2);
    return split('col', [split('row', l.slice(0, top)), split('row', l.slice(top))]);
  }

  function map(n, fn) {
    if (!n) return null;
    if (n.k === 'leaf') {
      const id = fn(n.id);
      return id ? leaf(id) : null;
    }
    return tidy(split(n.dir, n.kids.map((c) => map(c, fn)), n.sizes.slice()));
  }

  // Leaves `keep` says no to are dropped.
  const prune = (n, keep) => map(n, (id) => (keep(id) ? id : null));
  const remove = (n, id) => prune(n, (x) => x !== id);
  const replace = (n, a, b) => map(n, (x) => (x === a ? b : x));
  const swap = (n, a, b) => map(n, (x) => (x === a ? b : x === b ? a : x));

  // Puts `id` beside `target` ('left' | 'right' | 'top' | 'bottom'). Target takes half of its space.
  function insert(n, target, id, side) {
    if (!n) return leaf(id);
    if (!has(n, target)) target = leaves(n).slice(-1)[0];
    const dir = side === 'left' || side === 'right' ? 'row' : 'col';
    const before = side === 'left' || side === 'top';
    const go = (x) => {
      if (x.k === 'leaf') {
        if (x.id !== target) return x;
        return split(dir, before ? [leaf(id), x] : [x, leaf(id)]);
      }
      const i = x.kids.findIndex((c) => c.k === 'leaf' && c.id === target);
      if (i >= 0 && x.dir === dir) {
        const kids = x.kids.slice();
        const sizes = x.sizes.slice();
        const half = sizes[i] / 2;
        sizes[i] = half;
        kids.splice(before ? i : i + 1, 0, leaf(id));
        sizes.splice(before ? i : i + 1, 0, half);
        return split(x.dir, kids, sizes);
      }
      return split(x.dir, x.kids.map(go), x.sizes.slice());
    };
    return tidy(go(n));
  }

  // Moves an on-screen leaf next to another one (or onto it: swap).
  function move(n, id, target, side) {
    if (id === target) return n;
    if (side === 'center') return swap(n, id, target);
    return insert(remove(n, id), target, id, side);
  }

  // The split node at `path` (indices from the root).
  function at(n, path) {
    let x = n;
    for (const i of path) x = x && x.kids && x.kids[i];
    return x || null;
  }

  // Sets the sizes of the split at `path`; each child keeps at least `min` of the space.
  function resize(n, path, sizes, min = 0.06) {
    const clone = JSON.parse(JSON.stringify(n));
    const x = at(clone, path);
    if (!x || x.k !== 'split' || sizes.length !== x.kids.length) return n;
    x.sizes = norm(sizes.map((s) => Math.max(min, s)));
    return clone;
  }

  // A tree from disk or another source: only known shapes survive.
  function valid(n) {
    if (!n || typeof n !== 'object') return null;
    if (n.k === 'leaf') return typeof n.id === 'string' && n.id ? leaf(n.id) : null;
    if (n.k !== 'split' || (n.dir !== 'row' && n.dir !== 'col') || !Array.isArray(n.kids)) return null;
    const kids = n.kids.map(valid);
    const sizes = Array.isArray(n.sizes) && n.sizes.length === n.kids.length ? n.sizes.map(Number) : n.kids.map(() => 1);
    const keep = kids.map((k, i) => [k, sizes[i]]).filter(([k]) => k);
    if (!keep.length) return null;
    return tidy(split(n.dir, keep.map((x) => x[0]), norm(keep.map((x) => (Number.isFinite(x[1]) ? x[1] : 1)))));
  }

  return { leaf, split, leaves, has, build, map, prune, remove, replace, swap, insert, move, at, resize, valid, tidy };
})();

if (typeof module !== 'undefined') module.exports = Layout;
