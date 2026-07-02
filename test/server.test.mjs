// Wire-level tests for the structure API: create board, include-existing, move, cycle guards.
// Boots the real server against a temp boards dir and drives it over HTTP — no browser.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
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

  // fresh dir auto-seeds the 'tilemon' home board
  ok((await api('GET', '/api/boards')).json.some(b => b.slug === 'tilemon'), 'home board auto-seeded');

  // --- POST /api/board: create bare boards, placed nowhere ---
  const mk = await api('POST', '/api/board', { name: 'Word Duel' });
  ok(mk.status === 200 && mk.json.slug === 'word-duel', 'create board derives slug from name');
  ok((await api('POST', '/api/board', { slug: 'tools', name: 'Tools' })).json.slug === 'tools', 'create board honours explicit slug');
  ok((await api('POST', '/api/board', { slug: 'tools', name: 'Tools again' })).status === 409, 'duplicate slug rejected');
  ok((await api('POST', '/api/board', {})).status === 400, 'create board needs a name');
  await api('POST', '/api/board', { name: 'Hex Drop' }); // -> hex-drop

  // --- buckets: a group is just an item you add children into ---
  ok((await api('POST', '/api/node', { board: 'tilemon', kind: 'item', name: 'Games' })).status === 200, 'add group item');

  // --- include an EXISTING board (references, does not duplicate) ---
  ok((await api('POST', '/api/node', { board: 'tilemon', path: 'games', kind: 'include', target: 'word-duel' })).status === 200, 'include existing board');
  await api('POST', '/api/node', { board: 'tilemon', path: 'games', kind: 'include', target: 'hex-drop' });
  {
    const tree = (await api('GET', '/api/state?board=tilemon')).json;
    const wd = at(tree, 'games.word-duel');
    ok(wd && wd._boardLink === 'word-duel', 'include renders as a board-link tile under the bucket');
    ok((await api('GET', '/api/boards')).json.filter(b => b.slug === 'word-duel').length === 1, 'include did not create a duplicate board');
  }

  // include validation + cycle guards
  ok((await api('POST', '/api/node', { board: 'tilemon', kind: 'include', target: 'nope' })).status === 404, 'include of missing board rejected');
  ok((await api('POST', '/api/node', { board: 'tilemon', kind: 'include', target: 'tilemon' })).status === 409, 'self-include rejected');
  // clean chain c1 -> c2 -> c3; closing it (c3 -> c1) is a transitive cycle
  await api('POST', '/api/board', { slug: 'c1', name: 'C1' });
  await api('POST', '/api/board', { slug: 'c2', name: 'C2' });
  await api('POST', '/api/board', { slug: 'c3', name: 'C3' });
  await api('POST', '/api/node', { board: 'c1', kind: 'include', target: 'c2' });
  await api('POST', '/api/node', { board: 'c2', kind: 'include', target: 'c3' });
  ok((await api('POST', '/api/node', { board: 'c3', kind: 'include', target: 'c1' })).status === 409, 'transitive include cycle rejected');

  // --- move: re-parent the word-duel tile from Games into Tools (in-board) ---
  await api('POST', '/api/node', { board: 'tilemon', kind: 'item', name: 'Tools group' }); // id: tools-group (tools slug taken? no, that's a board slug; node ids are separate)
  // move needs a real node path; move games.word-duel under the 'games' sibling 'tools-group'
  const mv = await api('POST', '/api/move', { board: 'tilemon', path: 'games.word-duel', toPath: 'tools-group' });
  ok(mv.status === 200, 'move within a board');
  {
    const tree = (await api('GET', '/api/state?board=tilemon')).json;
    ok(!at(tree, 'games.word-duel'), 'node gone from old parent');
    ok(at(tree, 'tools-group.word-duel')?._boardLink === 'word-duel', 'node present under new parent');
  }
  // structural guard: cannot move a node into its own descendant
  ok((await api('POST', '/api/move', { board: 'tilemon', path: 'tools-group', toPath: 'tools-group.word-duel' })).status === 409, 'move into own descendant rejected');
  ok((await api('POST', '/api/move', { board: 'tilemon', path: 'games.nope', toPath: 'tools-group' })).status === 404, 'move of missing node rejected');
  // an in-board move of a subtree that includes a back-referencing board is still allowed (graph unchanged)
  ok((await api('POST', '/api/move', { board: 'tilemon', path: 'tools-group', toPath: 'games' })).status === 200, 'in-board move not blocked by include guard');
  // cross-board: moving the word-duel include INTO the word-duel board would self-reference -> reject
  ok((await api('POST', '/api/move', { board: 'tilemon', path: 'games.tools-group', toBoard: 'word-duel', toPath: '' })).status === 409, 'cross-board move creating a cycle rejected');

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

} finally {
  child.kill();
  await rm(dir, { recursive: true, force: true });
}

console.log(`server routes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
