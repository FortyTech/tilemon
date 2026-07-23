// TileMon reconcile — the attention.md executor (the roadmap's "user-defined attention rules").
//
// Run as a Stop hook (or by hand), it reads the operator's attention.md (the status DEFINITIONS +
// any rules), gathers ground-truth facts (git/gh) and the recent conversation, and asks a SEALED,
// tool-less `claude -p` to decide which tiles should change. The judge has NO tools; THIS module does
// the gathering and the posting — so the worst a bad/hostile judgment can do is set a wrong tile
// (reversible), never run a shell. Non-blocking and near-silent: prints one line only when it actually
// changed something. Keeps the core server dumb — all the "smarts" live here, behind one subcommand.
//
// ROUTING (docs/reconcile-routing.md): a session at the workspace root must NOT dump every tile onto
// the root board. The one hard rule is "decide solely from THIS session's transcript" — the only
// per-session record of what this session did, and therefore the boundary that makes concurrency safe
// (session A can't write board B unless A's own transcript concerns B). Within that boundary we route
// by marrying the transcript to the live board+tile INVENTORY: match existing tiles to update in place
// (dedup), use file-path edits as a confidence HINT (never a gate — pending-decision tiles change no
// files), and park a genuinely unmatched tile on the HOME board's root with an alert so the human can
// bucket it. No board is ever auto-created; structure stays the human's.
//
//   Stop hook (any repo):  "$CLAUDE_PROJECT_DIR" Stop -> `npx tilemon reconcile`  (hook JSON on stdin)
//   flags: --dry-run (decide + print, post nothing) · --model <id> · --board <slug> (force single board)
//   env:   TILEMON_RECONCILE_MODEL (default haiku) · TILEMON_RECONCILE_TIMEOUT_MS (default 90000)
//          TILEMON_HOME_BOARD (default "home") · TILEMON_RECONCILE_MAX_BOARDS (default 6)

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const STATUSES = ['todo', 'in_progress', 'waiting', 'blocked', 'done'];

