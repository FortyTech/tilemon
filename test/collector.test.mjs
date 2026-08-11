// collector.test.mjs — the passive collector: projection (decay / strict routing / name parse) +
// the ownership invariant (session tiles reconcile on project boards; human pins and `home` are
// never touched). `home` and the buckets are the human's seeded structure — the collector leaves
// them alone and only maintains session tiles on project boards (+ inbox).
import { projectTiles, runCollector, remoteSink, compileNamePattern, countSignals } from '../collector.mjs';
import { createEngine } from '../engine.js';

let passed = 0, failed = 0;
const eq = (got, want, label) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) passed++; else { failed++; console.error(`FAIL ${label}\n  got:  ${g}\n  want: ${w}`); }
};

const NOW = 1_800_000_000_000;
const fresh = NOW - 60_000;          // 1 min ago → live
const stale = NOW - 60 * 60_000;     // 60 min ago → dead
const fleet = (...jobs) => ({
  jobs,
  sessions: Object.fromEntries(jobs.map(j => [j.sessionId, { sessionId: j.sessionId, statusUpdatedAt: j._beat ?? fresh }])),
});
const job = (o) => ({ sessionId: o.sessionId || 'sid-' + (o.daemonShort || o.name), state: 'working', ...o });
const known = ['doefin', 'forty-tech', 'free-merch-maker', 'twigface', 'tilemon-app'];

// ---- projection: MIRROR every session (no decay), label = description ----
{
  const { byBoard } = projectTiles(fleet(
    job({ daemonShort: 'aaa', name: 'DOEFIN - live blocked', state: 'blocked' }),
    job({ daemonShort: 'bbb', name: 'DOEFIN - live working', state: 'working' }),
    job({ daemonShort: 'ccc', name: 'DOEFIN - done', state: 'done' }),
    job({ daemonShort: 'ddd', name: 'DOEFIN - dead', state: 'blocked', _beat: stale }),
  ), NOW, { knownSlugs: known });
  eq((byBoard.doefin || []).length, 4, 'mirror ALL sessions — done and stale are NOT dropped');
  const byId = Object.fromEntries((byBoard.doefin || []).map(t => [t.id, t]));
  eq(byId['s-aaa'].signals, 2, 'blocked → 2 signals (existence + needs-you) = amber');
  eq(byId['s-bbb'].signals, 1, 'working → 1 signal (existence) = green');
  eq(byId['s-ccc'].signals, 1, 'done → 1 signal (existence) = green');
  eq(byId['s-aaa'].name, 'live blocked', 'label = description (project token stripped)');
  eq(byId['s-aaa'].origin, 'session', 'tile stamped origin session');
}

// ---- signal counting → colour band (existence + blocked + open PR + failing CI) ----
{
  const openClean = 'https://gh/x/1', openFail = 'https://gh/x/2', merged = 'https://gh/x/3';
  const prStatus = {
    [openClean]: { state: 'OPEN', checks: { failed: 0 } },
    [openFail]: { state: 'OPEN', checks: { failed: 1 } },
    [merged]: { state: 'MERGED', checks: { failed: 0 } },
  };
  const sig = (o) => countSignals(o, prStatus).signals;
  eq(sig({ state: 'done' }), 1, 'done, nothing → 1 (green)');
  eq(sig({ state: 'working' }), 1, 'working → 1 (green)');
  eq(sig({ state: 'blocked' }), 2, 'blocked → 2 (amber)');
  eq(sig({ state: 'done', children: [{ kind: 'pr', href: merged }] }), 1, 'merged PR is NOT a signal → 1 (green)');
  eq(sig({ state: 'done', children: [{ kind: 'pr', href: openClean }] }), 2, 'done + open PR → 2 (amber)');
  eq(sig({ state: 'blocked', children: [{ kind: 'pr', href: openClean }] }), 3, 'blocked + open PR → 3 (red)');
  eq(sig({ state: 'done', children: [{ kind: 'pr', href: openFail }] }), 3, 'done + open PR + failing CI → 3 (red)');
  eq(countSignals({ state: 'done', children: [{ kind: 'pr', href: openClean }] }, prStatus).reasons.includes('1 open PR'), true, 'reason lists the open PR');
}

