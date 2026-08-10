# TileMon

**An attention-management tool, not a project manager.** The one question it answers is
*what are my agents waiting on me for?* Importance is **space** on a fixed canvas, so making
one thing bigger shrinks everything else — a zero-sum map that won't let you pretend ten things
are all urgent. Hand work to your agents; when one gets **stuck, it glows** and pulls you in.
Everything that's fine stays quiet. If a feature would add noise instead of directing attention,
it doesn't belong here.

```
npx tilemon           # serves ~/.tilemon — one board for the whole machine (created on first run)
```

…boots a local server, serves the board at `http://localhost:4000`, and reads/writes a
directory of JSON boards. By default that's `~/.tilemon`, so **every local repo shares one board** —
which is what a cross-project tool wants. Want a board scoped to just one repo instead? `npx tilemon
--project` (serves `./.tilemon`), or point it at any explicit folder: `npx tilemon ./some-dir`.
**The board keeps itself current** — a passive collector reads Claude Code's own per-session state
and projects your live sessions onto it (no hooks, no agent cooperation; see *How the board stays
current* below). You own the weights by dragging tiles.

Run it detached so it outlives the terminal (or the agent) that started it — no extra tooling,
just Node:

```
npx tilemon --daemon    # start in the background (survives this shell); --stop to kill it
npx tilemon --stop      # stop the backgrounded server
```

**One board across many local repos.** This is the default — `~/.tilemon` is machine-wide, so one
server covers every repo. Agents in any repo target `http://localhost:4000` by default, so they all
land on the same board; just don't start a second server elsewhere. (Spanning *different machines*
needs a hosted TileMon, which isn't built yet.)

Want it back after a reboot? That's your OS's job, not the tool's — add `npx tilemon --daemon`
to your startup (Login Items on macOS, a systemd user unit on Linux, Task Scheduler on Windows).

A fresh run seeds one empty **home board** for you. From there you either **add** things
yourself (in the top bar: an inline *item*, or a nested *board* with its own tasks; plus
rename/delete), or let **agents** populate it. Or run the bundled demo:

```
npm run demo        # serves ./examples/boards (a native board + a mounted one + a Jira stub)
```

## The idea

- **Area = importance.** A tile's on-screen area is its share of attention. The total
  never grows, so weighting one thing up *takes* space from its siblings. You spend
  importance like a budget.
