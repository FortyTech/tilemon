# TileMon — Build Spec & Handover

> A priority board where **importance is space**. The canvas is fixed, so making one thing
> bigger shrinks everything else — a zero-sum map that won't let you pretend ten things are
> all urgent. Hand tasks to your agents; when one gets stuck, it glows. Scale your attention
> sideways instead of drowning in a list.

This document is a handover for building TileMon for real (in Claude Code). It captures the
finished **design model**, the **architecture**, a concrete **v1**, the **roadmap**, the
**open decisions**, and ships a **proven reference renderer** plus a **server scaffold** so you
start from working code, not a blank repo.

Status legend used below: **[LOCKED]** = decided, don't relitigate · **[OPEN]** = needs a call,
my lean noted · **[PROVEN]** = working code included · **[SCAFFOLD]** = starter, verify it.

> **Post-v1 note:** two [LOCKED] decisions were deliberately revised after build — status is
> now recursive (any node, not leaves-only; heat = `max(own, rollup)`) and `done` is reversible
> via a show-done view. This document is left as the original handover; see `CLAUDE.md`
> ("Revisions to SPEC.md") for what supersedes §1.5/§1.6/§4.

---

## 0. Files in this handover

| File | What it is | Status |
|---|---|---|
| `SPEC.md` | This document | — |
| `dashboard-reference.html` | The full interaction model, working, data inlined as a seed | **[PROVEN]** |
| `server.mjs` | Dependency-free file-source server (`npx tilemon <file>`) | **[SCAFFOLD]** |
| `package.json` | Makes it `npx`-runnable, zero deps | **[SCAFFOLD]** |
| `state.sample.json` | The canonical file format, minimal | — |
| `state.forty.json` | Real 175-issue Jira backlog, converted to the format (12 epics) — realistic test data | — |

**To run the scaffold as-is:** rename `dashboard-reference.html` → `dashboard.html`, then
`node server.mjs ./state.sample.json` and open `http://localhost:4000`. Note: the reference
dashboard currently renders from its **inlined seed**, not the server — §4.5 is the surgical
change to feed it from `/api/state`. Everything else (layout, drag, drill) already works.

---

## 1. The core model **[LOCKED]**

This is the part that's been argued to death and settled. Don't soften it — the constraints
*are* the product.

1. **Strict tree.** Nodes contain nodes. No cross-branch links. If two things depend on each
   other across branches, that's a dependency graph — a *different tool*, explicitly out of scope.
   Single-parent, acyclic, always.

2. **Area = importance, and the canvas is fixed.** A node's on-screen area is its importance.
   The total never grows. This zero-sum property is the whole point: you can't mark everything
   "high priority" — making one thing bigger *takes* area from its siblings. You spend importance
   like a budget.

3. **Weight is per-sibling, never summed up.** Each node has a `weight`. Its share of its parent
   is `weight ÷ sum(sibling weights)`. **A parent's size is its own weight vs. its siblings —
   NOT the sum of its children.** (An epic with 30 tasks is not automatically bigger than an epic
   with 1; it's bigger only if *you* weight it bigger.) New nodes are born small (weight defaults
   low) so a stray agent-created task can't barge in at an equal share.

4. **Weight is yours. Status is the agent's.** You set importance (weight), deliberately, via the
   UI. Agents never set weight. Agents set **status**. This split is enforced at the API boundary
   (see §4) — it's not a rule you police, it's which endpoint a credential can reach.

5. **Heat is derived from status; it is not a thing anyone sets.** A leaf's status renders as heat:
   `todo → calm`, `in_progress → warm`, `blocked → hot`, `done → drops off the board entirely`.
   Heat carries a *reason* (the status), which ages better than a raw 0–1 number.

6. **Heat rolls up, area-weighted.** A parent's heat = the area-weighted average of its descendant
   leaves' heat. So a blocked task deep inside an epic bleeds its heat up to the epic, and you see
   "this epic is on fire" from across the room without drilling in. Heat crosses mount boundaries
   for free (see §3).

7. **Nothing auto-cools.** Heat does not decay on a timer (that just goes quiet and gets ignored).
   A blocked thing stays hot until it's resolved or the human consciously reweights it smaller.
   The only exits are *resolve* or *done-drops-off*.

8. **Self-prioritising legibility.** Because area = importance, only things that matter are big
   enough to read from a distance. The "dust" (tiny tiles) is *supposed* to be unreadable — you
   gave it that little space on purpose. Distance and importance are the same axis; the medium
   does the prioritising for you.

---

## 2. Interaction model **[PROVEN]** — see `dashboard-reference.html`

All of this already works in the reference file. Lift it; don't redesign it.

