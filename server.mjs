#!/usr/bin/env node
// TileMon — multi-board file-source server. Zero external deps; Node 18+ built-ins only.
//
//   npx tilemon                          # serves ./.tilemon (created on first run)
//   npx tilemon ./boards                 # or point it at any folder
//   PORT=4000 TILEMON_TOKEN=secret node server.mjs ./.tilemon
//
// A boards directory holds one <slug>.json per board:
//   { "name": "...", "visibility": "private", "source": "native", "children": [ ... ] }
//   source: "native" (default; agents write it) | "jira://PROJECT" (read-only; stubbed).
//
// Routes:
//   GET    /  ·  /boards/<slug>     -> dashboard (single-page app; reads the slug from the URL)
//   GET    /board.js                -> renderer module
//   GET    /api/boards              -> [{ slug, name, visibility, source }]
//   GET    /api/state?board=<slug>  -> resolved tree (includes -> navigable summary tiles, acyclic)
//   GET    /api/events              -> Server-Sent Events; "change" on any write
//   POST   /api/status {board,path,status,note?,name?} -> AGENT: upsert path, set status/note
//   POST   /api/weight {board,path,weight}             -> HUMAN: set weight (node must exist)
//   POST   /api/board  {name,slug?,source?}            -> HUMAN: create a bare board (placed nowhere) -> { slug }
//   POST   /api/node   {board,path,kind:item|include,name?,target?} -> HUMAN: add a plain item, or an include of an existing board
//   PATCH  /api/node   {board,path,name?,toolbar?}     -> HUMAN: rename / set app-shell flag
//   DELETE /api/node   {board,path}                    -> HUMAN: remove a node (referenced board file left intact)
//   POST   /api/move   {board,path,toBoard?,toPath?}   -> HUMAN: re-parent a node (within or across boards), cycle-guarded
//
// Two surfaces, split by route: AGENTS report status (they never touch structure or weight);
// HUMANS/UI own structure + weight. Setup is API-driven — nothing hand-authors the JSON files
// (though the server does watch them and live-reload, as a power-user escape hatch). If
// TILEMON_TOKEN is set, every write route requires `Authorization: Bearer <token>`.