export async function reconcile({ BOARDS, CLIENT_BASE, TOKEN, argv = [] }) {
  // Recursion guard: the judge is a `claude -p` running in this same repo, which re-fires the Stop
  // hook → `tilemon reconcile` again. This env flag (set when we spawn it) makes that nested call a no-op.
  if (process.env.TILEMON_RECONCILER) return 0;

  const opts = parseFlags(argv);
  const dry = !!(opts['dry-run'] || opts.dry);
  const model = opts.model || process.env.TILEMON_RECONCILE_MODEL || 'claude-haiku-4-5-20251001';
  const timeout = Number(process.env.TILEMON_RECONCILE_TIMEOUT_MS || 90000);
  const contextChars = Number(process.env.TILEMON_RECONCILE_CONTEXT_CHARS || 16000);
  const homeSlug = process.env.TILEMON_HOME_BOARD || 'home';
  const maxBoards = Number(process.env.TILEMON_RECONCILE_MAX_BOARDS || 6);

  const input = readStdinJson();                 // the Stop-hook payload, when piped
  if (input.stop_hook_active === true) return 0;  // already nudged this turn
  const cwd = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();

  // Board this folder maps to (the fallback target + always in scope). Silent bail if server down.
  const cwdBoard = opts.board || await resolveBoard(CLIENT_BASE, cwd);

  // The live inventory: every board (as a routing target) + its existing tiles (to match/dedup).
  // Read-only reference context — reading it can't make us act on another session's work.
  const inv = await fetchInventory(CLIENT_BASE);

  // --board forces the old single-board behaviour (manual runs); otherwise route from the transcript.
  let scopeBoards, hintBoards;
  if (opts.board) {
    scopeBoards = [opts.board];
    hintBoards = new Set([opts.board]);
  } else {
    // The file-path HINT: boards this session edited files in (confidence signal, not a filter).
    hintBoards = await touchedBoards(CLIENT_BASE, input.transcript_path);
    // Scope the judge to: boards edited this session, the cwd board, and the home board (park target).
    scopeBoards = uniq([...hintBoards, cwdBoard, homeSlug].filter(Boolean)).slice(0, maxBoards);
  }
  if (!scopeBoards.length) return 0;   // untracked folder, server down, nothing to do

  const rules = readFileSafe(join(BOARDS, 'attention.md'));
  const convo = transcriptTail(input.transcript_path, contextChars);
  // git/gh facts ONLY for boards THIS session actually touched (hint ∪ cwd) — never the home board just
  // because it's the always-in-scope park target. Reading a board's shared git state when the session
  // never touched it is the cross-session leak the spec forbids; home is often dir-linked, so exclude it.
  const factBoards = uniq([...hintBoards, cwdBoard].filter(Boolean));
  const factsByBoard = {};
  for (const slug of factBoards) {
    const dir = inv.dirBySlug[slug] || (slug === cwdBoard ? cwd : null);
    if (dir) factsByBoard[slug] = gatherFacts(dir);
  }

  const knownSlugs = new Set(inv.boards.map(b => b.slug));
  const prompt = buildPrompt({ scopeBoards, hintBoards, homeSlug, rules, factsByBoard, convo, inv });

  const res = spawnSync('claude', ['-p', '--model', model], {
    input: prompt, cwd, encoding: 'utf8', timeout, maxBuffer: 1 << 20,
    env: { ...process.env, TILEMON_RECONCILER: '1' },
  });
  const decisions = parseDecisions(res.stdout);

  if (dry) {
    if (res.error) process.stderr.write(`reconcile: judge did not run (${res.error.message}; is the \`claude\` CLI installed?)\n`);
    process.stdout.write(JSON.stringify({ scopeBoards, hintBoards: [...hintBoards], decisions }, null, 2) + '\n');
    return 0;
  }

  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = 'Bearer ' + TOKEN;
  const changed = [];
  const parked = [];   // new tiles landed on the home root → tell the human to bucket them
  for (const d of decisions) {
    if (!d || typeof d.path !== 'string' || !STATUSES.includes(d.status)) continue;
    const b = typeof d.board === 'string' && d.board ? d.board : cwdBoard;
    // Safety gate: only ever write a board that actually exists (or the home board). A hallucinated
    // slug can't be created here — structure is the human's.
    if (!knownSlugs.has(b) && b !== homeSlug) continue;
    try {
      const r = await fetch(`${CLIENT_BASE}/api/status`, {
        method: 'POST', headers,
        body: JSON.stringify({ board: b, path: d.path, status: d.status, note: d.note || '', name: d.name || undefined }),
      });
      if (r.ok) {
        changed.push(`${b}/${d.path}→${d.status}`);
        // Parked-on-root = a NEW top-level tile on the home board (no existing match). That's the
        // "no board fit this" signal → alert once so the human can create a bucket and move it.
        const existing = new Set((inv.tilesBySlug[homeSlug] || []).map(t => t.path));
        if (b === homeSlug && !d.path.includes('.') && !existing.has(d.path)) {
          parked.push(d.name || d.path);
        }
      }
    } catch { /* skip this tile; the rest still post */ }
  }

  // Report ONLY the result, and only when something changed. systemMessage = a brief, non-blocking note.
  if (changed.length || parked.length) {
    const bits = [];
    if (changed.length) bits.push(changed.join(', '));
    if (parked.length) bits.push(`⚠ parked on root (no board matched — create a bucket): ${parked.join('; ')}`);
    process.stdout.write(JSON.stringify({ systemMessage: `[tilemon] ${bits.join(' | ')}` }));
  }
  return 0;
}

// ---- routing helpers ----------------------------------------------------------------------------

async function resolveBoard(base, dir) {
  try {
    const r = await fetch(`${base}/api/resolve?dir=${encodeURIComponent(dir)}`);
    if (!r.ok) return '';
    return (await r.json()).board || '';
  } catch { return ''; }
}

// The board+tile INVENTORY: list of boards (with dirs) and each board's existing tiles (path/name/
// status). Used by the judge to match-and-update rather than duplicate, and to know valid targets.
async function fetchInventory(base) {
  const out = { boards: [], dirBySlug: {}, tilesBySlug: {} };
  let list = [];
  try {
    const r = await fetch(`${base}/api/boards`);
    if (r.ok) { const j = await r.json(); if (Array.isArray(j)) list = j; }   // 200-but-not-an-array can't throw the map below
  } catch { return out; }
  out.boards = list.map(b => ({ slug: b.slug, dir: b.dir, items: b.items }));
  for (const b of out.boards) if (b.dir) out.dirBySlug[b.slug] = b.dir;
  // Pull tiles only for boards that actually have any (keeps the fetch + prompt small).
  for (const b of out.boards) {
    if (!b.items) { out.tilesBySlug[b.slug] = []; continue; }
    try {
      const r = await fetch(`${base}/api/state?board=${encodeURIComponent(b.slug)}`);
      if (!r.ok) { out.tilesBySlug[b.slug] = []; continue; }
      out.tilesBySlug[b.slug] = flattenTiles(await r.json());
    } catch { out.tilesBySlug[b.slug] = []; }
  }
  return out;
}