// ---- projection: STRICT dash-stripped routing; unmatched → inbox ----
{
  const { byBoard } = projectTiles(fleet(
    job({ daemonShort: '1', name: 'TWIGFACE - x', state: 'blocked' }),
    job({ daemonShort: '2', name: 'HIGH - FORTYTECH - Ads', state: 'blocked' }),      // priority dropped; fortytech = forty-tech
    job({ daemonShort: '3', name: 'MED - FREEMERCHMAKER - ui', state: 'blocked' }),   // dash-strip match
    job({ daemonShort: '4', name: 'FFF - costings', state: 'blocked' }),              // no fff board → inbox
    job({ daemonShort: '5', name: 'random note', state: 'blocked', cwd: '/home/ai/forty-workspace/repos/doefin' }), // cwd ignored → inbox
  ), NOW, { knownSlugs: known });
  eq(Object.keys(byBoard).sort(), ['forty-tech', 'free-merch-maker', 'inbox', 'twigface'], 'strict routing; unmatched → inbox');
  eq(byBoard.inbox.length, 2, 'both unmatched (incl. cwd-only) land in inbox — cwd is not used');
}

// ---- projection: name parse (drop priority, project routes, description = label incl. inner dashes) ----
{
  const { byBoard } = projectTiles(fleet(
    job({ daemonShort: 'p', name: 'MED - DOEFIN - check e2e - retry', state: 'blocked', needs: 'install xvfb',
          children: [{ kind: 'pr', href: 'h/1' }, { kind: 'pr', href: 'h/2' }] }),
  ), NOW, { knownSlugs: known });
  const t = byBoard.doefin[0];
  eq(t.name, 'check e2e - retry', 'label = description (priority + project stripped; inner " - " kept)');
  eq(t.note, 'install xvfb', 'note = harness needs (PRs only counted when OPEN in the cache, none here)');
}

// ---- configurable name pattern: a custom regex extracts project + description ----
{
  const custom = compileNamePattern(String.raw`^(?<project>[^:]+):\s*(?<description>.+)$`);   // "project: description"
  const { byBoard } = projectTiles(fleet(
    job({ daemonShort: 'c', name: 'doefin: fix the thing', state: 'blocked' }),
  ), NOW, { knownSlugs: known, nameRe: custom });
  eq(byBoard.doefin?.[0]?.name, 'fix the thing', 'custom regex extracts description');
  eq(byBoard.doefin?.[0] != null, true, 'custom regex routes via its own project group');
}
// invalid override never throws — falls back to the default pattern
{
  const re = compileNamePattern('(((');   // malformed
  const { byBoard } = projectTiles(fleet(
    job({ daemonShort: 'd', name: 'MED - DOEFIN - x', state: 'blocked' }),
  ), NOW, { knownSlugs: known, nameRe: re });
  eq(byBoard.doefin?.[0]?.name, 'x', 'malformed pattern fell back to default (parsed correctly)');
}

async function memEngine(seed = {}) {
  const boards = new Map(Object.entries(seed).map(([k, v]) => [k, structuredClone(v)]));
  return {
    boards,
    engine: createEngine({
      readBoard: async s => boards.has(s) ? structuredClone(boards.get(s)) : null,
      writeBoard: async (s, b) => { boards.set(s, structuredClone(b)); },
      listSlugs: async () => [...boards.keys()],
    }),
  };
}

