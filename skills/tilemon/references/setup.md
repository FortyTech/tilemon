# TileMon — setting up a board (bootstrap)

Read this **only when you're setting up / bootstrapping TileMon for a project or workspace**, or
growing an existing board with a new project. Routine status reporting doesn't need any of this —
that's the hot path in `SKILL.md`. Setup builds **structure**, which is the human's to own: you
propose, they decide, you build through the API.

Everything here runs **through the live server's API**, never by hand-authoring JSON. Ensure the
board is up first (`npx tilemon --daemon` if nothing answers on `:4000`) — setup writes through the
API, so the server must be running before you survey.

## Addressing convention: a board per project, grouped into buckets

- **Each project is its own board** (slug = its repo/project name). Agents working a project report
  to *that* board.
- The human's **master board `include`s the project boards**, so the whole portfolio is one
  glanceable view with heat rolling up.
- Projects are **bucketed into weighted groups** on the master (e.g. `Products`, `Clients`,
  `Internal`) — a group tile that contains the project includes. Bucket weight = its importance (its
  size on screen).

## One board across many repos (same machine)

A board can span **multiple repos/workspaces on one machine** — run a single shared server instead
of one per project:

- **Run one server on the default machine-wide board** — `npx tilemon --daemon` serves `~/.tilemon`,
  the default. Every agent, in *any* local repo, already targets `http://localhost:4000`, so they
  all report into that one board. Don't start a second server (and don't use `--project`, which
  scopes a board to a single repo) — everything converges on `~/.tilemon`.
- **When setting up, survey every root the human names** (e.g. `~/work`, `~/side-projects`), not just
  the current directory — a board per project across all of them. A **bucket per workspace** is
  usually the natural top level.
- **Different machines can't share a `localhost` board** — that needs a hosted TileMon (not yet
  built). For now, one machine = one shared local board; treat cross-machine as out of scope and say so.

## The wizard — two required steps

When asked to **set up TileMon for a project/workspace**, structure and importance are the human's to
decide — but don't make them author it cold. Run a **propose-first dialogue**: you draft, they react.
Reacting to a wrong draft is far easier than answering "how do you want to group these?" from nothing.

Run setup as a **wizard with two required steps**. At each step you present, then **STOP — end your
turn and wait for the human's reply.** Don't blow through a step: don't build structure before Step 1
is answered, and don't consider setup finished before Step 2 is answered. These are hard pauses, not
"invite corrections and keep going." The steps: **(1) the buckets, (2) what should get their attention.**

The loop:

0. **Ensure the board is running** (`npx tilemon --daemon` if nothing answers on `:4000`). Do this
   before surveying so you're never blocked halfway.
1. **Survey the workspace and mine every grouping signal** so the first draft is ~80% right and the
   human is *editing*, not authoring. In priority order: an explicit tag (a manifest `group:` field),
   then directory structure (nested folders → nested groups), then a categorised doc (e.g. a project
   index in a `CLAUDE.md`). Survey the *workspace's own* signals — never TileMon's source. **Do NOT
   guess weights** — importance is the human's (see below).
2. **STEP 1 — the buckets (your board's layout).** Present your proposed grouping as a **table, one bucket per row** (rows, not
   columns — there can be many buckets):

   | Bucket | Projects |
   |---|---|
   | Products | webapp, api, mobile |
   | Clients  | acme, globex |
   | Internal | docs, scripts |

   Propose the **grouping only** (which projects sit in which bucket) — not sizes/weights. Then **STOP
   and wait.** Build **nothing** until the human has confirmed or corrected the table.

**Keep the surface coarse — this is the cardinal rule.** Bootstrap builds *structure* (buckets +
project boards), **not a task list.** Do NOT seed granular tasks/tickets — that makes the board busy
and *costs* the human attention, the one thing the tool exists to protect. Detail belongs in
drill-down and arrives naturally as agents flag their live work. If the board ever feels busy, the fix
is to *subtract*, not add.

3. **Only after Step 1 is answered, build it** through the server's API (below), not by writing files.
   The server live-reloads, so the human watches the board fill in as you go.

### Weight/importance is the human's — do NOT set it

Build everything at the default (equal) weight and leave allocation to the human, who spends the
importance budget by dragging tiles. That's the whole premise: importance is theirs to assign, not
yours to guess. There is deliberately **no `weight` command** — importance is the human's drag
surface, not something a script should reach for. The *only* time you set a weight is when the human
**explicitly tells you** a number ("make Products the biggest") — then you're just their hands, and
you POST it raw as the one documented exception:

