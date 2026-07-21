# Reconcile routing — session-scoped, inventory-matched

**Status:** proposed (spec only, no code yet)
**Touches:** `reconcile.mjs`
**Problem it fixes:** the Stop-hook reconciler writes every tile to the wrong board.

## The bug

`reconcile()` picks its board from the working directory:

```
cwd    = CLAUDE_PROJECT_DIR || input.cwd || process.cwd()
board  = opts.board || resolve(cwd)     // longest dir-prefix match
```

For a workspace session, `CLAUDE_PROJECT_DIR` is the repo **root**
(`/home/ai/forty-workspace`), whose board is `forty-workspace`. So *every* tile
this session infers — Blastgeist, the FFF email, the FortyTech offer,
social-content — is posted to `forty-workspace`, even though each has its own
board already `include`d into the `tilemon` home view. The judge prompt is
hardwired single-board (`board '${board}'`, "Consider only THIS project"), and
the write loop posts every decision to that one board.

## Why not "route by git"

The obvious fix — read `git status` across the workspace and route each changed
repo to its board — is **wrong under concurrency**. Git state is shared: a Stop
hook firing for session A would see session B's uncommitted work in another repo
and update a board A never touched. The routing signal must be **per-session**,
not global.

## The one hard rule

**Decide solely from *this* session's transcript.** The transcript is the only
per-session record of what this session did — no other session's work appears in
it. That single constraint is what makes concurrency safe: session A can't write
a `gap-form` tile unless A's own transcript is about `gap-form`. Everything below
is routing *within* that boundary. There is deliberately **no "must have changed
a file" gate** — the tool's whole purpose is surfacing pending decisions, which
change no files.

## The flow

### 1. Inventory (scripted, no model)

Fetch the full board + tile inventory from the server (`GET /api/boards`, then
each board's tree — or a single aggregate endpoint if added). This is plain code.
It gives the judge two things: the list of boards that exist, and the existing
tiles to match against (so it updates in place instead of duplicating).

### 2. File-path hint (deterministic, no model)

Scan this session's transcript JSONL for tool-use paths — `Edit`/`Write`/`Read`/
`NotebookEdit` → `input.file_path`; `Bash` → its `cwd`. Map each to a board by
longest-dir-prefix (`GET /api/resolve?dir=`). This yields "boards this session
edited files in." It is a **confidence hint only**, not a filter: it raises the
judge's confidence for those boards. (Note: the existing `transcriptTail` keeps
only text blocks — this is a separate pass over tool-use entries.)

### 3. Judge marries transcript ↔ inventory (one model call)

Give the judge: the transcript, the inventory, and the file-path hint. It decides,
for each thing needing the human (a pending decision, a block, a done), which
existing tile to update or — only on clear evidence — which board to create a new
tile on. Output decisions tagged with `board` and a stable `path`:

```json
[{ "board": "blastgeist", "path": "biomes", "status": "waiting", "note": "…", "name": "…" }]
```

Matching against real existing tiles is the dedup mechanism: it collapses the
"E2E Trade" ×6 duplicates on the `doefin` board, because the judge sees the tile
already exists and reuses its `path` rather than minting a new label each run.

**Precision, by nudge not gate:** the prompt says *prefer updating an existing
tile; create a new one only when the session clearly did work on that board.*
This stops it flagging a board merely mentioned in passing. False positives are
reversible and visible to the human — a nudge, not a mechanical block.

### 4. No match → park on root + alert

If a genuinely new tile matches no board (e.g. a brand-new project with no board
yet), the judge writes it to the **root of the home board** (unbucketed) and the
reconciler **prints a line to the caller**: *"parked 'X' on root — no board
matched; create a bucket for it."* That is the human's cue.

**TileMon never creates boards or buckets** — structure is the human's, per the
existing design (agents set status only). The human creates the bucket and moves
the card. It then **self-heals**: next session, step 1's inventory contains that
tile in its new bucket, the judge matches to it, and updates it *in place* — it
does not re-park on root, because a match now exists. The alert fires only for
genuinely unmatched new tiles, not every run.

### 5. Write, with a safety gate on the board

In the `POST /api/status` loop, post `{board: d.board, path, status, note, name}`
per decision. Gate: `d.board` must be a real board from the inventory (or `root`).
This makes a hallucinated board name structurally impossible to write — it can
only ever write somewhere that exists.

## Concurrency property (the whole point)

Everything the judge decides comes from *this* session's transcript, and the
inventory is read-only reference context (reading it can't make A act on B's
work). So two sessions running at once never collide: A editing `repos/tilemon`
and B editing `gap-form` update strictly their own boards.

## Node-path stability

Reusing an existing tile's `path` (step 3) is the primary dedup. As a fallback
for brand-new tiles, derive `path` from a stable key, never a mood-of-the-moment
label: tracked git state → `git`; a ticket → its id lowercased (`scrum-300`);
else the changed top-level module/dir.

## Limitations (honest)

- **Bash-driven edits under-report the hint.** `sed`/`echo >` carry no clean
  `file_path`, so the step-2 hint may miss a touched dir. This only weakens a
  *hint*, not correctness — the judge still routes via transcript content +
  inventory, and the interactive `tilemon flag <board>` path stays the primary,
  fully-explicit writer. This reconciler is the backstop.
- **Cost.** One inventory fetch + one model call per Stop. No per-board fan-out.

## Out of scope

- No structural change: the `tilemon` home board's buckets/includes already
  exist and are correct. This only fixes *which board a tile is written to*.
- The one-time re-home of the ~12 already-misplaced `forty-workspace` tiles
  (via `/api/move`) is a **separate** follow-up, done after this lands — else the
  next Stop refills root.

## Acceptance

1. A workspace-root session that edits only `repos/tilemon` writes tiles to the
   tilemon board, **not** `forty-workspace`.
2. A session touching two repos writes to exactly those two boards.
3. A pure-decision turn (no files changed) still surfaces its tile, on the
   matched board — not dropped.
4. Two concurrent sessions in different repos never write each other's boards.
5. Re-running a Stop on unchanged work updates the *same* existing tile, no
   duplicate.
6. A new project with no board yet lands on root and prints the "no board
   matched" alert; after the human buckets it, the next Stop updates it in place.
