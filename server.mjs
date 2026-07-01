#!/usr/bin/env node
// Tilemon — multi-board file-source server. Zero external deps; Node 18+ built-ins only.
//
//   node server.mjs ./boards            # or: npx tilemon ./boards
//   PORT=4000 TILEMON_TOKEN=secret node server.mjs ./boards
//
// A boards directory holds one <slug>.json per board:
//   { "name": "...", "visibility": "private", "source": "native", "children": [ ... ] }
//   source: "native" (default; agents write it) | "jira://PROJECT" (read-only; stubbed).
//
// Routes:
//   GET  /  ·  /boards/<slug>       -> dashboard (single-page app; reads the slug from the URL)
//   GET  /board.js                  -> renderer module
//   GET  /api/boards                -> [{ slug, name, visibility, source }]
//   GET  /api/state?board=<slug>    -> resolved tree (includes -> navigable summary tiles, acyclic)
//   GET  /api/events                -> Server-Sent Events; "change" on any write
//   POST /api/status {board,path,status,note?,name?}  -> AGENT: upsert path, set status/note
//   POST /api/weight {board,path,weight}              -> HUMAN: set weight (node must exist)
//
// Auth (capability-scoped): /api/status can only set a node's status/note; /api/weight only
// weight. If TILEMON_TOKEN is set, both write routes require `Authorization: Bearer <token>`.

import http from 'node:http';
import { readFile, writeFile, rename, watch, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const BOARDS = process.argv[2] || './boards';
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
    try { const b = await readBoard(slug); out.push({ slug, name: b.name || slug, visibility: b.visibility || 'private', source: b.source || 'native' }); }
    catch { /* skip unreadable */ }
  }
  return out;
}

// ---- heat rollup for an included board's summary tile (weight-proxied; the client uses rendered area) ----
function computeHeat(node) {
  if (node._include !== undefined) return node._summaryHeat || 0;
  const own = STATUS_HEAT[node.status] ?? 0;
  const ch = node.children;
  if (!ch || !ch.length) return own;
  let tw = 0, s = 0;
  for (const c of ch) {
    if (c.status === 'done' && !(c.children && c.children.length)) continue; // done leaves drop off
    const w = Math.max(Number(c.weight) || 1, 1e-6);
    tw += w; s += computeHeat(c) * w;
  }
  const rollup = tw ? s / tw : 0;
  return Math.max(own, rollup);
}

// ---- resolve a board for rendering: includes become navigable summary tiles, never inlined ----
async function resolveBoard(slug, chain = []) {
  if (chain.includes(slug)) return { __cycle: true };
  let board;
  try { board = await readBoard(slug); }
  catch { return null; }
  if (typeof board.source === 'string' && board.source.startsWith('jira://')) {
    // v2 source; not implemented yet — surface it honestly rather than pretending.
    return { name: board.name || slug, visibility: board.visibility || 'private', source: board.source,
             _sourceStub: 'jira', children: [] };
  }
  const process = async node => {
    if (node.include !== undefined) {
      const inc = await resolveBoard(node.include, [...chain, slug]);
      const cyc = !inc || inc.__cycle;
      const summary = cyc ? 0 : computeHeat({ children: inc.children || [] });
      return { id: node.id, name: node.name || humanize(node.include), weight: node.weight,
               _include: node.include, _summaryHeat: summary, _missing: !inc || undefined, _cycle: inc && inc.__cycle || undefined };
    }
    if (node.children && node.children.length) {
      const kids = [];
      for (const c of node.children) kids.push(await process(c));
      return { id: node.id, name: node.name, weight: node.weight, status: node.status, note: node.note, children: kids };
    }
    return { id: node.id, name: node.name, weight: node.weight, status: node.status, note: node.note };
  };
  const children = [];
  for (const c of (board.children || [])) children.push(await process(c));
  return { name: board.name || slug, visibility: board.visibility || 'private', source: board.source || 'native', children };
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

  json(res, 404, { error: 'not found' });
});

await mkdir(BOARDS, { recursive: true }).catch(() => {});
server.listen(PORT, async () => {
  const boards = await listBoards();
  console.log(`Tilemon serving ${BOARDS}  (${boards.length} board${boards.length === 1 ? '' : 's'})`);
  console.log(`  dashboard : http://localhost:${PORT}`);
  console.log(`  boards    : http://localhost:${PORT}/api/boards`);
  console.log(TOKEN ? '  auth      : token required on writes' : '  auth      : OPEN (set TILEMON_TOKEN before exposing the port)');
});
