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

The collector routes each session to a board by its **name** (e.g. a session named "DOEFIN — fix
tests" → the `doefin` board), falling back to its working directory, else an `inbox` board. Project
boards are created on demand, and `home` is rebuilt as a set of includes over the boards that have
live tiles. If sessions collect in `inbox`, give them a recognisable project prefix in the name.

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
