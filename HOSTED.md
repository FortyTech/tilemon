# HOSTED.md — TileMon on tilemon.com (v5 design)

The hosted, multi-tenant version. This is **SPEC §5, v5** fleshed out. Read
[`SPEC.md`](./SPEC.md) for the locked model and [`CLAUDE.md`](./CLAUDE.md) for the shipped
local tool; this doc is the design for the cloud version and **supersedes two locked spec
points** (recorded in §11 below).

The whole reason this exists: **your PC is off.** The local `npx` tool serves a board off a
JSON file on your machine — great for a monitor on your desk, useless when the machine is
asleep. Hosted puts the data and the server in the cloud so agents on any machine can write
to it and the board is reachable from any browser, always.

---

## 1. The one thing that changes

**Where the data lives.** Nothing else about the product changes. In the local tool a board
*is* a `<slug>.json` file and `server.mjs` reads it; hosted, a board *is* a row in Postgres
and a Next.js route reads it. The renderer, the tree shape, the status vocabulary, the
include/mount semantics, the agent's `flag` command — all identical. That faithfulness is the
point of the "renderer over a source" architecture: the DB is just another source behind the
same seam.

```
 LOCAL (v1)                         HOSTED (v5)
 ─────────────────────────          ─────────────────────────────
 board.js        (renderer)   ==    board.js            (renderer, verbatim)
 dashboard.html  (adapter)     →    Next.js page        (adapter, Clerk-gated)
 server.mjs      (file I/O)    →    Next.js API routes  (Neon I/O)
 <slug>.json     (a board)     →    boards row          (a board)
 TILEMON_TOKEN   (one secret)  →    per-tenant API keys (hashed, revocable)
 (no login)                    →    Clerk               (humans)
```

## 2. Components

Standard workspace stack (see `STACK.md`), which the local tool deliberately *doesn't* use:

- **Next.js on Vercel** — serves the board UI and the API. Replaces `server.mjs`.
- **Neon (Postgres)** — stores boards. Replaces the JSON files. Always-on, serverless.
- **Clerk** — human auth + tenancy (user or org = tenant). Agents don't use Clerk; they use
  API keys.
- **`board.js`** — reused **verbatim**. It already talks to its host only through
  `mount(..., { state, onWeightChange, onStatusChange, onOpenBoard })`; the hosted page wires
  those callbacks to server actions instead of `fetch('/api/…')` to a local port.

## 3. Data model

