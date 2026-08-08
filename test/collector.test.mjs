// collector.test.mjs — the passive collector: projection (decay/routing/status) + the ownership
// invariant that keeps the board sane (session tiles reconcile; human pins are never touched).
import { projectTiles, runCollector } from '../collector.mjs';
import { createEngine } from '../engine.js';

let passed = 0, failed = 0;
const eq = (got, want, label) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) passed++; else { failed++; console.error(`FAIL ${label}\n  got:  ${g}\n  want: ${w}`); }
};

const NOW = 1_800_000_000_000;
const fresh = NOW - 60_000;          // 1 min ago → live
const stale = NOW - 60 * 60_000;     // 60 min ago → dead
// a fleet builder: jobs[] + sessions{} keyed by sessionId
const fleet = (...jobs) => ({
  jobs,
  sessions: Object.fromEntries(jobs.map(j => [j.sessionId, { sessionId: j.sessionId, statusUpdatedAt: j._beat ?? fresh }])),
});
const job = (o) => ({ sessionId: o.sessionId || 'sid-' + (o.daemonShort || o.name), state: 'working', ...o });

// ---- projection: decay ----
{
  const { byBoard, dropped } = projectTiles(fleet(
    job({ daemonShort: 'aaa', name: 'DOEFIN - live blocked', state: 'blocked' }),
    job({ daemonShort: 'bbb', name: 'DOEFIN - live working', state: 'working' }),
    job({ daemonShort: 'ccc', name: 'DOEFIN - done', state: 'done' }),
    job({ daemonShort: 'ddd', name: 'DOEFIN - dead', state: 'blocked', _beat: stale }),
  ), NOW);
  eq(dropped.length, 2, 'decay: done + dead dropped');
  eq((byBoard.doefin || []).length, 2, 'decay: only live kept');
  const byId = Object.fromEntries((byBoard.doefin || []).map(t => [t.id, t]));
  eq(byId['s-aaa'].status, 'waiting', 'blocked → waiting');
  eq(byId['s-bbb'].status, 'in_progress', 'working → in_progress');
  eq(byId['s-aaa'].origin, 'session', 'tile stamped origin session');
}

// ---- projection: routing ----
{
  const { byBoard } = projectTiles(fleet(
    job({ daemonShort: '1', name: 'TOONWALK - x', state: 'blocked' }),
    job({ daemonShort: '2', name: 'HIGH - FORTYTECH - Ads', state: 'blocked' }),   // priority token skipped
    job({ daemonShort: '3', name: 'Something odd', state: 'blocked', cwd: '/home/ai/forty-workspace/repos/gap-form' }),
    job({ daemonShort: '4', name: 'No idea', state: 'blocked', cwd: '/tmp/elsewhere' }),
    job({ daemonShort: '5', name: 'META - workspace thing', state: 'blocked' }),
  ), NOW);
  eq(Object.keys(byBoard).sort(), ['forty-tech', 'forty-workspace', 'gap-form', 'inbox', 'twigface'], 'routing: name/prefix/cwd/inbox');
}

// ---- projection: note carries needs + PR count ----
{
  const { byBoard } = projectTiles(fleet(
    job({ daemonShort: 'n', name: 'DOEFIN - x', state: 'blocked', needs: '! sudo apt-get install xvfb',
          children: [{ kind: 'pr', href: 'h/1' }, { kind: 'pr', href: 'h/2' }] }),
  ), NOW);
  eq(byBoard.doefin[0].note, '! sudo apt-get install xvfb (2 PRs)', 'note = needs + PR count');
}

// ---- reconcile: ownership invariant (pins survive), idempotency, home includes, board-clear ----
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
{
  const { boards, engine } = await memEngine({
    'tilemon-app': { name: 'Tilemon App', children: [{ id: 'pin1', name: 'PIN', weight: 2, status: 'waiting' }] },
    home: { name: 'Home', toolbar: true, children: [{ id: 'homepin', name: 'HOME PIN', weight: 1 }] },
  });
  const f = fleet(job({ daemonShort: 'zzz', name: 'TILEMON - work', state: 'blocked' }));

  await runCollector({ engine, fleet: f, now: NOW });
  await runCollector({ engine, fleet: f, now: NOW });   // idempotent

  const ta = boards.get('tilemon-app');
  eq(ta.children.filter(c => c.id === 'pin1').length, 1, 'pin survived on board');
  eq(ta.children.filter(c => c.origin === 'session').length, 1, 'exactly one session tile (no dup on re-run)');
  const home = boards.get('home');
  eq(home.children.some(c => c.id === 'homepin' && !c.origin), true, 'home pin survived');
  eq(home.children.some(c => c.include === 'tilemon-app' && c.origin === 'session'), true, 'home includes active board');

  // the session dies → its tile clears, but the pin stays and the home include drops
  await runCollector({ engine, fleet: { jobs: [], sessions: {} }, now: NOW });
  const ta2 = boards.get('tilemon-app');
  eq(ta2.children.filter(c => c.origin === 'session').length, 0, 'dead session tile cleared');
  eq(ta2.children.some(c => c.id === 'pin1'), true, 'pin still there after clear');
  eq(boards.get('home').children.some(c => c.include === 'tilemon-app'), false, 'home include dropped when board empty');
  eq(boards.get('home').children.some(c => c.id === 'homepin'), true, 'home pin still there after clear');
}

// ---- churn: an unchanged fleet across polls does no work (no write, nothing to broadcast) ----
{
  const { engine } = await memEngine();
  const f = fleet(job({ daemonShort: 'q', name: 'DOEFIN - x', state: 'blocked', _beat: fresh }));
  const r1 = await runCollector({ engine, fleet: f, now: NOW });
  const r2 = await runCollector({ engine, fleet: f, now: NOW });
  eq(r1.changed > 0, true, 'first poll changes the board');
  eq(r2.changed, 0, 'identical second poll = no change (no churn / no SSE spam)');
}

// ---- migration: a session that re-routes A→B leaves no orphan tile on A ----
{
  const { boards, engine } = await memEngine();
  await runCollector({ engine, fleet: fleet(job({ daemonShort: 'm', name: 'DOEFIN - x', state: 'blocked' })), now: NOW });
  eq(boards.get('doefin').children.some(c => c.origin === 'session'), true, 'tile on doefin first');
  // same session id, name now routes to twigface
  await runCollector({ engine, fleet: fleet(job({ sessionId: 'sid-DOEFIN - x', daemonShort: 'm', name: 'TOONWALK - x', state: 'blocked' })), now: NOW });
  eq(boards.get('doefin').children.some(c => c.origin === 'session'), false, 'old board cleared after re-route');
  eq(boards.get('twigface').children.some(c => c.origin === 'session'), true, 'tile moved to new board');
  eq(boards.get('home').children.some(c => c.include === 'twigface'), true, 'home follows the move');
  eq(boards.get('home').children.some(c => c.include === 'doefin'), false, 'home drops the emptied board');
}

console.log(`collector: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