```bash
curl -s -X POST ${TILEMON_URL:-http://localhost:4000}/api/weight \
  -d '{"board":"tilemon","path":"products","weight":3}'   # add -H "Authorization: Bearer $TILEMON_TOKEN" if a token is set
```

Otherwise never touch it.

### Build it with the setup commands — never hand-author the JSON

Structure is human-owned and can't be created via `tilemon flag`; use the setup commands below. These
are **setup-only** — a routine reporting agent never touches them (that's why they live here, behind
the door you only open when bootstrapping). Order: create the project boards, make the buckets on the
home board, then include the boards into their buckets. New nodes are born at weight 1 (equal) — the
neutral starting point you want. Each command is verified (exits non-zero if the write didn't land),
so you never guess whether structure was created.

```bash
# 1. a board per project (bare; prints its slug). ALWAYS pass --dir = the project's absolute folder —
#    that's the folder↔board link. It lets any agent later `tilemon resolve` that folder to this board
#    with certainty, instead of guessing a slug or inventing a duplicate.
tilemon add-board "Webapp" --slug webapp --dir /home/you/work/webapp
tilemon add-board "API"    --slug api    --dir /home/you/work/api
# 2. buckets on the home board (a bucket is just an item you add into); "tilemon" is the seeded home board
tilemon add-item tilemon "Products"                 # node id derived from the name -> "products"
# 3. include the EXISTING project boards into the bucket (born at weight 1 — DON'T set weights)
tilemon include tilemon webapp --path products
tilemon include tilemon api    --path products
# then: leave weights equal — the human drags to allocate importance.
```

Node ids are derived from the name/slug (bucket "Products" → `products`, an include of `webapp` →
`webapp`), so address children as `products.webapp`. Re-running reconciles: run **`tilemon state
tilemon`** first, respect what's already placed and its weights, and only add what's missing — never
overwrite the human's arrangement.

This dialogue is the **cold-start** path — bulk-shaping many things from nothing, where
reacting-to-a-draft beats dragging tiles. Ongoing maintenance is different: reweight by dragging in
the UI, move/regroup via `/api/move` (no command — regrouping is the human's UI surface). Ongoing
*status* updates use `tilemon flag` (the hot path in `SKILL.md`); only the initial structure is built
here.

## STEP 2 — what should get your attention (write attention.md)

The board only earns its keep once it knows what deserves *their* attention, so this is a **required
step**, not an afterthought: after the structure's built, **STOP and directly ask** the human what
they want surfaced, offering a few concrete examples to react to — then **wait for their answer**
before you finish. **Setup is NOT complete until you've asked and recorded a reply** (even if the
reply is "none for now"). Never leave `attention.md` blank because you skipped the question. Same rule
as weights: you **elicit and record, you never impose or guess.**

`~/.tilemon/attention.md` is organised **by status**: one heading per status, and each heading
**defines the bar** that status must meet. The template already ships those definitions — including a
deliberately strict **Definition of Done** ("finished AND confirmed by me, or independently verifiable;
never done just because it was built or 'should work'"). **Keep that DoD bar high** — a false `done`
makes a pending item silently vanish from the board, the one thing the tool must never do. So Step 2 is
about the *triggers* the human wants slotted under each status, not redefining the statuses.

First, name the part that's automatic and needs no rule: **an agent that needs the human already
flags it** — `waiting` for a decision/input, `blocked` when something's wrong. Then present this
**menu** (they pick which apply, edit wording, or add their own); each chosen line goes as a bullet
**under its status heading** in `~/.tilemon/attention.md`:

| Candidate trigger | Under status |
|---|---|
| Uncommitted or committed-but-unpushed work parked a while | `waiting` |
| Failing tests / a red CI run | `blocked` |
| An open PR awaiting your review (or yours blocked on changes) | `waiting` |
| Any obvious security issue (e.g. a vulnerable dependency) | `blocked` |
| An urgent item from a connected tool (email / Slack / tickets) | `waiting` |

Then **also ask, in plain free text, whether anything is specific to particular repos or areas** —
e.g. *"Is there anything special you'd want flagged for specific projects — something one repo needs
watching for that the others don't?"* Record those under a `# board: <slug>` section (with its own
`## <status>` sub-headings).

A rule is only useful if the reconciler can actually *check* it — bounded by what's available (git is
always there; PRs/CI need `gh`/CI access; email needs an MCP), so treat the menu as candidates, not
guarantees. Write the chosen triggers under their status headings. If they genuinely want none yet,
leave the shipped definitions as-is (the DoD alone already earns its keep) — but you must have *asked* (Step 2).

