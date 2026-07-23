# CLAUDE.md — TileMon

**An attention-management tool, not a project manager.** The one question it answers is *what
are my agents waiting on me for?* A zero-sum treemap: importance = on-screen area; agents flag
status, you own the weights. The needs-you states glow — `waiting` (needs your input) amber, `blocked`
(something's wrong) louder red + pulse; `in_progress` is a calm "working"
dot (no heat); the surface stays coarse — detail is drill-down. **The test for any feature: does
it direct attention, or dilute it?** Adding granular detail (e.g. seeding every task) is the
failure mode — when it feels busy, subtract. Distributed as an `npx` tool over local JSON boards.

**Read [`SPEC.md`](./SPEC.md) first** — it is the ratified design (locked model,
architecture, roadmap, open decisions). This file is the working-state layer on top.
The v5 hosted (tilemon.com) design lives in the private `tilemon-cloud` repo (its `HOSTED.md`) —
where the data lives when your PC is off, and the two SPEC [LOCKED] points it supersedes
(multi-parent mounts; no `parent_id`).

## Status

Multi-board swarm loop built and shipping. `npx tilemon` serves a directory of boards (default
`~/.tilemon`, the machine-wide board; `--project` scopes to `./.tilemon`); agents `POST /api/status`
to **upsert**, the board live-updates over SSE, includes render as navigable summary tiles.
**Structure is API-driven** (`/api/board`, `/api/node {item|include}`, `/api/move` — nothing
hand-authors JSON), **background mode** (`--daemon`/`--stop`, detached via Node built-ins), and the
**skill** installs via `npx skills add FortyTech/tilemon`. Working tree is **`0.11.0`**: `0.7.0` =
renderer keyed by globally-unique `_board::_path` (fixes id-collision on drill/hover), always-visible
inline notes + tooltip, two-gate setup wizard; `0.8.0` = **auto-attach + liveness** (agents claim an
`in_progress` tile on start; every status write stamps a `seen` heartbeat, so a fresh `in_progress`
shows a live "working" dot and a stale one dims/greys as abandoned); `0.11.0` = **full client-CLI
coverage** — `resolve`/`boards`/`state`/`add-board`/`add-item`/`include` added as verified subcommands
(exit non-zero on failure) alongside `flag`/`attention`, so nothing hand-rolls curl, plus the
**skill restructured** into a lean hot-path `SKILL.md` (report status) + `references/setup.md`
(bootstrap) with command-first framing throughout. One machine = one shared board; **cross-machine forces the hosted/SaaS path
(deferred)**. Jira source stubbed (v2). UI verified in a real browser; logic/API/packaging
verified headlessly here.

## Stack — deliberately *not* the workspace default

This repo does **not** follow `STACK.md` (Next.js/Tailwind/Clerk). That's intentional and
agreed: SPEC §4 defines v1 as a **zero-dependency `npx` tool** (single Node server + a
static renderer), and §5 places Next.js + Neon + Clerk at **v5 (hosted, optional, last)**.
Forcing the full stack onto v1 is the double-rewrite the architecture exists to avoid.
Node 18+ built-ins only; no build step, no framework, no dependencies.

## Files

| File | Role |
|---|---|
| `board.js` | The renderer. Framework-agnostic ESM, owns no data. `mount(boardEl, controlsEl, {state, onWeightChange, onStatusChange, onOpenBoard}) → {update, setShowDone, getState, destroy}`. The npm package + the thing a hosted app reuses verbatim. Handles include tiles + notes. |
| `dashboard.html` | The **multi-board file-source adapter** — routes boards by URL (`/boards/<slug>`), board-scoped `POST`s, board switcher, SSE refresh. Swap this layer to change *where data lives*; the renderer is untouched. |
| `server.mjs` | Local server over a **boards directory**: `/api/boards`, `/api/state?board=`, upsert on `/api/status`, include-resolution (summary heat + acyclic), atomic writes, SSE, slug safety, jira stub. |
| `dashboard-reference.html` | The original proven prototype (numeric ids + manual heat). Behavioural source-of-truth for diffing; not served. |
| `examples/boards/` | Sample boards: a native board that `include`s another + a Jira-source stub. `npm run demo` serves these. |
| `state.sample.json` | Legacy single-board sample data (pre-multi-board). Any real `state.*.json` you create is **gitignored, local-only**. |
| `examples/agent.mjs` · `examples/flag.mjs` | A toy swarm agent (in_progress→blocked→done) and a one-shot flagger — the whole loop in a file. |
| `test/board.test.mjs` + `test/fixture.json` | Headless renderer checks via a minimal DOM shim (`npm test`) — done-drop, rollup, parent-status floor, show-done, include-nav. |

## The one architectural rule

**The renderer owns no data; it is a renderer over a source.** It announces *what changed*
via callbacks (`onWeightChange` / `onStatusChange`); the host decides where that goes. v1's
source is the file (via `server.mjs`); a future hosted version is just another source
(Neon) behind the same callbacks. Keep all data access on the adapter side of that seam —
never let `board.js` reach for `fetch`/storage directly.

## Capability split (the safety story)

The write surface is split **by route**, and each route does exactly one job: `POST /api/status`
sets a node's status/note (any level) and nothing else; `POST /api/weight` sets weight and nothing
else; structure lives on its own routes (`/api/board`, `/api/node`, `/api/move`). No route can be
made to do another's job.

**But there is only one credential, and it is not scoped.** `TILEMON_TOKEN` is a single board-wide
write secret: if it's set, it authorises *every* write route — status, weight, and structure alike
(see `authed`, server.mjs); if it's unset (the default local setup), writes are open. So handing the
token to an agent grants **all** writes, not just flagging — it can reshape weights and structure too.
The routine-vs-setup separation an agent actually observes is enforced by **what its skill docs expose**
(routine agents see only `flag`/`attention`/`resolve`), not by the token. A genuinely status-only
credential would be new work (per-capability tokens).

## Data conventions

- Stable **string** `id`s, addressed dotted from the root's children (`work.ship.task`),
  no dots inside an id. `name` is display-only and free to change.
- **Any node may carry a `status`** (`todo|in_progress|waiting|blocked|done`; `waiting`=needs your
  input (amber), `blocked`=something's wrong (red+pulse, louder)) — the tree is
  uniformly recursive, not leaf-only. A node's own status maps to heat and acts as a
  **floor**; a node with children also rolls up heat area-weighted, so displayed heat is
  `max(own, rollup)`. A statusless node behaves as pure rollup (exactly the old model).
- `done` (at any level) drops that node and its subtree off the board — but on a **cooldown**,
  not instantly: a viewer-side dial (`board.setDoneCooldown(ms)`; toolbar cycles
  off/1m/5m/10m/30m/always, default 5m) keeps a just-completed tile visible (dimmed sage) for that
  long, measured from its `seen` stamp, then fades it. `0` = hide instantly, `Infinity` = show forever
  (the old show-done). `setShowDone(bool)` remains as a shim over the two extremes. So `done` is
  reversible and gives a moment of "handled" feedback — never a one-way trapdoor.
- **Liveness (`seen`) — orthogonal to status.** Every `/api/status` upsert stamps `seen` (epoch ms).
  The renderer shows a live dot on *any* fresh tile (any status, own or a fresh descendant, seen
  `< LIVE_TTL` = 10 min) — the dot means "an agent is attached and fresh here", **not** "in progress":
  a live `waiting` reads as "an agent's waiting on you *right now*". Heat (how much it needs you) and
  the dot (is an agent live on it) are two independent axes. Separately, a *stale* `in_progress`
  renders **`stalled`** (dimmed + greyscaled) — started-then-abandoned work; a stale `waiting`/`blocked`
  keeps its glow (it still needs you) and merely loses the dot. Agents keep tiles live by re-POSTing
  as they work, and resolve to `done`/`waiting`/`blocked` before stopping. Heartbeat is write-driven
  only (no server heartbeat/reaper) — a generous TTL absorbs the gaps; SessionEnd reaping deferred.
- Weight is a node's share vs. its siblings; resizing one node squeezes the others
  proportionally. New nodes should be born small.
- **Multi-board:** each board is `<slug>.json` in the boards dir, with a board-level
  `source` (`native` default; `jira://…` read-only, stubbed) and `visibility`. A node with
  `include: "<slug>"` renders as a navigable summary tile (glows with the included board's
  rolled-up heat; double-click navigates; never inlined; acyclic-guarded). Includes only
  reference boards — every data origin *is* a board.
- **Upsert:** `POST /api/status` creates the board and any missing path nodes (born small)
  so agents populate an empty board from scratch. `POST /api/weight` requires the node to
  exist (humans lay out weight; agents don't create structure they can't already reach).
- **Human structure surface (clean primitives):** `POST /api/board {name}` creates a bare board
  (placed nowhere) and returns its slug; `POST /api/node {kind:"item"}` adds a plain node (a task,
  or a bucket once you add into it); `POST /api/node {kind:"include", target}` references an
  *existing* board; `POST /api/move` re-parents a node (within/across boards, cycle-guarded);
  `PATCH` renames / sets the toolbar flag; `DELETE` removes a node (referenced board file left
  intact). The UI's "add nested board" composes board+include client-side. Fresh dirs auto-seed
  a `tilemon` home board. Agents own status/note; humans own structure + weight. **Setup is
  API-driven — nothing hand-authors the JSON** (though file live-reload survives as a power-user
  escape hatch). The old `kind:"native"` combo verb was dropped in favour of the two primitives.

## Vocabulary

User-facing language is neutral — **item / group / tile**, never Jira's "epic"/"task".
The structure has one concept: an item that may contain items. `parent`/`leaf`/`children`
survive only as internal tree mechanics.

## Revisions to SPEC.md (post-v1)

These supersede the marked **[LOCKED]** spec sections — kept here, not edited into the
handover, so SPEC.md stays the original record:

1. **Status is recursive, not leaf-only** (supersedes §1.5/§1.6 and the §4 leaves-only
   guard). Any node can hold a status; heat is `max(own, rollup)`. Rationale: the leaf-only
   rule made the tree two-tier; a whole branch can legitimately be blocked.
   *Trade-off accepted:* a glowing parent no longer always means "drill in to find the hot
   thing" — it may be the container itself. Surface the heat *reason* (own vs rolled-up)
   to keep legibility — **not yet built.**
2. **`done` is reversible via a show-done view** (addition). Hiding removes the only handle
   to un-hide; an "archived" status would have the same flaw, so the fix is a view that
   reveals hidden items, not a new label.

## Run / test

```bash
npm run demo                          # serve ./examples/boards  (http://localhost:4000)
npm start                             # serve ~/.tilemon (default machine-wide board; --project for ./.tilemon)
TILEMON_TOKEN=secret node server.mjs              # auth on writes (serves ~/.tilemon by default)
node examples/agent.mjs webapp api.refactor-auth  # toy agent walks a job through the lifecycle
tilemon flag <board> <path> <status> "<note>" --name "..."  # VERIFIED status write (exits non-zero if it didn't land)
tilemon attention [board]             # VERIFIED read — print what's glowing (board defaults to home)
                                      # ↑ flag/attention auto-start the default local server if down (TILEMON_NO_AUTOSTART=1 to disable)
npm test                              # headless; no browser required
```

Note: a browser **cannot** be launched in the workspace sandbox (Chromium SIGTRAPs), so UI
verification here is via the headless data-pipeline test + wire-level route checks, not
Playwright. Eyeball the actual board in a real browser when iterating on visuals.

## Next (not built)

- **`attention.md` — user-defined attention rules — ✅ BUILT as `tilemon reconcile`.** The Stop-hook
  executor (`reconcile.mjs`, dispatched from `server.mjs`): resolves the folder's board, gathers
  ground-truth facts (git/gh) + the recent conversation, hands them to a **sealed tool-less** `claude -p`
  that decides tile changes against the operator's status **definitions** (attention.md is now organised
  by status, each heading defining the bar — incl. a strict Definition of Done so nothing is falsely
  cleared), then POSTs the result. Non-blocking, near-silent (one line only when a tile changed). Core
  stays dumb — all the smarts live in `reconcile.mjs`; the judge has no tools so its blast radius is "a
  wrong tile", never a shell. Original free-text design notes below. **Rules belong to the operator/viewer,
  not the board** (same personal-lens category as weight; never baked into shared data): lives
  operator-side (`~/.tilemon/attention.md` locally; stays client-side in SaaS). Per-board/per-node
  granularity by *targeting inside* the file (keyed by slug/path). Guardrail: a few glow-triggers,
  not auto-spawned task lists. Deferred sub-layer: board-owner default rules overridden per viewer.
- **Theming — per-status/category colours (configurable).** `in_progress` should read as *active*
  (e.g. blue), distinct from `waiting` amber; a **"quick win"** marker (cheap-to-clear tiles — git
  ops the common case) in its own colour (e.g. purple); operator-configurable palette (fill/outline/
  pulse per status) with safe defaults. Frontend work — `board.js` + `dashboard.html`; not started.
- **Move UI (E):** a "move" icon in the hover bar arms move-mode; drag drops the tile into the
  highlighted innermost container (reuse the gold target highlight); calls `/api/move`.
- **"Growing the board"** skill note: incremental add of a workspace/project; reshape with `/api/move`.
- **Reply channel** (board→agent): `POST /api/reply` + agent polls its inbox — the "action the
  things" half. Deliberately deferred (and it's messaging, never board-overrides-agent).
- **v2: Jira as a read-only second source** — the `jira://` board type is stubbed; wire the
  adapter (a Jira project; weight kept in a TileMon sidecar keyed by ticket id) and add it as an
  `add`-type in the UI once the source is real. See SPEC §5.
- Heat-reason legibility (own-status vs rolled-up) and the frame-as-tile header — still open.
- Killed: task-seeding on bootstrap — it adds noise; an attention tool subtracts, it doesn't seed.
