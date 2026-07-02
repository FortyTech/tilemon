---
name: tilemon
description: Report task/agent status to a Tilemon priority board (todo/in_progress/blocked/done) so it shows live on the always-on board, and bootstrap boards for a project. Use when you start, block on, or finish a tracked task, or when asked to set up Tilemon for a project. Requires a running Tilemon server (npx tilemon).
---

# Tilemon — report status to the board

Tilemon is a zero-sum treemap priority board: importance is on-screen area, the human owns the
weights, and **agents set status**. Blocked work glows. Your entire integration is **one HTTP
POST**, and it **upserts** (creates the board and any missing nodes on first write), so you can
register your own work as you go.

## Reporting status (the core — this is 95% of it)

1. **Find the board.** Use `$TILEMON_URL`, else `http://localhost:4000`. If nothing answers
   there, the board isn't running — tell the human, don't guess.
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

## Bootstrapping a project (setup)

When asked to **set up Tilemon for a project/workspace**, structure and importance are the
human's to decide — but don't make them author it cold. Run a **propose-first dialogue**: you
draft, they react. Reacting to a wrong draft is far easier than answering "how do you want to
group these?" from nothing.

The loop:

1. **Survey and mine every grouping signal** so the first draft is ~80% right and the human is
   *editing*, not authoring. In priority order: an explicit tag (a manifest `group:` field),
   then directory structure (nested folders → nested groups), then a categorised doc (e.g. a
   project index in a `CLAUDE.md`). For a first-cut at **weight**, lean on activity/recency —
   but say you've done so; it's a guess for them to correct.
2. **Propose a concrete strawman**, not questions: a board per project (or sub-project) grouped
   into a few named, weighted buckets. Show it, and only ask where the draft is *genuinely*
   ambiguous ("these five could be their own bucket or fold into Products — which?").
3. **React → redraft → confirm.** Each round, rewrite the master board JSON directly — the
   server watches the folder and live-reloads, so they literally watch buckets rearrange as you
   talk. The **master board file is the wizard's state**; there is no side artifact and no
   separate "commit" step — the moment they're happy, it's already done.

Structure — `include` nodes, groups, weights — is human-owned and *not* creatable via
`POST /api/status`, so you **author the JSON files directly** in the boards folder (default
`./.tilemon/`):
- `.tilemon/<slug>.json` per project (a `native` board; may start empty or seeded with items).
- `.tilemon/tilemon.json` — the master/home board (`toolbar: true`), whose children are the
  weighted **bucket groups**, each containing `include` nodes pointing at the project slugs.

Re-running reconciles: read the existing `tilemon.json` (respect the human's arrangement +
weights) plus the current project list, and only **add what's missing** — never clobber. New
projects drop into a sensible bucket or you ask where they go.

A board file:
```jsonc
{ "name": "Portfolio", "toolbar": true, "source": "native", "children": [
  { "id": "products", "name": "Products", "weight": 3, "children": [
    { "id": "chessku", "name": "Chessku", "weight": 1, "include": "chessku" },
    { "id": "eulogy",  "name": "EulogySong", "weight": 1, "include": "eulogy-song" } ] },
  { "id": "internal", "name": "Internal", "weight": 1, "children": [
    { "id": "scout", "name": "Client Scout", "weight": 1, "include": "client-scout" } ] }
] }
```

This dialogue is the **cold-start** path — bulk-shaping many things from nothing, where
reacting-to-a-draft beats dragging tiles. Ongoing maintenance is different: reweight by dragging
in the UI, and (once built) move/regroup with in-app structure ops. Ongoing *status* updates use
`POST /api/status` (above); only the initial structure is authored here.

## Activation note

This skill is passive — it tells you *how*, not *when*. To make reporting routine, the project's
own agent instructions should say something like: "when you block on or finish a board-tracked
task, flag it via the tilemon skill."
