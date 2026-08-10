// collector.mjs — the PASSIVE collector. TileMon's board becomes a *view over ground truth*
// instead of a log of self-reports: no Stop hook, no `claude -p` judge, no agent cooperation.
//
// Claude Code already maintains per-session state for its own agent/fleet view. We read it and
// project it onto boards. The design (see tickets/todo/TIL-002.md):
//
//   • Source        ~/.claude/jobs/<id>/state.json  (state working|blocked|done, name, detail,
//                   needs, cwd, children[].href, sessionId) + ~/.claude/sessions/<pid>.json
//                   (busy|idle heartbeat → liveness).
//   • A tile is a LIVE session. Keyed by session short-id, routed to its project board, decays
//     the moment the session dies or settles. The board is bounded by live-session count and
//     can never accrete — the failure mode that made the pushed board unusable (223 flat tiles).
//   • Ownership. Every tile the collector writes is stamped origin:'session'. It reconciles ONLY
//     those (engine.syncManaged) — human-PINNED tiles (any node without that origin) are never
//     touched, so "important, don't-forget" tiles persist until the human marks them done.
//   • home = includes of the boards that currently have session tiles. Nothing lands on home
//     root; the unroutable go to an `inbox` board, not the overview.
//
// Storage-agnostic: reads the local fleet, writes through an injected engine — so the same run
// targets the file daemon or (with an HTTP-backed engine) hosted tilemon.com.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { slugify } from './engine.js';

const ORIGIN = 'session';
const LIVE_MS = 20 * 60 * 1000;         // live if the session heartbeat within 20 min
const INBOX = 'inbox';                                 // sessions whose project token matches no board
const PRIORITY_TOKEN = /^(low|med|medium|high|z)$/i;   // dropped leading importance labels

// The human names every session `[<importance> - ]<PROJECT> - <description>`. We split on " - ":
// drop a leading importance token, the next token is the PROJECT (routes to a board), and the rest
// is the DESCRIPTION (the tile's label). Only the first two tokens are structural, so a description
// containing " - " stays intact. See references/setup.md.
function parseName(name) {
  const parts = String(name || '').split(/\s+-\s+/).map(s => s.trim()).filter(Boolean);
  let i = 0;
  if (parts[i] && PRIORITY_TOKEN.test(parts[i])) i++;   // drop importance if present
  const project = parts[i] || '';
  const description = parts.slice(i + 1).join(' - ');
  return { project, description };
}

// Routing is STRICT: normalize the project token and every real board slug the same way
// (lowercase, drop non-alphanumerics) and require an exact match — no alias table. The dash-strip
// is the only fuzz, so `FORTYTECH`→`forty-tech` and `FREEMERCHMAKER`→`free-merch-maker` just match.
// A token that matches no board goes to `inbox` (rename the session to fix it).
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function routeBoard(project, slugByNorm) {
  return slugByNorm.get(norm(project)) || INBOX;
}

const readJSON = p => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

/** Read the local Claude Code fleet: jobs (rich state) + sessions (liveness). The one impure bit. */
export function readFleet(ccDir) {
  const jobs = [];
  try {
    for (const dir of readdirSync(join(ccDir, 'jobs'))) {
      const j = readJSON(join(ccDir, 'jobs', dir, 'state.json'));
      if (j) jobs.push(j);
    }
  } catch { /* no jobs dir yet */ }
  const sessions = {};
  try {
    for (const f of readdirSync(join(ccDir, 'sessions'))) {
      if (!f.endsWith('.json')) continue;
      const s = readJSON(join(ccDir, 'sessions', f));
      if (!s?.sessionId) continue;
      const prev = sessions[s.sessionId];
      if (!prev || (s.statusUpdatedAt || 0) > (prev.statusUpdatedAt || 0)) sessions[s.sessionId] = s;
    }
  } catch { /* no sessions dir */ }
  return { jobs, sessions };
}

const shortId = job =>
  job.daemonShort || (typeof job.sessionId === 'string' ? job.sessionId.slice(0, 8) : slugify(job.name || 'session'));

/**
 * Pure projection: fleet → { boardSlug: [tileNode, …] }. Only LIVE, non-done sessions become
 * tiles (decay). `knownSlugs` is the set of real board slugs to route against (strict match; a
 * project token that matches none → `inbox`). Each tile's LABEL is the description parsed from the
 * session name; its NOTE is the harness's live status (`needs`/`detail`).
 */
