// engine.js — TileMon's board semantics over a PLUGGABLE STORE. The write-side twin of
// board.js: the renderer owns no data (it renders over a source); the engine owns no storage
// (it operates over a store). One implementation of what an op MEANS — upsert, add, move,
// rename, delete, include-cycle guards, resolve/stamping — consumed by every place boards
// live: the local server (JSON files) and the hosted app (Postgres rows) plug in three
// callbacks and share everything else.
//
//   const engine = createEngine({
//     readBoard:  async slug => boardObject | null,     // null means ABSENT ONLY; THROW on read
//                                                       // failure (engine.status creates on null —
//                                                       // a failure mapped to null would overwrite
//                                                       // a real board). Slugs arriving here can be
//                                                       // untrusted (stored `include` strings) — a
//                                                       // store must not eval/concat them unsafely.
//     writeBoard: async (slug, board) => void,          // UPSERT persistence (create-or-replace)
//     listSlugs:  async () => ['slug', ...],            // existing board slugs (for uniquing)
//   });
//
// Ops return { ok: true, ... } or { error, status } — `status` is the HTTP code both consumers
// already speak, and messages are stable (tests assert on them). The engine validates inputs
// (slugs, paths, status enum) so a store never sees garbage; auth, body parsing, broadcast/SSE
// and store-specific metadata (file `dir` links, tenant columns) stay with the caller.
//
// Zero dependencies, Node 18+ / browser-safe (no fs, no fetch): pure logic + the store calls.

export const VALID_STATUS = new Set(['todo', 'in_progress', 'waiting', 'blocked', 'done']);

