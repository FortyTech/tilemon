#!/usr/bin/env node
// TileMon — multi-board file-source server. Zero external deps; Node 18+ built-ins only.
//
//   npx tilemon                          # serves ~/.tilemon — one board every local repo shares (default)
//   npx tilemon --daemon                 # the usual setup: one detached, always-on machine-wide board
//   npx tilemon --project                # scope the board to THIS repo instead (serves ./.tilemon)
//   npx tilemon ./boards                 # or point it at any explicit folder
//   npx tilemon flag <board> <path> <status> [note] [--name "..."]   # a VERIFIED status write (exits non-zero if it didn't land)
//   npx tilemon attention [board]        # print what's glowing (waiting/blocked); verified read, board defaults to home
//   npx tilemon --stop                   # stop the backgrounded server
//   (flag/attention auto-start the default local server if it isn't running — set TILEMON_NO_AUTOSTART=1 to disable)
//   PORT=4000 TILEMON_TOKEN=secret node server.mjs
//
// A boards directory holds one <slug>.json per board:
//   { "name": "...", "visibility": "private", "source": "native", "children": [ ... ] }
//   source: "native" (default; agents write it) | "jira://PROJECT" (read-only; stubbed).
//
// Routes:
//   GET    /  ·  /boards/<slug>     -> dashboard (single-page app; reads the slug from the URL)
//   GET    /board.js                -> renderer module
//   GET    /api/boards              -> [{ slug, name, visibility, source, dir? }]
//   GET    /api/resolve?dir=<abs>   -> { board, dir } : the board whose `dir` is the longest prefix of <abs> (folder -> board)
//   GET    /api/attention?board=<slug> -> { board, items:[{board,path,name,note,status,seen}] } : waiting/blocked within a board's TREE (follows includes, blocked first); default slug = tilemon (home)
//   GET    /api/state?board=<slug>  -> resolved tree (includes -> navigable summary tiles, acyclic)
//   GET    /api/events              -> Server-Sent Events; "change" on any write
//   POST   /api/status {board,path,status,note?,name?} -> AGENT: upsert path, set status/note
//   POST   /api/weight {board,path,weight}             -> HUMAN: set weight (node must exist)
//   POST   /api/board  {name,slug?,source?,dir?}        -> HUMAN: create a bare board -> { slug }; `dir` links it to a folder
//   PATCH  /api/board  {slug,dir?,name?}               -> HUMAN: set the folder link (dir) / rename an existing board
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
import net from 'node:net';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rename, watch, readdir, mkdir } from 'node:fs/promises';
import { existsSync, unlinkSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const __dir = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const hasFlag = f => argv.includes(f);

const SUBCMD = ['flag', 'attention', 'resolve', 'reconcile', 'boards', 'state', 'add-board', 'add-item', 'include'].includes(argv[0]) ? argv[0] : null;   // client subcommands (talk to a board), not "serve this dir"
// boards dir: an explicit path wins; else --project => ./.tilemon (board scoped to this one repo);
// else the default ~/.tilemon. In subcommand mode the positionals belong to the command, not the dir.
const BOARDS = (!SUBCMD && argv.find(a => !a.startsWith('-'))) || (hasFlag('--project') ? './.tilemon' : join(homedir(), '.tilemon'));
const PORT   = Number(process.env.PORT) || 4000;
const TOKEN  = process.env.TILEMON_TOKEN || null;
const DASH   = join(__dir, 'dashboard.html');
const PIDFILE = join(BOARDS, '.server.pid');
const CLIENT_BASE = process.env.TILEMON_URL || ('http://localhost:' + PORT);   // where client subcommands send requests

// ---- background mode (zero-dep, cross-platform via Node's own detached spawn) ----
// Is something already listening on PORT? (a quick TCP probe; no HTTP needed)
const portUp = () => new Promise(r => {
  const s = net.connect({ port: PORT, host: '127.0.0.1' });
  s.once('connect', () => { s.destroy(); r(true); });
  s.once('error', () => r(false));
  s.setTimeout(400, () => { s.destroy(); r(false); });
});
// Spawn a DETACHED server that outlives this process; resolve true once it accepts connections.
async function startDaemon() {
  if (await portUp()) return true;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), BOARDS],
    { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  child.unref();
  for (let i = 0; i < 40 && !(await portUp()); i++) await new Promise(r => setTimeout(r, 150));
  return portUp();
}
// Auto-start for client subcommands: only the pure DEFAULT local server (TILEMON_URL unset) and only
// if not opted out — never try to boot a server for a configured/remote TILEMON_URL. Announced, not silent.
async function ensureUpForClient() {
  if (process.env.TILEMON_URL || process.env.TILEMON_NO_AUTOSTART) return;   // configured target / opted out → leave it
  if (await portUp()) return;
  process.stderr.write("TileMon wasn't running — starting it…\n");
  await startDaemon();
}