- **Squarified treemap at rest.** Tiles pack to be as square as possible (minimised perimeter),
  sorted biggest-first. (Algorithm: Bruls/Huizing/van Wijk squarify, implemented in the file.)

- **Drag a tile to resize it.** Drag **down/right = bigger, up/left = smaller**, applied
  **multiplicatively** (`weight *= exp(delta / 220)`) so a nudge feels the same whether the tile
  is tiny or huge. Resizing a node sets its share of its parent; **all other siblings squeeze
  proportionally** to fit (they keep their relative ratios). This is the gesture that solves
  "bounded by my neighbour" — you're not trading with one sibling, you're taking from all of them.

- **Fixed order during a drag, re-sort on release.** While dragging, sibling order is frozen so
  the tile grows *in place* (no dancing under the cursor). On release it re-sorts by size and the
  reflow **animates** (~180ms) — the one unavoidable reorder happens as a glide, never a snap.
  This is the resolution of the squareness-vs-stability tension: you keep squareness *and* never
  get a live teleport. (Trade-off the user accepted: resting positions still shift when a tile
  changes size-rank, but always as an animated, user-initiated move.)

- **Focus level / "arming" a parent.** By default, dragging *any* tile resizes the **top-level
  node** it belongs to (the epic), regardless of which sub-tile you grabbed. To resize tasks
  *inside* an epic, **click the epic first** — it gets a dashed outline ("armed") — and then drags
  target its children. Dragging outside the armed parent drops back to top level. This is the
  SpaceMonger drill model without losing sight of the rest of the board. (Solid outline = selected
  leaf; dashed = armed parent.)

- **Double-click a parent = drill in** (zoom so it fills the canvas; breadcrumb to climb back out).

- **Click to select; selection is deliberate (a drag never changes selection).** Selecting a leaf
  lets you flag its heat / fine-tune size via the slider fallback. Selecting a parent arms it.

- **Slider is a precision fallback**, not the main gesture. Dragging is primary.

- **Aesthetic:** dark warm charcoal (`#14120D`), Space Grotesk + Space Mono, heat ramp from calm
  slate → amber → vermilion, designed to read across a room on an always-on monitor. Calm is the
  default state so that motion/colour *means something*.

---

## 3. Architecture: a renderer over **sources** **[LOCKED]**

The single most important architectural idea, and the thing that dissolves every "where does the
data live" argument:

> **The board owns no data. It is a renderer over one or more *sources*. A source is anything that
> can answer "give me a tree" and "here's an update." The renderer never talks to storage directly
> — only to the source interface.**

Hold that one line and everything composes; break it (let the renderer reach into a database) and
v1 and the hosted version become two rewrites.

### The source interface (three verbs)

```
read()           -> returns the subtree (nodes, weights, statuses)
subscribe(cb)    -> calls cb when something changes   (or the renderer polls)
writeStatus(path, status)   -> OPTIONAL. A source may be read-only.
```

That last word — *optional* — is the unlock. Sources come in two kinds, differing in exactly one
way: **who owns the write path.**

| Source type | Data lives in | Write path | Needs a TileMon key? |
|---|---|---|---|
| **File** (v1) | a JSON file you host | TileMon's own endpoint | **Yes** — agents POST status |
| **Jira** (later) | Jira | Jira's own API (agent moves a ticket to Blocked) | **No** — read-only; Jira owns auth |
| **Mounted board** (later) | another TileMon instance | that instance | No (it owns its own) |

This is why the API-key machinery felt oversized earlier: it belongs to **one source type** (the
self-hosted file/endpoint), not to the whole product. Read-only Jira needs *zero* new auth.

### Weight always lives in your layer

Whatever the source, **weight is never stored in the source.** A weight is a property of a node's
*position in your tree* (its share vs. its siblings, possibly under a synthetic parent the source
knows nothing about) — not a property of the underlying ticket. Keep a weight map in TileMon's
own layer, keyed by stable node id. (For the File source, weight just lives on the node in the
file, which *is* your layer. For Jira, weight lives in TileMon keyed by ticket id; Jira stays
read-only.)

### Mounts = just another source

"Mount a team's board inside mine" is a source of type *mounted-board*. Heat rolls up through
the mount for free (it's the same area-weighted rollup, it doesn't know it crossed a boundary).
Discipline: a mount is **read-through, single-parent, acyclic** — you can't mount your master tree
back inside a child. **[LOCKED]**

---

## 4. v1 — the `npx` tool **[SCAFFOLD provided]**

The smallest thing that proves the whole loop (agent flags → you see it → you act) with the least
plumbing. **No login, no database, no hosting you run, no Jira.** One source type: the File source,
served by a tiny local server so it's monitor-friendly and shareable.

```
npx tilemon ./state.json
```

