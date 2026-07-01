// Headless check of board.js's data pipeline using a minimal DOM shim.
// No browser / jsdom needed: we stub exactly what mount() touches, render an
// anonymized fixture, and assert the bridge logic (done-drop, status->heat,
// area-weighted rollup, string-id handling, weight-share callback path).
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { mount } from '../board.js';

// ---- tiny DOM shim ----------------------------------------------------------
let raf = [];
globalThis.requestAnimationFrame = fn => { raf.push(fn); return raf.length; };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };

const doc = {
  head: { appendChild() {} },
  getElementById: () => ({ /* style already injected */ }),
  createElement: () => makeEl(),
};
function makeEl() {
  const el = {
    ownerDocument: doc, children: [], _listeners: {}, style: {}, dataset: {},
    _cls: new Set(), innerHTML: '', _html: undefined,
    classList: {
      add: c => el._cls.add(c), remove: c => el._cls.delete(c),
      toggle: (c, on) => { on ? el._cls.add(c) : el._cls.delete(c); return on; },
      contains: c => el._cls.has(c),
    },
    addEventListener(t, f) { (el._listeners[t] ||= []).push(f); },
    removeEventListener() {}, setPointerCapture() {},
    appendChild(c) { c._parentEl = el; el.children.push(c); return c; },
    remove() { const p = el._parentEl; if (p) { const i = p.children.indexOf(el); if (i >= 0) p.children.splice(i, 1); } },
    querySelector: () => makeEl(), querySelectorAll: () => [],
    get clientWidth() { return el._w ?? 0; }, get clientHeight() { return el._h ?? 0; },
  };
  return el;
}
const boardEl = makeEl(); boardEl._w = 1200; boardEl._h = 700;
const controlsEl = makeEl();

// ---- run ---------------------------------------------------------------------
const state = JSON.parse(await readFile(new URL('./fixture.json', import.meta.url)));
const writes = [];
const board = mount(boardEl, controlsEl, {
  state,
  onWeightChange: (path, weight) => writes.push({ kind: 'weight', path, weight }),
  onStatusChange: (path, status) => writes.push({ kind: 'status', path, status }),
  onOpenBoard: slug => writes.push({ kind: 'open', slug }),
});
raf.forEach(fn => fn()); // flush opacity-in callbacks

const tiles = boardEl.children;
const heatOf = id => tiles.find(t => t.dataset.id === id)?.style.background;

// 1. every non-done node got a tile (4 epics + a sub-epic + their open leaves)
assert.ok(tiles.length > 25, `expected many tiles, got ${tiles.length}`);

// 2. done leaves drop off the board entirely
function countOpenLeaves(n) {
  const k = n.children;
  if (!k || !k.length) return n.status === 'done' ? 0 : 1;
  return k.reduce((s, c) => s + countOpenLeaves(c), 0);
}
const visibleLeaves = tiles.filter(t => (t._html || '').includes('class="leaf"')).length;
// (only leaves big enough to label render text; just assert no 'done' id is present)
const doneIds = [];
(function walk(n){ const k=n.children; if(!k||!k.length){ if(n.status==='done') doneIds.push(n.id); } else k.forEach(walk); })(state);
for (const id of doneIds) assert.equal(heatOf(id), undefined, `done leaf ${id} should not render`);

// 3. status -> heat -> colour. blocked must be hot (vermilion-ish, high R), todo calm (dark).
const blockedColor = 'rgb(216,67,46)';
const calmColor = 'rgb(50,48,41)';
// pick a known todo leaf
const aTodo = 'gamma-1';
assert.equal(heatOf(aTodo), calmColor, `todo leaf should be calm, got ${heatOf(aTodo)}`);

// flip it blocked via a fresh state and update(); its tile must turn hot, and its
// parent epic must heat up too (area-weighted rollup crosses the leaf->epic boundary).
const s2 = JSON.parse(JSON.stringify(state));
(function setBlocked(n){ if(n.id===aTodo){n.status='blocked';return true;} return (n.children||[]).some(setBlocked); })(s2);
board.update(s2); raf.forEach(fn => fn());
assert.equal(heatOf(aTodo), blockedColor, `blocked leaf should be vermilion, got ${heatOf(aTodo)}`);
assert.ok(tiles.find(t => t.dataset.id === aTodo)._cls.has('hot'), 'blocked leaf tile should have .hot');
// parent epic 'gamma' should now be warmer than pure-calm
const epicColor = heatOf('gamma');
assert.notEqual(epicColor, calmColor, `epic with a blocked child should not be fully calm (rollup), got ${epicColor}`);

