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
//   • Structure is the human's. `home` and the buckets are seeded once and persistent — the
//     collector NEVER rebuilds them. It only maintains session tiles on project boards; a session
//     whose project matches no board goes to an `inbox` board (never `home` root). Heat rolls up
//     through the human's includes automatically.
//
// Storage-agnostic: reads the local fleet, writes through an injected engine — so the same run
// targets the file daemon or (with an HTTP-backed engine) hosted tilemon.com.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { slugify } from './engine.js';

const ORIGIN = 'session';
const INBOX = 'inbox';                                 // sessions whose project token matches no board

// How a session NAME is split into its parts is CONFIGURABLE — a named-capture regex, so anyone can
// use their own naming convention (not just this repo's). The collector reads `project` (routes to a
// board), `description` (the tile's label), and optionally `importance` (extracted and dropped).
// Override in ~/.tilemon/config.json → { "namePattern": "<regex with named groups>" }.
//
// The DEFAULT handles `[IMPORTANCE - ]PROJECT - description` (case-insensitive importance; the
// project has no dashes so `forty-tech` is written `FORTYTECH`; the description keeps any dashes).
export const DEFAULT_NAME_PATTERN =
  String.raw`^\s*(?:(?<importance>LOW|MED|MEDIUM|HIGH|Z)\s*-\s*)?(?<project>[^-]+?)\s*-\s*(?<description>.+?)\s*$`;

/** Compile a name pattern; an invalid override falls back to the built-in default (never throws). */
export function compileNamePattern(src) {
  try { return new RegExp(src || DEFAULT_NAME_PATTERN, 'i'); }
  catch { return new RegExp(DEFAULT_NAME_PATTERN, 'i'); }
}

/** Read ~/.tilemon/config.json (collector settings: namePattern, …). Absent/broken → {}. */
export function loadConfig(ccDir) {
  return (ccDir && readJSON(join(ccDir, 'config.json'))) || {};
}

// Apply the pattern: matched named groups win; if the name doesn't match at all, the whole name is
// the description (→ project empty → inbox), so a badly-named session is visible, not dropped.
function parseName(name, nameRe) {
  // Cap the matched input: a user-supplied namePattern could backtrack catastrophically on a long
  // string, and a hang wouldn't throw (it freezes the poll). Session names are short; 200 is ample.
  const s = String(name || '').slice(0, 200);
  const g = s.match(nameRe)?.groups;
  if (!g) return { project: '', description: String(name || '').trim() };
  return { project: (g.project || '').trim(), description: (g.description || '').trim() };
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
  // Claude Code's PR-status cache (open/merged + CI checks), keyed by PR URL — an attention signal.
  const prStatus = readJSON(join(ccDir, 'gh-pr-status-cache.json')) || {};
  return { jobs, sessions, prStatus };
}

const shortId = job =>
  job.daemonShort || (typeof job.sessionId === 'string' ? job.sessionId.slice(0, 8) : slugify(job.name || 'session'));

/**
 * Count a session's live ATTENTION SIGNALS — the colour is the count, not a fixed palette:
 *   1 = it just exists (a finished outcome to glance at)     → green
 *   2 = existence + one of {blocked, an open PR}             → amber
 *   3+ = existence + blocked + open PR / failing CI          → red
 * New signals slot in here later (uncommitted work, requested-changes, …) with no new colours.
 */
export function countSignals(job, prStatus = {}) {
  let n = 1;                                    // existence — the baseline signal
  const reasons = [];
  if (job.state === 'blocked') { n++; reasons.push('needs you'); }
  const openPRs = (job.children || []).filter(c => c && c.kind === 'pr' && prStatus[c.href]?.state === 'OPEN');
  if (openPRs.length) { n++; reasons.push(`${openPRs.length} open PR${openPRs.length === 1 ? '' : 's'}`); }
  if (openPRs.some(c => (prStatus[c.href]?.checks?.failed || 0) > 0)) { n++; reasons.push('CI failing'); }
  return { signals: n, reasons };
}
// interim compat: map the count onto an existing status so board.js renders sanely until it learns
// to colour by `signals` directly (green shows as neutral `todo` for now; amber/red already match).
const statusForSignals = n => (n >= 3 ? 'blocked' : n >= 2 ? 'waiting' : 'todo');

/**
 * Pure projection: fleet → { boardSlug: [tileNode, …] }. MIRRORS every session that exists — no
 * decay; a tile lives while its job does and vanishes when the harness GCs the job. Each tile
 * carries `signals` (the attention-signal count → colour) and `seen` (liveness → the live dot,
 * a separate axis). `knownSlugs` routes the project token (strict match; no match → `inbox`).
 * Label = the description parsed from the name; note = the harness status + signal reasons.
 */
export function projectTiles({ jobs, sessions, prStatus = {} }, now = Date.now(), { knownSlugs = [], nameRe = compileNamePattern() } = {}) {
  const slugByNorm = new Map(knownSlugs.map(s => [norm(s), s]));   // normalized slug → real slug
  const byBoard = {};
  const dropped = [];
  for (const job of jobs) {
    try {
      const s = sessions[job.sessionId] || {};
      const beat = s.statusUpdatedAt || Date.parse(job.updatedAt || '') || 0;   // heartbeat → live dot
      const { project, description } = parseName(job.name, nameRe);
      const { signals, reasons } = countSignals(job, prStatus);
      let note = (job.needs || job.detail || '').toString().replace(/\s+/g, ' ').trim();
      const extra = reasons.filter(r => r !== 'needs you');   // 'needs you' is already said by the amber colour
      if (extra.length) note = (note ? note + ' · ' : '') + extra.join(' · ');
      const node = {
        id: 's-' + shortId(job),
        name: (description || project || job.intent || 'session').toString().slice(0, 120),  // the DESCRIPTION is the label
        weight: 1,
        status: statusForSignals(signals),   // interim; board.js will colour by `signals`
        signals,                              // the attention-signal count → colour (green/amber/red)
        note,
        // seen = the session's own heartbeat (NOT now) — stable across idle polls (no churn), and it
        // drives the live dot: a fresh session shows "active", a settled/old one just shows quietly.
        seen: beat || now,
        origin: ORIGIN, sessionId: job.sessionId,
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
  const nameRe = compileNamePattern(loadConfig(ccDir).namePattern);    // ~/.tilemon/config.json override, else default
  const { byBoard, dropped } = projectTiles(fleet || readFleet(ccDir), now, { knownSlugs: existing, nameRe });
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
