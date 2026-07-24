// Wire-level tests for the structure API: create board, include-existing, move, cycle guards.
// Boots the real server against a temp boards dir and drives it over HTTP — no browser.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink, realpath, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, '..', 'server.mjs');
const PORT = 47823;
const BASE = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } };

const api = async (method, path, bodyObj) => {
  const res = await fetch(BASE + path, {
    method,
    headers: bodyObj ? { 'content-type': 'application/json' } : undefined,
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
};
// walk a resolved tree to the node at a dotted local path (by id)
const at = (tree, path) => path.split('.').reduce((n, part) => (n?.children || []).find(c => c.id === part), tree);

const dir = await mkdtemp(join(tmpdir(), 'tilemon-test-'));
const child = spawn('node', [SERVER, dir], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });

try {
  // wait for the server to accept connections
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/boards'); break; } catch { await new Promise(r => setTimeout(r, 100)); }
  }

  // fresh dir auto-seeds an EMPTY home board + a SEPARATE, populated tutorial board (never mixed)
  {
    const bl = (await api('GET', '/api/boards')).json;
    ok(bl.some(b => b.slug === 'home' && b.items === 0), 'home board seeded empty');
    ok(bl.some(b => b.slug === 'tutorial' && b.items > 0), 'tutorial board seeded separately with content');
  }

  // status vocabulary includes the new `waiting` level; garbage is rejected
  ok((await api('POST', '/api/status', { board: 'home', path: 'demo', status: 'waiting', note: 'need a decision' })).status === 200, 'waiting is a valid status');
  ok((await api('POST', '/api/status', { board: 'home', path: 'demo', status: 'nonsense' })).status === 400, 'invalid status rejected');
  await api('DELETE', '/api/node', { board: 'home', path: 'demo' });   // tidy up so it doesn't affect later checks

  // --- POST /api/board: create bare boards, placed nowhere ---
  const mk = await api('POST', '/api/board', { name: 'Word Duel' });
  ok(mk.status === 200 && mk.json.slug === 'word-duel', 'create board derives slug from name');
  ok((await api('POST', '/api/board', { slug: 'tools', name: 'Tools' })).json.slug === 'tools', 'create board honours explicit slug');
  ok((await api('POST', '/api/board', { slug: 'tools', name: 'Tools again' })).status === 409, 'duplicate slug rejected');
  ok((await api('POST', '/api/board', {})).status === 400, 'create board needs a name');
  await api('POST', '/api/board', { name: 'Hex Drop' }); // -> hex-drop

  // --- folder↔board link: dir on boards + /api/resolve (longest-prefix, boundary-aware) ---
  await api('POST', '/api/board', { name: 'Alpha', slug: 'alpha', dir: '/tmp/work/alpha' });
  await api('POST', '/api/board', { name: 'Alpha Sub', slug: 'alpha-sub', dir: '/tmp/work/alpha/sub' });
  ok((await api('GET', '/api/boards')).json.find(b => b.slug === 'alpha').dir === '/tmp/work/alpha', 'board carries its dir');
  ok((await api('GET', '/api/resolve?dir=/tmp/work/alpha')).json.board === 'alpha', 'resolve: exact dir match');
  ok((await api('GET', '/api/resolve?dir=/tmp/work/alpha/sub/deep')).json.board === 'alpha-sub', 'resolve: longest-prefix (nested wins over parent)');
  ok((await api('GET', '/api/resolve?dir=/tmp/work/alpha/other')).json.board === 'alpha', 'resolve: prefix -> parent board');
  ok((await api('GET', '/api/resolve?dir=/tmp/work/alphabet')).status === 404, 'resolve: no false match across a path boundary');
  ok((await api('GET', '/api/resolve?dir=/tmp/elsewhere')).status === 404, 'resolve: untracked folder -> 404');
  await api('PATCH', '/api/board', { slug: 'word-duel', dir: '/tmp/work/wd' });   // backfill an existing board
  ok((await api('GET', '/api/resolve?dir=/tmp/work/wd')).json.board === 'word-duel', 'PATCH sets dir on an existing board; resolve finds it');

  // --- realpath normalisation: symlinked/aliased paths resolve to the same board (the start hook needs this) ---
  {
    const realDir = await mkdtemp(join(tmpdir(), 'tilemon-real-'));
    const linkDir = realDir + '-link';
    await symlink(realDir, linkDir);
    const realSub = join(realDir, 'sub'); await mkdir(realSub);
    await api('POST', '/api/board', { name: 'Linked', slug: 'linked', dir: linkDir });   // register via the SYMLINK
    const canon = await realpath(realDir);
    ok((await api('GET', '/api/boards')).json.find(b => b.slug === 'linked').dir === canon, 'store canonicalises a symlinked dir to its real path');
    ok((await api('GET', `/api/resolve?dir=${encodeURIComponent(linkDir)}`)).json.board === 'linked', 'resolve: symlinked query path matches the canonical board');
    ok((await api('GET', `/api/resolve?dir=${encodeURIComponent(realSub)}`)).json.board === 'linked', 'resolve: subdir under a symlinked board still matches');
    await rm(linkDir); await rm(realDir, { recursive: true, force: true });
  }

  // --- /api/attention: the "what needs me" query — board-scoped, follows includes, blocked first ---
  {
    await api('POST', '/api/status', { board: 'attn', path: 'calm', status: 'in_progress', name: 'Calm' });
    await api('POST', '/api/status', { board: 'attn', path: 'ask', status: 'waiting', name: 'Ask', note: 'which one?' });
    await api('POST', '/api/status', { board: 'attn', path: 'oops', status: 'blocked', name: 'Oops' });
    const scoped = (await api('GET', '/api/attention?board=attn')).json.items;
    ok(scoped.length === 2, '/api/attention?board= returns only that board\'s waiting+blocked (in_progress excluded)');
    ok(scoped[0].status === 'blocked', '/api/attention sorts blocked before waiting');
    ok(scoped.some(i => i.path === 'ask' && i.status === 'waiting' && i.note === 'which one?'), '/api/attention carries board+path+note');
    ok(scoped.every(i => typeof i.area === 'number' && i.area > 0 && i.area <= 1), '/api/attention stamps each item with its area fraction (0,1]');
    // area ranking: within the same status, a heavier-weighted sibling ranks first
    await api('POST', '/api/status', { board: 'rank', path: 'small', status: 'waiting', name: 'Small' });
    await api('POST', '/api/status', { board: 'rank', path: 'big', status: 'waiting', name: 'Big' });
    await api('POST', '/api/weight', { board: 'rank', path: 'big', weight: 9 });   // big now owns 9/10 of the board
    const ranked = (await api('GET', '/api/attention?board=rank')).json.items;
    ok(ranked[0].path === 'big' && ranked[0].area > ranked[1].area, '/api/attention ranks larger-area (more attention) first within a status');
    // include-following: a parent board surfaces an included board's glowing nodes, addressed by the OWNING board
    await api('POST', '/api/board', { name: 'Hub', slug: 'hub' });
    await api('POST', '/api/node', { board: 'hub', kind: 'include', target: 'attn' });
    const viaHub = (await api('GET', '/api/attention?board=hub')).json.items;
    ok(viaHub.some(i => i.board === 'attn' && i.path === 'oops'), '/api/attention follows includes, reports owning board+path');
    ok((await api('GET', '/api/attention?board=nope')).status === 404, '/api/attention 404s an unknown board');
    // default scope = home board, which does NOT include attn → unrelated boards don't leak in
    ok(!(await api('GET', '/api/attention')).json.items.some(i => i.board === 'attn'), '/api/attention default is home-scoped (unrelated boards excluded)');
  }

  // --- client subcommands (flag/attention): VERIFIED — land/read on success, exit non-zero on failure ---
  {
    // TILEMON_NO_AUTOSTART + explicit TILEMON_URL keep these from spawning a stray daemon during tests
    const runCmd = (args, env) => new Promise(resolve => {
      const c = spawn('node', [SERVER, ...args], { env: { ...process.env, TILEMON_NO_AUTOSTART: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; c.stdout.on('data', d => out += d);
      c.on('close', code => resolve({ code, out }));
    });
    // flag — verified write
    const w = await runCmd(['flag', 'flagboard', 'task', 'blocked', 'need input', '--name', 'Flag Task'], { TILEMON_URL: BASE });
    ok(w.code === 0, 'tilemon flag exits 0 on a successful write');
    const landed = (await api('GET', '/api/attention?board=flagboard')).json.items;
    ok(landed.some(i => i.path === 'task' && i.status === 'blocked' && i.name === 'Flag Task'), 'tilemon flag actually landed the status (board+path+name)');
    ok((await runCmd(['flag', 'flagboard', 'task', 'blocked'], { TILEMON_URL: 'http://localhost:1' })).code !== 0, 'tilemon flag exits NON-ZERO when unreachable — no silent no-op');
    // attention — verified read
    const r = await runCmd(['attention', 'flagboard'], { TILEMON_URL: BASE });
    ok(r.code === 0 && /Flag Task/.test(r.out), 'tilemon attention reads back the glowing box');
    ok((await runCmd(['attention', 'flagboard'], { TILEMON_URL: 'http://localhost:1' })).code !== 0, 'tilemon attention exits NON-ZERO when unreachable');
  }

  // --- buckets: a group is just an item you add children into ---
  ok((await api('POST', '/api/node', { board: 'home', kind: 'item', name: 'Games' })).status === 200, 'add group item');

  // --- include an EXISTING board (references, does not duplicate) ---
  ok((await api('POST', '/api/node', { board: 'home', path: 'games', kind: 'include', target: 'word-duel' })).status === 200, 'include existing board');
  await api('POST', '/api/node', { board: 'home', path: 'games', kind: 'include', target: 'hex-drop' });
  {
    const tree = (await api('GET', '/api/state?board=home')).json;
    const wd = at(tree, 'games.word-duel');
    ok(wd && wd._boardLink === 'word-duel', 'include renders as a board-link tile under the bucket');
    ok((await api('GET', '/api/boards')).json.filter(b => b.slug === 'word-duel').length === 1, 'include did not create a duplicate board');
  }

  // include validation + cycle guards
  ok((await api('POST', '/api/node', { board: 'home', kind: 'include', target: 'nope' })).status === 404, 'include of missing board rejected');
  ok((await api('POST', '/api/node', { board: 'home', kind: 'include', target: 'home' })).status === 409, 'self-include rejected');
  // clean chain c1 -> c2 -> c3; closing it (c3 -> c1) is a transitive cycle
  await api('POST', '/api/board', { slug: 'c1', name: 'C1' });
  await api('POST', '/api/board', { slug: 'c2', name: 'C2' });
  await api('POST', '/api/board', { slug: 'c3', name: 'C3' });
  await api('POST', '/api/node', { board: 'c1', kind: 'include', target: 'c2' });
  await api('POST', '/api/node', { board: 'c2', kind: 'include', target: 'c3' });
  ok((await api('POST', '/api/node', { board: 'c3', kind: 'include', target: 'c1' })).status === 409, 'transitive include cycle rejected');

  // --- move: re-parent the word-duel tile from Games into Tools (in-board) ---
  await api('POST', '/api/node', { board: 'home', kind: 'item', name: 'Tools group' }); // id: tools-group (tools slug taken? no, that's a board slug; node ids are separate)
  // move needs a real node path; move games.word-duel under the 'games' sibling 'tools-group'
  const mv = await api('POST', '/api/move', { board: 'home', path: 'games.word-duel', toPath: 'tools-group' });
  ok(mv.status === 200, 'move within a board');
  {
    const tree = (await api('GET', '/api/state?board=home')).json;
    ok(!at(tree, 'games.word-duel'), 'node gone from old parent');
    ok(at(tree, 'tools-group.word-duel')?._boardLink === 'word-duel', 'node present under new parent');
  }
  // structural guard: cannot move a node into its own descendant
  ok((await api('POST', '/api/move', { board: 'home', path: 'tools-group', toPath: 'tools-group.word-duel' })).status === 409, 'move into own descendant rejected');
  ok((await api('POST', '/api/move', { board: 'home', path: 'games.nope', toPath: 'tools-group' })).status === 404, 'move of missing node rejected');
  // an in-board move of a subtree that includes a back-referencing board is still allowed (graph unchanged)
  ok((await api('POST', '/api/move', { board: 'home', path: 'tools-group', toPath: 'games' })).status === 200, 'in-board move not blocked by include guard');
  // cross-board: moving the word-duel include INTO the word-duel board would self-reference -> reject
  ok((await api('POST', '/api/move', { board: 'home', path: 'games.tools-group', toBoard: 'word-duel', toPath: '' })).status === 409, 'cross-board move creating a cycle rejected');

  // --- daemon mode: a detached server survives the launcher exiting; --stop kills it ---
  {
    const dir2 = await mkdtemp(join(tmpdir(), 'tilemon-d-'));
    const P2 = 47824;
    const runCli = extra => new Promise(r => spawn('node', [SERVER, ...extra, dir2], { env: { ...process.env, PORT: String(P2) }, stdio: 'ignore' }).on('exit', c => r(c)));
    const up2 = () => fetch(`http://localhost:${P2}/api/boards`).then(() => true).catch(() => false);
    await runCli(['--daemon']);                 // launcher backgrounds a child, then exits
    ok(await up2(), 'daemon server reachable after its launcher exited');
    await runCli(['--daemon']);                 // idempotent: no second server, no crash
    ok(await up2(), 'second --daemon is a no-op (already running)');
    await runCli(['--stop']);
    for (let i = 0; i < 20 && await up2(); i++) await new Promise(r => setTimeout(r, 100));
    ok(!(await up2()), 'daemon server stops on --stop');
    await rm(dir2, { recursive: true, force: true });
  }

  // --- aggregate GET /api/state (no param) + ?glowing (subsumes /api/attention) ---
  {
    await api('POST', '/api/board', { name: 'Agg A', slug: 'agg-a' });
    await api('POST', '/api/board', { name: 'Agg B', slug: 'agg-b' });
    await api('POST', '/api/status', { board: 'agg-a', path: 'x', status: 'blocked', note: 'boom' });
    await api('POST', '/api/status', { board: 'agg-a', path: 'y', status: 'in_progress' });
    await api('POST', '/api/status', { board: 'agg-b', path: 'z', status: 'waiting' });

    const agg = (await api('GET', '/api/state')).json;
    ok(Array.isArray(agg.boards), 'GET /api/state (no param) returns { boards: [...] }');
    const a = agg.boards.find(b => b.slug === 'agg-a');
    ok(a && a.tree && Array.isArray(a.tree.children), 'aggregate carries each board\'s resolved tree');
    ok(agg.boards.some(b => b.slug === 'agg-b'), 'aggregate includes every board in one call');

    const glowAll = (await api('GET', '/api/state?glowing=1')).json.items;
    ok(glowAll.some(i => i.board === 'agg-a' && i.path === 'x' && i.status === 'blocked'), '?glowing returns waiting/blocked across ALL boards');
    ok(glowAll.some(i => i.board === 'agg-b' && i.path === 'z' && i.status === 'waiting'), '?glowing spans boards');
    ok(!glowAll.some(i => i.board === 'agg-a' && i.path === 'y'), '?glowing excludes in_progress');

    const glowOne = (await api('GET', '/api/state?glowing=1&board=agg-a')).json.items;
    ok(glowOne.length && glowOne.every(i => i.board === 'agg-a'), '?glowing&board= scopes to one board');

    const bare = (await api('GET', '/api/state?board=agg-a')).json;
    ok(bare.children && !bare.boards && !bare.items, '?board= still returns the bare tree (unchanged shape)');

    const alias = (await api('GET', '/api/attention?board=agg-a')).json.items;
    ok(alias.some(i => i.path === 'x'), '/api/attention still works as a deprecated alias');
  }

} finally {
  child.kill();
  await rm(dir, { recursive: true, force: true });
}

console.log(`server routes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