**One row per board. The tree is a JSON column. There is no `parent_id`.** (The old §5 sketch
said adjacency list keyed on `parent_id` — that's wrong; see §11.)

```sql
create table boards (
  slug        text not null,              -- the board's own id
  tenant_id   text not null,              -- Clerk user or org id (the owner)
  name        text not null,
  source      text not null default 'native',   -- 'native' | 'jira://<project>'
  visibility  text not null default 'private',   -- 'private' | 'unlisted' | 'public'
  tree        jsonb not null,             -- nested nodes; a node may hold { include: "<slug>" }
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, slug)
);
```

`tree` is exactly today's board JSON: nested nodes with `children` arrays, each node carrying
`id / name / weight / status / note / seen`, and mount nodes carrying `include: "<slug>"`.
Every read/write is scoped by `tenant_id` — that is the entire multi-tenancy story.

### Why the tree is a blob, not normalised rows

A board is small (tens–hundreds of nodes) and is always read and written **whole** — the
renderer eats the entire tree. Shredding it into a `nodes` table buys nothing and reintroduces
exactly the `parent_id` back-reference we're removing. Store the board as the document it
already is. (If a board ever grew huge we'd revisit — not a v5 problem.)

### Hierarchy has two directions, stored differently

1. **Nodes inside a board** — a tree; the parent holds its `children`. Never child→parent.
2. **Board contains board (mount/include)** — the parent board has a node
   `{ include: "<child-slug>" }`. The reference lives **entirely in the parent**. The child
   board's row stores nothing about being included.

Consequences of the child storing nothing (this is the whole model, and it's what you
asked for):

- A child board is **independently top-level** — it's a normal board in its own right.
- It's **oblivious** to being mounted; it has no back-pointer.
- The **same** child can be included by **many** parents at once (multi-parent).
- The only hard rule is **acyclic**: B can't include A if A already includes B. Guarded at
  write time (walk the include graph before allowing an include/move), exactly as the local
  server does today.

## 4. Two writers, two credentials

The local tool has one unscoped `TILEMON_TOKEN` that authorises *every* write route. Hosted
keeps that model — **ratified (2026-07): one key does everything.**

| Writer | Auth | Can write |
|---|---|---|
| **Human** (you, in the browser) | Clerk session | everything — status, **weight**, **structure** (add/move/rename/delete boards & nodes) |
| **Anything with a key** (agent, CLI, wizard, script) | API key (bearer) | everything, on boards owned by the key's tenant — same capability as a session |

A capability-scoped split (status-only agent keys vs full keys) was designed and **rejected**:
it forces the owner to mint and juggle two keys, and the npx wizard needs structure writes over
a key anyway. Blast radius is bounded by the tenant — a key can only touch its owner's own
boards. Revisit scoping (as an *opt-in* restriction at mint time, or a device-flow CLI login)
only if keys are ever handed to less-trusted parties than the owner's own agents.

**The owner id is just Clerk's `userId` — decided. There is no separate "tenancy" system, now
or maybe ever.** Every board row carries `tenant_id = userId`, stamped from Clerk on write;
every query filters on it. That *is* the isolation — if a second account ever exists, its boards
are already separated, with nothing to migrate. So "add multi-tenancy later" is a non-event: the
scoping is present from day one by virtue of using `userId`.

Dedicated multi-tenancy machinery (teams, orgs, shared boards) is **not** being built and may
**never** be needed — this is plausibly a single-user product (you) forever. The *only* future
scenario that touches this is wanting several humans to share edit access to one board; that's a
Clerk **org** id in the same column instead of a user id — still no schema change. Until then,
`tenant_id` holds a `userId` and the word "tenant" is just what the column is called. The one
discipline that keeps that door open for free: routes resolve "who owns this board" through the
id, never a hard-coded single user — costs nothing, so do it.

### API key lifecycle

- Generate in board settings → a random key, shown **once**.
- Store only a **hash** (e.g. SHA-256) + a label + `created_at` + `last_used_at`.
- Revoke / rotate any time (delete the hash row).
- Scoped to the tenant; every `/api/status` call resolves the key → tenant → allowed boards.

```sql
create table api_keys (
  tenant_id   text not null,
  key_hash    text not null,        -- sha256 of the plaintext; plaintext never stored
  label       text,
  created_at  timestamptz not null default now(),
  last_used_at timestamptz,
  primary key (key_hash)
);
```

## 5. The agent write path

The client CLI does not change shape — only the target URL and the credential:

```bash
# local today
tilemon flag <board> <path> <status> "<note>"          # → http://localhost:4000

# hosted
TILEMON_URL=https://tilemon.com TILEMON_KEY=sk_live_… \
  tilemon flag <board> <path> <status> "<note>"        # → https://tilemon.com/api/status
```

`flag` already bakes in `$TILEMON_URL` (else `:4000`) and fail-loud verification (it checks
the response landed). Pointing it at the hosted API is a config change, not a code change. The
route handler: verify key → resolve tenant → upsert the node's status/note in that board's
`tree` → bump `updated_at` → return `{ok:true}`.

Upsert semantics are preserved: POSTing a status to a not-yet-existing path creates the board
and any missing path nodes (born small), so an agent can populate an empty hosted board from
scratch — same as local.

## 6. Reading + live updates

**Read:** the Clerk-gated board page loads `GET /api/state?board=<slug>` (tenant from the
session), which returns the resolved tree (see §7), and mounts `board.js`.

**Live update — decision: poll first.** Vercel serverless functions can't cheaply hold the
long-lived SSE connection the local server uses. The board is an ambient monitor, not a
trading screen — a few seconds' latency is fine. So v5.0 **polls** `GET /api/state` every
~3–5s (cheap: one indexed row read, `updated_at` lets us 304 when nothing changed). Real push
(SSE via edge streaming, or a managed realtime channel) is a later upgrade behind the same
adapter seam — the renderer never knows the difference. **[decision: polling for v5.0]**

## 7. Include resolution (mounts) at read time

When assembling a board's state for the renderer, the server walks the `tree`; for any node
with `include: "<slug>"` it fetches that board's row (same tenant), rolls up its heat, and
emits a summary tile — **the child is never inlined**, exactly as `server.mjs` does today. The
child board is fetched read-through; it has no idea it was rendered inside a parent. Cycle
guard runs on the include graph. Because the reference lives on the parent, resolving A and
resolving C can both pull in B independently.

## 8. Where weight and attention rules live

- **Weight** is part of the board `tree` (a node's share vs. its siblings), owner-editable via
  the human/structure routes. It travels with the board. **One weight map per board — decided.**
  Per-viewer weight overlays (different people seeing the same board with their own layout) are
  explicitly *not* built; there's a single layout, the owner's.
- **Attention rules** (`attention.md`) stay **operator-side and do not move to the server.**
  They're executed by *your* agents, wherever they run, which then POST status in. The hosted
  board is a dumb recipient of those POSTs — it never runs your rules. This keeps the
  personal-lens layer (like weight) off the shared data, and means hosting adds no
  rule-execution surface.

## 9. Migrating a local board up

A local `state.json` / `<slug>.json` **is** the `tree` value — same format. "Import" is: read
the file, `insert into boards (tenant_id, slug, name, source, tree)`. So the upsell button is
literally "host the board you already have," no transform. Includes come across as-is (their
referenced boards import as sibling rows).

## 10. Visibility / sharing

**v5.0 is private-only — decided.** Every board is Clerk-gated to its owning tenant; no public
or shared-link boards to begin with. The `visibility` column still ships (default `'private'`)
so the later options don't need a migration, but only `'private'` is implemented.

Later, if wanted, `'unlisted'` (anyone with the link can view, read-only) and `'public'`
(unlisted + discoverable) are cheap to add: the renderer is the same, just mounted with no
write callbacks (`onWeightChange`/`onStatusChange` omitted) — `board.js` already supports a
read-only mount. Not now.

## 11. Supersedes these SPEC.md [LOCKED] points

1. **Mounts are multi-parent, not single-parent.** SPEC §3 says a mount is
   *"read-through, single-parent, acyclic."* The reference-lives-on-the-parent model makes the
   child oblivious, so the same board can be mounted under many parents. **Keep `acyclic`;
   drop `single-parent`.**
2. **Storage is one-row-per-board JSONB, not a `parent_id` adjacency list.** SPEC §5's v5 line
   (`adjacency list keyed by (tenant_id, node_id, parent_id, weight, status)`) is replaced by
   `boards(tenant_id, slug, …, tree jsonb)` (§3). `parent_id` is wrong because it forces the
   child to know its (single) parent — the opposite of the mount model.

## 12. Build order (first concrete steps)

Everything stacks on proving the read path; auth and agent-writes come after.

1. **Scaffold** Next.js + Clerk + Neon in `repos/tilemon-cloud` (separate private repo — see
   below). Consume the renderer straight from the **published npm package** — `tilemon` is on
   npm (`^0.11`, 0.12 imminent); `board.js` is in its `files`, so a client component does
   `import { mount } from 'tilemon/board.js'`. No vendoring. (Optional later tidy: add an
   `exports: { "./board": "./board.js" }` map to the `tilemon` package so the import is
   `tilemon/board` and the CLI-only files aren't reachable — cosmetic, not blocking.)
2. **One board renders from Neon behind a login.** Seed one `boards` row by hand; the page
   loads it via `/api/state` and mounts the renderer. No writes yet. *(This is the
   "board renders from Neon behind Clerk" milestone.)*
3. **Human writes** — wire the structure/weight/status routes to the session; drag-to-resize
   and add/move persist to `tree`.
4. **API keys + agent status route** — generate/hash/revoke; `/api/status` accepts a bearer
   key; point the local CLI at `TILEMON_URL=https://tilemon.com`.
5. **Includes** resolved at read time (multi-parent, acyclic).
6. **Polling live-refresh**, then visibility/import.

### Repo split

Open-core, as discussed: **`tilemon`** stays the public repo (the renderer + npx tool, already
published to npm as `tilemon`); **`tilemon-cloud`** is a new **private** repo that consumes it as
an ordinary npm dependency. The renderer is client-side JS with no moat to protect; the value
that's worth money is the hosting, auth, and non-native sources — that's what stays closed.

---

## What explicitly does NOT change

`board.js`. If a change to the hosted version needs the renderer edited, that's a smell — the
seam has leaked. The renderer takes a tree and fires callbacks; it must not learn that Neon or
Clerk exist.
