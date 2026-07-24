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
//   GET    /api/state                  -> { boards:[{slug,name,dir?,tree}] } : AGGREGATE — every board + resolved tree, one call
//   GET    /api/state?board=<slug>     -> resolved tree (includes -> navigable summary tiles, acyclic)
//   GET    /api/state?glowing[&board=] -> { items:[{board,path,name,note,status,seen,area}] } : waiting/blocked (one board or ALL), blocked-first
//   GET    /api/attention?board=<slug> -> DEPRECATED alias of ?glowing (kept for old installs)
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
import { createEngine, slugOk } from './engine.js';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rename, watch, readdir, mkdir } from 'node:fs/promises';
import { unlinkSync, realpathSync } from 'node:fs';
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
    const q = board ? `?glowing=1&board=${encodeURIComponent(board)}` : '?glowing=1';
    const { res, out } = await apiGet(`/api/state${q}`);
    if (!res.ok) { console.error(`✗ read failed (HTTP ${res.status}) @ ${CLIENT_BASE}: ${out.error || res.statusText}`); process.exit(1); }
    const items = out.items || [];
    const where = board || 'all boards';
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

const clients = new Set();

// ---- slugs: a board is addressed by a filesystem-safe slug, never a path ----
// (slug/id semantics — slugOk/humanize/slugify/uniq — live in engine.js, shared with hosted)
const boardFile = slug => join(BOARDS, slug + '.json');

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

// ---- the shared semantics engine over this file store ----
// engine.js owns what every op MEANS (upsert, add/move/rename/delete, cycle guards, resolve
// stamping) — shared verbatim with the hosted app, which plugs in Postgres instead of files.
// This side owns only WHERE boards live: read/write JSON files (slug-guarded against path
// escape), list what exists. Store-specific metadata (the `dir` folder link) stays here too.
const engine = createEngine({
  readBoard: async slug => {
    if (!slugOk(slug)) return null;   // a hand-edited include could hold a path-escaping "slug"
    // null means ABSENT only. A file that exists but can't be read (truncated mid-edit, fs
    // error) must THROW — engine.status treats null as "create fresh", so mapping read
    // failures to null would silently overwrite a real board.
    try { return await readBoard(slug); }
    catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
  },
  writeBoard,
  listSlugs: async () => {
    try { return (await readdir(BOARDS)).filter(f => f.endsWith('.json') && !f.endsWith('.tmp.json')).map(f => f.slice(0, -5)); }
    catch { return []; }
  },
});
const resolveBoard = slug => engine.resolveBoard(slug);   // the routes' read-side entry point

