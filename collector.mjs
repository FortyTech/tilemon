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
import { humanize, slugify, slugOk } from './engine.js';

const ORIGIN = 'session';
const LIVE_MS = 20 * 60 * 1000;         // live if the session heartbeat within 20 min
const SKIP_BOARDS = new Set(['home', 'tutorial']);   // home is built from includes; tutorial is fresh-install content

// name-prefix → project board slug. The reliable routing key is the session NAME, not cwd
// (cwd is often the workspace root or a stale spawn dir). Extend as projects are added/renamed.
const PREFIX = {
  doefin: 'doefin', blastgeist: 'blastgeist', blastguist: 'blastgeist',
  toonwalk: 'twigface', twigface: 'twigface', tilemon: 'tilemon-app',
  fortytech: 'forty-tech', fff: 'freeing-female-founders', vidifai: 'vidifai',
  chessku: 'chessku', noughtle: 'noughtle', 'social-content': 'social-content',
  eulogy: 'eulogy-song', 'gap-form': 'gap-form', gapform: 'gap-form',
  meta: 'forty-workspace', 'forty-workspace': 'forty-workspace', workspace: 'forty-workspace',
};
const PRIORITY_TOKEN = /^(low|med|medium|high|z)$/i;   // dropped leading priority labels

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

function routeBoard(job) {
  const parts = String(job.name || '').split(/\s*[-—]\s*/).map(s => s.trim());
  for (const p of parts) {                                   // first name-part that maps wins (skips LOW/HIGH/…)
    if (PRIORITY_TOKEN.test(p)) continue;
    const key = p.toLowerCase();
    if (PREFIX[key]) return PREFIX[key];
    break;                                                   // only the leading meaningful token routes
  }
  const cwd = String(job.cwd || '');
  const m = cwd.match(/repos\/([a-z0-9][a-z0-9-]*)/i);
  if (m && slugOk(m[1])) return m[1];
  if (cwd.replace(/\/+$/, '').endsWith('/forty-workspace')) return 'forty-workspace';
  if (/doefin/i.test(cwd)) return 'doefin';
  return 'inbox';                                            // unroutable → inbox board, never home root
}

const shortId = job =>
  job.daemonShort || (typeof job.sessionId === 'string' ? job.sessionId.slice(0, 8) : slugify(job.name || 'session'));

/**
 * Pure projection: fleet → { boardSlug: [tileNode, …] }. Only LIVE, non-done sessions become
 * tiles (decay). Each tile is a top-level node the collector owns.
 */
export function projectTiles({ jobs, sessions }, now = Date.now(), { liveMs = LIVE_MS } = {}) {
  const byBoard = {};
  const dropped = [];
  for (const job of jobs) {
    try {
      const s = sessions[job.sessionId] || {};
      const beat = s.statusUpdatedAt || Date.parse(job.updatedAt || '') || 0;
      const live = (now - beat) < liveMs;
      if (job.state === 'done' || !live) { dropped.push(job); continue; }   // decay: dead or settled
      const status = job.state === 'blocked' ? 'waiting' : 'in_progress';   // working → in_progress
      const prs = (job.children || []).filter(c => c.kind === 'pr').length;
      let note = (job.needs || job.detail || '').toString().replace(/\s+/g, ' ').trim();
      if (prs) note = (note ? note + ' ' : '') + `(${prs} PR${prs === 1 ? '' : 's'})`;
      const node = {
        id: 's-' + shortId(job),
        name: String(job.name || job.intent || 'session').slice(0, 120),
        // seen = the session's own heartbeat, NOT now — so an idle poll yields byte-identical
        // tiles and syncManaged skips the write (no per-poll file churn / SSE spam).
        weight: 1, status, note, seen: beat || now, origin: ORIGIN, sessionId: job.sessionId,
      };
      (byBoard[routeBoard(job)] ||= []).push(node);
    } catch { dropped.push(job); }   // one malformed job must never abort the whole poll
  }
  return { byBoard, dropped };
}

/**
 * Reconcile the projection onto boards through the engine. Owns only origin:'session' nodes on
 * every board it touches; rebuilds `home` as includes of the boards that currently have tiles.
 */
export async function runCollector({ engine, ccDir, fleet, now = Date.now(), log = () => {} }) {
  const { byBoard, dropped } = projectTiles(fleet || readFleet(ccDir), now);
  const desired = Object.keys(byBoard);

  // union of boards that currently exist and boards we now want tiles on — so a board that lost
  // all its live sessions gets its session tiles cleared (syncManaged with []).
  const existing = (await engine.listSlugs()).filter(s => !SKIP_BOARDS.has(s));
  const touch = [...new Set([...existing, ...desired])].filter(s => !SKIP_BOARDS.has(s));

  let boardsWithTiles = [];
  let changed = 0;                                        // count real mutations, so the caller only broadcasts on change
  for (const slug of touch) {
    const nodes = byBoard[slug] || [];
    const r = await engine.syncManaged(slug, ORIGIN, nodes);
    if (r.error) { log(`collect: ${slug} skipped (${r.error})`); continue; }
    changed += (r.added + r.updated + r.removed);
    if (nodes.length) boardsWithTiles.push(slug);
  }

  // home = one include per board that currently has session tiles (alphabetical, stable order)
  const includes = boardsWithTiles.sort().map(slug => ({
    id: slug, name: humanize(slug), weight: 1, include: slug,
  }));
  const rh = await engine.syncManaged('home', ORIGIN, includes);
  if (!rh.error) changed += (rh.added + rh.updated + rh.removed);

  const total = includes.reduce((n, i) => n + (byBoard[i.id]?.length || 0), 0);
  if (changed) log(`collect: ${total} live tiles across ${includes.length} board(s); dropped ${dropped.length} (done/dead)`);
  return { boards: boardsWithTiles.length, tiles: total, dropped: dropped.length, changed };
}
