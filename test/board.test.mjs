// Headless check of board.js: data pipeline + the hover-driven interaction model.
// No browser/jsdom — we stub what mount() touches and drive hover/actions with synthetic events.
// The bars' buttons live in innerHTML (the shim doesn't parse it), so bar clicks are simulated
// by invoking the bar's click listener with a synthetic target whose .closest('button') returns
// the {data-a,data-s} we want — exercising the real barAction path.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { mount } from '../board.js';

let raf = [];
globalThis.requestAnimationFrame = fn => { raf.push(fn); };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.prompt = () => globalThis.__prompt ?? 'X';
globalThis.confirm = () => globalThis.__confirm ?? true;
const winH = {};
globalThis.addEventListener = (t, f) => { (winH[t] ||= []).push(f); };
globalThis.removeEventListener = (t, f) => { winH[t] = (winH[t] || []).filter(x => x !== f); };

const doc = { head: { appendChild() {} }, getElementById: () => ({}), createElement: () => makeEl(), defaultView: globalThis };
function makeEl() {
  const el = {
    ownerDocument: doc, children: [], _listeners: {}, style: {}, dataset: {}, _q: {},
    _cls: new Set(), className: '', innerHTML: '', _html: undefined, _bar: null, offsetWidth: 200, offsetHeight: 40,
    classList: { add: c => el._cls.add(c), remove: c => el._cls.delete(c), toggle: (c, on) => { on ? el._cls.add(c) : el._cls.delete(c); return on; }, contains: c => el._cls.has(c) },
    addEventListener(t, f) { (el._listeners[t] ||= []).push(f); },
    removeEventListener() {}, setPointerCapture() {},
    appendChild(c) { c._parentEl = el; el.children.push(c); return c; },
    remove() { const p = el._parentEl; if (p) { const i = p.children.indexOf(el); if (i >= 0) p.children.splice(i, 1); } },
    closest(sel) { let e = el; while (e) { if (sel === '.tile' && e.className === 'tile') return e; e = e._parentEl; } return null; },
    querySelector(s) { return el._q[s] || (el._q[s] = makeEl()); }, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: el._w ?? 0, height: el._h ?? 0 }),
    get clientWidth() { return el._w ?? 0; }, get clientHeight() { return el._h ?? 0; },
  };
  return el;
}
const boardEl = makeEl(); boardEl._w = 1200; boardEl._h = 700;

function stampSingle(tree, board) {
  tree._board = board; tree._path = '';
  (function walk(n) { for (const c of n.children || []) { c._board = board; c._path = n._path ? n._path + '.' + c.id : c.id; walk(c); } })(tree);
  return tree;
}

const state = stampSingle(JSON.parse(await readFile(new URL('./fixture.json', import.meta.url))), 'fixture');
const w = [];
const board = mount(boardEl, null, {
  state, boards: [{ slug: 'fixture', name: 'Fixture', source: 'native' }],
  onStatusChange: (b, path, status) => w.push({ k: 'status', b, path, status }),
  onWeightChange: (b, path, weight) => w.push({ k: 'weight', b, path, weight }),
  onAddNode: (b, path, kind, name) => w.push({ k: 'add', b, path, kind, name }),
  onRenameNode: (b, path, name) => w.push({ k: 'rename', b, path, name }),
  onDeleteNode: (b, path) => w.push({ k: 'del', b, path }),
  onSetToolbar: (b, path, v) => w.push({ k: 'tbar', b, path, v }),
  onOpenBoard: slug => w.push({ k: 'open', slug }),
});
raf.forEach(fn => fn());

const T = () => boardEl.children.filter(t => t.className === 'tile');
const tile = id => T().find(t => t.dataset.id === id);
const ids = () => new Set(T().map(t => t.dataset.id));
const heatOf = id => tile(id)?.style.background;
const calmColor = 'rgb(50,48,41)', blockedColor = 'rgb(216,67,46)';
const hover = id => { hoverId = id; boardEl._listeners.pointermove.forEach(f => f({ target: tile(id) })); };
let hoverId = null;
function barClick(id, a, s) {   // click a button in a tile's hover bar
  const el = tile(id); assert.ok(el && el._bar, `expected a hover bar on ${id}`);
  el._bar._listeners.click.forEach(f => f({ target: { closest: x => x === 'button' ? { dataset: { a, s } } : null } }));
}

