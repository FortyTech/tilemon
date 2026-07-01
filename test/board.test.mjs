// Headless check of board.js's data pipeline + interaction wiring using a minimal DOM shim.
// No browser / jsdom: we stub exactly what mount() touches, then assert on the resulting tiles
// and the callbacks fired — including the tricky bit, cross-board write addressing when a
// nested board is inlined (a node's edits must target ITS board, not the one you're viewing).
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { mount } from '../board.js';

// ---- tiny DOM shim ----------------------------------------------------------
let raf = [];
globalThis.requestAnimationFrame = fn => { raf.push(fn); return raf.length; };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.prompt = () => globalThis.__prompt ?? 'X';
globalThis.confirm = () => globalThis.__confirm ?? true;
const winHandlers = {};                                  // board.js adds pointermove/up to the window
globalThis.addEventListener = (t, f) => { (winHandlers[t] ||= []).push(f); };
globalThis.removeEventListener = (t, f) => { winHandlers[t] = (winHandlers[t] || []).filter(x => x !== f); };

const doc = { head: { appendChild() {} }, getElementById: () => ({}), createElement: () => makeEl(), defaultView: globalThis };
function makeEl() {
  const el = {
    ownerDocument: doc, children: [], _listeners: {}, style: {}, dataset: {}, _q: {},
    _cls: new Set(), className: '', innerHTML: '', _html: undefined, offsetWidth: 200, offsetHeight: 120,
    classList: { add: c => el._cls.add(c), remove: c => el._cls.delete(c), toggle: (c, on) => { on ? el._cls.add(c) : el._cls.delete(c); return on; }, contains: c => el._cls.has(c) },
    addEventListener(t, f) { (el._listeners[t] ||= []).push(f); },
    removeEventListener() {}, setPointerCapture() {},
    appendChild(c) { c._parentEl = el; el.children.push(c); return c; },
    remove() { const p = el._parentEl; if (p) { const i = p.children.indexOf(el); if (i >= 0) p.children.splice(i, 1); } },
    querySelector(sel) { return el._q[sel] || (el._q[sel] = makeEl()); },
    querySelectorAll: () => [],
    get clientWidth() { return el._w ?? 0; }, get clientHeight() { return el._h ?? 0; },
  };
  return el;
}
const boardEl = makeEl(); boardEl._w = 1200; boardEl._h = 700;
const controlsEl = makeEl();

// stamp a single-board tree the way the server does (_board + local dotted _path)
function stampSingle(tree, board) {
  tree._board = board; tree._path = '';
  (function walk(n) { for (const c of n.children || []) { c._board = board; c._path = n._path ? n._path + '.' + c.id : c.id; walk(c); } })(tree);
  return tree;
}

// ---- run ---------------------------------------------------------------------
const state = stampSingle(JSON.parse(await readFile(new URL('./fixture.json', import.meta.url))), 'fixture');
const writes = [];
const board = mount(boardEl, controlsEl, {
  state,
  onStatusChange: (b, path, status) => writes.push({ kind: 'status', b, path, status }),
  onWeightChange: (b, path, weight) => writes.push({ kind: 'weight', b, path, weight }),
  onAddNode: (b, path, addKind, name) => writes.push({ kind: 'add', b, path, addKind, name }),
  onRenameNode: (b, path, name) => writes.push({ kind: 'rename', b, path, name }),
  onDeleteNode: (b, path) => writes.push({ kind: 'del', b, path }),
  onOpenBoard: slug => writes.push({ kind: 'open', slug }),
});
raf.forEach(fn => fn());

const T = () => boardEl.children.filter(t => t.className === 'tile');   // live (excludes empty-hint + popover)
const tile = id => T().find(t => t.dataset.id === id);
const tileIds = () => new Set(T().map(t => t.dataset.id));
const heatOf = id => tile(id)?.style.background;
const calmColor = 'rgb(50,48,41)', blockedColor = 'rgb(216,67,46)';
function clickTile(id) {                                  // pointerdown then pointerup (no move) => select
  const t = tile(id);
  t._listeners.pointerdown[0]({ stopPropagation() {}, currentTarget: t, clientX: 0, clientY: 0, pointerId: 1 });
  (winHandlers.pointerup || []).slice().forEach(f => f());
  raf.forEach(fn => fn());
}
const popover = () => boardEl.children.find(c => c.className === 'tlm-pop');

