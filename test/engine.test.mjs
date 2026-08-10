// engine.test.mjs — the shared semantics engine over an IN-MEMORY store. This is the exact
// contract hosted (tilemon-cloud) consumes: if these pass, any store that honours the three
// callbacks (readBoard -> object|null, writeBoard upsert, listSlugs) gets correct semantics.
// The HTTP layer over the file store is covered separately by server.test.mjs.
import { createEngine, slugOk, slugify, humanize, uniq, resolvePath, collectIncludes } from '../engine.js';

let passed = 0, failed = 0;
const eq = (got, want, label) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) passed++;
  else { failed++; console.error(`FAIL ${label}\n  got:  ${g}\n  want: ${w}`); }
};

const memStore = () => {
  const boards = new Map();
  const store = {
    boards, writes: 0,
    readBoard: async slug => structuredClone(boards.get(slug)) ?? null,
    writeBoard: async (slug, board) => { store.writes++; boards.set(slug, structuredClone(board)); },
    listSlugs: async () => [...boards.keys()],
  };
  return store;
};

// ---- pure helpers ----
eq(slugOk('a-b_C9'), true, 'slugOk accepts');
eq(slugOk('-bad'), false, 'slugOk rejects leading dash');
eq(slugOk('has space'), false, 'slugOk rejects space');
eq(slugify('Hello, World!'), 'hello-world', 'slugify');
eq(humanize('ship-cloud_v2'), 'Ship Cloud V2', 'humanize');
eq(uniq('a', new Set(['a', 'a-2'])), 'a-3', 'uniq appends next free');
eq(resolvePath({ children: [{ id: 'a', children: [{ id: 'b' }] }] }, 'a.b'), { id: 'b' }, 'resolvePath nested');
eq(resolvePath({ children: [] }, 'nope'), null, 'resolvePath miss');
eq(collectIncludes({ children: [{ id: 'x', include: 'p' }, { id: 'y', children: [{ id: 'z', include: 'q' }] }] }).sort(), ['p', 'q'], 'collectIncludes deep');

