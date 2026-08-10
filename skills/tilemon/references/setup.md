# TileMon — setup (the passive collector)

TileMon keeps itself current by reading Claude Code's own per-session state and projecting your
**live sessions** onto a board — no hooks, no agent cooperation, no self-reporting. Setup is: point a
board at yourself, then run the collector. ~2 minutes.

## The shape

- **The board** is hosted at **tilemon.com** — sign in and it's yours (one account, all your
  projects). Prefer everything local? Run a local board with `npx tilemon` instead — see *Local-only*.
- **The collector** is a small local process — `tilemon collect --loop` — that runs next to Claude
  Code, reads `~/.claude/jobs`, and every ~60s reconciles your live sessions onto the board. It's the
  bridge: the cloud can't read your laptop, so this local process does.
- **Tiles come and go on their own.** Each live session becomes a tile on its project's board and
  **disappears when the session ends.** You never tend it; it can't pile up.
- **Pins are the durable half.** A pin is a tile *you* add in the board UI that stays until *you* mark
  it done — your "don't forget this" list. The collector only ever manages its own session tiles and
  **never touches a pin.**

## Hosted setup (the normal path)

1. **Sign in** at https://www.tilemon.com — you get an empty board.
2. **Mint an API key** in settings (shown once).
3. **Save it locally** in `~/.tilemon/credentials` — a dotenv-style file that sits *outside* every git
   repo (so a stray `git clean` can't wipe it):
   ```
   TILEMON_URL=https://www.tilemon.com
   TILEMON_TOKEN=<your key>
   ```
   > Use `https://www.tilemon.com`, not the apex — the apex redirect strips the `Authorization` header.
4. **Run the collector**, backgrounded so it outlives the shell:
   ```
   tilemon collect --dry-run     # optional first: print the board it WOULD build, write nothing
   tilemon collect --loop &      # reads the credentials, feeds tilemon.com every 60s
   ```
   Open tilemon.com and watch your live sessions appear; they clear as sessions finish.

To survive a **reboot**, drop that command into your OS startup (a login item / a systemd user unit).
Optional — when the machine's off there are no sessions to collect anyway; if you reboot, just re-run
the one command. `--interval <seconds>` changes the cadence (default 60).

## Routing — how a session lands on the right board

Routing is off the **session name**, which you control (the working directory is deliberately *not*
used — sessions launched from a shared root would all misroute). How the name is split into parts is
**configurable via a regex**, so you can use whatever naming convention you like.

**The default** handles `[<importance> - ]<PROJECT> - <description>`:

```
MED - FORTYTECH - adfin outreach   →   importance MED (dropped) · project FORTYTECH · description "adfin outreach"
```

It reads three named groups — **`project`** (routes to a board), **`description`** (the tile's
label), and optional **`importance`** (extracted and dropped). To use a different convention, set
your own pattern in **`~/.tilemon/config.json`**:

```json
{ "namePattern": "^(?<project>[^:]+):\\s*(?<description>.+)$" }
```

(That example parses `project: description`.) A malformed pattern safely falls back to the default,
and a name that doesn't match at all keeps the whole name as its description and routes to `inbox`.
Keep patterns simple — avoid nested quantifiers like `(a+)+` (catastrophic backtracking); the
matched name is length-capped as a backstop, but a pathological pattern is still your own footgun.

**Matching the project to a board is strict** (this part isn't configurable): the extracted project
and the board slugs are both normalised (lowercase, drop dashes) and must match exactly — no alias
table. The dash-strip is the only fuzz, so `FORTYTECH` → `forty-tech` and `FREEMERCHMAKER` →
`free-merch-maker` match automatically. No match → **`inbox`**, your cue to rename the session (or
add the board). True abbreviations (`FFF`, `META`) won't match `freeing-female-founders` /
`forty-workspace`; spell them out, or name the board to match your habit.

## Buckets & the overview (`home`) — your persistent structure

`home` and its buckets (Products / Clients / Internal / …) are **yours**, seeded once and persistent —
the collector **never** rebuilds them. Each project is a board; buckets are boards that `include`
the project boards; `home` includes the buckets. You drag to size and regroup. The collector only
maintains the live **session tiles** on project boards; heat rolls up through the includes, so a
blocked session lights its project → its bucket → the overview, automatically.

Seed it once from your project manifest (e.g. `projects.yml`): a board per project, your buckets, the
includes, plus `inbox` on `home`. After that it's stable — a new project shows up in `inbox`; file it
into a bucket and add it to the manifest. (Weights stay equal until you drag; importance is yours.)

## Local-only (no cloud)

Want everything on your machine? Run a local board and collect into it — same model, no hosting:
```
npx tilemon --daemon          # serves ~/.tilemon at http://localhost:4000
tilemon collect --loop        # TILEMON_URL unset → writes the local board directly (engine sink)
```

## What setup no longer involves

Retired with the passive model — do **not** set these up: the agent skill's `tilemon flag`
self-reporting, the `UserPromptSubmit`/`Stop` hooks, `attention.md`, and the `claude -p` reconcile
judge. The collector reads ground truth mechanically instead, so none of it is needed.
