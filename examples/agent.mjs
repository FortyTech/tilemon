#!/usr/bin/env node
// A toy swarm agent — the whole thesis in one file. It registers its job on a board
// (creating the board + node if they don't exist) and walks it through the lifecycle,
// so on the monitor you watch a tile appear, glow when it blocks, and drop when done.
//
//   node examples/agent.mjs [board] [path] [baseUrl]
//   node examples/agent.mjs webapp api.refactor-auth http://localhost:4000
//
// Set TILEMON_TOKEN if the server requires auth. An agent needs exactly this: POST status.

const [, , board = 'webapp', path = 'api.refactor-auth',
  base = process.env.TILEMON_URL || 'http://localhost:4000'] = process.argv;

const headers = { 'content-type': 'application/json' };
if (process.env.TILEMON_TOKEN) headers.authorization = `Bearer ${process.env.TILEMON_TOKEN}`;

const report = (status, note) =>
  fetch(`${base}/api/status`, { method: 'POST', headers, body: JSON.stringify({ board, path, status, note }) })
    .then(r => r.json()).catch(e => ({ error: String(e) }));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const steps = [
  ['in_progress', 'starting work'],
  ['blocked', 'need the staging DB password'],   // <- this is the moment the tile glows and pulls you in
  ['in_progress', 'unblocked, continuing'],
  ['done', 'shipped'],
];

console.log(`agent → ${base}  board="${board}"  job="${path}"`);
for (const [status, note] of steps) {
  const r = await report(status, note);
  console.log(`  ${status.padEnd(12)} ${note.padEnd(30)} ${r.ok ? '✓' : '✗ ' + JSON.stringify(r)}`);
  await sleep(2500);
}
console.log('done — the tile appeared, glowed on "blocked", then dropped off on "done".');