// 1. tiles render, status→heat, done-drop, parent-status floor (fixture: no done items)
assert.ok(T().length > 25, `expected many tiles, got ${T().length}`);
assert.equal(heatOf('gamma-1'), calmColor, 'todo leaf is calm');

// 2. done-drop + parent-prune (synthetic)
const s3 = stampSingle({ name: 'T', children: [
  { id: 'mixed', name: 'Mixed', weight: 1, children: [ { id: 'keep', name: 'Keep', weight: 1, status: 'todo' }, { id: 'gone', name: 'Gone', weight: 1, status: 'done' } ] },
  { id: 'alldone', name: 'All done', weight: 1, children: [ { id: 'd1', name: 'd1', weight: 1, status: 'done' } ] },
] }, 't');
board.update(s3); raf.forEach(fn => fn());
let ids = tileIds();
assert.ok(ids.has('keep') && ids.has('mixed'), 'open leaf + its parent remain');
assert.ok(!ids.has('gone') && !ids.has('alldone'), 'done leaf dropped, all-done epic pruned');

// 3. show-done reveals (green) then re-hides
board.update(s3); board.setShowDone(true); raf.forEach(fn => fn());
assert.ok(tile('gone'), 'show-done reveals a done leaf');
assert.equal(heatOf('gone'), 'rgb(74,92,58)', 'done tile is sage-green');
board.setShowDone(false); raf.forEach(fn => fn());
assert.ok(!tile('gone'), 'hiding done removes it again');

// 4. INLINED nested board: children are visible inline, tile is marked, heat rolls up across the boundary
const inlined = {
  name: 'Home', _board: 'home', _path: '', children: [
    { id: 'local', name: 'Local', weight: 1, status: 'todo', _board: 'home', _path: 'local' },
    { id: 'team', name: 'Team', weight: 2, _boardLink: 'team', _board: 'home', _path: 'team', children: [
      { id: 'job1', name: 'Job 1', weight: 1, status: 'blocked', _board: 'team', _path: 'job1' },
      { id: 'job2', name: 'Job 2', weight: 1, status: 'todo', _board: 'team', _path: 'job2' },
    ] },
  ],
};
board.update(inlined); raf.forEach(fn => fn());
assert.ok(tile('job1') && tile('job2'), 'nested board children are inlined (visible), not hidden behind navigation');
assert.ok(tile('team')._cls.has('board'), 'nested-board tile is marked .board');
assert.notEqual(heatOf('team'), calmColor, 'a blocked job inside rolls heat up across the board boundary');

// 5. CROSS-BOARD WRITE: editing a node inside the inlined board targets ITS board, not "home".
clickTile('job1');
let pop = popover(); assert.ok(pop, 'selecting a tile opens its popover');
pop.querySelector('#wmore').onclick();                   // nudge size bigger
const w = writes.filter(x => x.kind === 'weight').at(-1);
assert.equal(w.b, 'team', 'weight write targets the sub-board (team), not the viewed board (home)');
assert.equal(w.path, 'job1', 'weight write uses the local path within that board');
globalThis.__prompt = 'Subtask';
pop.querySelector('#pAddItem').onclick();
const a = writes.filter(x => x.kind === 'add').at(-1);
assert.deepEqual([a.b, a.path, a.addKind], ['team', 'job1', 'item'], 'add into a sub-board node targets that board');

// 6. double-click a nested board drills in (viewRoot changes), not navigate
tile('team')._listeners.dblclick[0]({ stopPropagation() {} });
raf.forEach(fn => fn());
ids = tileIds();
assert.ok(ids.has('job1') && !ids.has('local'), 'double-click a board drills into it (only its children show)');

// 7. header "add" targets the current view root's board
board.update(state); raf.forEach(fn => fn());
globalThis.__prompt = 'Top level thing';
controlsEl.querySelector('#addItem').onclick();
const ha = writes.filter(x => x.kind === 'add').at(-1);
assert.deepEqual([ha.b, ha.path, ha.addKind, ha.name], ['fixture', '', 'item', 'Top level thing'], 'header add → (viewRoot board, root path, item)');

console.log(`PASS — render + heat + done-drop + show-done + inlined-boards + cross-board writes + add verified`);