// Walk a resolved tree collecting the glowing (waiting/blocked) tiles, each stamped with `area` (its
// share of the board = product of normalised sibling weights). Dedupes by owning board+path. Shared by
// GET /api/state?glowing and the deprecated GET /api/attention.
function collectGlowing(tree, keys = new Set(), out = []) {
  (function walk(node, acc) {
    const kids = node.children || [];
    const tot = kids.reduce((s, c) => s + (c.weight ?? 1), 0) || 1;
    for (const c of kids) {
      const area = acc * ((c.weight ?? 1) / tot);
      if (c.status === 'waiting' || c.status === 'blocked') {
        const key = c._board + '::' + c._path;
        if (!keys.has(key)) { keys.add(key); out.push({ board: c._board, path: c._path, name: c.name || c.id, status: c.status, note: c.note || '', seen: c.seen, area }); }
      }
      walk(c, area);
    }
  })(tree, 1);
  return out;
}
// blocked before waiting; within a level, biggest area (most of your attention) first
const glowingSort = (a, z) => ((a.status === 'blocked' ? 0 : 1) - (z.status === 'blocked' ? 0 : 1)) || (z.area - a.area);


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

  if (req.method === 'GET' && p === '/api/attention') {   // DEPRECATED alias — use GET /api/state?glowing. Kept for old installs.
    const slug = url.searchParams.get('board') || 'home';
    try {
      const tree = await resolveBoard(slug);
      if (!tree) return json(res, 404, { error: 'board not found: ' + slug });
      json(res, 200, { board: slug, items: collectGlowing(tree).sort(glowingSort) });
    } catch (e) { json(res, 500, { error: String(e) }); }
    return;
  }
  if (req.method === 'GET' && p === '/api/state') {   // one board's tree, OR ?glowing (waiting/blocked), OR no-param AGGREGATE (all boards)
    const slug = url.searchParams.get('board');
    const glowing = url.searchParams.get('glowing');
    try {
      // ?glowing[&board=] → just the waiting/blocked tiles (one board, or ALL). Subsumes /api/attention.
      if (glowing != null) {
        const slugs = slug ? [slug] : (await listBoards()).map(b => b.slug);
        const keys = new Set(), items = [];
        for (const s of slugs) { const t = await resolveBoard(s); if (t) collectGlowing(t, keys, items); }
        return json(res, 200, { items: items.sort(glowingSort) });
      }
      // ?board=X → that one board's resolved tree (bare — the dashboard's shape, unchanged).
      if (slug) {
        if (!slugOk(slug)) return json(res, 400, { error: 'bad or missing board slug' });
        const tree = await resolveBoard(slug);
        if (!tree) return json(res, 404, { error: 'board not found: ' + slug });
        return json(res, 200, tree);
      }
      // no params → AGGREGATE: every board + its resolved tree, in ONE call (the reconciler's inventory).
      const boards = [];
      for (const b of await listBoards()) { const tree = await resolveBoard(b.slug); if (tree) boards.push({ slug: b.slug, name: b.name, dir: b.dir, tree }); }
      json(res, 200, { boards });
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
      const r = await engine.status(slug, path, { status, note, name });
      if (r.error) return json(res, r.status, { error: r.error });
      broadcast(); json(res, 200, { ok: true });
    } catch (e) { json(res, 400, { error: String(e) }); }
    return;
  }
  if (req.method === 'POST' && p === '/api/weight') {   // HUMAN write: weight only, node must exist
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
    try {
      const { board: slug, path, weight } = await body(req);
      const r = await engine.weight(slug, path, weight);
      if (r.error) return json(res, r.status, { error: r.error });
      broadcast(); json(res, 200, { ok: true });
    } catch (e) { json(res, 400, { error: String(e) }); }
    return;
  }

  if (req.method === 'POST' && p === '/api/node') {   // HUMAN: add a plain item OR an include of an existing board
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
    try {
      const { board: slug, path = '', kind = 'item', name, target } = await body(req);
      const r = await engine.addNode(slug, { path, kind, name, target });
      if (r.error) return json(res, r.status, { error: r.error });
      broadcast(); json(res, 200, { ok: true });
    } catch (e) { json(res, 400, { error: String(e) }); }
    return;
  }
  if (req.method === 'PATCH' && p === '/api/node') {   // HUMAN: rename and/or set toolbar. Empty path => the board itself.
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
    try {
      const { board: slug, path, name, toolbar } = await body(req);
      const r = await engine.patchNode(slug, path || '', { name, toolbar });
      if (r.error) return json(res, r.status, { error: r.error });
      broadcast(); json(res, 200, { ok: true });
    } catch (e) { json(res, 400, { error: String(e) }); }
    return;
  }
  if (req.method === 'DELETE' && p === '/api/node') {   // HUMAN: remove a node (leaves any referenced board file intact)
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
    try {
      const { board: slug, path } = await body(req);
      const r = await engine.removeNode(slug, path);
      if (r.error) return json(res, r.status, { error: r.error });
      broadcast(); json(res, 200, { ok: true });
    } catch (e) { json(res, 400, { error: String(e) }); }
    return;
  }

  if (req.method === 'POST' && p === '/api/board') {   // HUMAN: create a bare board (placed nowhere); returns its slug
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
    try {
      const { name, slug: wantSlug, source, dir } = await body(req);
      const extra = {};   // store-specific board fields the engine passes through untouched
      if (typeof source === 'string' && source.trim()) extra.source = source.trim();
      if (typeof dir === 'string' && dir.trim()) extra.dir = canonDir(dir.trim());   // the folder this board maps to (the link), canonicalised
      const r = await engine.createBoard(name, wantSlug, extra);
      if (r.error) return json(res, r.status, { error: r.error });
      broadcast(); json(res, 200, { ok: true, slug: r.slug });
    } catch (e) { json(res, 400, { error: String(e) }); }
    return;
  }
  if (req.method === 'PATCH' && p === '/api/board') {   // HUMAN: set board-level metadata — the `dir` link (and/or name)
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
    try {
      const { slug, dir, name } = await body(req);
      const r = await engine.updateBoard(slug, board => {
        if (typeof dir === 'string') { const d = dir.trim(); if (d) board.dir = canonDir(d); else delete board.dir; }   // '' clears the link
        if (name != null && String(name).trim()) board.name = String(name).trim();
      });
      if (r.error) return json(res, r.status, { error: r.error });
      broadcast(); json(res, 200, { ok: true });
    } catch (e) { json(res, 400, { error: String(e) }); }
    return;
  }
  if (req.method === 'POST' && p === '/api/move') {   // HUMAN: re-parent a node within or across boards
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
    try {
      const { board: slug, path, toBoard, toPath = '' } = await body(req);
      const r = await engine.moveNode(slug, path, toBoard, toPath);
      if (r.error) return json(res, r.status, { error: r.error });
      broadcast(); json(res, 200, { ok: true });
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
  await writeBoard('home', { name: 'Home', visibility: 'private', source: 'native', toolbar: true, children: [] });
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