import http from 'node:http';
import { readFile, writeFile, rename, watch, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const BOARDS = process.argv[2] || './.tilemon';   // a hidden folder of <slug>.json boards
const PORT   = Number(process.env.PORT) || 4000;
const TOKEN  = process.env.TILEMON_TOKEN || null;
const DASH   = join(__dir, 'dashboard.html');

const VALID_STATUS = new Set(['todo', 'in_progress', 'blocked', 'done']);
const STATUS_HEAT = { todo: 0, in_progress: 0.5, blocked: 1 }; // done -> treated as 0 for summary
const clients = new Set();

// ---- slugs: a board is addressed by a filesystem-safe slug, never a path ----
const slugOk = s => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(s);
const boardFile = slug => join(BOARDS, slug + '.json');
const humanize = id => id.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const slugify = s => (String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item');
// make `base` unique among a set of existing ids/slugs (append -2, -3, …)
function uniq(base, taken) {
  if (!taken.has(base)) return base;
  let i = 2; while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

// ---- board io (atomic writes; all writes serialised so near-simultaneous ones don't clobber) ----
async function readBoard(slug) {
  return JSON.parse(await readFile(boardFile(slug), 'utf8'));
}
let writing = Promise.resolve();
function writeBoard(slug, data) {
  writing = writing.then(async () => {
    const tmp = boardFile(slug) + '.tmp';
    await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
    await rename(tmp, boardFile(slug));
  });
  return writing;
}
async function listBoards() {
  let files = [];
  try { files = (await readdir(BOARDS)).filter(f => f.endsWith('.json') && !f.endsWith('.tmp.json')); }
  catch { return []; }
  const out = [];
  for (const f of files) {
    const slug = f.slice(0, -5);
    try { const b = await readBoard(slug); out.push({ slug, name: b.name || slug, visibility: b.visibility || 'private', source: b.source || 'native', toolbar: !!b.toolbar }); }
    catch { /* skip unreadable */ }
  }
  return out;
}

// ---- heat rollup for an included board's summary tile (weight-proxied; the client uses rendered area) ----
// ---- resolve a board for rendering: includes are INLINED at full granularity ----
// Every node is stamped with its owning board (`_board`) and local dotted path within that
// board (`_path`), so the client can write to the right board even across nested boundaries.
// An include becomes a boundary node (`_boardLink: slug`) whose children are the sub-board's
// resolved tree. Read-only sources mark their nodes `_ro`. Acyclic-guarded.
async function resolveBoard(slug, chain = []) {
  if (chain.includes(slug)) return { __cycle: true };
  let board;
  try { board = await readBoard(slug); }
  catch { return null; }
  const ro = typeof board.source === 'string' && board.source.startsWith('jira://');
  const build = async (node, path) => {
    if (node.include !== undefined) {
      const sub = await resolveBoard(node.include, [...chain, slug]);
      const cyc = !sub || sub.__cycle;
      return { id: node.id, name: node.name || humanize(node.include), weight: node.weight,
               _board: slug, _path: path, _boardLink: node.include,      // boundary: this node lives in THIS board
               toolbar: (!cyc && sub) ? sub.toolbar : undefined,          // pass the sub-board's shell flag through
               _missing: !sub || undefined, _cycle: (sub && sub.__cycle) || undefined,
               children: cyc ? [] : (sub.children || []) };              // children carry the sub-board's own stamps
    }
    const out = { id: node.id, name: node.name, weight: node.weight, status: node.status, note: node.note, _board: slug, _path: path };
    if (ro) out._ro = true;
    if (node.children && node.children.length) {
      out.children = [];
      for (const c of node.children) out.children.push(await build(c, path ? path + '.' + c.id : c.id));
    }
    return out;
  };
  const children = [];
  for (const c of (board.children || [])) children.push(await build(c, c.id));
  const tree = { name: board.name || slug, visibility: board.visibility || 'private',
                 source: board.source || 'native', _board: slug, _path: '', children };
  if (board.toolbar !== undefined) tree.toolbar = board.toolbar;   // app-shell flag (absent => shell; explicit false => bare)
  if (ro) tree._sourceStub = 'jira';
  return tree;
}

// ---- include-graph helpers (structure is a tree per board; includes form a cross-board graph) ----
// all board slugs referenced by `include` anywhere in a node's subtree
function collectIncludes(node) {
  const out = [], stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (n.include !== undefined) out.push(n.include);
    if (n.children) for (const c of n.children) stack.push(c);
  }
  return out;
}
// does board `from` reach board `target` by following includes (transitively)?
async function includeReaches(from, target, seen = new Set()) {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  let b; try { b = await readBoard(from); } catch { return false; }
  for (const inc of collectIncludes({ children: b.children || [] }))
    if (await includeReaches(inc, target, seen)) return true;
  return false;
}

// ---- resolve a dotted-id path in a board (node must exist) ----
function resolvePath(board, path) {
  const parts = path.split('.');
  let node = board;
  for (const part of parts) {
    const next = (node.children || []).find(c => c.id === part);
    if (!next) return null;
    node = next;
  }
  return node;
}

// ---- upsert a dotted-id path (create missing nodes, born small) and set status/note ----
function upsert(board, path, { status, note, name }) {
  const parts = path.split('.');
  let node = board;
  parts.forEach((part, i) => {
    const kids = node.children || (node.children = []);
    const last = i === parts.length - 1;
    let next = kids.find(c => c.id === part);
    if (!next) {
      next = { id: part, name: last && name ? name : humanize(part), weight: 1 };
      if (last) { next.status = status; if (note != null) next.note = note; }
      else next.children = [];
      kids.push(next);
    } else if (last) {
      next.status = status;
      if (note != null) next.note = note;
      if (name && !next.name) next.name = name;
    }
    node = next;
  });
  return node;
}

// ---- SSE ----
function broadcast() { for (const res of clients) res.write('data: change\n\n'); }
let debounce;
(async () => {
  try {
    const watcher = watch(BOARDS);
    for await (const _ of watcher) { clearTimeout(debounce); debounce = setTimeout(broadcast, 80); }
  } catch (_) { /* dir may not exist yet */ }
})();

// ---- http plumbing ----
const authed = req => !TOKEN || req.headers['authorization'] === `Bearer ${TOKEN}`;
const body = req => new Promise((res, rej) => {
  let b = ''; req.on('data', c => (b += c));
  req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(e); } });
});
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // dashboard (SPA) for / and /boards/<slug>
  if (req.method === 'GET' && (p === '/' || p === '/index.html' || p.startsWith('/boards/') || p === '/boards')) {
    try { res.writeHead(200, { 'content-type': 'text/html' }); res.end(await readFile(DASH)); }
    catch { json(res, 500, { error: 'dashboard.html not found next to server.mjs' }); }
    return;
  }
  if (req.method === 'GET' && p === '/board.js') {
    try { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(await readFile(join(__dir, 'board.js'))); }
    catch { json(res, 500, { error: 'board.js not found next to server.mjs' }); }
    return;
  }
  if (req.method === 'GET' && p === '/api/boards') {
    try { json(res, 200, await listBoards()); } catch (e) { json(res, 500, { error: String(e) }); }
    return;
  }
  if (req.method === 'GET' && p === '/api/state') {
    const slug = url.searchParams.get('board');
    if (!slugOk(slug)) return json(res, 400, { error: 'bad or missing board slug' });
    try {
      const tree = await resolveBoard(slug);
      if (!tree) return json(res, 404, { error: 'board not found: ' + slug });
      json(res, 200, tree);
    } catch (e) { json(res, 500, { error: String(e) }); }
    return;
  }
  if (req.method === 'GET' && p === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (req.method === 'POST' && p === '/api/status') {   // AGENT write: upsert + status/note
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
    try {
      const { board: slug, path, status, note, name } = await body(req);
      if (!slugOk(slug)) return json(res, 400, { error: 'bad or missing board slug' });
      if (!path) return json(res, 400, { error: 'missing path' });
      if (!VALID_STATUS.has(status)) return json(res, 400, { error: 'bad status' });
      let board;
      if (existsSync(boardFile(slug))) board = await readBoard(slug);
      else board = { name: humanize(slug), visibility: 'private', source: 'native', children: [] }; // agents can create a board
      if (typeof board.source === 'string' && board.source.startsWith('jira://'))
        return json(res, 409, { error: 'board is a read-only jira source' });
      upsert(board, path, { status, note, name });
      await writeBoard(slug, board); broadcast();
      json(res, 200, { ok: true });
    } catch (e) { json(res, 400, { error: String(e) }); }
    return;
  }
  if (req.method === 'POST' && p === '/api/weight') {   // HUMAN write: weight only, node must exist
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
    try {
      const { board: slug, path, weight } = await body(req);
      if (!slugOk(slug)) return json(res, 400, { error: 'bad or missing board slug' });
      if (!existsSync(boardFile(slug))) return json(res, 404, { error: 'board not found: ' + slug });
      const board = await readBoard(slug);
      const node = resolvePath(board, path);
      if (!node) return json(res, 404, { error: 'path not found: ' + path });
      node.weight = Number(weight);
      await writeBoard(slug, board); broadcast();
      json(res, 200, { ok: true });
    } catch (e) { json(res, 400, { error: String(e) }); }
    return;
  }

  if (req.method === 'POST' && p === '/api/node') {   // HUMAN: add a plain item OR an include of an existing board
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
    try {
      const { board: slug, path = '', kind = 'item', name, target } = await body(req);
      if (!slugOk(slug)) return json(res, 400, { error: 'bad or missing board slug' });
      if (!existsSync(boardFile(slug))) return json(res, 404, { error: 'board not found: ' + slug });
      const board = await readBoard(slug);
      if (typeof board.source === 'string' && board.source.startsWith('jira://'))
        return json(res, 409, { error: 'board is a read-only jira source' });
      const parent = path ? resolvePath(board, path) : board;   // no path => board root
      if (!parent) return json(res, 404, { error: 'path not found: ' + path });
      const kids = parent.children || (parent.children = []);
      const taken = new Set(kids.map(c => c.id));
      if (kind === 'include') {                                  // reference an EXISTING board (a navigable summary tile)
        if (!slugOk(target)) return json(res, 400, { error: 'bad or missing target board' });
        if (!existsSync(boardFile(target))) return json(res, 404, { error: 'target board not found: ' + target });
        if (target === slug || await includeReaches(target, slug))
          return json(res, 409, { error: 'would create an include cycle' });
        const nm = (name && String(name).trim()) ? String(name).trim() : humanize(target);
        kids.push({ id: uniq(target, taken), name: nm, weight: 1, include: target });
      } else if (kind === 'item') {                              // a plain node: a task, or a bucket once you add into it
        if (!name || !String(name).trim()) return json(res, 400, { error: 'missing name' });
        const nm = String(name).trim();
        kids.push({ id: uniq(slugify(nm), taken), name: nm, weight: 1, status: 'todo' });
      } else {
        return json(res, 400, { error: 'unknown kind (item | include)' });
      }
      await writeBoard(slug, board); broadcast();
      json(res, 200, { ok: true });
    } catch (e) { json(res, 400, { error: String(e) }); }
    return;
  }
  if (req.method === 'PATCH' && p === '/api/node') {   // HUMAN: rename and/or set toolbar. Empty path => the board itself.
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
    try {
      const { board: slug, path, name, toolbar } = await body(req);
      if (!slugOk(slug)) return json(res, 400, { error: 'bad or missing board slug' });
      if ((name == null || !String(name).trim()) && typeof toolbar !== 'boolean') return json(res, 400, { error: 'nothing to change' });
      if (!existsSync(boardFile(slug))) return json(res, 404, { error: 'board not found: ' + slug });
      const board = await readBoard(slug);
      const node = path ? resolvePath(board, path) : board;   // no path => the board (the "frame" tile)
      if (!node) return json(res, 404, { error: 'path not found: ' + path });
      if (name != null && String(name).trim()) node.name = String(name).trim();
      if (typeof toolbar === 'boolean') node.toolbar = toolbar;   // store explicitly (false = bare)
      await writeBoard(slug, board); broadcast();
      json(res, 200, { ok: true });
    } catch (e) { json(res, 400, { error: String(e) }); }
    return;
  }
  if (req.method === 'DELETE' && p === '/api/node') {   // HUMAN: remove a node (leaves any referenced board file intact)
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
    try {
      const { board: slug, path } = await body(req);
      if (!slugOk(slug)) return json(res, 400, { error: 'bad or missing board slug' });
      if (!path) return json(res, 400, { error: 'missing path' });
      if (!existsSync(boardFile(slug))) return json(res, 404, { error: 'board not found: ' + slug });
      const board = await readBoard(slug);
      const parts = path.split('.'); const id = parts.pop();
      const parent = parts.length ? resolvePath(board, parts.join('.')) : board;
      if (!parent || !parent.children) return json(res, 404, { error: 'path not found: ' + path });
      const before = parent.children.length;
      parent.children = parent.children.filter(c => c.id !== id);
      if (parent.children.length === before) return json(res, 404, { error: 'path not found: ' + path });
      await writeBoard(slug, board); broadcast();
      json(res, 200, { ok: true });
    } catch (e) { json(res, 400, { error: String(e) }); }
    return;
  }

  if (req.method === 'POST' && p === '/api/board') {   // HUMAN: create a bare board (placed nowhere); returns its slug
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
    try {
      const { name, slug: wantSlug, source } = await body(req);
      if (!name || !String(name).trim()) return json(res, 400, { error: 'missing name' });
      const nm = String(name).trim();
      const existing = new Set((await listBoards()).map(b => b.slug));
      let slug;
      if (wantSlug !== undefined) {
        if (!slugOk(wantSlug)) return json(res, 400, { error: 'bad slug' });
        if (existing.has(wantSlug)) return json(res, 409, { error: 'board already exists: ' + wantSlug });
        slug = wantSlug;
      } else {
        slug = uniq(slugify(nm), existing);
      }
      const src = (typeof source === 'string' && source.trim()) ? source.trim() : 'native';
      await writeBoard(slug, { name: nm, visibility: 'private', source: src, children: [] });
      broadcast();
      json(res, 200, { ok: true, slug });
    } catch (e) { json(res, 400, { error: String(e) }); }
    return;
  }
  if (req.method === 'POST' && p === '/api/move') {   // HUMAN: re-parent a node within or across boards
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
    try {
      const { board: slug, path, toBoard = slug, toPath = '' } = await body(req);
      if (!slugOk(slug)) return json(res, 400, { error: 'bad or missing board slug' });
      if (!path) return json(res, 400, { error: 'missing path' });
      if (!slugOk(toBoard)) return json(res, 400, { error: 'bad toBoard slug' });
      if (!existsSync(boardFile(slug))) return json(res, 404, { error: 'board not found: ' + slug });
      if (!existsSync(boardFile(toBoard))) return json(res, 404, { error: 'toBoard not found: ' + toBoard });
      const sameBoard = slug === toBoard;
      // structural guard: within a board, a node can't move into itself or one of its descendants
      if (sameBoard && (toPath === path || toPath.startsWith(path + '.')))
        return json(res, 409, { error: 'cannot move a node into itself' });
      const src = await readBoard(slug);
      if (typeof src.source === 'string' && src.source.startsWith('jira://'))
        return json(res, 409, { error: 'source board is a read-only jira source' });
      // detach the node from its parent (in memory; not persisted until every check passes)
      const parts = path.split('.'); const id = parts.pop();
      const srcParent = parts.length ? resolvePath(src, parts.join('.')) : src;
      if (!srcParent || !srcParent.children) return json(res, 404, { error: 'path not found: ' + path });
      const idx = srcParent.children.findIndex(c => c.id === id);
      if (idx < 0) return json(res, 404, { error: 'path not found: ' + path });
      const dest = sameBoard ? src : await readBoard(toBoard);   // same object when in-board, so the splice persists
      if (typeof dest.source === 'string' && dest.source.startsWith('jira://'))
        return json(res, 409, { error: 'destination board is a read-only jira source' });
      const [node] = srcParent.children.splice(idx, 1);
      // include-cycle guard (cross-board only — an in-board move can't change the board graph):
      // any board this subtree includes must not equal or reach the destination board.
      if (!sameBoard)
        for (const inc of collectIncludes(node))
          if (inc === toBoard || await includeReaches(inc, toBoard))
            return json(res, 409, { error: 'would create an include cycle' });
      const destParent = toPath ? resolvePath(dest, toPath) : dest;
      if (!destParent) return json(res, 404, { error: 'toPath not found: ' + toPath });
      const dkids = destParent.children || (destParent.children = []);
      node.id = uniq(node.id, new Set(dkids.map(c => c.id)));     // avoid an id clash among new siblings
      dkids.push(node);
      if (sameBoard) await writeBoard(slug, src);
      else { await writeBoard(slug, src); await writeBoard(toBoard, dest); }
      broadcast();
      json(res, 200, { ok: true });
    } catch (e) { json(res, 400, { error: String(e) }); }
    return;
  }

  json(res, 404, { error: 'not found' });
});

