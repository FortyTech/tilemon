---
name: tilemon
description: Report task/agent status to a TileMon priority board so the human can see, on their always-on board, what their agents are waiting on them for. Use this whenever you START a tracked task, NEED the human (a decision, input, or a review), BLOCK on a problem you can't pass, or FINISH — set status to in_progress / waiting / blocked / done with one command (`tilemon flag`). Fire it proactively as your work changes state, not only when asked; a board that reflects reality without the human tending it is the whole point. Also covers bootstrapping a board for a project/workspace (see references/setup.md). Requires a running TileMon server (npx tilemon).
---

# TileMon — report status to the board

TileMon is an **attention-management tool, not a project tracker**: a zero-sum treemap that answers
one question for the human — *what are my agents waiting on me for?* Importance is on-screen area,
the human owns the weights, and **agents set status**. The "needs-you" states glow — `waiting`
(needs your input) amber, `blocked` (something's wrong) louder red; `in_progress` is a calm signal
(an agent's working, no attention needed). Your entire integration is **one command** — `tilemon
flag` (a verified `POST /api/status` under the hood) — and it **upserts** (creates the board and any
missing nodes on first write), so you can register your own work as you go — but keep it coarse;
noise defeats the tool.

**Setting up or bootstrapping a board?** That's a different, rarer job (structure is the human's,
built through a propose-first wizard). Don't do it from memory — read **`references/setup.md`**, which
has the two-gate wizard, the structure API, the bucket/addressing convention, and the hook install.
Everything below is the routine hot path: reporting your own status.

**It is a shared, long-running board — not this session's state.** The board runs as its own server
(often detached with `--daemon`, so it outlives any single session) and is written to by **many
agents over time**: future sessions, agents on other projects, unattended or scheduled ones — often
at once. You are just one client. So:
- Your job is narrow: report the status of **your own** tracked tasks, by stable `path`. You are
  **not** the board's owner or bookkeeper, and **not** tracking other agents' work.
- Don't hold the whole board in your head, poll it to "monitor" everything, or keep your session
  alive to watch it. When you've reported, move on — the server persists and other agents update
  their own tiles. The **human** watches the board; agents just report into it.

## Reporting status (the core — this is 95% of it)

1. **Find the board.** The `tilemon` subcommands (`flag`, `attention`) talk to `$TILEMON_URL` else
   `http://localhost:4000` and **auto-start the local server if it's down** — so you usually don't
   need to start anything; just run the command. (If you're hand-calling the HTTP API and nothing
   answers, `npx tilemon --daemon` starts it detached; `--stop` kills it.) **Never read TileMon's own
   source to work out how to run it** — this skill is the complete manual; treat the server as a black
   box behind the API. To see **what's currently glowing** (waiting on the human), read it — don't
   guess: `tilemon attention [board]` (board defaults to the portfolio home), or `GET /api/attention`.
2. **Address your work.** Resolve your `board` *with certainty* — don't guess from the folder name and
   never invent a new board: run **`tilemon resolve`** (defaults to your cwd; or `tilemon resolve
   <dir>`). It prints the slug of the board that owns this folder (the one whose `dir` is the longest
   prefix of your path) and exits 0. If it exits non-zero with "isn't tracked", this folder isn't on
   the board — leave it, don't create one. **Reuse the same board + path across a task's whole life**
   so a reconnecting agent (or a later session) lands on the same tile instead of duplicating it.

   **Deriving a stable `path` — pick a deterministic id so two agents on the same task collide on the
   *same* tile rather than making two.** `path` is a dotted id within the board (no dots inside a
   segment). Derive it from something both agents would independently choose:
   - **Tracked git/VCS state** (uncommitted, unpushed) → use `vcs`. This is the shared convention;
     always the same, so the repo's git-state tile never duplicates.
   - **A ticket / issue** → the id, lowercased, e.g. `scrum-119` or `fo-42`.
   - **A code task** → the primary area it touches, e.g. `api.refactor-auth` (mirror the file/module
     path so it's reproducible, not a mood-of-the-moment label).

3. **Write it — use the verified command, not a hand-rolled curl.** `status` ∈
   `todo | in_progress | waiting | blocked | done`. Include a `note` (what you're doing / what you
   need — shows inline + in the tooltip) and a **`name`** in **plain language a human reads at a
   glance** — "Uncommitted changes", "Deploy to prod" — **never a cryptic code** ("vcs", "wip"). (The
   *name* is human-facing prose; the *path* is the stable id from step 2 — they're different fields.)
   ```bash
   tilemon flag <board> <path> <status> "<note>" --name "Plain name"
   tilemon flag webapp api.refactor-auth waiting "which auth provider — Clerk or Auth0?" --name "Refactor auth"
   ```
   **A status write you didn't confirm landed isn't done.** Prefer `tilemon flag` (or `npx tilemon
   flag`): it uses the right default port, handles `$TILEMON_TOKEN`, and **exits non-zero and prints
   loudly if the write didn't land** — so a wrong port or a down server can't silently swallow it (a
   real failure mode: a hand-rolled `curl -s` to a phantom port returns nothing and looks like
   success). If you *must* use curl (`POST $TILEMON_URL/api/status`, same JSON, `Authorization: Bearer
   $TILEMON_TOKEN` if set), **confirm the response is `{"ok":true}`** yourself before trusting it.

4. **When to fire:** think of `in_progress` as a **mute**, not a new light. A box glows because it
   needs the human (`waiting`/`blocked`); when you pick that work up, set it `in_progress` and the
   glow goes **off** ("I'm on it, look away"). So the trigger is: **you start handling a glowing box →
   mute it** (the start hook shows you what's glowing so you can match yours). Then, when you hand
   back: `done` if finished (drops off), or **flip it back** — `waiting` = you need their
   input/decision and nothing's broken (amber), `blocked` = something's *wrong*, an obstacle you can't
   pass (red + pulses, louder). Always attach a `note` saying exactly what you need. **Don't create a
   box just to announce you're busy** — an agent quietly working with nothing flagged needs no tile
   (in_progress carries no heat). Boxes exist to demand attention; muting is how you say "handled for
   now."

You can only ever set **status/note**, on any node, via this endpoint — never weights or structure.
The human owns importance. That's why one board-wide token is safe: it can't reshuffle priorities,
only flag and (via upsert) add.

### Liveness — a heartbeat that shows you're still attached

Every status write stamps a **heartbeat** (`seen`), and the board shows a live dot on any tile with a
fresh one. **Liveness is orthogonal to status** — the dot means "an agent is attached and fresh here",
whatever the status: a live `waiting` reads as "an agent is waiting on you *right now*", distinct from
one sitting untouched for an hour. Once a tile goes stale (no write for ~10 min) it loses the dot; a
stale `in_progress` also **dims and greys** (the agent walked away mid-task — exactly what the human
wants to spot), while a stale `waiting`/`blocked` keeps its glow (it still needs them). So:

- On a **long-running** task, **re-run the same `tilemon flag`** (same `board`+`path`) every few
  minutes as you progress — a cheap heartbeat that keeps the dot live and the note current. It
  upserts, so re-affirming costs nothing and won't duplicate the tile.
- Before you stop, **resolve the tile**: `done` if finished, `waiting`/`blocked` if you need the
  human. Don't leave a bare `in_progress` behind — a live task nobody's working is a false signal. (If
  work genuinely pauses without needing the human, fine — it greys out to show it's idle, which is
  honest.)

## Honouring attention rules (attention.md)

The human may keep **attention rules** in `~/.tilemon/attention.md` (operator-side, free text): what
should grab their attention and how it maps to status, with per-board/node rules in targeted sections
(`# board: <slug>`, `# node: <board>.<path>`). The rules are theirs, not the board's. Honour them by
**sending updates** — when active in a project, read its `attention.md` rules (global + this board's
section) and **push status as you see fit**: flag `blocked` the instant you hit something a rule cares
about, mark things `done`, surface anything they asked to see. The rules are prose so you can apply
judgment, and you evaluate them with **your own tools** (rule about git → run git; about logs → read
them). TileMon prescribes no mechanism and ships no rule-specific tooling.

**Flagging is automatic — NEVER ask the human whether to set a status. Just set it.** Status is the
one surface you own outright (reversible, can't touch weights or structure), which is exactly why it's
safe to write without permission. Asking "want me to flag this?" defeats the point — the board is meant
to reflect reality *without* the human tending it. If a rule matches, flag it silently; if not, leave
it. (Weights and structure are the opposite — those are the human's; never touch them without them.)

**Only flag what's in your working scope** — the repo/project you're actually operating in. Don't roam
into other repos to check them, and don't flag a repo you're not working in (a session working *there*
catches it). In-scope → flag automatically; out-of-scope → leave it, no comment.

How those pushes get generated is the operator's choice — you doing it live with `tilemon flag`, a
`Stop` hook when you pause, CI, a scheduled job — all of it just reports status. The natural default
is to report from where the work is happening; the only constant is that updates are *sent to*
TileMon (it's a receiver — it never reaches out).

## Activation note

This skill is passive — it tells you *how*, not *when*. To make reporting routine, the project's own
agent instructions should say something like: "when you block on or finish a board-tracked task, flag
it via the tilemon skill." Setup (`references/setup.md`) installs start/stop hooks that make this
automatic in Claude Code.