// ---- ops over the in-memory store ----
{
  const s = memStore();
  const e = createEngine(s);

  // status upserts: creates the board + missing path nodes (born small, humanized)
  eq(await e.status('alpha', 'work.ship', { status: 'in_progress', note: 'going' }), { ok: true }, 'status upsert ok');
  const a1 = s.boards.get('alpha');
  eq(a1.name, 'Alpha', 'upsert created board with humanized name');
  eq(a1.children[0].id, 'work', 'intermediate node created');
  eq(a1.children[0].name, 'Work', 'intermediate humanized');
  eq(a1.children[0].children[0].status, 'in_progress', 'leaf status set');
  eq(typeof a1.children[0].children[0].seen, 'number', 'liveness stamped');
  // name only fills a gap, never overwrites
  await e.status('alpha', 'work.ship', { status: 'done', name: 'Renamed?' });
  eq(s.boards.get('alpha').children[0].children[0].name, 'Ship', 'existing name not overwritten');
  eq((await e.status('alpha', 'x', { status: 'nope' })).error, 'bad status', 'status enum enforced');
  eq((await e.status('bad slug', 'x', { status: 'todo' })).status, 400, 'status slugOk enforced');

  // weight: node must exist
  eq(await e.weight('alpha', 'work', 3), { ok: true }, 'weight ok');
  eq((await e.weight('alpha', 'ghost', 3)).status, 404, 'weight 404 on missing node');
  eq((await e.weight('ghost', 'x', 1)).status, 404, 'weight 404 on missing board');

  // addNode: item + include with cycle guard
  eq((await e.createBoard('Beta', 'beta')).slug, 'beta', 'createBoard want-slug');
  eq((await e.createBoard('Beta 2')).slug, 'beta-2', 'createBoard auto-slug');
  eq((await e.createBoard('X', 'beta')).status, 409, 'createBoard dup 409');
  eq(await e.addNode('beta', { kind: 'item', name: 'First Task' }), { ok: true }, 'addNode item');
  eq(s.boards.get('beta').children[0].id, 'first-task', 'item id slugified');
  eq(s.boards.get('beta').children[0].status, 'todo', 'item born todo');
  eq(await e.addNode('alpha', { kind: 'include', target: 'beta' }), { ok: true }, 'addNode include');
  eq((await e.addNode('beta', { kind: 'include', target: 'alpha' })).status, 409, 'include cycle 409');
  eq((await e.addNode('beta', { kind: 'include', target: 'beta' })).status, 409, 'self-include 409');
  eq((await e.addNode('beta', { kind: 'include', target: 'ghost' })).status, 404, 'include missing target 404');
  eq((await e.addNode('beta', { kind: 'weird' })).status, 400, 'unknown kind 400');
  // sibling id uniquing
  await e.addNode('beta', { kind: 'item', name: 'First Task' });
  eq(s.boards.get('beta').children[1].id, 'first-task-2', 'sibling id uniqued');

  // patchNode: node rename, root rename, toolbar, nothing-to-change
  eq(await e.patchNode('beta', 'first-task', { name: 'Renamed' }), { ok: true }, 'patch rename');
  eq(s.boards.get('beta').children[0].name, 'Renamed', 'rename landed');
  eq(await e.patchNode('beta', '', { name: 'Beta Prime', toolbar: false }), { ok: true }, 'patch root');
  eq(s.boards.get('beta').name, 'Beta Prime', 'root rename landed');
  eq(s.boards.get('beta').toolbar, false, 'toolbar stored explicitly');
  eq((await e.patchNode('beta', 'first-task', {})).error, 'nothing to change', 'patch no-op 400');

  // moveNode: in-board, cross-board, guards
  await e.addNode('beta', { kind: 'item', name: 'Bucket' });
  eq(await e.moveNode('beta', 'first-task', 'beta', 'bucket'), { ok: true }, 'in-board move');
  eq(resolvePath(s.boards.get('beta'), 'bucket.first-task').name, 'Renamed', 'moved under bucket');
  eq((await e.moveNode('beta', 'bucket', 'beta', 'bucket.first-task')).status, 409, 'move into own descendant 409');
  eq(await e.moveNode('beta', 'bucket.first-task', 'alpha', ''), { ok: true }, 'cross-board move');
  eq(resolvePath(s.boards.get('alpha'), 'first-task').name, 'Renamed', 'arrived on alpha');
  eq(resolvePath(s.boards.get('beta'), 'bucket.first-task'), null, 'left beta');
  // cross-board cycle guard: a subtree including the destination can't move into it
  await e.createBoard('Gamma', 'gamma');
  await e.addNode('gamma', { kind: 'include', target: 'beta' });   // gamma includes beta
  eq((await e.moveNode('gamma', 'beta', 'beta', '')).status, 409, 'move include-of-dest into dest 409');
  eq((await e.moveNode('beta', 'ghost', 'beta', '')).status, 404, 'move missing path 404');
  eq((await e.moveNode('ghost', 'x', 'beta', '')).status, 404, 'move missing board 404');

  // removeNode
  eq(await e.removeNode('alpha', 'first-task'), { ok: true }, 'remove ok');
  eq((await e.removeNode('alpha', 'first-task')).status, 404, 'remove again 404');
  eq(s.boards.has('beta'), true, 'removing an include leaves the board intact');

  // updateBoard: caller-owned metadata mutation
  eq(await e.updateBoard('beta', b => { b.dir = '/tmp/x'; }), { ok: true }, 'updateBoard ok');
  eq(s.boards.get('beta').dir, '/tmp/x', 'metadata landed');
  eq((await e.updateBoard('ghost', () => {})).status, 404, 'updateBoard 404');

  // jira boards are read-only for structure + status
  s.boards.set('jira-b', { name: 'J', source: 'jira://PROJ', children: [] });
  eq((await e.status('jira-b', 'x', { status: 'todo' })).status, 409, 'status on jira 409');
  eq((await e.addNode('jira-b', { kind: 'item', name: 'x' })).status, 409, 'add on jira 409');
  eq((await e.moveNode('jira-b', 'x', 'beta', '')).status, 409, 'move from jira 409');

  // resolveBoard: stamping, include inlining, boundary toolbar, cycles
  const rt = await e.resolveBoard('gamma');
  eq(rt._board, 'gamma', 'root stamped');
  const boundary = rt.children.find(c => c._boardLink === 'beta');
  eq(boundary._board, 'gamma', 'boundary owned by including board');
  eq(boundary.toolbar, false, "boundary carries sub-board's shell flag");
  eq(boundary.children.every(c => c._board === 'beta'), true, "boundary children carry sub-board's stamps");
  eq(await e.resolveBoard('ghost'), null, 'resolve missing board null');
  // a hand-authored include cycle resolves as a cycle-marked empty boundary, not a hang
  s.boards.get('beta').children.push({ id: 'gamma', include: 'gamma' });
  const rc = await e.resolveBoard('gamma');
  const cyc = rc.children.find(c => c._boardLink === 'beta').children.find(c => c._boardLink === 'gamma');
  eq(cyc._cycle, true, 'cycle marked');
  eq(cyc.children, [], 'cycle children empty');
}