await mkdir(BOARDS, { recursive: true }).catch(() => {});
// first run: seed a self-describing home board so a fresh `tilemon ./boards` teaches the model
if ((await listBoards()).length === 0) {
  await writeBoard('tilemon', { name: 'TileMon', visibility: 'private', source: 'native', toolbar: true, children: [
    { id: 'welcome', name: 'Welcome — drag a tile to resize it, double-click to drill in', weight: 4, status: 'todo' },
    { id: 'hover', name: 'Hover a tile for its actions (＋ rename ✕)', weight: 2, status: 'todo' },
    { id: 'blocked', name: 'Blocked items glow — like this one', weight: 2, status: 'blocked' },
    { id: 'agents', name: 'Agents fill boards by POSTing status (see examples/agent.mjs)', weight: 1, status: 'in_progress' },
    { id: 'yours', name: 'Delete these and make it yours', weight: 1, status: 'todo' },
  ] });
}
server.listen(PORT, async () => {
  const boards = await listBoards();
  console.log(`TileMon serving ${BOARDS}  (${boards.length} board${boards.length === 1 ? '' : 's'})`);
  console.log(`  dashboard : http://localhost:${PORT}`);
  console.log(`  boards    : http://localhost:${PORT}/api/boards`);
  console.log(TOKEN ? '  auth      : token required on writes' : '  auth      : OPEN (set TILEMON_TOKEN before exposing the port)');
});