## Then install the hooks — start + stop (core plumbing, opt-out)

The board staying current depends on these, so **install them by default as part of setup** — core
plumbing, not optional extras. **Don't ask a yes/no**: add them, then tell the human you did and how
to opt out (delete the entries from `.claude/settings.json`). Only skip if they told you not to. Both
are Claude-Code-specific (other setups push however they push). Neither hook *writes* a tile itself — a
dumb script can't know which of the human's boxes is "the one you're handling" (that's a judgement).
Instead they bracket your turn: **start** shows you what's glowing so you can mute the right box,
**stop** makes you flip it back before you hand control back:

- **`UserPromptSubmit` "start" hook** — fires the moment a prompt arrives, *before* work begins,
  fetches the currently-glowing boxes (`GET /api/state?glowing=1`) and prints them into your context. You
  then MUTE the one you're picking up (set it `in_progress`) as your first action. Read-only,
  fire-and-forget with a hard timeout, so it can never add latency or hang the turn.
- **`Stop` hook** — fires when you pause/hand back, and makes you flip any box you muted back to
  `waiting`/`blocked`/`done` (a muted box left behind reads as "handled" when it isn't) and apply
  `attention.md`.

Write `.claude/hooks/tilemon-start.mjs` (Node, no extra deps) — it only *reads* and prints; the muting
is your first action, not the hook's:
```js
#!/usr/bin/env node
// TileMon start hook (UserPromptSubmit) — READ-ONLY. Shows the agent what's currently glowing
// (waiting/blocked) so it can MUTE (set in_progress) the box it's picking up as its first action.
// Writes nothing itself. Fire-and-forget with a hard timeout so it can never slow or hang the turn.
let s = ''; process.stdin.on('data', c => (s += c)).on('end', async () => {
  const url = process.env.TILEMON_URL || 'http://localhost:4000';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 800);   // cap the whole thing — the turn is never blocked
  try {
    const r = await fetch(`${url}/api/state?glowing=1`, { signal: ctl.signal });
    if (!r.ok) return;                                  // server down / error → show nothing
    const items = (await r.json()).items || [];
    if (!items.length) return;                          // nothing glowing → say nothing
    const list = items.map(i =>
      `  - [${i.status}] ${i.board} / ${i.name}${i.note ? ' — ' + i.note : ''}  (${i.board} path: ${i.path})`).join('\n');
    process.stdout.write(
      `[TileMon] Boxes currently glowing (waiting on the human):\n${list}\n` +
      `If your work handles one of these, MUTE it as your first action — set it to in_progress via the ` +
      `tilemon skill (POST /api/status), which turns its glow off while you work. Flag any NEW blocker as ` +
      `waiting/blocked when you hit it. Don't create a tile just to say you're busy.\n`);
  } catch { /* server down / timed out → show nothing */ }
  finally { clearTimeout(timer); process.exit(0); }
});
```

The **Stop** hook needs no bespoke script — it's the packaged command **`tilemon reconcile`** (the
attention.md executor). On stop it resolves this folder's board, gathers ground-truth facts (git/gh)
plus the recent conversation, hands them to a sealed **tool-less** `claude -p` that decides which tiles
should change against the operator's status definitions, and POSTs the result. It is **non-blocking and
near-silent** — it prints one line only when a tile actually changed (never the old rulebook dumped into
the chat), never re-tasks the main agent, and bails silently if the folder isn't tracked or the server's
down. It self-guards against recursion (the `claude -p` it spawns re-fires this same hook; an env flag
no-ops the nested call) and spawns one model per stop (a few seconds — `TILEMON_RECONCILE_MODEL`
overrides the default). A tool-less judge means the worst a bad decision can do is set a wrong tile
(reversible), never run a shell.
Then **create or merge** `.claude/settings.json` (neither hook takes a matcher):
```json
{ "hooks": {
  "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/tilemon-start.mjs\"" } ] } ],
  "Stop": [ { "hooks": [ { "type": "command", "command": "npx tilemon reconcile" } ] } ]
} }
```
The start hook always exits 0 with no output, so it never blocks the prompt; the Stop hook
(`tilemon reconcile`) is non-blocking too, self-guards against recursion, and posts directly to the
board. TileMon ships the reconciler in the package — only the start hook is written into *your* project
at setup; the Stop hook is just the one-line command wired above.

## Growing the board later

Adding a workspace/project after the initial setup is the same primitives: create the new board (with
its `dir`), then `include` it into the right bucket. Reshape with `/api/move`. Don't re-seed tasks;
let agents flag live work as it happens.