// ---- slugs & ids ----
export const slugOk = s => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(s);
export const humanize = id => id.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
export const slugify = s => (String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item');
// make `base` unique among a set of existing ids/slugs (append -2, -3, …)
export function uniq(base, taken) {
  if (!taken.has(base)) return base;
  let i = 2; while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

// ---- pure tree helpers ----
// resolve a dotted-id path in a board (node must exist); '' is NOT valid here — callers that
// mean "the board itself" branch on empty path before calling.
export function resolvePath(board, path) {
  const parts = path.split('.');
  let node = board;
  for (const part of parts) {
    const next = (node.children || []).find(c => c.id === part);
    if (!next) return null;
    node = next;
  }
  return node;
}
// all board slugs referenced by `include` anywhere in a node's subtree
export function collectIncludes(node) {
  const out = [], stack = [node];
  while (stack.length) {
    const n = stack.pop();
    if (n.include !== undefined) out.push(n.include);
    if (n.children) for (const c of n.children) stack.push(c);
  }
  return out;
}

const isJira = board => typeof board.source === 'string' && board.source.startsWith('jira://');
const err = (status, error) => ({ error, status });

export function createEngine({ readBoard, writeBoard, listSlugs }) {
  // does board `from` reach board `target` by following includes (transitively)?
  async function includeReaches(from, target, seen = new Set()) {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    const b = await readBoard(from);
    if (!b) return false;
    for (const inc of collectIncludes({ children: b.children || [] }))
      if (await includeReaches(inc, target, seen)) return true;
    return false;
  }

  // ---- resolve a board for rendering: includes INLINED, every node stamped ----
  // `_board` (owning board) + `_path` (dotted path within it) let the client write to the
  // right board across include boundaries — board.js keys tiles by `_board::_path`.
  // An include becomes a boundary node (`_boardLink`) carrying the sub-board's children
  // (with the SUB-board's stamps) and shell flag. Read-only sources mark nodes `_ro`.
  // Acyclic-guarded; returns null for a missing board. (A named closure, not a method,
  // so it survives destructuring — consumers grab ops off the engine freely.)
  async function resolveBoard(slug, chain = []) {
    if (chain.includes(slug)) return { __cycle: true };
    // reads soft-fail: an unreadable board renders as missing (404), same as the old local
    // resolver. WRITES must not do this — engine.status propagates read errors so a corrupt
    // board is never mistaken for absent and overwritten.
    let board; try { board = await readBoard(slug); } catch { return null; }
    if (!board) return null;
    const ro = isJira(board);
    const build = async (node, path) => {
      if (node.include !== undefined) {
        const sub = await resolveBoard(node.include, [...chain, slug]);
        const cyc = !sub || sub.__cycle;
        return { id: node.id, name: node.name || humanize(node.include), weight: node.weight,
                 _board: slug, _path: path, _boardLink: node.include,      // boundary: this node lives in THIS board
                 toolbar: (!cyc && sub) ? sub.toolbar : undefined,          // pass the sub-board's shell flag through
                 _missing: !sub || undefined, _cycle: (sub && sub.__cycle) || undefined,
                 children: cyc ? [] : (sub.children || []) };              // children carry the sub-board's own stamps
      }
      const out = { id: node.id, name: node.name, weight: node.weight, status: node.status, note: node.note, seen: node.seen, _board: slug, _path: path };
      if (ro) out._ro = true;
      if (node.children && node.children.length) {
        out.children = [];
        for (const c of node.children) out.children.push(await build(c, path ? path + '.' + c.id : c.id));
      }
      return out;
    };
    const children = [];
    for (const c of (board.children || [])) children.push(await build(c, c.id));
    const tree = { name: board.name || slug, visibility: board.visibility || 'private',
                   source: board.source || 'native', _board: slug, _path: '', children };
    if (board.toolbar !== undefined) tree.toolbar = board.toolbar;   // app-shell flag (absent => shell; explicit false => bare)
    if (ro) tree._sourceStub = 'jira';
    return tree;
  }

  return {
    includeReaches,
    resolveBoard,

    // ---- AGENT write: upsert a dotted path (create board + missing nodes, born small) + status/note ----
    async status(slug, path, { status, note, name } = {}) {
      if (!slugOk(slug)) return err(400, 'bad or missing board slug');
      if (!path) return err(400, 'missing path');
      if (!VALID_STATUS.has(status)) return err(400, 'bad status');
      let board = await readBoard(slug);
      if (!board) board = { name: humanize(slug), visibility: 'private', source: 'native', children: [] }; // agents can create a board
      if (isJira(board)) return err(409, 'board is a read-only jira source');
      const parts = path.split('.');
      let node = board;
      parts.forEach((part, i) => {
        const kids = node.children || (node.children = []);
        const last = i === parts.length - 1;
        let next = kids.find(c => c.id === part);
        if (!next) {
          next = { id: part, name: last && name ? name : humanize(part), weight: 1 };
          if (last) { next.status = status; if (note != null) next.note = note; }
          else next.children = [];
          kids.push(next);
        } else if (last) {
          next.status = status;
          if (note != null) next.note = note;
          if (name && !next.name) next.name = name;
        }
        node = next;
      });
      node.seen = Date.now();   // liveness heartbeat: stamped on every status write
      await writeBoard(slug, board);
      return { ok: true };
    },

    // ---- HUMAN write: weight only, node must exist (humans lay out; agents don't create structure this way) ----
    async weight(slug, path, weight) {
      if (!slugOk(slug)) return err(400, 'bad or missing board slug');
      if (!path || typeof path !== 'string') return err(400, 'missing path');
      const board = await readBoard(slug);
      if (!board) return err(404, 'board not found: ' + slug);
      const node = resolvePath(board, path);
      if (!node) return err(404, 'path not found: ' + path);
      node.weight = Number(weight);
      await writeBoard(slug, board);
      return { ok: true };
    },

    // ---- HUMAN: add a plain item OR an include of an existing board ----
    async addNode(slug, { path = '', kind = 'item', name, target } = {}) {
      if (!slugOk(slug)) return err(400, 'bad or missing board slug');
      if (typeof path !== 'string') return err(400, 'bad path');
      const board = await readBoard(slug);
      if (!board) return err(404, 'board not found: ' + slug);
      if (isJira(board)) return err(409, 'board is a read-only jira source');
      const parent = path ? resolvePath(board, path) : board;   // no path => board root
      if (!parent) return err(404, 'path not found: ' + path);
      const kids = parent.children || (parent.children = []);
      const taken = new Set(kids.map(c => c.id));
      if (kind === 'include') {                                  // reference an EXISTING board (a navigable summary tile)
        if (!slugOk(target)) return err(400, 'bad or missing target board');
        if (!(await readBoard(target))) return err(404, 'target board not found: ' + target);
        if (target === slug || await includeReaches(target, slug)) return err(409, 'would create an include cycle');
        const nm = (name && String(name).trim()) ? String(name).trim() : humanize(target);
        kids.push({ id: uniq(target, taken), name: nm, weight: 1, include: target });
      } else if (kind === 'item') {                              // a plain node: a task, or a bucket once you add into it
        if (!name || !String(name).trim()) return err(400, 'missing name');
        const nm = String(name).trim();
        kids.push({ id: uniq(slugify(nm), taken), name: nm, weight: 1, status: 'todo' });
      } else {
        return err(400, 'unknown kind (item | include)');
      }
      await writeBoard(slug, board);
      return { ok: true };
    },

    // ---- HUMAN: rename and/or set the toolbar flag. Empty path => the board itself (the "frame" tile) ----
    async patchNode(slug, path, { name, toolbar } = {}) {
      if (!slugOk(slug)) return err(400, 'bad or missing board slug');
      if (typeof path !== 'string') return err(400, 'bad path');
      if ((name == null || !String(name).trim()) && typeof toolbar !== 'boolean') return err(400, 'nothing to change');
      const board = await readBoard(slug);
      if (!board) return err(404, 'board not found: ' + slug);
      const node = path ? resolvePath(board, path) : board;
      if (!node) return err(404, 'path not found: ' + path);
      if (name != null && String(name).trim()) node.name = String(name).trim();
      if (typeof toolbar === 'boolean') node.toolbar = toolbar;   // store explicitly (false = bare)
      await writeBoard(slug, board);
      return { ok: true };
    },

    // ---- HUMAN: remove a node (any board it references stays intact) ----
    async removeNode(slug, path) {
      if (!slugOk(slug)) return err(400, 'bad or missing board slug');
      if (!path || typeof path !== 'string') return err(400, 'missing path');
      const board = await readBoard(slug);
      if (!board) return err(404, 'board not found: ' + slug);
      const parts = path.split('.'); const id = parts.pop();
      const parent = parts.length ? resolvePath(board, parts.join('.')) : board;
      if (!parent || !parent.children) return err(404, 'path not found: ' + path);
      const before = parent.children.length;
      parent.children = parent.children.filter(c => c.id !== id);
      if (parent.children.length === before) return err(404, 'path not found: ' + path);
      await writeBoard(slug, board);
      return { ok: true };
    },

    // ---- HUMAN: create a bare board (placed nowhere); returns its slug ----
    // `extra` merges store-specific board fields the engine doesn't interpret (e.g. the local
    // tool's `dir` folder link) — pre-validated by the caller.
    async createBoard(name, wantSlug, extra = {}) {
      if (!name || !String(name).trim()) return err(400, 'missing name');
      const nm = String(name).trim();
      const existing = new Set(await listSlugs());
      let slug;
      if (wantSlug !== undefined) {
        if (!slugOk(wantSlug)) return err(400, 'bad slug');
        if (existing.has(wantSlug)) return err(409, 'board already exists: ' + wantSlug);
        slug = wantSlug;
      } else {
        slug = uniq(slugify(nm), existing);
      }
      const board = { name: nm, visibility: 'private', source: 'native', children: [], ...extra };
      await writeBoard(slug, board);
      return { ok: true, slug };
    },

    // ---- generic board-metadata primitive: shared read/404/write plumbing, caller-owned mutation ----
    // For store-specific fields (the local `dir` link, future visibility toggles): the mutator
    // edits the board in place; return false to skip the write. Must be SYNCHRONOUS — an async
    // mutator's promise is never `=== false` and the write would race the pending mutation.
    async updateBoard(slug, mutate) {
      if (!slugOk(slug)) return err(400, 'bad or missing slug');
      const board = await readBoard(slug);
      if (!board) return err(404, 'board not found: ' + slug);
      if (mutate(board) === false) return { ok: true };
      await writeBoard(slug, board);
      return { ok: true };
    },

    // ---- HUMAN: re-parent a node within or across boards (cycle-guarded) ----
    async moveNode(slug, path, toBoard, toPath = '') {
      if (!slugOk(slug)) return err(400, 'bad or missing board slug');
      if (!path || typeof path !== 'string') return err(400, 'missing path');
      if (toBoard === undefined) toBoard = slug;   // default only when ABSENT — an explicit null/'' toBoard is a client bug, rejected below
      if (!slugOk(toBoard)) return err(400, 'bad toBoard slug');
      if (typeof toPath !== 'string') return err(400, 'bad toPath');
      const sameBoard = slug === toBoard;
      const src = await readBoard(slug);
      if (!src) return err(404, 'board not found: ' + slug);
      const dest = sameBoard ? src : await readBoard(toBoard);   // same object when in-board, so the splice persists
      if (!dest) return err(404, 'toBoard not found: ' + toBoard);
      // structural guard: within a board, a node can't move into itself or one of its descendants
      if (sameBoard && (toPath === path || toPath.startsWith(path + '.'))) return err(409, 'cannot move a node into itself');
      if (isJira(src)) return err(409, 'source board is a read-only jira source');
      if (isJira(dest)) return err(409, 'destination board is a read-only jira source');
      // detach the node from its parent (in memory; nothing persisted until every check passes)
      const parts = path.split('.'); const id = parts.pop();
      const srcParent = parts.length ? resolvePath(src, parts.join('.')) : src;
      if (!srcParent || !srcParent.children) return err(404, 'path not found: ' + path);
      const idx = srcParent.children.findIndex(c => c.id === id);
      if (idx < 0) return err(404, 'path not found: ' + path);
      const [node] = srcParent.children.splice(idx, 1);
      // include-cycle guard (cross-board only — an in-board move can't change the board graph):
      // any board this subtree includes must not equal or reach the destination board.
      if (!sameBoard)
        for (const inc of collectIncludes(node))
          if (inc === toBoard || await includeReaches(inc, toBoard))
            return err(409, 'would create an include cycle');
      const destParent = toPath ? resolvePath(dest, toPath) : dest;
      if (!destParent) return err(404, 'toPath not found: ' + toPath);
      const dkids = destParent.children || (destParent.children = []);
      node.id = uniq(node.id, new Set(dkids.map(c => c.id)));     // avoid an id clash among new siblings
      dkids.push(node);
      // cross-board is two writes: DESTINATION first, so a mid-move failure duplicates the
      // node rather than losing it (stores may not be transactional).
      if (sameBoard) await writeBoard(slug, src);
      else { await writeBoard(toBoard, dest); await writeBoard(slug, src); }
      return { ok: true };
    },

  };
}