- **Weight is yours; status is read from your sessions.** You set importance by dragging (or the
  size slider), deliberately. Status — `in_progress`, `waiting` (needs your input), `blocked`
  (something's wrong), `done` — is projected mechanically from Claude Code's session state by the
  collector, not something agents report.
- **Any item can carry a status, at any depth.** It's a uniformly recursive tree — an
  item may contain items *and* hold its own status. A whole group can be `blocked` (the
  branch is stuck) without lying about a child.
- **Heat = "how loudly it needs you."** Two needs-you levels: `waiting` glows **amber** (needs your
  input — present, no rush); `blocked` glows **red and pulses** (something's wrong — louder). `done`
  drops off. `in_progress` carries **no heat** — a working agent doesn't want your attention; it gets
  a **calm "working" dot** instead (a separate, quiet channel). Heat rolls up area-weighted, so a stuck thing deep in a group makes the whole
  group glow, visible from across the room — while the surface stays coarse and calm otherwise.
- **`done` is reversible.** Finished items drop off so the board shows live work, but the
  **done** toggle brings them back (dimmed) so you can re-open one — hiding never means
  losing.

## How the board stays current — the passive collector

You don't tend the board and agents don't report to it. A **standalone collector** reads Claude
Code's *own* per-session state (`~/.claude/jobs/*/state.json` — which already records whether each
session is working, waiting on you, blocked, or done, plus what it needs) and projects your **live
sessions** onto the board. No hooks, no agent cooperation, no `claude -p` judge — a plain,
deterministic read-and-reconcile.

```bash
# key + board URL live in ~/.tilemon/credentials (TILEMON_URL / TILEMON_TOKEN)
tilemon collect --dry-run     # print the board it WOULD build from your sessions; write nothing
tilemon collect --loop &      # run it: reconcile every 60s (--interval to change)
```

- **A tile is a live session** — routed to its project board by the session's name, gone the moment
  the session ends. The board can't accrete; it only ever shows what's live.
- **Target is the sink.** With `TILEMON_URL` set it POSTs to the hosted app (`/api/collect`); unset,
  it writes a local board directly. Same collector either way — run it next to Claude Code and point
  it at tilemon.com, or at your own `npx tilemon` server.
- **Pins are yours.** A tile you add in the UI persists until you mark it done; the collector manages
  only its own session tiles and never touches a pin.

Full setup (hosted or local) is in [`skills/tilemon/references/setup.md`](./skills/tilemon/references/setup.md).
The `POST /api/status` route still exists for a non-Claude agent that wants to report directly, but
it's no longer the primary path — the collector is.

## Boards & file format

A **board** is `<slug>.json` in the boards directory. A board has a `source` (where its data
comes from); a node has children, and/or a `status`, or `include`s another board.

```jsonc
{
  "name": "My board",
  "visibility": "private",          // private | public (public boards can be included by others)
  "source": "native",               // native (agents write it) | "jira://PROJECT" (read-only)
  "children": [
    { "id": "api", "name": "API", "weight": 2, "children": [
      { "id": "refactor-auth", "name": "Refactor auth", "weight": 1,
        "status": "waiting", "note": "which auth provider — Clerk or Auth0?" }   // leaf: status + agent note
    ]},
    { "id": "team", "name": "Team Atlas", "weight": 1, "include": "team-atlas" }  // a navigable board tile
  ]
}
```

Any node may carry a `status`; a node with children rolls up heat from them (its own status
sets the floor). An `include` node is a **navigable summary tile** — it glows with the
included board's rolled-up heat, and double-clicking navigates to it (never inlined). `id` is
a stable string agents address by (dotted: `api.refactor-auth`); `name` can change freely.
Edit a board file directly and it live-updates — the server watches the directory.

## Routes

| Route | Who | Does |
|---|---|---|
| `GET /` · `/boards/<slug>` | — | the board (single-page app) |
| `GET /api/boards` | — | list boards |
| `GET /api/state?board=<slug>` | — | one board's resolved tree |
| `GET /api/events` | — | Server-Sent Events; `change` on any write |
| `POST /api/collect` | **the collector** | `{origin?, boards:{slug:[nodes]}}` — reconcile the collector-owned tiles across boards in one call (hosted); leaves human pins untouched |
| `POST /api/status` | direct/legacy | `{board, path, status, note?, name?}` — upsert one node's status/note (the pre-passive self-report path; still works for non-Claude agents) |
| `POST /api/weight` | **you / UI** | `{board, path, weight}` — weight only, node must exist |
| `POST /api/board` | **you / UI** | `{name, slug?, source?}` — create a bare board (placed nowhere) → `{slug}` |
| `POST /api/node` | **you / UI** | `{board, path, kind, name?, target?}` — add a plain item (`kind:"item"`) or an include of an existing board (`kind:"include"`, `target` = its slug) |
| `POST /api/move` | **you / UI** | `{board, path, toBoard?, toPath?}` — re-parent a node within or across boards (cycle-guarded) |
| `PATCH /api/node` | **you / UI** | `{board, path, name}` — rename |
| `DELETE /api/node` | **you / UI** | `{board, path}` — remove a node (a referenced board file is left intact) |

Structure is assembled from clean primitives: **create a board once** (`/api/board`), **reference it**
wherever you like (`/api/node kind:"include"`), and **rearrange references** (`/api/move`). A *bucket*
is just an item you add children into. These are the human's structure surface (via the UI); the
collector only reconciles its own session tiles and never reshapes them.

Set `TILEMON_TOKEN` to require `Authorization: Bearer <token>` on the write routes
before exposing the port beyond a trusted network.

**Where credentials live:** `TILEMON_TOKEN` and `TILEMON_URL` are read from the environment, but
if they're not set, the CLI loads them from **`~/.tilemon/credentials`** — a dotenv-style file next
to your boards (`TILEMON_TOKEN=…` / `TILEMON_URL=…`, one per line). That's the canonical home: it sits
outside every git repo, so a stray `git clean` can't wipe it, and one file holds your whole
point-at-hosted config. An explicit env var still wins over the file.

## The renderer is reusable

`board.js` is a framework-agnostic ES module that owns no data — you hand it a tree and
two callbacks:

```js
import { mount } from 'tilemon/board.js';
const board = mount(boardEl, controlsEl, {
  state,
  onWeightChange: (path, weight) => { /* persist however you like */ },
  onStatusChange: (path, status) => { /* persist however you like */ },
  onOpenBoard:    slug          => { /* navigate to an included board */ },
});
board.update(newState); // re-render; drill level + selection preserved
```

The npx tool wires those callbacks to `POST`. A hosted app would wire the same callbacks
to a database — the renderer doesn't change. See [`SPEC.md`](./SPEC.md) for the full
design, architecture, and roadmap.

## Develop

```bash
npm run demo    # serve ./examples/boards
npm start       # serve ~/.tilemon (the default machine-wide board)
npm test        # headless renderer checks (no browser needed)
```

MIT.