…boots a local server that (1) serves the dashboard as a web page and (2) reads/writes/ watches
the file. The office monitor points a browser at `http://your-box:4000`. Agents POST to the same
server (or write the file directly). Sharing = publish the npm package; each person runs their own
against their own file. This is local **and** shareable at once — the combination the user kept
reaching for.

### 4.1 File format

See `state.sample.json` (minimal) and `state.forty.json` (real data). Schema:

```jsonc
{
  "name": "Priorities",            // root container (unnamed in UI; shown in breadcrumb)
  "children": [
    {
      "id": "work",                // STABLE string id — agents address by it, survives renames
      "name": "Work",              // display name (renaming this does NOT change the id)
      "weight": 2,                 // share vs siblings. Human-owned. Any positive number.
      "children": [ /* ... */ ]    // a node with children is a "parent"/container
    },
    {
      "id": "data-migration",
      "name": "Data migration",
      "weight": 1,
      "status": "blocked"          // LEAVES carry status. one of: todo|in_progress|blocked|done
    }
  ]
}
```

- **Leaves have `status`; parents don't** (a parent's heat is derived by rollup).
- **`done` leaves are hidden** by the renderer (done drops off the board). An epic whose children
  are all done therefore disappears too.
- **Addressing is by dotted stable ids**: `work.ship-v2.data-migration`. **[OPEN: see §7.1]**

### 4.2 Server routes (in `server.mjs`)

```
GET  /              -> dashboard.html
GET  /api/state     -> current tree (JSON)
GET  /api/events    -> Server-Sent Events; emits "change" on any update (push)
POST /api/status    -> { path, status }   AGENT write — status only, leaves only
POST /api/weight    -> { path, weight }   HUMAN/UI write — weight only
```

The two write routes are the **capability split from §1.4 made physical**: `/api/status` literally
cannot change a weight; `/api/weight` literally cannot change a status. A buggy or hostile agent
holding the key can only flag/append — it can't reshuffle your priorities, because the capability
isn't exposed to it. That's the entire safety story, and it falls out of the route design.

### 4.3 Live updates

The server watches the file (so direct edits and agent file-writes also push) and broadcasts a
`change` event over SSE after any write. The dashboard subscribes via `EventSource('/api/events')`
and re-fetches `/api/state` on each event. Polling is an acceptable fallback if SSE is a pain.

### 4.4 Concurrency & safety

- **Atomic writes**: write to `state.json.tmp`, then `rename` (a reader never sees a half file).
  Implemented in the scaffold.
- **Serialised writes**: writes are chained so two near-simultaneous writes don't clobber.
- **Idempotency** **[OPEN: §7.2]**: if you allow create-by-path, make it an upsert so a retrying
  agent doesn't spawn duplicates.

### 4.5 Wiring the proven renderer to the server (the one surgical change)

The reference dashboard renders from an inlined `<script id="seed">`. Replace that with the server
as the source. Concretely, in `dashboard-reference.html`:

1. **Load from the server instead of the seed.** Replace `loadSeed()` so it does
   `await fetch('/api/state').then(r => r.json())`. Keep the `uid`/`_parent` bookkeeping.
2. **Map status → heat on load** (and drop `done`). The reference currently stores a numeric
   `heat` on leaves; the file uses `status`. Add a tiny adapter:
   `todo→0, in_progress→0.5, blocked→1, done→omit`. (Or: change the renderer to read `status`
   directly and compute heat in `calcHeat`. Either is fine; the status→heat map is the contract.)
3. **Persist weight changes.** On drag-end and on slider change, `POST /api/weight {path, weight}`
   for the changed node(s). Build `path` by walking `_parent` chain collecting `id`s.
4. **Live refresh.** Open `new EventSource('/api/events')`; on message, re-fetch `/api/state`,
   rebuild the tree, and `render()` — **preserving `viewRoot` and `selId`** so the user's drill/
   selection survives an agent's update.
5. **(Demo) heat buttons → status.** The reference's calm/warm/hot buttons can `POST /api/status`
   so the UI itself exercises the agent path. In production, real agents drive status.

Everything else in the renderer (squarify, drag, focus-level, drill, animation) is unchanged.

### 4.6 The honest cost of v1

