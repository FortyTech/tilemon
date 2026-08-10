---
name: tilemon
description: Informational only — TileMon is now a PASSIVE attention board. It reads your Claude Code session state automatically; agents do NOT report status to it and there is nothing to call. Load only if you're wondering whether you should be updating a TileMon board — you're not.
---

# TileMon is passive — there is nothing for you to do

TileMon shows the human, on one always-on board, **what their agents are waiting on them for.** It
used to require every agent to `POST /api/status` ("flag") as it worked. **That model is retired** —
it depended on agents remembering, and the board filled with noise.

TileMon now reads Claude Code's **own** per-session state (`~/.claude/jobs/*/state.json`) directly,
through a standalone collector the human runs (`tilemon collect --loop`). Your status — working,
waiting on the human, blocked, done — is derived from that **automatically, whether you cooperate or
not.**

So, as an agent:

- **Do not report anything.** There is no `tilemon flag` to run, no status to POST. Don't write to a
  TileMon board.
- **Don't watch or poll the board.** It's the human's surface; you are not its bookkeeper.
- If the human explicitly asks you to leave a durable note on the board ("pin this so I don't
  forget"), that's a **human-owned pin** they add in the board UI — point them there, don't create it
  yourself. An agent-made tile that never decays is exactly the noise this board exists to avoid.

Setting up TileMon for the first time (the collector, a board, a key)? That's a human task — see
[`references/setup.md`](./references/setup.md).
