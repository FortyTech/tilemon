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
Point an always-on monitor at it. Agents flag status over HTTP (and can populate an empty board
from scratch); you own the weights by dragging tiles.

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
- **Weight is yours; status is the agent's.** You set importance by dragging (or the
  size slider), deliberately. Agents set status — `todo → in_progress → blocked → done`.
- **Any item can carry a status, at any depth.** It's a uniformly recursive tree — an
  item may contain items *and* hold its own status. A whole group can be `blocked` (the
  branch is stuck) without lying about a child.
- **Heat = "needs you". Only `blocked` glows.** `done` drops off the board. `in_progress`
  carries **no heat** — an agent that's working doesn't want your attention; it gets a **calm
  "working" dot** instead (a separate, quiet channel, so you can see activity without being
  pulled by it). Heat rolls up area-weighted, so a stuck thing deep in a group makes the whole
  group glow, visible from across the room — while the surface stays coarse and calm otherwise.
- **`done` is reversible.** Finished items drop off so the board shows live work, but the
  **done** toggle brings them back (dimmed) so you can re-open one — hiding never means
  losing.

## How agents update it

To let your coding agent feed the board unprompted, install the skill:

```
npx skills add FortyTech/tilemon        # into this project's ./.claude/skills/
npx skills add -g FortyTech/tilemon     # or globally, for every project
```

The skill teaches the agent *when* to flag (block/finish) and how to bootstrap a board — but
it's not required: any agent told "there's a TileMon board at localhost:4000" can use the API
directly. The whole integration is one POST, scoped to a board. It **upserts** — if the board or the node doesn't exist yet,
it's created (born small) — and it can *only* set status/note, never your weights or
structure (a different endpoint, with no access to weight).

```bash
node examples/agent.mjs webapp api.refactor-auth      # a toy agent: in_progress → blocked → done
node examples/flag.mjs  webapp api.refactor-auth blocked "need the staging DB password"
# or directly:
curl -X POST http://localhost:4000/api/status \
  -H 'content-type: application/json' \
  -d '{"board":"webapp","path":"api.refactor-auth","status":"blocked","note":"need the staging DB password"}'
```

## Attention rules (`attention.md`)

You decide what deserves your attention — write it in plain English in `~/.tilemon/attention.md`
(seeded with a template on first run). Agents working in a place read it and push status so the
things that need *you* glow:

```
# --- global ---
- Uncommitted changes in a repo should be blocked until committed.
- A client email unanswered >2 days → blocked.

# --- board: acme-portal ---
- Failing CI → blocked.
```

The rules are **yours** — a personal lens, like your weights, never baked into the shared board —
and they're honoured by **whoever's already working there**, evaluating them with their own tools.
TileMon prescribes no mechanism and ships no rule-specific tooling: **sending updates to TileMon
(`POST /api/status`) is the whole interface**, and how you generate those updates — an agent working
live, a hook, CI, a scheduled job — is up to you. Scope with `# board: <slug>` / `# node: <board>.<path>`
sections; the rest is global.

**Optional — a Claude Code `Stop` hook.** So the board stays current without you (or an agent)
remembering, setup can add a project `Stop` hook that, when the agent pauses for input, nudges it once
to apply `attention.md` and push updates before it stops. It's offered opt-out at setup, scoped to the
project's `.claude/settings.json`, and removable by deleting the `Stop` entry. Claude-Code-specific;
everything else just pushes via `POST /api/status`.

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
        "status": "blocked", "note": "need the staging DB password" }   // leaf: status + agent note
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
| `POST /api/status` | **agents** | `{board, path, status, note?, name?}` — upsert; status/note only |
| `POST /api/weight` | **you / UI** | `{board, path, weight}` — weight only, node must exist |
| `POST /api/board` | **you / UI** | `{name, slug?, source?}` — create a bare board (placed nowhere) → `{slug}` |
| `POST /api/node` | **you / UI** | `{board, path, kind, name?, target?}` — add a plain item (`kind:"item"`) or an include of an existing board (`kind:"include"`, `target` = its slug) |
| `POST /api/move` | **you / UI** | `{board, path, toBoard?, toPath?}` — re-parent a node within or across boards (cycle-guarded) |
| `PATCH /api/node` | **you / UI** | `{board, path, name}` — rename |
| `DELETE /api/node` | **you / UI** | `{board, path}` — remove a node (a referenced board file is left intact) |

Structure is assembled from clean primitives: **create a board once** (`/api/board`), **reference it**
wherever you like (`/api/node kind:"include"`), and **rearrange references** (`/api/move`). A *bucket*
is just an item you add children into. Agents never touch these — they only `POST /api/status`.

Set `TILEMON_TOKEN` to require `Authorization: Bearer <token>` on the write routes
before exposing the port beyond a trusted network.

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