"Serve it on a port for the monitor and agents" crosses from *a file on disk* into *a small server
with a network surface*. On a trusted LAN that's fine with no auth. **Before exposing the write
port beyond your network, set `TILEMON_TOKEN`** (the scaffold guards both write routes with a
bearer token when it's set). A read-only office monitor is harmless; an open write port on the
internet is not.

---

## 5. Roadmap

Each stage adds a **source type** or a **deployment**, behind the same seam. Nothing earlier is
thrown away.

- **v0 — prototype.** In-memory, manual heat. **Done** (it's `dashboard-reference.html`).
- **v1 — the npx file-source tool.** This spec. Proves the agent loop end-to-end with minimal
  plumbing. Local, monitor-friendly, shareable.
- **v2 — Jira as a second (read-only) source.** Adapter maps epic→story→subtask to the tree and
  Jira status → TileMon status. **Needs zero new auth on the write side** (Jira owns writes).
  Weight lives in your layer keyed by ticket id. You already have Atlassian connected; one project
  (`FO`) is the test case — `state.forty.json` is that project, pre-converted.
- **v3 — real push.** Swap polling/file-watch for webhooks/SSE from sources. Renderer unchanged.
- **v4 — mounts.** Mount another TileMon instance as a source (tree-of-trees; per-team boards
  under your master root). Heat rolls up across mounts for free.
- **v5 — hosted multi-tenant (optional).** Next.js + Neon (Postgres) + Clerk. The Neon-backed
  store is just *another implementation of the source interface*; the renderer doesn't change.
  Tree storage: adjacency list keyed by `(tenant_id, node_id, parent_id, weight, status)`.
  **All the hard problems (auth, isolation, concurrent writes) land here, last, on purpose** —
  after the model is proven. Don't build this to find out if you want it.

The reframe that keeps you sane: **the board is the foundation; Jira/hosting are plugins you may
never need.** v1 + v2 may be the entire product for one person.

---

## 6. Auth, stated once

- **Human** authenticates to the UI (none in v1/local; Clerk in v5). Full read/write incl. weight.
- **Agent** authenticates to the *status* endpoint with a bearer token (the `TILEMON_TOKEN` in
  v1; a generated, hashed, revocable key per tenant in v5). The key scopes **capability, not
  identity** — it can only do status writes, by construction. One board-wide key is safe precisely
  because it *can't* reach weight or structure.
- In v5: store only a **hash** of each key, show plaintext **once**, support revoke/rotate.

---

## 7. Open decisions (need your call; my lean noted)

### 7.1 Addressing: path vs id **[OPEN]**
Agents address nodes by dotted **stable ids** (`work.ship-v2.data-migration`). Stable ids survive
renames; the display `name` can change freely. The cost: if you *move* a node to a new parent, its
path changes, and an agent targeting the old path breaks. **Lean:** ids are stable and
rename-safe; moving a node is rare and a conscious act, so accept that moving requires updating the
agent. Do **not** key on display name.

### 7.2 Can an agent *create* nodes, or only update existing ones? **[OPEN]**
- *Update-only* (safer, simpler): the human lays out the tree; agents only flag status within it.
- *Create-allowed* (more powerful): an agent discovers new work and adds a leaf (born small).
  Needs upsert-by-path for idempotency, and means the key can grow your tree.
**Lean:** v1 update-only (smallest surface, proves the loop). Add guarded create in v2 if you want
agents populating, not just flagging.

### 7.3 Status vocabulary **[OPEN, low stakes]**
v1 uses `todo | in_progress | blocked | done`. Only `blocked` is "hot" and only `done` drops off.
Note from real data: **your Jira has no `blocked` status** — so nothing is ever truly hot today.
If you want the nag, your workflow needs a status that *means* "needs me." **Lean:** keep the
four-value vocab; add a `blocked`/`needs-me` status to your Jira workflow so v2 has something to
glow on.

### 7.4 Stable positions vs maximal squareness **[OPEN, taste]**
Current: squarest packing, positions re-sort on resize (animated). If glance-stability on the
monitor matters more than squareness, switch to fixed-order packing (one line — remove the sort).
**Lean:** keep squarest for now; revisit after living with it on the real monitor.

---

## 8. Naming

Working name: **TileMon** (attention + tile) — names the *resource* the whole tool allocates
(attention), is distinctive/ownable, and has headroom beyond "nag me about Jira." Runner-up for a
purely-personal build: **Nagtile** (snappier, but names the nag layer, which is a feature on top,
not the core). Other live candidates checked but not chosen: Heedtile, Mattertile, Priotile.
Domain availability was not confirmable (shared GoDaddy quota was exhausted) — check
`tilemon.com` / `.io` / `.app` before committing.

---

## 9. TL;DR for the first commit

1. `npm init` around the provided `package.json` + `server.mjs`; rename
   `dashboard-reference.html` → `dashboard.html`.
2. Apply §4.5 (feed the renderer from `/api/state`, add SSE refresh, POST weight on drag-end,
   status→heat adapter).
3. `node server.mjs ./state.forty.json` → open the browser → drag your real epics around, watch
   it persist to the file.
4. Write a 10-line agent script that `POST`s `{path, status:"blocked"}` and watch the tile glow
   live. That's the whole thesis, working.
5. Everything after that is a new **source type** behind the same seam.