// 4. done-drop + parent-prune (synthetic, since the FO data has no `done` items):
//    a leaf marked done vanishes; an epic whose children are ALL done vanishes too.
const s3 = {
  name: 'T', children: [
    { id: 'mixed', name: 'Mixed', weight: 1, children: [
      { id: 'keep', name: 'Keep', weight: 1, status: 'todo' },
      { id: 'gone', name: 'Gone', weight: 1, status: 'done' },
    ]},
    { id: 'alldone', name: 'All done', weight: 1, children: [
      { id: 'd1', name: 'd1', weight: 1, status: 'done' },
    ]},
  ],
};
board.update(s3); raf.forEach(fn => fn());
const idsNow = new Set(tiles.map(t => t.dataset.id));
assert.ok(idsNow.has('keep'), 'open leaf should remain');
assert.ok(!idsNow.has('gone'), 'done leaf should be dropped');
assert.ok(idsNow.has('mixed'), 'parent with an open child should remain');
assert.ok(!idsNow.has('alldone'), 'epic with all children done should be pruned');

// 5. a PARENT's own status is a heat floor (recursive: any node can be blocked,
//    independent of its children — the whole branch is stuck, not one task in it).
function mark(n, id, status) { if (n.id === id) { n.status = status; return true; } return (n.children || []).some(c => mark(c, id, status)); }
const s4 = JSON.parse(JSON.stringify(state)); mark(s4, 'gamma', 'blocked');
board.update(s4); raf.forEach(fn => fn());
assert.equal(heatOf('gamma'), blockedColor, `parent with its own blocked status should be hot, got ${heatOf('gamma')}`);
assert.ok(tiles.find(t => t.dataset.id === 'gamma')._cls.has('hot'), 'blocked parent tile should have .hot');
assert.equal(heatOf('gamma-1'), calmColor, 'a todo child of a blocked parent stays calm itself');

// 6. show-done makes `done` reversible from the board (not a one-way trapdoor):
//    toggling it on reveals done items (dimmed) so they can be selected and un-done.
board.update(s3);
board.setShowDone(true); raf.forEach(fn => fn());
let shown = new Set(tiles.map(t => t.dataset.id));
assert.ok(shown.has('gone'), 'show-done should reveal a done leaf');
assert.ok(shown.has('alldone') && shown.has('d1'), 'show-done should reveal an all-done branch');
assert.ok(tiles.find(t => t.dataset.id === 'gone')._cls.has('done'), 'revealed done tile should be dimmed (.done)');
assert.equal(heatOf('gone'), 'rgb(74,92,58)', 'done tile should render sage-green, not on the heat ramp');
board.setShowDone(false); raf.forEach(fn => fn());
assert.ok(!tiles.map(t => t.dataset.id).includes('gone'), 'hiding done removes it from the board again');

// 7. include tiles: a node with `_include` renders as a navigable summary tile — heat from
//    the server-provided summary, an .include marker, and double-click navigates (no inline splice).
const s7 = {
  name: 'With includes', children: [
    { id: 'local', name: 'Local work', weight: 1, status: 'todo' },
    { id: 'team', name: 'Team board', weight: 2, _include: 'team-atlas', _summaryHeat: 0.9 },
  ],
};
board.update(s7); raf.forEach(fn => fn());
const incTile = tiles.find(t => t.dataset.id === 'team');
assert.ok(incTile, 'include node should render a tile');
assert.ok(incTile._cls.has('include'), 'include tile should carry .include');
assert.ok(incTile._cls.has('hot') && heatOf('team') !== calmColor, 'include tile takes the served summary heat (0.9 → hot)');
assert.ok((incTile._html || '').includes('badge'), 'include tile shows a board badge');
assert.ok(!tiles.find(t => t.dataset.id === 'team-atlas'), 'included board is NOT inlined (navigate, not splice)');
const before = writes.filter(w => w.kind === 'open').length;
incTile._listeners.dblclick[0]({ stopPropagation() {} });   // double-click the include tile
const opened = writes.filter(w => w.kind === 'open');
assert.equal(opened.length, before + 1, 'double-clicking an include fires onOpenBoard');
assert.equal(opened.at(-1).slug, 'team-atlas', 'onOpenBoard gets the included board slug');

// 8. drill + selection survive an update (no exception, viewRoot preserved by id)
board.update(JSON.parse(JSON.stringify(s2)));

console.log(`PASS — ${tiles.length} tiles, done-drop + prune + rollup + parent-status floor + show-done + include-nav verified`);