export function flattenTiles(node, prefix = '', acc = []) {
  for (const c of node.children || []) {
    const path = prefix ? `${prefix}.${c.path || c.id}` : (c.path || c.id);
    if (!path) continue;
    acc.push({ path, name: c.name || path, status: c.status || '' });
    flattenTiles(c, path, acc);
  }
  return acc;
}

// The file-path HINT: parse THIS session's transcript for what it touched, map to boards.
//  - file-editing tools (Edit/Write/Read/NotebookEdit/MultiEdit) → their file_path's board
//  - explicit `tilemon flag <slug>` calls in Bash → that slug directly (strongest signal)
// Returns a Set of board slugs. A hint, never a gate.
export async function touchedBoards(base, transcriptPath) {
  const boards = new Set();
  if (!transcriptPath) return boards;
  let lines;
  try { lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean); } catch { return boards; }
  const dirs = new Set();
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const msg = e.message || e;
    if (!Array.isArray(msg.content)) continue;
    for (const blk of msg.content) {
      if (!blk || blk.type !== 'tool_use' || !blk.input) continue;
      const inp = blk.input;
      const fp = inp.file_path || inp.notebook_path || inp.path;
      if (typeof fp === 'string' && fp.startsWith('/')) dirs.add(dirname(fp));
      if (blk.name === 'Bash' && typeof inp.command === 'string') {
        for (const m of inp.command.matchAll(/\btilemon\s+flag\s+([a-z0-9][a-z0-9-]*)/g)) boards.add(m[1]);
      }
    }
  }
  // Resolve each distinct touched directory to its board.
  for (const dir of dirs) {
    const b = await resolveBoard(base, dir);
    if (b) boards.add(b);
  }
  return boards;
}

// ---- generic helpers (unchanged) ---------------------------------------------------------------

function uniq(a) { return [...new Set(a)]; }

function parseFlags(args) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) continue;
    const k = args[i].slice(2), nxt = args[i + 1];
    if (nxt && !nxt.startsWith('--')) { o[k] = nxt; i++; } else o[k] = true;
  }
  return o;
}

function readStdinJson() {
  try {
    if (process.stdin.isTTY) return {};        // interactive run, nothing piped
    const raw = readFileSync(0, 'utf8');        // fd 0: read the whole hook payload synchronously
    return raw.trim() ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function readFileSafe(path) {
  try { return readFileSync(path, 'utf8').trim(); } catch { return ''; }
}

function sh(cmd, args, cwd, timeout = 5000) {
  try {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 1 << 20 });
    return r.status === 0 ? (r.stdout || '').trim() : '';
  } catch { return ''; }
}

function gatherFacts(cwd) {
  const parts = [];
  const status = sh('git', ['-C', cwd, 'status', '-sb'], cwd);
  if (status) parts.push(`git status:\n${status}`);
  const last = sh('git', ['-C', cwd, 'log', '-1', '--format=%cr — %s'], cwd);
  if (last) parts.push(`last commit: ${last}`);
  const unpushed = sh('git', ['-C', cwd, 'log', '--oneline', '@{u}..'], cwd);
  parts.push(`unpushed commits: ${unpushed ? unpushed.split('\n').length : 0}`);
  const prs = sh('gh', ['pr', 'list', '--state', 'open', '--json', 'number,title,reviewRequests'], cwd, 6000);
  if (prs) parts.push(`open PRs: ${prs}`);
  const runs = sh('gh', ['run', 'list', '--limit', '1', '--json', 'status,conclusion,name'], cwd, 6000);
  if (runs) parts.push(`latest CI: ${runs}`);
  return parts.join('\n') || '(no git/gh facts available)';
}

