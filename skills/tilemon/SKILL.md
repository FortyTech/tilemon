---
name: tilemon
description: Report task/agent status to a TileMon priority board (todo/in_progress/blocked/done) so it shows live on the always-on board, and bootstrap boards for a project. Use when you start, block on, or finish a tracked task, or when asked to set up TileMon for a project. Requires a running TileMon server (npx tilemon).
---

# TileMon — report status to the board

TileMon is a zero-sum treemap priority board: importance is on-screen area, the human owns the
weights, and **agents set status**. Blocked work glows. Your entire integration is **one HTTP
POST**, and it **upserts** (creates the board and any missing nodes on first write), so you can
register your own work as you go.

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
2. **Address your work.** `board` = the project's slug (usually the repo/project name).
   `path` = a stable, dotted id for your task within that board, e.g. `api.refactor-auth`.
   **Reuse the same board + path across a task's whole life** — that's how a reconnecting agent
   lands back on the same tile. Address by id, never by display name.
3. **POST it.** `status` ∈ `todo | in_progress | blocked | done`. Include a `note` — your message
   (what you're doing / stuck on); it shows in the tile's hover actions.
   ```bash
   curl -s -X POST "$TILEMON_URL/api/status" \
     -H 'content-type: application/json' \
     -d '{"board":"webapp","path":"api.refactor-auth","status":"blocked","note":"need the staging DB password"}'
   ```
   Add `-H "Authorization: Bearer $TILEMON_TOKEN"` if the server requires a token.
   From inside the tilemon repo: `node examples/flag.mjs <board> <dotted.id.path> <status> "<note>"`.
4. **When to fire:** you *start* a tracked task → `in_progress`; you're *blocked* (need a
   decision, a key, an upstream fix) → `blocked` (this glows and pulls the human in); you
   *finish* → `done` (it drops off the board). A `{"ok":true}` response means it's live.

You can only ever set **status/note**, on any node, via this endpoint — never weights or
structure. The human owns importance. That's why one board-wide token is safe: it can't
reshuffle priorities, only flag and (via upsert) add.

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
- **When setting up, survey every root the human names** (e.g. `~/forty-workspace`, `~/doefin-local`),
  not just the current directory — a board per project across all of them. A **bucket per workspace**
  is usually the natural top level.
- **Different machines can't share a `localhost` board** — that needs a hosted TileMon (not yet
  built). For now, one machine = one shared local board; treat cross-machine as out of scope and say so.

## Bootstrapping a project (setup)

When asked to **set up TileMon for a project/workspace**, structure and importance are the
human's to decide — but don't make them author it cold. Run a **propose-first dialogue**: you
draft, they react. Reacting to a wrong draft is far easier than answering "how do you want to
group these?" from nothing.

The loop:

0. **Ensure the board is running** (see step 1 of "Reporting status" — `npx tilemon --daemon` if
   nothing answers on `:4000`). Setup builds *through the live API*, so the server must be up
   first; do this before surveying so you're never blocked halfway.
1. **Survey the workspace and mine every grouping signal** so the first draft is ~80% right and
   the human is *editing*, not authoring. In priority order: an explicit tag (a manifest `group:`
   field), then directory structure (nested folders → nested groups), then a categorised doc
   (e.g. a project index in a `CLAUDE.md`). Survey the *workspace's own* signals — never TileMon's
   source. For a first-cut at **weight**, lean on activity/recency — but say you've done so; it's
   a guess for them to correct.
2. **Propose a concrete strawman in prose, and invite free-text corrections** ("move X, split Y,
   drop Z") — a board per project grouped into a few named, weighted buckets. Reacting to a
   written draft is lower-friction than multiple-choice prompts, so prefer it; reserve a formal
   question for a *genuine* either/or blocker, not for things you can just propose a default for.
3. **React → redraft → confirm.** Once agreed, build it **through the server's API** (below), not
   by writing files. The server live-reloads, so the human watches the board fill in as you go.

**Build it with the structure API — never hand-author the JSON.** Structure is human-owned and
can't be created via `POST /api/status`; use the admin routes instead. The order is: create the
project boards, make the buckets on the home board, then include the boards into their buckets,
then set weights.

```bash
U=${TILEMON_URL:-http://localhost:4000}
# 1. a board per project (bare; returns its slug)
curl -s -X POST $U/api/board -d '{"name":"Chessku","slug":"chessku"}'          # -> {"slug":"chessku"}
curl -s -X POST $U/api/board -d '{"name":"EulogySong","slug":"eulogy-song"}'
# 2. buckets on the home board (a bucket is just an item you add into); "tilemon" is the seeded home board
curl -s -X POST $U/api/node  -d '{"board":"tilemon","kind":"item","name":"Products"}'   # -> node id "products"
# 3. include the EXISTING project boards into the bucket
curl -s -X POST $U/api/node  -d '{"board":"tilemon","path":"products","kind":"include","target":"chessku"}'
curl -s -X POST $U/api/node  -d '{"board":"tilemon","path":"products","kind":"include","target":"eulogy-song"}'
# 4. weight the bucket (importance = size); reorganise later with /api/move
curl -s -X POST $U/api/weight -d '{"board":"tilemon","path":"products","weight":3}'
```

Node ids are derived from the name/slug (e.g. bucket "Products" → `products`, an include of
`chessku` → `chessku`), so address children as `products.chessku`. Re-running reconciles: `GET
/api/state?board=tilemon` first, respect what's already placed and its weights, and only add
what's missing — never overwrite the human's arrangement.

This dialogue is the **cold-start** path — bulk-shaping many things from nothing, where
reacting-to-a-draft beats dragging tiles. Ongoing maintenance is different: reweight by dragging
in the UI, and move/regroup via `/api/move`. Ongoing *status* updates use `POST /api/status`
(above); only the initial structure is built here — and only ever through the API.

## Activation note

This skill is passive — it tells you *how*, not *when*. To make reporting routine, the project's
own agent instructions should say something like: "when you block on or finish a board-tracked
task, flag it via the tilemon skill."