// ---- reconcile: pin survives, idempotent, and `home` is NEVER touched by the collector ----
{
  const { boards, engine } = await memEngine({
    doefin: { name: 'Doefin', children: [{ id: 'pin1', name: 'PIN', weight: 2, status: 'waiting' }] },
    home: { name: 'Home', toolbar: true, children: [{ id: 'products', name: 'Products', weight: 1, include: 'doefin' }] },
  });
  const f = fleet(job({ daemonShort: 'zzz', name: 'DOEFIN - work', state: 'blocked' }));

  await runCollector({ engine, fleet: f, now: NOW });
  await runCollector({ engine, fleet: f, now: NOW });   // idempotent

  const d = boards.get('doefin');
  eq(d.children.filter(c => c.id === 'pin1').length, 1, 'pin survived on board');
  eq(d.children.filter(c => c.origin === 'session').length, 1, 'exactly one session tile (no dup on re-run)');
  eq(JSON.stringify(boards.get('home').children), JSON.stringify([{ id: 'products', name: 'Products', weight: 1, include: 'doefin' }]),
    'home is the human\'s structure — collector never touches it');

  // session dies → its tile clears; pin and home stay
  await runCollector({ engine, fleet: { jobs: [], sessions: {} }, now: NOW });
  const d2 = boards.get('doefin');
  eq(d2.children.filter(c => c.origin === 'session').length, 0, 'dead session tile cleared');
  eq(d2.children.some(c => c.id === 'pin1'), true, 'pin still there after clear');
  eq(boards.get('home').children.length, 1, 'home still untouched after clear');
}

// ---- churn: an unchanged fleet across polls does no work ----
{
  const { engine } = await memEngine({ doefin: { name: 'Doefin', children: [] } });
  const f = fleet(job({ daemonShort: 'q', name: 'DOEFIN - x', state: 'blocked', _beat: fresh }));
  const r1 = await runCollector({ engine, fleet: f, now: NOW });
  const r2 = await runCollector({ engine, fleet: f, now: NOW });
  eq(r1.changed > 0, true, 'first poll changes the board');
  eq(r2.changed, 0, 'identical second poll = no change (no churn / no SSE spam)');
}

// ---- migration: a session that re-routes A→B leaves no orphan on A ----
{
  const { boards, engine } = await memEngine({ doefin: { name: 'Doefin', children: [] }, twigface: { name: 'Twigface', children: [] } });
  await runCollector({ engine, fleet: fleet(job({ daemonShort: 'm', name: 'DOEFIN - x', state: 'blocked' })), now: NOW });
  eq(boards.get('doefin').children.some(c => c.origin === 'session'), true, 'tile on doefin first');
  // same session id, renamed so it now routes to twigface
  await runCollector({ engine, fleet: fleet(job({ sessionId: 'sid-DOEFIN - x', daemonShort: 'm', name: 'TWIGFACE - x', state: 'blocked' })), now: NOW });
  eq(boards.get('doefin').children.some(c => c.origin === 'session'), false, 'old board cleared after re-route');
  eq(boards.get('twigface').children.some(c => c.origin === 'session'), true, 'tile moved to new board');
}

// ---- remote sink: one GET /api/boards + one POST /api/collect carrying the plan (no home) ----
{
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers?.authorization });
    if (url.endsWith('/api/boards')) return { ok: true, json: async () => [{ slug: 'doefin' }, { slug: 'stale-board' }] };
    if (url.endsWith('/api/collect')) return { ok: true, json: async () => ({ ok: true, changed: 3 }) };
    return { ok: false, status: 404, text: async () => 'nope' };
  };
  const sink = remoteSink({ url: 'https://www.tilemon.com/', token: 'k', fetchImpl });
  const f = fleet(job({ daemonShort: 'r', name: 'DOEFIN - x', state: 'blocked' }));
  const res = await runCollector({ sink, fleet: f, now: NOW });

  const boardsCall = calls.find(c => c.url.endsWith('/api/boards'));
  const collectCall = calls.find(c => c.url.endsWith('/api/collect'));
  eq(boardsCall.auth, 'Bearer k', 'remote sink sends the bearer token');
  eq(collectCall.method, 'POST', 'remote posts to /api/collect');
  eq(collectCall.body.origin, 'session', 'payload carries the origin');
  eq(collectCall.body.boards.doefin.length, 1, 'doefin tile in the plan');
  eq(collectCall.body.boards['stale-board'], [], 'a board that lost its sessions is sent empty (gets cleared)');
  eq('home' in collectCall.body.boards, false, 'no home rebuild — home is human structure');
  eq(res.changed, 3, 'runCollector reports the server-side change count');
}

console.log(`collector: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