// ---- client subcommands: talk to a running board over HTTP, VERIFIED (never a silent no-op) ----
if (SUBCMD) {
  const cmdArgs = argv.slice(1);
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = 'Bearer ' + TOKEN;
  await ensureUpForClient();

  // Verified GET/POST helpers for the read + structure subcommands (flag keeps its own inline form).
  // Every subcommand exits non-zero on failure so a script can never mistake a no-op for success.
  const apiGet = async (path) => {
    let res;
    try { res = await fetch(`${CLIENT_BASE}${path}`, { headers }); }
    catch (e) { console.error(`✗ TileMon unreachable at ${CLIENT_BASE} — ${e.message}`); process.exit(1); }
    return { res, out: await res.json().catch(() => ({})) };
  };
  const apiPost = async (path, payload) => {
    let res;
    try { res = await fetch(`${CLIENT_BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(payload) }); }
    catch (e) { console.error(`✗ TileMon unreachable at ${CLIENT_BASE} — ${e.message}`); process.exit(1); }
    return { res, out: await res.json().catch(() => ({})) };
  };
  // pull `--key value` options out; leave the rest as positionals
  const parseOpts = (args) => {
    const opts = {}, pos = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith('--')) opts[args[i].slice(2)] = args[++i];
      else pos.push(args[i]);
    }
    return { opts, pos };
  };

  // ---- routine agent commands: flag (write status), attention + resolve (reads) ----

  if (SUBCMD === 'flag') {
    const [board, path, status = 'blocked', ...rest] = cmdArgs;
    let name; const noteWords = [];
    for (let i = 0; i < rest.length; i++) { if (rest[i] === '--name') name = rest[++i]; else noteWords.push(rest[i]); }
    const note = noteWords.join(' ') || undefined;
    if (!board || !path) { console.error('usage: tilemon flag <board> <path> <status> [note] [--name "Plain name"]'); process.exit(2); }
    let res;
    try { res = await fetch(`${CLIENT_BASE}/api/status`, { method: 'POST', headers, body: JSON.stringify({ board, path, status, note, name }) }); }
    catch (e) { console.error(`✗ TileMon unreachable at ${CLIENT_BASE} — ${e.message}`); process.exit(1); }
    const out = await res.json().catch(() => ({}));
    if (res.ok && out.ok) { console.log(`✓ ${board}/${path} → ${status}${note ? ` ("${note}")` : ''}  @ ${CLIENT_BASE}`); process.exit(0); }
    console.error(`✗ write did NOT land (HTTP ${res.status}) @ ${CLIENT_BASE}: ${out.error || res.statusText}`);
    process.exit(1);
  }

  // `tilemon attention [board]` — verified READ of what's glowing; board defaults to the home board
  if (SUBCMD === 'attention') {
    const board = cmdArgs.find(a => !a.startsWith('-'));
    const q = board ? `?board=${encodeURIComponent(board)}` : '';
    const { res, out } = await apiGet(`/api/attention${q}`);
    if (!res.ok) { console.error(`✗ read failed (HTTP ${res.status}) @ ${CLIENT_BASE}: ${out.error || res.statusText}`); process.exit(1); }
    const items = out.items || [];
    const where = out.board || board || 'tilemon';
    if (!items.length) { console.log(`(nothing glowing on '${where}')`); process.exit(0); }
    console.log(`${items.length} glowing on '${where}':`);
    for (const i of items) console.log(`  [${i.status}] ${i.board} / ${i.name}${i.note ? ' — ' + i.note : ''}  (path: ${i.path})`);
    process.exit(0);
  }

  // `tilemon resolve [dir]` — which board owns this folder? (default: cwd). Prints just the slug, for capture.
  if (SUBCMD === 'resolve') {
    const dir = cmdArgs.find(a => !a.startsWith('-')) || process.cwd();
    const { res, out } = await apiGet(`/api/resolve?dir=${encodeURIComponent(dir)}`);
    if (res.ok && out.board) { console.log(out.board); process.exit(0); }
    if (res.status === 404) { console.error(`✗ no board maps to ${dir} — this folder isn't tracked (leave it; don't invent one)`); process.exit(4); }
    console.error(`✗ resolve failed (HTTP ${res.status}) @ ${CLIENT_BASE}: ${out.error || res.statusText}`);
    process.exit(1);
  }

  // `tilemon reconcile` — run the attention.md executor for this folder's board (Stop-hook or manual).
  // Reads the hook JSON on stdin, delegates to a sealed tool-less `claude -p`, posts the result. All
  // the logic lives in reconcile.mjs so the core server stays dumb; imported lazily so it costs nothing
  // for every other command. Prints one line only when a tile actually changed.
  if (SUBCMD === 'reconcile') {
    const { reconcile } = await import('./reconcile.mjs');
    process.exit(await reconcile({ BOARDS, CLIENT_BASE, TOKEN, argv: cmdArgs }));
  }

  // ---- setup-only commands (bootstrapping / reconciling a board; routine reporting never needs these) ----

  // `tilemon boards` — list every board (slug, name, dir).
  if (SUBCMD === 'boards') {
    const { res, out } = await apiGet('/api/boards');
    if (!res.ok) { console.error(`✗ read failed (HTTP ${res.status}) @ ${CLIENT_BASE}: ${out.error || res.statusText}`); process.exit(1); }
    const boards = Array.isArray(out) ? out : [];
    if (!boards.length) { console.log('(no boards yet)'); process.exit(0); }
    for (const b of boards) console.log(`  ${b.slug}\t${b.name || ''}${b.dir ? '\t(' + b.dir + ')' : ''}`);
    process.exit(0);
  }

  // `tilemon state <board>` — dump a board's resolved tree as JSON (reconcile before adding structure).
  if (SUBCMD === 'state') {
    const slug = cmdArgs.find(a => !a.startsWith('-'));
    if (!slug) { console.error('usage: tilemon state <board>'); process.exit(2); }
    const { res, out } = await apiGet(`/api/state?board=${encodeURIComponent(slug)}`);
    if (res.ok) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
    console.error(`✗ read failed (HTTP ${res.status}) @ ${CLIENT_BASE}: ${out.error || res.statusText}`);
    process.exit(res.status === 404 ? 4 : 1);
  }

  // `tilemon add-board <name> [--slug s] [--dir /abs/path]` — create a bare board; prints its slug.
  if (SUBCMD === 'add-board') {
    const { opts, pos } = parseOpts(cmdArgs);
    const name = pos.join(' ').trim();
    if (!name) { console.error('usage: tilemon add-board <name> [--slug <slug>] [--dir <abs path>]'); process.exit(2); }
    const payload = { name };
    if (opts.slug) payload.slug = opts.slug;
    if (opts.dir) payload.dir = opts.dir;
    const { res, out } = await apiPost('/api/board', payload);
    if (res.ok && out.ok) { console.log(`✓ created board '${out.slug}'${opts.dir ? ` → ${opts.dir}` : ''}  @ ${CLIENT_BASE}`); process.exit(0); }
    console.error(`✗ add-board did NOT land (HTTP ${res.status}) @ ${CLIENT_BASE}: ${out.error || res.statusText}`);
    process.exit(1);
  }

  // `tilemon add-item <board> <name> [--path <parent>]` — add a plain item/bucket (root, or under --path).
  if (SUBCMD === 'add-item') {
    const { opts, pos } = parseOpts(cmdArgs);
    const [slug, ...nameParts] = pos;
    const name = nameParts.join(' ').trim();
    if (!slug || !name) { console.error('usage: tilemon add-item <board> <name> [--path <parent>]'); process.exit(2); }
    const { res, out } = await apiPost('/api/node', { board: slug, path: opts.path || '', kind: 'item', name });
    if (res.ok && out.ok) { console.log(`✓ added item "${name}" to '${slug}'${opts.path ? '.' + opts.path : ''}  @ ${CLIENT_BASE}`); process.exit(0); }
    console.error(`✗ add-item did NOT land (HTTP ${res.status}) @ ${CLIENT_BASE}: ${out.error || res.statusText}`);
    process.exit(1);
  }

  // `tilemon include <board> <targetBoard> [--path <parent>]` — include an EXISTING board as a summary tile.
  if (SUBCMD === 'include') {
    const { opts, pos } = parseOpts(cmdArgs);
    const [slug, target] = pos;
    if (!slug || !target) { console.error('usage: tilemon include <board> <targetBoard> [--path <parent>]'); process.exit(2); }
    const { res, out } = await apiPost('/api/node', { board: slug, path: opts.path || '', kind: 'include', target });
    if (res.ok && out.ok) { console.log(`✓ included '${target}' under '${slug}'${opts.path ? '.' + opts.path : ''}  @ ${CLIENT_BASE}`); process.exit(0); }
    console.error(`✗ include did NOT land (HTTP ${res.status}) @ ${CLIENT_BASE}: ${out.error || res.statusText}`);
    process.exit(1);
  }
}

// `--stop`: terminate the backgrounded server recorded in the pidfile
if (hasFlag('--stop')) {
  try { const pid = Number(await readFile(PIDFILE, 'utf8')); process.kill(pid); console.log(`TileMon stopped (pid ${pid})`); }
  catch { console.log('no running TileMon found for ' + BOARDS); }
  process.exit(0);
}
// `--daemon`/`-d`: spawn a DETACHED server that outlives this process — and any agent that launched it
if (hasFlag('--daemon') || hasFlag('-d')) {
  if (await portUp()) { console.log(`TileMon already running at http://localhost:${PORT}`); process.exit(0); }
  if (await startDaemon()) { console.log(`TileMon started in the background at http://localhost:${PORT}`); console.log('  stop it with:  npx tilemon --stop'); process.exit(0); }
  console.log('TileMon did not come up — run `npx tilemon` in the foreground to see the error.'); process.exit(1);
}

const VALID_STATUS = new Set(['todo', 'in_progress', 'waiting', 'blocked', 'done']);
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
// Canonicalise a folder path for the folder<->board link: strip trailing slashes, then resolve
// symlinks via realpath so a hook's cwd matches the stored `dir` even across symlinked/aliased
// paths. Falls back to the string form when the path isn't on disk (e.g. a moved/deleted repo).
function canonDir(s) {
  if (!s) return s;
  let t = String(s).replace(/\/+$/, '');
  try { t = realpathSync(t); } catch { /* not on disk — use the plain string form */ }
  return t.replace(/\/+$/, '');
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
    try { const b = await readBoard(slug); out.push({ slug, name: b.name || slug, visibility: b.visibility || 'private', source: b.source || 'native', toolbar: !!b.toolbar, items: (b.children || []).length, dir: b.dir || undefined }); }
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
    const out = { id: node.id, name: node.name, weight: node.weight, status: node.status, note: node.note, seen: node.seen, _board: slug, _path: path };
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
  node.seen = Date.now();   // liveness heartbeat: stamped on every status write; client shows "live" dot while fresh
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
  if (req.method === 'GET' && p === '/api/resolve') {   // folder -> board: the board whose `dir` is the longest prefix of the query
    const q = url.searchParams.get('dir');
    if (!q) return json(res, 400, { error: 'missing dir' });
    try {
      const target = canonDir(q);
      let best = null, bestLen = -1;
      for (const b of await listBoards()) {
        if (!b.dir) continue;
        const d = canonDir(b.dir);
        if (target === d || target.startsWith(d + '/')) { if (d.length > bestLen) { best = b; bestLen = d.length; } }
      }
      if (!best) return json(res, 404, { error: 'no board maps to ' + q });
      json(res, 200, { board: best.slug, dir: best.dir });
    } catch (e) { json(res, 500, { error: String(e) }); }
    return;
  }

  if (req.method === 'GET' && p === '/api/attention') {   // what needs the human within a board's TREE (follows includes); default = home board
    const slug = url.searchParams.get('board') || 'tilemon';
    try {
      const tree = await resolveBoard(slug);   // resolved => includes inlined; every node stamped with owning _board/_path
      if (!tree) return json(res, 404, { error: 'board not found: ' + slug });
      const keys = new Set(), out = [];
      // `area` = the tile's share of the whole board = path-product of normalized sibling weights
      // (importance IS on-screen area, so this is the human's revealed attention allocation, exact
      // and resolution-independent — no need to measure rendered pixels). Carried down the walk.
      (function walk(node, acc) {
        const kids = node.children || [];
        const tot = kids.reduce((s, c) => s + (c.weight ?? 1), 0) || 1;
        for (const c of kids) {
          const area = acc * ((c.weight ?? 1) / tot);
          if (c.status === 'waiting' || c.status === 'blocked') {
            const key = c._board + '::' + c._path;   // address on the OWNING board; dedupe a board included more than once
            if (!keys.has(key)) { keys.add(key);
              out.push({ board: c._board, path: c._path, name: c.name || c.id, status: c.status, note: c.note || '', seen: c.seen, area }); }
          }
          walk(c, area);
        }
      })(tree, 1);
      // blocked before waiting; within a level, biggest area (most of your attention) first
      out.sort((a, z) => ((a.status === 'blocked' ? 0 : 1) - (z.status === 'blocked' ? 0 : 1)) || (z.area - a.area));
      json(res, 200, { board: slug, items: out });
    } catch (e) { json(res, 500, { error: String(e) }); }
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
      const { name, slug: wantSlug, source, dir } = await body(req);
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
      const board = { name: nm, visibility: 'private', source: src, children: [] };
      if (typeof dir === 'string' && dir.trim()) board.dir = canonDir(dir.trim());   // the folder this board maps to (the link), canonicalised
      await writeBoard(slug, board);
      broadcast();
      json(res, 200, { ok: true, slug });
    } catch (e) { json(res, 400, { error: String(e) }); }
    return;
  }
  if (req.method === 'PATCH' && p === '/api/board') {   // HUMAN: set board-level metadata — the `dir` link (and/or name)
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
    try {
      const { slug, dir, name } = await body(req);
      if (!slugOk(slug)) return json(res, 400, { error: 'bad or missing slug' });
      if (!existsSync(boardFile(slug))) return json(res, 404, { error: 'board not found: ' + slug });
      const board = await readBoard(slug);
      if (typeof dir === 'string') { const d = dir.trim(); if (d) board.dir = canonDir(d); else delete board.dir; }   // '' clears the link
      if (name != null && String(name).trim()) board.name = String(name).trim();
      await writeBoard(slug, board); broadcast();
      json(res, 200, { ok: true });
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

// operator-side attention rules — a starter template dropped next to the boards on first run.
const ATTENTION_TEMPLATE = `# attention.md — your TileMon board, organised BY STATUS
#
# Free text, entirely yours. The reconciler (\`tilemon reconcile\`) reads this whole file and sets each
# tile's status so the things that need YOU glow. One heading per status; the bullets under it are what
# belongs in that status, and the heading DEFINES what the status means — the bar the reconciler must
# meet before using it. Global by default; add "# board: <slug>" or "# node: <board>.<path>" sections
# to override for a specific board or tile.
#
# Severity, loudest first: blocked > waiting > in_progress > todo > done.

## blocked — something is WRONG: an obstacle the agent cannot pass on its own. (red, loudest)
# - Failing tests or a red CI run.
# - A vulnerable dependency or other obvious security problem.

## waiting — needs MY input, decision, review, or confirmation; nothing is broken. (amber)
# - Committed-but-unpushed work parked a while, or a dirty tree left sitting (not every WIP edit).
# - An open PR awaiting my review, or one of mine with requested changes.
# - Anything where an agent has asked me to decide/confirm and can't proceed without me.

## in_progress — an agent is actively working this right now; no attention needed. (a mute)

## todo — identified but not started.

## done — finished AND confirmed by me, OR independently verifiable as complete (merged + deployed,
#         CI green). Do NOT mark done just because something was built, is live, or "should work":
#         if it is awaiting my check, it stays \`waiting\`. A false 'done' makes a pending item vanish.

# --- board: example-project ---   (scope extra rules to one board)
# ## waiting
# - A client message unanswered for more than a day or two.
`;

await mkdir(BOARDS, { recursive: true }).catch(() => {});
// first run: seed an EMPTY home board (yours) + a SEPARATE, self-describing `tutorial` board.
// They never mix — the dashboard lands on your board once it has content, else on the tutorial,
// which stays revisitable in the board switcher forever.
if ((await listBoards()).length === 0) {
  await writeBoard('tilemon', { name: 'TileMon', visibility: 'private', source: 'native', toolbar: true, children: [] });
  await writeBoard('tutorial', { name: 'Tutorial', visibility: 'private', source: 'native', toolbar: true, children: [
    { id: 'welcome', name: 'This is the Tutorial board — your own board is the default. Come back any time from the board switcher.', weight: 4, status: 'todo' },
    { id: 'blocked', name: 'blocked = something is wrong and needs you: glows red and pulses (loudest).', weight: 3, status: 'blocked' },
    { id: 'waiting', name: 'waiting = an agent needs your input or a decision: glows amber (present, not urgent).', weight: 2, status: 'waiting' },
    { id: 'working', name: 'in progress = an agent is working here: a calm dot, no glow — it does not need you.', weight: 2, status: 'in_progress' },
    { id: 'area', name: 'Importance is area — drag a tile to resize it; double-click to drill in.', weight: 1, status: 'todo' },
    { id: 'agents', name: 'Agents fill boards by POSTing status (see examples/agent.mjs).', weight: 1, status: 'todo' },
  ] });
  await writeFile(join(BOARDS, 'attention.md'), ATTENTION_TEMPLATE).catch(() => {});
}
await writeFile(PIDFILE, String(process.pid)).catch(() => {});   // so `--stop` can find us (foreground or backgrounded)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { unlinkSync(PIDFILE); } catch {} process.exit(0); });
server.listen(PORT, async () => {
  const boards = await listBoards();
  console.log(`TileMon serving ${BOARDS}  (${boards.length} board${boards.length === 1 ? '' : 's'})`);
  console.log(`  dashboard : http://localhost:${PORT}`);
  console.log(`  boards    : http://localhost:${PORT}/api/boards`);
  console.log(TOKEN ? '  auth      : token required on writes' : '  auth      : OPEN (set TILEMON_TOKEN before exposing the port)');
});