function transcriptTail(path, maxChars) {
  if (!path) return '';
  let lines;
  try { lines = readFileSync(path, 'utf8').split('\n').filter(Boolean); } catch { return ''; }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.join('\n').length < maxChars; i--) {
    let e; try { e = JSON.parse(lines[i]); } catch { continue; }
    const msg = e.message || e;
    const role = msg.role || e.type;
    if (role !== 'user' && role !== 'assistant') continue;
    let text = '';
    if (typeof msg.content === 'string') text = msg.content;
    else if (Array.isArray(msg.content)) text = msg.content.filter(b => b && b.type === 'text').map(b => b.text).join(' ');
    text = text.trim();
    // Cap each message so the window spans MORE turns: keep the head + tail, drop the middle (the
    // "lost in the middle" effect). Weighted by role — an ASSISTANT message ends with the hand-off/ask
    // (keep the tail); a USER message leads with the instruction and often trails into a pasted blob
    // (keep the head). Small opposite end kept in case (assistant preamble / a user's closing "thoughts?").
    if (text.length > 1500) {
      const [head, tail] = role === 'user' ? [1200, 300] : [300, 1200];
      text = text.slice(0, head) + ' […] ' + text.slice(-tail);
    }
    if (text) out.unshift(`${role}: ${text}`);
  }
  return out.join('\n').slice(-maxChars);
}

function parseDecisions(stdout) {
  if (!stdout) return [];
  let t = stdout.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  if (a === -1 || b === -1 || b < a) return [];
  try { const v = JSON.parse(t.slice(a, b + 1)); return Array.isArray(v) ? v : []; } catch { return []; }
}

// Compact inventory: valid targets + existing tiles to match against. Home marked; empty boards
// listed as bare targets. Tiles capped per board to keep the prompt small.
function inventoryText(inv, homeSlug, scopeBoards) {
  const scope = new Set(scopeBoards);
  const lines = [];
  for (const b of inv.boards) {
    const tiles = inv.tilesBySlug[b.slug] || [];
    const tag = b.slug === homeSlug ? ' [HOME — park unmatched tiles here, top-level]' : (b.dir ? ` [dir: ${b.dir}]` : '');
    const star = scope.has(b.slug) ? '* ' : '  ';   // * = in this session's scope
    if (!tiles.length) { lines.push(`${star}${b.slug}${tag}: (no tiles)`); continue; }
    const shown = tiles.slice(0, 15).map(t => `${t.path}${t.status ? `(${t.status})` : ''}`).join(', ');
    lines.push(`${star}${b.slug}${tag}: ${shown}${tiles.length > 15 ? ` …+${tiles.length - 15}` : ''}`);
  }
  return lines.join('\n');
}

function buildPrompt({ scopeBoards, hintBoards, homeSlug, rules, factsByBoard, convo, inv }) {
  const facts = Object.entries(factsByBoard)
    .map(([slug, f]) => `[${slug}]\n${f}`).join('\n\n') || '(no git/gh facts available)';
  return `You are the TileMon reconciliation judge. You have NO tools — you only read what is below and
OUTPUT a decision. Do not attempt to run anything.

Your job: after the main agent handed back to the human, decide which TILES should change to reflect
what now needs the human — and put each tile on the RIGHT board.

ATTENTION RULES & STATUS DEFINITIONS (operator-owned — the bar each status must meet):
${rules || '(none configured)'}

BOARD INVENTORY (valid targets; '*' = boards this session is scoped to; match EXISTING tiles to update
them in place rather than create duplicates):
${inventoryText(inv, homeSlug, scopeBoards)}

THIS SESSION EDITED FILES IN (a routing hint — higher confidence these boards are in play; NOT a limit):
${[...hintBoards].join(', ') || '(no file edits detected)'}

GROUND-TRUTH FACTS per scoped board (git/gh):
${facts}

RECENT CONVERSATION (decide ONLY from this — it is this session's own record; do not infer other work):
<<<CONVO
${convo || '(none)'}
CONVO

ROUTING RULES:
- Decide solely from THIS conversation. Do not flag work that isn't evidenced here.
- Put each tile on the board it concerns. Prefer UPDATING an existing tile (reuse its exact path) over
  creating a new one. Create a new tile only when the session clearly did work on that board.
- A tile that needs the human but changed no files is STILL valid (a pending decision, a review) — do
  not require a file edit.
- If a genuinely new tile matches NO board (e.g. a project with no board yet), put it on board
  '${homeSlug}' with a top-level path (no dots). It will be flagged to the human to bucket.
- Be coarse and conservative: only surface what genuinely needs their attention; noise defeats the board.
- Respect the status definitions exactly — especially the strict bar for 'done'.

Output ONLY a JSON array, no prose. Each element: {"board","path","status","note","name"} where board is
a slug from the inventory and status is one of ${STATUSES.join('|')}. Use stable dotted paths (e.g. "git"
for a repo's git state) so tiles update rather than duplicate. Output [] if nothing should change.`;
}
