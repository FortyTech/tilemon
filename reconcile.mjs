// TileMon reconcile — the attention.md executor (the roadmap's "user-defined attention rules").
//
// Run as a Stop hook (or by hand), it reads the operator's attention.md (the status DEFINITIONS +
// any rules), gathers ground-truth facts (git/gh) and the recent conversation, and asks a SEALED,
// tool-less `claude -p` to decide which tiles should change. The judge has NO tools; THIS module does
// the gathering and the posting — so the worst a bad/hostile judgment can do is set a wrong tile
// (reversible), never run a shell. Non-blocking and near-silent: prints one line only when it actually
// changed something. Keeps the core server dumb — all the "smarts" live here, behind one subcommand.
//
//   Stop hook (any repo):  "$CLAUDE_PROJECT_DIR" Stop -> `npx tilemon reconcile`  (hook JSON on stdin)
//   flags: --dry-run (decide + print, post nothing) · --model <id> · --board <slug>
//   env:   TILEMON_RECONCILE_MODEL (default haiku) · TILEMON_RECONCILE_TIMEOUT_MS (default 90000)

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

  const input = readStdinJson();                 // the Stop-hook payload, when piped
  if (input.stop_hook_active === true) return 0;  // already nudged this turn
  const cwd = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();

  // Resolve the board for this folder (unless one was named). Silent bail if untracked or server down.
  let board = opts.board;
  if (!board) {
    try {
      const r = await fetch(`${CLIENT_BASE}/api/resolve?dir=${encodeURIComponent(cwd)}`);
      if (r.status === 404) return 0;
      if (r.ok) board = (await r.json()).board;
    } catch { return 0; }
  }
  if (!board) return 0;

  const rules = readFileSafe(join(BOARDS, 'attention.md'));
  const facts = gatherFacts(cwd);
  const convo = transcriptTail(input.transcript_path, contextChars);
  const prompt = buildPrompt(board, rules, facts, convo);

  const res = spawnSync('claude', ['-p', '--model', model], {
    input: prompt, cwd, encoding: 'utf8', timeout, maxBuffer: 1 << 20,
    env: { ...process.env, TILEMON_RECONCILER: '1' },
  });
  const decisions = parseDecisions(res.stdout);

  if (dry) {
    if (res.error) process.stderr.write(`reconcile: judge did not run (${res.error.message}; is the \`claude\` CLI installed?)\n`);
    process.stdout.write(JSON.stringify({ board, cwd, decisions }, null, 2) + '\n');
    return 0;
  }

  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = 'Bearer ' + TOKEN;
  const changed = [];
  for (const d of decisions) {
    if (!d || typeof d.path !== 'string' || !STATUSES.includes(d.status)) continue;
    try {
      const r = await fetch(`${CLIENT_BASE}/api/status`, {
        method: 'POST', headers,
        body: JSON.stringify({ board, path: d.path, status: d.status, note: d.note || '', name: d.name || undefined }),
      });
      if (r.ok) changed.push(`${d.path}→${d.status}`);
    } catch { /* skip this tile; the rest still post */ }
  }
  // Report ONLY the result, and only when something changed. systemMessage = a brief, non-blocking note.
  if (changed.length) process.stdout.write(JSON.stringify({ systemMessage: `[tilemon] ${changed.join(', ')}` }));
  return 0;
}

// ---- helpers ------------------------------------------------------------------------------------

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

function buildPrompt(board, rules, facts, convo) {
  return `You are the TileMon reconciliation judge for board '${board}'. You have NO tools — you only read
what is below and OUTPUT a decision. Do not attempt to run anything.

ATTENTION RULES & STATUS DEFINITIONS (operator-owned — the bar each status must meet):
${rules || '(none configured)'}

GROUND-TRUTH FACTS (gathered for you):
${facts}

RECENT CONVERSATION (the main agent has just handed back to the human):
<<<CONVO
${convo || '(none)'}
CONVO

Decide which tiles on board '${board}' should change RIGHT NOW to reflect what needs the human. Weigh
(1) the rules/definitions against the facts, and (2) whether the conversation shows the main agent is
now waiting on the human for a decision, input, or review. Respect the status definitions exactly —
especially the bar for 'done'. Be coarse and conservative: only surface what genuinely needs their
attention; noise defeats the board. Consider only THIS project.

Output ONLY a JSON array, no prose. Each element: {"path","status","note","name"} where status is one
of ${STATUSES.join('|')}. Use stable dotted paths (e.g. "git" for the repo's git state) so tiles update
rather than duplicate. Output [] if nothing should change.`;
}