export function projectTiles({ jobs, sessions }, now = Date.now(), { liveMs = LIVE_MS, knownSlugs = [] } = {}) {
  const slugByNorm = new Map(knownSlugs.map(s => [norm(s), s]));   // normalized slug → real slug
  const byBoard = {};
  const dropped = [];
  for (const job of jobs) {
    try {
      const s = sessions[job.sessionId] || {};
      const beat = s.statusUpdatedAt || Date.parse(job.updatedAt || '') || 0;
      const live = (now - beat) < liveMs;
      if (job.state === 'done' || !live) { dropped.push(job); continue; }   // decay: dead or settled
      const status = job.state === 'blocked' ? 'waiting' : 'in_progress';   // working → in_progress
      const { project, description } = parseName(job.name);
      const prs = (job.children || []).filter(c => c.kind === 'pr').length;
      let note = (job.needs || job.detail || '').toString().replace(/\s+/g, ' ').trim();
      if (prs) note = (note ? note + ' ' : '') + `(${prs} PR${prs === 1 ? '' : 's'})`;
      const node = {
        id: 's-' + shortId(job),
        name: (description || project || job.intent || 'session').toString().slice(0, 120),  // the DESCRIPTION is the label
        // seen = the session's own heartbeat, NOT now — so an idle poll yields byte-identical
        // tiles and syncManaged skips the write (no per-poll file churn / SSE spam).
        weight: 1, status, note, seen: beat || now, origin: ORIGIN, sessionId: job.sessionId,
      };
      (byBoard[routeBoard(project, slugByNorm)] ||= []).push(node);
    } catch { dropped.push(job); }   // one malformed job must never abort the whole poll
  }
  return { byBoard, dropped };
}

/**
 * Build the desired-state map { boardSlug: [managed nodes] }. Every board that has tiles now, plus
 * every existing board (swept with [] so one that lost all its sessions gets cleared). There is NO
 * `home` rebuild — `home` and the buckets are the human's seeded, persistent structure (from
 * projects.yml); the collector only maintains session tiles on project boards (+ `inbox`) and clears
 * `origin:'session'` from everything else — a no-op for a board that never had any (buckets, home).
 */
function planBoards(byBoard, existing) {
  const touch = [...new Set([...existing, ...Object.keys(byBoard)])].filter(s => s !== 'tutorial');
  const plan = {};
  for (const slug of touch) plan[slug] = byBoard[slug] || [];
  return plan;
}

// A SINK is where tiles land: `listSlugs()` + `sync(slug, origin, nodes) -> {added,updated,removed}`.
// The engine sink writes local board files in-process; the remote sink POSTs to a hosted /api/collect.
// Same projection either way — local `npx tilemon`, or the standalone bridge feeding tilemon.com.

/** Local sink: reconcile straight through an in-process engine (file store). */
export const engineSink = engine => ({
  listSlugs: () => engine.listSlugs(),
  sync: (slug, origin, nodes) => engine.syncManaged(slug, origin, nodes),
});

/** Remote sink: one POST to /api/collect applies the whole plan server-side (atomic per board). */
export function remoteSink({ url, token, fetchImpl = fetch }) {
  const base = url.replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  return {
    async listSlugs() {
      const r = await fetchImpl(`${base}/api/boards`, { headers });
      if (!r.ok) throw new Error(`GET /api/boards -> ${r.status}`);
      const b = await r.json();
      return Array.isArray(b) ? b.map(x => x.slug) : [];
    },
    // remote applies the FULL plan in one request; we hand each board through here, but batch at runCollector
    _postPlan: async (origin, plan) => {
      const r = await fetchImpl(`${base}/api/collect`, { method: 'POST', headers, body: JSON.stringify({ origin, boards: plan }) });
      if (!r.ok) throw new Error(`POST /api/collect -> ${r.status} ${await r.text().catch(() => '')}`);
      return r.json();
    },
  };
}

/**
 * Read the fleet, project the live sessions, and reconcile them onto the target. Owns only
 * origin:'session' nodes; human pins are never touched. `sink` is engineSink (local) or remoteSink.
 */
export async function runCollector({ engine, sink, ccDir, fleet, now = Date.now(), log = () => {} }) {
  sink = sink || engineSink(engine);
  const existing = await sink.listSlugs();                              // the real boards to route against
  const { byBoard, dropped } = projectTiles(fleet || readFleet(ccDir), now, { knownSlugs: existing });
  const plan = planBoards(byBoard, existing);

  let changed = 0;
  if (sink._postPlan) {                                   // remote: one batched request
    const res = await sink._postPlan(ORIGIN, plan);
    changed = res?.changed || 0;
  } else {                                                // local: per-board through the engine
    for (const [slug, nodes] of Object.entries(plan)) {
      const r = await sink.sync(slug, ORIGIN, nodes);
      if (r.error) { log(`collect: ${slug} skipped (${r.error})`); continue; }
      changed += (r.added + r.updated + r.removed);
    }
  }

  const withTiles = Object.values(byBoard).filter(a => a.length).length;
  const tiles = Object.values(byBoard).reduce((n, a) => n + a.length, 0);
  if (changed) log(`collect: ${tiles} live tile(s) across ${withTiles} board(s); dropped ${dropped.length} (done/dead)`);
  return { boards: withTiles, tiles, dropped: dropped.length, changed };
}
