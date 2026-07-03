# CLAUDE.md — TileMon

A zero-sum treemap priority board. Importance = on-screen area; agents flag status, you
own the weights. Distributed as an `npx` tool over a local JSON file.

**Read [`SPEC.md`](./SPEC.md) first** — it is the ratified design (locked model,
architecture, roadmap, open decisions). This file is the working-state layer on top.

## Status

Multi-board swarm loop built and shipping. `npx tilemon` serves a directory of boards (default
`~/.tilemon`, the machine-wide board; `--project` scopes to `./.tilemon`); agents `POST /api/status`
to **upsert**, the board live-updates over SSE, includes render as navigable summary tiles.
**Structure is API-driven** (`/api/board`, `/api/node {item|include}`, `/api/move` — nothing
hand-authors JSON), **background mode** (`--daemon`/`--stop`, detached via Node built-ins), and the
**skill** installs via `npx skills add FortyTech/tilemon`. Published to npm; latest is **`0.3.0`**
(multi-repo default). One machine = one shared board; **cross-machine forces the hosted/SaaS path
(deferred)**. Jira source stubbed (v2). UI verified in-browser by William; logic/API/packaging
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
| `state.sample.json` / `state.forty.json` | Legacy single-board data (pre-multi-board). `state.forty.json` is **gitignored, local-only** (personal). |
| `examples/agent.mjs` · `examples/flag.mjs` | A toy swarm agent (in_progress→blocked→done) and a one-shot flagger — the whole loop in a file. |
| `test/board.test.mjs` + `test/fixture.json` | Headless renderer checks via a minimal DOM shim (`npm test`) — done-drop, rollup, parent-status floor, show-done, include-nav. |

## The one architectural rule

**The renderer owns no data; it is a renderer over a source.** It announces *what changed*
via callbacks (`onWeightChange` / `onStatusChange`); the host decides where that goes. v1's
source is the file (via `server.mjs`); a future hosted version is just another source
(Neon) behind the same callbacks. Keep all data access on the adapter side of that seam —
never let `board.js` reach for `fetch`/storage directly.

## Capability split (the safety story)

`/api/status` is the agent surface — it can only set a **node's status** (any level).
`/api/weight` is the human surface — weight only. Neither can do the other's job; that's
enforced by route, not policy. One board-wide `TILEMON_TOKEN` is safe to hand an agent
because it *can't* reach weight or structure.

## Data conventions

- Stable **string** `id`s, addressed dotted from the root's children (`work.ship.task`),
  no dots inside an id. `name` is display-only and free to change.
- **Any node may carry a `status`** (`todo|in_progress|blocked|done`) — the tree is
  uniformly recursive, not leaf-only. A node's own status maps to heat and acts as a
  **floor**; a node with children also rolls up heat area-weighted, so displayed heat is
  `max(own, rollup)`. A statusless node behaves as pure rollup (exactly the old model).
- `done` (at any level) drops that node and its subtree off the board. The **show-done**
  toggle (`board.setShowDone(true)`) renders them dimmed instead, so `done` is reversible
  from the board — never a one-way trapdoor.
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
npm test                              # headless; no browser required
```

Note: a browser **cannot** be launched in the workspace sandbox (Chromium SIGTRAPs), so UI
verification here is via the headless data-pipeline test + wire-level route checks, not
Playwright. Eyeball the actual board in a real browser when iterating on visuals.

## Next (not built)

- **Publish `0.1.0`** (this multi-board version) — `0.0.1` is already up as the name claim.
- **Include-navigation UX** in a real browser: history-based back is wired (`/boards/<slug>`
  + `popstate`); confirm the feel, and the summary-heat-reason legibility note from the
  SPEC revisions is still open.
- **Reply channel** (board→agent): `POST /api/reply` + agent polls its inbox — the "action
  the things" half. Deliberately deferred.
- **v2: Jira as a read-only second source** — the `jira://` board type is stubbed; wire the
  adapter (FO project; weight kept in a TileMon sidecar keyed by ticket id) and add it as an
  `add`-type in the UI once the source is real. See SPEC §5.
- Task-seeding on bootstrap (populate boards from state/next-steps docs) — parked, next up.