// 1. data pipeline: many tiles; todo is calm; blocked rolls up
assert.ok(T().length > 25, `expected many tiles, got ${T().length}`);
assert.equal(heatOf('gamma-1'), calmColor, 'todo leaf is calm');

// 2. done-drop + parent-prune
const s3 = stampSingle({ name: 'T', children: [
  { id: 'mixed', name: 'Mixed', weight: 1, children: [{ id: 'keep', name: 'Keep', weight: 1, status: 'todo' }, { id: 'gone', name: 'Gone', weight: 1, status: 'done' }] },
  { id: 'alldone', name: 'All done', weight: 1, children: [{ id: 'd1', name: 'd1', weight: 1, status: 'done' }] },
] }, 't');
board.setShowDone(false); board.update(s3); raf.forEach(fn => fn());   // done shown by default now; hide to test drop
assert.ok(ids().has('keep') && ids().has('mixed') && !ids().has('gone') && !ids().has('alldone'), 'done dropped, all-done pruned');

// 3. show-done reveals (green)
board.update(s3); board.setShowDone(true); raf.forEach(fn => fn());
assert.ok(tile('gone') && heatOf('gone') === 'rgb(74,92,58)', 'show-done reveals done in sage-green');
board.setShowDone(false); raf.forEach(fn => fn());
assert.ok(!tile('gone'), 'hiding done removes it');

// 4. inlined nested board + rollup across the boundary
const inlined = { name: 'Home', _board: 'home', _path: '', children: [
  { id: 'local', name: 'Local', weight: 1, status: 'todo', _board: 'home', _path: 'local' },
  { id: 'team', name: 'Team', weight: 2, _boardLink: 'team', _board: 'home', _path: 'team', children: [
    { id: 'job1', name: 'Job 1', weight: 1, status: 'blocked', _board: 'team', _path: 'job1' },
    { id: 'job2', name: 'Job 2', weight: 1, status: 'todo', _board: 'team', _path: 'job2' }] }] };
board.update(inlined); raf.forEach(fn => fn());
assert.ok(tile('job1') && tile('job2'), 'nested board children are inlined');
assert.ok(tile('team')._cls.has('board'), 'nested-board tile marked .board');
assert.notEqual(heatOf('team'), calmColor, 'blocked child rolls heat up across the boundary');

// 5. hover reveals ancestry bars; acting via a sub-board node's bar targets THAT board
hover('job1');
assert.ok(tile('job1')._bar, 'hovering a tile shows its action bar');
assert.ok(tile('team')._bar, 'and the containing board’s bar (ancestry)');
tile('job1')._bar._listeners.change.forEach(f => f({ target: { dataset: { a: 'st' }, value: 'blocked' } }));   // status dropdown
assert.deepEqual((w.at(-1)), { k: 'status', b: 'team', path: 'job1', status: 'blocked' }, 'status dropdown write targets the sub-board (team)');
barClick('job1', 'more');
let wt = w.filter(x => x.k === 'weight').at(-1);
assert.deepEqual([wt.b, wt.path], ['team', 'job1'], 'size nudge targets the sub-board too');

// 5b. double-click a deep child drills the OUTERMOST container under the view (not the child itself)
tile('job1')._listeners.dblclick[0]({ stopPropagation() {} });   // job1 is a leaf inside the 'team' board
raf.forEach(fn => fn());
assert.ok(ids().has('job1') && !ids().has('local'), 'double-clicking a nested leaf drilled into its outermost container (team)');

// 5c. an EMPTY nested board is still drillable (so you can go in and populate it)
const withEmpty = { name: 'H', _board: 'h', _path: '', children: [
  { id: 'eb', name: 'Empty board', weight: 1, _boardLink: 'eb', _board: 'h', _path: 'eb', children: [] },
  { id: 'task', name: 'Task', weight: 1, status: 'todo', _board: 'h', _path: 'task' } ] };
board.update(withEmpty); raf.forEach(fn => fn());
assert.ok(tile('eb'), 'empty board renders as a tile');
tile('eb')._listeners.dblclick[0]({ stopPropagation() {} });
raf.forEach(fn => fn());
assert.ok(!tile('eb') && T().length === 0, 'double-click drilled into the empty board (now the frame, showing no children)');

