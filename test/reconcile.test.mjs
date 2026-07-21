// Tests for `tilemon reconcile` (the attention.md executor). Boots the real server against a temp
// boards dir, puts a FAKE `claude` on PATH (so the judge is deterministic — no model call), and drives
// reconcile exactly as the Stop hook does: `node server.mjs reconcile` with the hook JSON on stdin.
// Verifies: decision → post + one-line result, board-resolve-from-cwd, --dry-run, recursion guard,
// malformed/invalid judge output, and the stop_hook_active short-circuit.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flattenTiles, touchedBoards } from '../reconcile.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dir, '..', 'server.mjs');
const PORT = 47831;
const BASE = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } };
const api = async (method, path, bodyObj) => {
  const res = await fetch(BASE + path, {
    method, headers: bodyObj ? { 'content-type': 'application/json' } : undefined,
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
};
const at = (tree, path) => path.split('.').reduce((n, part) => (n?.children || []).find(c => c.id === part), tree);
const stateOf = async (slug) => (await api('GET', `/api/state?board=${slug}`)).json;

const boards = await mkdtemp(join(tmpdir(), 'tilemon-recon-'));
const work = await mkdtemp(join(tmpdir(), 'tilemon-work-'));
const fakebin = await mkdtemp(join(tmpdir(), 'tilemon-bin-'));
// fake judge: drains stdin (the prompt), then prints whatever FAKE_CLAUDE_OUT says — no model involved.
await writeFile(join(fakebin, 'claude'),
  "#!/usr/bin/env node\nlet s='';process.stdin.on('data',c=>s+=c).on('end',()=>process.stdout.write(process.env.FAKE_CLAUDE_OUT ?? '[]'));\n");
await chmod(join(fakebin, 'claude'), 0o755);

// run reconcile the way the Stop hook does: a fresh process, hook JSON on stdin, fake claude first on PATH
function runReconcile({ args = [], stdin = '', env = {} } = {}) {
  const e = { ...process.env, PATH: fakebin + ':' + process.env.PATH, TILEMON_URL: BASE };
  delete e.TILEMON_RECONCILER;            // don't let an ambient value trip the guard
  Object.assign(e, env);
  return spawnSync('node', [SERVER, 'reconcile', ...args], { input: stdin, encoding: 'utf8', env: e, cwd: work });
}
const decision = (arr) => ({ FAKE_CLAUDE_OUT: JSON.stringify(arr) });

const server = spawn('node', [SERVER, boards], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });

try {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/boards'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }

  // a board linked to `work` so reconcile can resolve it from cwd
  await api('POST', '/api/board', { name: 'Test Repo', slug: 'testrepo', dir: work });

  // 1. happy path: a waiting decision is posted, and the one-line systemMessage is printed
  let r = runReconcile({ args: ['--board', 'testrepo'], stdin: '{}',
    env: decision([{ path: 'api.auth', status: 'waiting', note: 'which provider?', name: 'Auth' }]) });
  ok(r.stdout.includes('"systemMessage"') && r.stdout.includes('api.auth→waiting'), 'posts decision + prints one-line result');
  ok(at(await stateOf('testrepo'), 'api.auth')?.status === 'waiting', 'decision landed on the board');

  // 2. resolve-from-cwd: no --board, board found via the dir link
  r = runReconcile({ stdin: JSON.stringify({ cwd: work }), env: decision([{ path: 'resolved', status: 'blocked', note: 'x' }]) });
  ok(at(await stateOf('testrepo'), 'resolved')?.status === 'blocked', 'resolves board from cwd and posts');

  // 3. --dry-run: prints the decision, posts NOTHING
  r = runReconcile({ args: ['--board', 'testrepo', '--dry-run'], stdin: '{}', env: decision([{ path: 'dry', status: 'waiting' }]) });
  ok(r.stdout.includes('"decisions"') && r.stdout.includes('dry'), 'dry-run prints the decision');
  ok(!at(await stateOf('testrepo'), 'dry'), 'dry-run posts nothing');

  // 4. recursion guard: TILEMON_RECONCILER set => no-op (no post)
  r = runReconcile({ args: ['--board', 'testrepo'], stdin: '{}', env: { TILEMON_RECONCILER: '1', ...decision([{ path: 'guarded', status: 'waiting' }]) } });
  ok(!at(await stateOf('testrepo'), 'guarded'), 'recursion guard makes a nested reconcile a no-op');

  // 5. malformed judge output => [] => nothing changes, no crash
  r = runReconcile({ args: ['--board', 'testrepo'], stdin: '{}', env: { FAKE_CLAUDE_OUT: 'sorry, I cannot help with that' } });
  ok(r.status === 0 && !r.stdout.includes('systemMessage'), 'malformed judge output is ignored, no crash');

  // 6. invalid status skipped; a valid decision alongside it still lands
  r = runReconcile({ args: ['--board', 'testrepo'], stdin: '{}',
    env: decision([{ path: 'bad', status: 'nonsense' }, { path: 'good', status: 'done' }]) });
  const st6 = await stateOf('testrepo');
  ok(!at(st6, 'bad'), 'invalid status is rejected');
  ok(at(st6, 'good')?.status === 'done', 'valid decision alongside an invalid one still lands');

  // 7. stop_hook_active short-circuits before any work
  r = runReconcile({ args: ['--board', 'testrepo'], stdin: '{"stop_hook_active":true}', env: decision([{ path: 'active', status: 'waiting' }]) });
  ok(!at(await stateOf('testrepo'), 'active'), 'stop_hook_active short-circuits');

  // ---- routing (docs/reconcile-routing.md) ----

  // 8. cross-board routing: a session whose cwd resolves to `testrepo` writes a tile tagged for a
  //    DIFFERENT board — it must land on that board, not the cwd board. (The core bug this fixes.)
  await api('POST', '/api/board', { name: 'Other Repo', slug: 'otherrepo', dir: join(work, 'nope') });
  r = runReconcile({ stdin: JSON.stringify({ cwd: work }),
    env: decision([{ board: 'otherrepo', path: 'feature', status: 'waiting', note: 'x', name: 'F' }]) });
  ok(at(await stateOf('otherrepo'), 'feature')?.status === 'waiting', 'tile routes to the named board, not cwd');
  ok(!at(await stateOf('testrepo'), 'feature'), 'the cwd board is NOT written for another board\'s tile');

  // 9. safety gate: a decision naming a board that doesn't exist is dropped (no auto-create, no crash).
  r = runReconcile({ stdin: JSON.stringify({ cwd: work }),
    env: decision([{ board: 'ghost-xyz', path: 'nope', status: 'blocked' }]) });
  ok(r.status === 0 && !r.stdout.includes('ghost-xyz'), 'unknown board is gated out, no crash');

  // 10. park-on-root + alert: a tile for the HOME board's top level fires the "no board matched" note.
  await api('POST', '/api/board', { name: 'Home', slug: 'home' });
  r = runReconcile({ stdin: JSON.stringify({ cwd: work }), env: { TILEMON_HOME_BOARD: 'home',
    ...decision([{ board: 'home', path: 'orphan', status: 'waiting', note: 'new project, no board', name: 'Orphan' }]) } });
  ok(at(await stateOf('home'), 'orphan')?.status === 'waiting', 'unmatched tile lands on the home root');
  ok(r.stdout.includes('parked on root'), 'a parked tile alerts the caller to create a bucket');

  // 11. flattenTiles: dotted paths + status, recursive.
  const flat = flattenTiles({ children: [
    { path: 'a', name: 'A', status: 'waiting', children: [{ path: 'b', status: 'done' }] },
    { path: 'c' },
  ] });
  ok(flat.some(t => t.path === 'a' && t.status === 'waiting') && flat.some(t => t.path === 'a.b' && t.status === 'done')
     && flat.some(t => t.path === 'c'), 'flattenTiles yields dotted paths with status');

  // 12. touchedBoards: file edits + explicit `tilemon flag` calls both resolve to boards (the HINT).
  const tPath = join(work, 'ts.jsonl');
  await writeFile(tPath, [
    JSON.stringify({ message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Edit', input: { file_path: join(work, 'src/x.js') } }] } }),
    JSON.stringify({ message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Bash', input: { command: 'npx tilemon flag otherrepo a.b waiting "y"' } }] } }),
  ].join('\n'));
  const touched = await touchedBoards(BASE, tPath);
  ok(touched.has('testrepo'), 'touchedBoards picks up the board of an edited file (via resolve)');
  ok(touched.has('otherrepo'), 'touchedBoards picks up an explicit `tilemon flag <board>` call');

} finally {
  server.kill();
  await rm(boards, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
  await rm(fakebin, { recursive: true, force: true });
}
console.log(`reconcile: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
