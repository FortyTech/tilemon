#!/usr/bin/env node
// One-shot: flag a single task's status on a board. The board reacts live.
//
//   node examples/flag.mjs <board> <dotted.id.path> [status] [note] [http://host:4000]
//   node examples/flag.mjs webapp api.refactor-auth blocked "need the staging DB password"
//
// status defaults to "blocked" (the one that glows). Set TILEMON_URL / TILEMON_TOKEN as needed.
// This is all an agent needs — one POST to /api/status. It upserts the path (creating the
// board + nodes if missing) and can ONLY set status/note; weight and structure are out of reach.

const [, , board, path, status = 'blocked', note,
  base = process.env.TILEMON_URL || 'http://localhost:4000'] = process.argv;

if (!board || !path) {
  console.error('usage: node examples/flag.mjs <board> <dotted.id.path> [status] [note] [baseUrl]');
  process.exit(1);
}

const headers = { 'content-type': 'application/json' };
if (process.env.TILEMON_TOKEN) headers.authorization = `Bearer ${process.env.TILEMON_TOKEN}`;

const res = await fetch(`${base}/api/status`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ board, path, status, note }),
});

const out = await res.json().catch(() => ({}));
if (res.ok) console.log(`✓ ${board}/${path} → ${status}${note ? ` (“${note}”)` : ''} — the tile should change now`);
else { console.error(`✗ ${res.status}: ${out.error || res.statusText}`); process.exit(1); }