// 5d. the resize-target highlight follows hover, and flips with the modifier key
board.update(state); raf.forEach(fn => fn());
hover('gamma-1');
assert.ok(tile('gamma')._cls.has('target') && !tile('gamma-1')._cls.has('target'), 'plain hover highlights the outermost container as the resize target');
(winH.keydown || []).forEach(f => f({ ctrlKey: true }));
assert.ok(tile('gamma-1')._cls.has('target') && !tile('gamma')._cls.has('target'), 'holding a modifier flips the highlight to the innermost tile');
(winH.keyup || []).forEach(f => f({ ctrlKey: false }));
assert.ok(tile('gamma')._cls.has('target'), 'releasing the modifier flips it back to the outermost');

// 6. add via a container's hover bar
board.update(state); raf.forEach(fn => fn());
hover('gamma');
globalThis.__prompt = 'New thing';
barClick('gamma', 'add');
const add = w.filter(x => x.k === 'add').at(-1);
assert.deepEqual([add.b, add.path, add.kind, add.name], ['fixture', 'gamma', 'item', 'New thing'], 'add lands in the hovered container');

// 7. corner-drag. plain drag resizes the OUTERMOST container under the view; modifier-drag
//    resizes the exact (innermost) tile you grabbed.
function dragTile(id, mod) {
  const g = tile(id);
  const rx = parseFloat(g.style.left), ry = parseFloat(g.style.top), rw = parseFloat(g.style.width), rh = parseFloat(g.style.height);
  g._listeners.pointerdown[0]({ stopPropagation() {}, currentTarget: g, target: g, clientX: rx, clientY: ry, ctrlKey: !!mod, pointerId: 1 });
  (winH.pointermove || []).slice().forEach(f => f({ clientX: rx + rw - 15, clientY: ry + rh - 15 }));
  (winH.pointerup || []).slice().forEach(f => f());
  raf.forEach(fn => fn());
  return w.filter(x => x.k === 'weight').at(-1);
}
let cd = dragTile('gamma-1');
assert.deepEqual([cd.b, cd.path], ['fixture', 'gamma'], 'plain drag resizes the outermost container (gamma), not the leaf');
cd = dragTile('gamma-1', true);
assert.deepEqual([cd.b, cd.path], ['fixture', 'gamma.gamma-1'], 'modifier-drag resizes the innermost tile you grabbed');

// 8. shell vs bare + toolbar toggle from the toolbar
const bare = { name: 'Bare', _board: 'bare', _path: '', toolbar: false, children: [{ id: 'x', name: 'X', weight: 1, status: 'todo', _board: 'bare', _path: 'x' }] };
board.update(bare); raf.forEach(fn => fn());
assert.ok(tile('__root'), 'a bare board renders the frame as its own tile');
assert.ok(!boardEl.children.some(c => c.className === 'tlm-toolbar'), 'bare board has no toolbar');
const shell = { name: 'Shell', _board: 'shell', _path: '', children: [{ id: 'y', name: 'Y', weight: 1, status: 'todo', _board: 'shell', _path: 'y' }] };
board.update(shell); raf.forEach(fn => fn());
const tb = boardEl.children.find(c => c.className === 'tlm-toolbar');
assert.ok(tb && !tile('__root'), 'a shell board renders the toolbar; the frame is not a tile');
tb.querySelector('#tbShell').onclick();
assert.deepEqual((w.at(-1)), { k: 'tbar', b: 'shell', path: '', v: false }, 'toolbar shell toggle turns this board bare');

// attention channels: `blocked` glows (hot); `in_progress` is a calm "working" dot with zero heat
const chan = { name: 'Chan', _board: 'chan', _path: '', children: [
  { id: 'work', name: 'Work', weight: 1, status: 'in_progress', _board: 'chan', _path: 'work' },
  { id: 'stuck', name: 'Stuck', weight: 1, status: 'blocked', _board: 'chan', _path: 'stuck' },
] };
board.update(chan); raf.forEach(fn => fn());
assert.ok(tile('work') && tile('work')._cls.has('working') && !tile('work')._cls.has('hot'), 'in_progress = calm working dot, never glows');
assert.ok(tile('stuck') && tile('stuck')._cls.has('hot') && !tile('stuck')._cls.has('working'), 'blocked = glows (hot), no working dot');

console.log(`PASS — data pipeline + inlined boards + hover bars + cross-board writes + add + corner-drag + shell/toolbar + attention channels verified`);
