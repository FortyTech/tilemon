---
name: tilemon
description: Report task/agent status to a TileMon priority board (todo/in_progress/waiting/blocked/done) so it shows live on the always-on board, and bootstrap boards for a project. Use when you start, need the human, block on a problem, or finish a tracked task, or when asked to set up TileMon for a project. Requires a running TileMon server (npx tilemon).
---

# TileMon — report status to the board

TileMon is an **attention-management tool, not a project tracker**: a zero-sum treemap that answers
one question for the human — *what are my agents waiting on me for?* Importance is on-screen area,
the human owns the weights, and **agents set status**. The "needs-you" states glow — `waiting`
(needs your input) amber, `blocked` (something's wrong) louder red; `in_progress` is a calm signal
(an agent's working, no attention needed). Your entire integration
is **one HTTP POST**, and it **upserts** (creates the board and any missing nodes on first write),
so you can register your own work as you go — but keep it coarse (see below); noise defeats the tool.

**It is a shared, long-running board — not this session's state.** The board runs as its own
server (often started detached with `--daemon`, so it outlives any single session) and is written
to by **many agents over time**: future sessions, agents on other projects, and unattended or
scheduled ones — often at the same time. You are just one of those clients. So:
- Your job is narrow: report the status of **your own** tracked tasks, by stable `path`. You are
  **not** the board's owner or bookkeeper, and you are **not** tracking the other agents' work.
- Don't try to hold the whole board in your head, poll it to "monitor" everything, or keep your
  session alive to watch it. When you've reported, you can move on — the server persists and other
  agents keep updating their own tiles. The **human** watches the board; agents just report into it.
- Address by stable `board`+`path` so a *different* agent (or a later session) that resumes the
  same task lands on the same tile instead of creating a duplicate.

## Reporting status (the core — this is 95% of it)

1. **Find the board.** Use `$TILEMON_URL`, else `http://localhost:4000`. If nothing answers,
   start it detached with `npx tilemon --daemon` (it outlives your session; `--stop` kills it),
   wait for it to come up, then proceed. **Never read TileMon's own source to work out how to run
   it** — this skill is the complete manual; treat the server as a black box behind the API.
   (TileMon may itself be one of the projects on the board — that's fine; just don't crack open
   its implementation to operate it.)
2. **Address your work.** Find your `board` *with certainty* — don't guess from the folder name and
   never invent a new board: resolve it from the folder you're working in —
   `GET /api/resolve?dir=<abs cwd>` → `{board}` (matches the board whose `dir` is the longest prefix
   of your path). If it 404s, this folder isn't tracked — leave it, don't create one. `path` = a
   stable, dotted id for your task within that board, e.g. `api.refactor-auth`. **Reuse the same
   board + path across a task's whole life** so a reconnecting agent lands back on the same tile.
3. **POST it.** `status` ∈ `todo | in_progress | waiting | blocked | done`. Include a `note` — your
   message (what you're doing / what you need); it shows in the tile's hover actions.
   ```bash
   curl -s -X POST "$TILEMON_URL/api/status" \
     -H 'content-type: application/json' \
     -d '{"board":"webapp","path":"api.refactor-auth","status":"waiting","note":"which auth provider do you want — Clerk or Auth0?"}'
   ```
   Add `-H "Authorization: Bearer $TILEMON_TOKEN"` if the server requires a token.
   From inside the tilemon repo: `node examples/flag.mjs <board> <dotted.id.path> <status> "<note>"`.
4. **When to fire:** *start* → `in_progress`; *finish* → `done` (drops off). When you **need the
   human**, pick the level by severity: `waiting` = you need their input/decision/answer/approval and
   nothing is broken (glows amber — present, not urgent); `blocked` = something is *wrong* — an error,
   a failing build, an obstacle you can't get past (glows red **and pulses**, louder). Always attach a
   `note` saying exactly what you need. A `{"ok":true}` response means it's live.

You can only ever set **status/note**, on any node, via this endpoint — never weights or
structure. The human owns importance. That's why one board-wide token is safe: it can't
reshuffle priorities, only flag and (via upsert) add.

## Attention rules (attention.md) — push what needs the human

The human may keep **attention rules** in `~/.tilemon/attention.md` (operator-side, free text):
what should grab their attention and how it maps to status. The rules are theirs, not the board's;
per-board/node rules appear as targeted sections (`# board: <slug>`, `# node: <board>.<path>`).

Honour them by **sending updates to TileMon** — `POST /api/status` is the whole interface. When
active in a project, read its `attention.md` rules (the global ones + this board's section) and
**push status as you see fit** — flag `blocked` the instant you hit something a rule cares about, mark
things `done`, surface anything the human asked to see. The rules are prose precisely so you can apply
judgment, and you evaluate them with **your own tools** (rule about git → run git; about logs → read
them). TileMon prescribes no mechanism and ships no rule-specific tooling.

**Flagging is automatic — NEVER ask the human whether to set a status. Just set it.** Status is the
one surface you own outright (it's reversible, and it can't touch weights or structure), which is
exactly why it's safe to write without permission. Asking "want me to flag this?" defeats the entire
point of the board — it's meant to reflect reality *without* the human tending it. So: if a rule
matches, flag it silently; if it doesn't, leave it. Never a question. (Weights and structure are the
opposite — those are the human's; never touch *those* without them. Status is always yours.)

**Only flag what's in your working scope** — the repo/project you're actually operating in. Don't roam
into other repos to check them, and don't flag a repo you're not working in (a session working *there*,
or a scheduled sweep, catches it). In-scope → flag automatically; out-of-scope → leave it, no comment.

How those pushes get generated is the operator's choice — you doing it live as you work, a `Stop` hook
when you pause, CI, a scheduled job, whatever suits them — all of it just `POST`s status. The natural
default is to push from where the work is happening; the only constant is that updates are *sent to*
TileMon (it's a receiver — it never reaches out).

## Addressing convention: a board per project, grouped into buckets

- **Each project is its own board** (slug = its repo/project name). Agents working a project
  report to *that* board.
- The human's **master board `include`s the project boards**, so the whole portfolio is one
  glanceable view with heat rolling up.
- Projects are **bucketed into weighted groups** on the master (e.g. `Products`, `Clients`,
  `Internal`) — a group tile that contains the project includes. Bucket weight = its importance
  (its size on screen).

## One board across many repos (same machine)

A board can span **multiple repos/workspaces on one machine** — you just run a single shared server
instead of one per project:

- **Run one server on the default machine-wide board** — `npx tilemon --daemon` serves `~/.tilemon`,
  which is the default. Every agent, in *any* local repo, already targets `http://localhost:4000`, so
  they all report into that one board. Don't start a second server (and don't use `--project`, which
  scopes a board to a single repo) — everything converges on `~/.tilemon`.
- **When setting up, survey every root the human names** (e.g. `~/work`, `~/side-projects`),
  not just the current directory — a board per project across all of them. A **bucket per workspace**
  is usually the natural top level.
- **Different machines can't share a `localhost` board** — that needs a hosted TileMon (not yet
  built). For now, one machine = one shared local board; treat cross-machine as out of scope and say so.

## Bootstrapping a project (setup)

When asked to **set up TileMon for a project/workspace**, structure and importance are the
human's to decide — but don't make them author it cold. Run a **propose-first dialogue**: you
draft, they react. Reacting to a wrong draft is far easier than answering "how do you want to
group these?" from nothing.

**Run setup as a WIZARD with two mandatory gates.** At each gate you present, then **STOP — end your
turn and wait for the human's reply.** Do not blow through a gate: don't build structure before Gate 1
is answered, and don't consider setup finished before Gate 2 is answered. These aren't "invite
corrections and keep going" — they are hard pauses. (Conversational prose is fine; you don't need the
multiple-choice widget.) The gates: **(1) the buckets, (2) what should get their attention.**

The loop:

0. **Ensure the board is running** (see step 1 of "Reporting status" — `npx tilemon --daemon` if
   nothing answers on `:4000`). Setup builds *through the live API*, so the server must be up
   first; do this before surveying so you're never blocked halfway.
1. **Survey the workspace and mine every grouping signal** so the first draft is ~80% right and
   the human is *editing*, not authoring. In priority order: an explicit tag (a manifest `group:`
   field), then directory structure (nested folders → nested groups), then a categorised doc
   (e.g. a project index in a `CLAUDE.md`). Survey the *workspace's own* signals — never TileMon's
   source. **Do NOT guess weights** — importance is the human's (see below).
2. **GATE 1 — buckets.** Present your proposed grouping as a **table, one bucket per row** (rows, not
   columns — there can be many buckets, and a column each would squash them):

   | Bucket | Projects |
   |---|---|
   | Products | webapp, api, mobile |
   | Clients  | acme, globex |
   | Internal | docs, scripts |

   Propose the **grouping only** (which projects sit in which bucket) — not sizes/weights. Then
   **STOP and wait.** Build **nothing** until the human has confirmed or corrected the table. This is
   a real pause, not a rhetorical "let me know."

**Keep the surface coarse — this is the cardinal rule.** Bootstrap builds *structure* (buckets +
project boards), **not a task list**. Do NOT seed granular tasks/tickets — that makes the board
busy and *costs* the human attention, which is the one thing the tool exists to protect. Detail
belongs in drill-down and arrives naturally as agents flag their live work. If the board ever feels
busy, the fix is to *subtract*, not add.
3. **Only after Gate 1 is answered, build it** through the server's API (below), not by writing
   files. The server live-reloads, so the human watches the board fill in as you go.

**Weight/importance is the human's — do NOT set it.** Build everything at the default (equal)
weight and leave allocation to the human, who spends the importance budget by dragging tiles.
That's the whole premise: importance is theirs to assign, not yours to guess. The *only* time you
set a weight is when the human **explicitly tells you** one ("make Products the biggest") — then
you're just their hands (`POST /api/weight`); otherwise never touch it.

**Build it with the structure API — never hand-author the JSON.** Structure is human-owned and
can't be created via `POST /api/status`; use the admin routes instead. The order is: create the
project boards, make the buckets on the home board, then include the boards into their buckets.
New nodes are born at weight 1 (equal), which is exactly the neutral starting point you want.

```bash
U=${TILEMON_URL:-http://localhost:4000}
# 1. a board per project (bare; returns its slug). ALWAYS pass `dir` = the project's absolute folder —
#    that's the folder↔board link. It lets any agent later resolve "which board is this folder?" with
#    certainty (GET /api/resolve), instead of guessing a slug or inventing a duplicate board.
curl -s -X POST $U/api/board -d '{"name":"Webapp","slug":"webapp","dir":"/home/you/work/webapp"}'   # -> {"slug":"webapp"}
curl -s -X POST $U/api/board -d '{"name":"API","slug":"api","dir":"/home/you/work/api"}'
# 2. buckets on the home board (a bucket is just an item you add into); "tilemon" is the seeded home board
curl -s -X POST $U/api/node  -d '{"board":"tilemon","kind":"item","name":"Products"}'   # -> node id "products"
# 3. include the EXISTING project boards into the bucket (born at weight 1 — DON'T set weights)
curl -s -X POST $U/api/node  -d '{"board":"tilemon","path":"products","kind":"include","target":"webapp"}'
curl -s -X POST $U/api/node  -d '{"board":"tilemon","path":"products","kind":"include","target":"api"}'
# then: leave weights equal. The human drags to allocate importance. Reorganise later with /api/move.
# (Set dir on an existing board later with: PATCH /api/board {"slug":"webapp","dir":"..."} )
```

Node ids are derived from the name/slug (e.g. bucket "Products" → `products`, an include of
`webapp` → `webapp`), so address children as `products.webapp`. Re-running reconciles: `GET
/api/state?board=tilemon` first, respect what's already placed and its weights, and only add
what's missing — never overwrite the human's arrangement.

This dialogue is the **cold-start** path — bulk-shaping many things from nothing, where
reacting-to-a-draft beats dragging tiles. Ongoing maintenance is different: reweight by dragging
in the UI, and move/regroup via `/api/move`. Ongoing *status* updates use `POST /api/status`
(above); only the initial structure is built here — and only ever through the API.

### GATE 2 — ask what should get their attention (write attention.md)

The board only earns its keep once it knows what deserves *their* attention, so this is a **mandatory
gate**, not an optional afterthought: after the structure's built, **STOP and directly ask** the human
what they want surfaced, offering a few concrete examples to react to — then **wait for their answer**
before you finish. **Setup is NOT complete until you've asked and recorded a reply** (even if the reply
is "none for now"). Never leave `attention.md` blank because you skipped the question. Same rule as
weights: you **elicit and record, you never impose or guess**.

First, name the part that's automatic and needs no rule: **an agent that needs the human already flags
it** — `waiting` for a decision/input, `blocked` when something's wrong. Then present this **curated
list as a menu to pick from** (they choose which apply, edit wording, or add their own) — these are the
candidate lines that go into `~/.tilemon/attention.md`:

| Candidate attention rule | Flags as |
|---|---|
| Uncommitted or committed-but-unpushed work in a repo | `waiting` |
| Failing tests / a red CI run | `blocked` |
| An open PR awaiting your review (or yours blocked on changes) | `waiting` |
| Any obvious security issue (e.g. a vulnerable dependency) | `blocked` |
| An urgent item from a connected tool (email / Slack / tickets) | `waiting` |

Then **also ask, in plain free text, whether anything is specific to particular repos or areas** — e.g.
*"Is there anything special you'd want flagged for specific projects — something one repo needs watching
for that the others don't?"* Record those under a `# board: <slug>` section.

A rule is only useful if an agent can actually *check* it — bounded by the tools in its context (git is
always there; PRs/CI need `gh`/CI access; email needs an MCP), so treat the menu as candidates, not
guarantees. Write the chosen rules into `~/.tilemon/attention.md`. If they genuinely want none yet,
leave the template — but you must have *asked* (Gate 2).

### Then install the Stop hook (core plumbing, opt-out)

The board staying current depends on this, so **install it by default as part of setup** — it's core
plumbing, not an optional extra. **Don't ask a yes/no**: add it, then tell the human you did and how to
opt out (delete the `Stop` entry from `.claude/settings.json`). Only skip it if they told you not to.
It's a Claude Code `Stop` hook that fires when the agent pauses for input and nudges that agent — once —
to apply `attention.md` and push updates before stopping. Claude-Code-specific; other setups push
however they push.

Write `.claude/hooks/tilemon-stop.mjs` in the project (Node, no extra deps). It **resolves this folder
to its board** (`GET /api/resolve` — folder → board via the `dir` link) so the agent flags the right
tile and never invents one, then injects the operator's LIVE `attention.md` rules and demands a
per-rule check. It stays silent (no block) if the folder isn't tracked or the board's unreachable —
nothing to flag. It computes nothing and hard-codes no rule (evaluation is the agent's job):
```js
#!/usr/bin/env node
// TileMon Stop hook — resolve folder→board, inject live attention.md rules, demand a per-rule check.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
let s = ''; process.stdin.on('data', c => (s += c)).on('end', async () => {
  try { if (JSON.parse(s).stop_hook_active === true) process.exit(0); } catch {}   // already nudged this turn → let it stop
  const url = process.env.TILEMON_URL || 'http://localhost:4000';
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let board = null;
  try {
    const r = await fetch(`${url}/api/resolve?dir=${encodeURIComponent(cwd)}`);
    if (r.status === 404) process.exit(0);            // folder not tracked → stay quiet
    if (r.ok) board = (await r.json()).board;
  } catch { process.exit(0); }                         // board unreachable → don't block
  if (!board) process.exit(0);
  let rules = '';
  try { rules = readFileSync(join(homedir(), '.tilemon', 'attention.md'), 'utf8')
    .split('\n').filter(l => l.trim() && !l.trim().startsWith('#')).join('\n').trim(); } catch {}
  const reason = `[TileMon hook] This folder is TileMon board '${board}' — flag THAT board, never create a new one. `
    + `Before you stop: if you're pausing because you need the human, flag 'waiting' (need a decision/input) or 'blocked' (something's wrong) with a note, via the tilemon skill (POST /api/status to ${url}).`
    + (rules ? ` Then check EACH of these attention rules against what you're working on and flag any that match (one by one, don't skip):\n${rules}\n` : ` `)
    + `If nothing matches, just stop.`;
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
});
```
Then **create or merge** `.claude/settings.json` (Stop hooks take no matcher):
```json
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/tilemon-stop.mjs\"" } ] } ] } }
```
The `stop_hook_active` guard makes it block only once per turn, so it can't loop. TileMon ships none
of this — it's written into *your* project at setup; the hook only ever triggers a `POST /api/status`.

## Activation note

This skill is passive — it tells you *how*, not *when*. To make reporting routine, the project's
own agent instructions should say something like: "when you block on or finish a board-tracked
task, flag it via the tilemon skill."