// ---- store-failure semantics (the data-loss guard) ----
{
  // a store whose read THROWS (corrupt file, db error) must never be treated as "board absent"
  const s = memStore();
  await createEngine(s).createBoard('Precious', 'precious');
  await createEngine(s).addNode('precious', { kind: 'item', name: 'Keep Me' });
  const broken = {
    ...s,
    readBoard: async slug => { if (slug === 'precious') throw new Error('EACCES: cannot read'); return s.readBoard(slug); },
  };
  const e = createEngine(broken);
  let threw = false;
  try { await e.status('precious', 'oops', { status: 'todo' }); } catch { threw = true; }
  eq(threw, true, 'status propagates a read failure (never creates over a real board)');
  eq(s.boards.get('precious').children[0].name, 'Keep Me', 'board untouched after failed status');
  eq(await e.resolveBoard('precious'), null, 'resolveBoard soft-fails a read error to null (404, not 500)');

  // explicit falsy toBoard is a client bug, not an in-board move (only ABSENT defaults)
  eq((await e.moveNode('beta', 'x', '', '')).error, 'bad toBoard slug', 'moveNode rejects empty toBoard');
  eq((await e.moveNode('beta', 'x', null, '')).error, 'bad toBoard slug', 'moveNode rejects null toBoard');
  // weight with a missing path is a clean 400, not a throw
  eq((await createEngine(s).weight('precious', undefined, 1)).error, 'missing path', 'weight validates path');
}

// ---- syncManaged: the collector's ownership-scoped reconcile ----
{
  const s = memStore();
  const e = createEngine(s);
  // board with a human PIN (no origin) — must never be touched by syncManaged
  s.boards.set('proj', { name: 'Proj', children: [{ id: 'pin', name: 'PIN', weight: 2, status: 'waiting' }] });

  let r = await e.syncManaged('proj', 'session', [{ id: 's-1', name: 'A', weight: 1, status: 'in_progress' }]);
  eq([r.added, r.updated, r.removed], [1, 0, 0], 'syncManaged: first add');
  eq(s.boards.get('proj').children.map(c => c.id), ['pin', 's-1'], 'pin kept, managed appended');
  eq(s.boards.get('proj').children[1].origin, 'session', 'managed node stamped with origin');

  r = await e.syncManaged('proj', 'session', [{ id: 's-1', name: 'A2', weight: 1, status: 'waiting' }, { id: 's-2', name: 'B', weight: 1 }]);
  eq([r.added, r.updated, r.removed], [1, 1, 0], 'syncManaged: add one, update one');
  eq(s.boards.get('proj').children.find(c => c.id === 's-1').name, 'A2', 'managed node updated in place');

  r = await e.syncManaged('proj', 'session', []);   // all sessions gone
  eq([r.added, r.updated, r.removed], [0, 0, 2], 'syncManaged: clears all managed');
  eq(s.boards.get('proj').children.map(c => c.id), ['pin'], 'pin survives an empty sync');

  r = await e.syncManaged('fresh-board', 'session', [{ id: 's-9', name: 'X', weight: 1 }]);
  eq(r.ok && s.boards.has('fresh-board'), true, 'syncManaged creates a missing board');
  // a different origin is left alone by a session sync
  s.boards.set('multi', { name: 'M', children: [{ id: 'a', origin: 'other', name: 'other' }] });
  await e.syncManaged('multi', 'session', [{ id: 's-x', name: 'x', weight: 1 }]);
  eq(s.boards.get('multi').children.some(c => c.id === 'a' && c.origin === 'other'), true, 'other origin untouched');

  // no-op sync does NOT write (kills the per-poll churn)
  const s2 = memStore(); const e2 = createEngine(s2);
  const nodes = [{ id: 's-a', name: 'A', weight: 1, status: 'waiting', seen: 5 }];
  await e2.syncManaged('b', 'session', nodes);
  const after1 = s2.writes;
  const r2 = await e2.syncManaged('b', 'session', nodes);   // identical → skip
  eq([r2.added, r2.updated, r2.removed], [0, 0, 0], 'no-op sync reports no change');
  eq(s2.writes, after1, 'no-op sync does not write (no churn)');
  const r3 = await e2.syncManaged('b', 'session', [{ id: 's-a', name: 'A', weight: 1, status: 'in_progress', seen: 9 }]);
  eq([r3.updated, s2.writes > after1], [1, true], 'a real change DOES write');

  // a managed id that collides with a PIN is suffixed, never shadows the pin
  s2.boards.set('c', { name: 'C', children: [{ id: 's-a', name: 'PIN', weight: 3 }] });   // pin id 's-a', no origin
  await e2.syncManaged('c', 'session', [{ id: 's-a', name: 'session-a', weight: 1 }]);
  const cc = s2.boards.get('c').children;
  eq(cc.find(x => x.id === 's-a' && !x.origin)?.name, 'PIN', 'pin with clashing id kept intact');
  eq(cc.some(x => x.origin === 'session' && x.id !== 's-a'), true, 'colliding managed id suffixed');
}

console.log(`engine: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
