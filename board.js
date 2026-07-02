// board.js — Tilemon renderer. Framework-agnostic, zero dependencies, ESM.
//
//   import { mount } from './board.js'
//   const board = mount(boardEl, null, {
//     state, boards,                                // resolved tree + board list (for the switcher)
//     onStatusChange:(board,path,status)=>{}, onWeightChange:(board,path,weight)=>{},
//     onAddNode:(board,parentPath,kind,name)=>{},   // kind 'item' | 'native'
//     onRenameNode:(board,path,name)=>{}, onDeleteNode:(board,path)=>{},
//     onSetToolbar:(board,path,bool)=>{}, onOpenBoard:(slug)=>{},
//   })
//   board.update(newState); board.setBoards(list)
//
// Interaction model: NO selection. Hovering a tile reveals a compact action bar on its header
// AND on every ancestor container's header (act on any level under the cursor). Corner-drag
// resizes the tile you grab, directly. Double-click a container to drill in. The renderer owns
// no data — it announces changes via callbacks, addressed by each node's server-stamped
// _board (owning board) + _path (local path), so edits land right even across nested boards.

const PAD = 5, HEADER = 22, INSET = 2, TOOLBAR_H = 36, STATUS_H = 22, BAR_MIN_W = 150, BAR_MIN_H = 22;
const STATUS_HEAT = { todo: 0, in_progress: 0.5, blocked: 1 };
const STATUSES = ['todo', 'in_progress', 'blocked', 'done'];
const STAT_LABEL = { todo: 'todo', in_progress: 'in progress', blocked: 'blocked', done: 'done' };
const DONE_COLOR = 'rgb(74,92,58)';

const STYLE = `
.tlm-board{position:relative;width:100%;height:100%;overflow:hidden;background:var(--tlm-bg,#14120D);touch-action:none}
.tlm-board .tile{position:absolute;box-sizing:border-box;border:1px solid rgba(0,0,0,.32);border-radius:5px;overflow:hidden;
  cursor:grab;user-select:none;transition:left .18s ease,top .18s ease,width .18s ease,height .18s ease,background .25s ease,opacity .2s ease}
.tlm-board.nodrag .tile{transition:background .25s ease}
.tlm-board .tile:active{cursor:grabbing}
.tlm-board .tile.board{outline:1px dashed var(--tlm-gold,#E8C56A);outline-offset:-3px}
.tlm-board .tile.target{outline:2px solid var(--tlm-gold,#E8C56A);outline-offset:-2px;box-shadow:inset 0 0 12px rgba(232,197,106,.35)}
.tlm-board .tile .hd{position:absolute;top:0;left:0;right:0;height:22px;display:flex;align-items:center;justify-content:space-between;
  padding:0 8px;gap:6px;pointer-events:none}
.tlm-board .tile .leaf{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
  text-align:center;padding:6px;gap:3px;pointer-events:none}
.tlm-board .nm{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.tlm-board .bl{font-family:"Space Mono",monospace;font-size:9px;opacity:.7}
.tlm-board .wt{font-family:"Space Mono",monospace;font-size:10.5px;opacity:.6;white-space:nowrap}
.tlm-board .badge{font-family:"Space Mono",monospace;font-size:9.5px;opacity:.75;letter-spacing:.03em}
.tlm-board .tile.done{opacity:.6}
.tlm-board .tile.hot{animation:tlm-pulse 1.7s ease-in-out infinite}
@keyframes tlm-pulse{0%,100%{filter:brightness(1)}50%{filter:brightness(1.22)}}
@media (prefers-reduced-motion:reduce){.tlm-board .tile.hot{animation:none}}
/* per-tile actions: a top-right icon cluster revealed on hover — the tile's own header/name
   style is left untouched (no dark bar, no duplicated name) */
.tlm-bar{position:absolute;top:3px;right:3px;display:flex;align-items:center;gap:3px;flex-wrap:nowrap;z-index:700}
.tlm-bar button,.tlm-bar select{box-sizing:border-box;height:22px;font-family:"Space Mono",monospace;font-size:10px;line-height:1;
  background:rgba(28,26,20,.92);color:var(--tlm-ink,#ECE7DA);border:1px solid var(--tlm-line,#2A2820);border-radius:4px;
  padding:0 6px;margin:0;cursor:pointer;white-space:nowrap;vertical-align:middle;appearance:none;-webkit-appearance:none;-moz-appearance:none}
.tlm-bar button:hover,.tlm-bar select:hover{border-color:var(--tlm-gold,#E8C56A);color:var(--tlm-gold,#E8C56A)}
.tlm-bar button.on{border-color:var(--tlm-gold,#E8C56A);color:var(--tlm-gold,#E8C56A)}
.tlm-bar button.del:hover{border-color:#b0563a;color:#d8674a}
.tlm-ghost{position:absolute;z-index:800;border:2px solid var(--tlm-gold,#E8C56A);background:rgba(232,197,106,.14);border-radius:5px;
  pointer-events:none;box-shadow:0 0 0 1px rgba(0,0,0,.3)}
.tlm-board .tlm-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  font-family:"Space Mono",monospace;font-size:12.5px;color:var(--tlm-dim,#9A9182);text-align:center;padding:24px;pointer-events:none}
.tlm-board .tlm-toolbar{position:absolute;top:0;left:0;right:0;height:36px;z-index:820;display:flex;align-items:center;gap:8px;padding:0 10px;
  background:var(--tlm-panel,#1C1A14);border-bottom:1px solid var(--tlm-line,#2A2820)}
.tlm-board .tlm-toolbar .tb-name{font-weight:600;font-size:13px;color:var(--tlm-ink,#ECE7DA);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tlm-board .tlm-toolbar .cr{cursor:pointer;color:var(--tlm-dim,#9A9182);font-weight:400}
.tlm-board .tlm-toolbar .cr:hover{color:var(--tlm-gold,#E8C56A)}
.tlm-board .tlm-toolbar .tb-spacer{flex:1}
.tlm-board .tlm-toolbar select,.tlm-board .tlm-toolbar button{font-family:"Space Mono",monospace;font-size:11px;background:var(--tlm-bg,#14120D);
  color:var(--tlm-ink,#ECE7DA);border:1px solid var(--tlm-line,#2A2820);border-radius:6px;padding:4px 8px;cursor:pointer}
.tlm-board .tlm-toolbar select:hover,.tlm-board .tlm-toolbar button:hover{border-color:var(--tlm-gold,#E8C56A);color:var(--tlm-gold,#E8C56A)}
.tlm-board .tlm-toolbar .up{padding:4px 9px;font-size:14px;line-height:1}
.tlm-board .tlm-status{position:absolute;bottom:0;left:0;right:0;height:22px;z-index:820;display:flex;align-items:center;padding:0 10px;
  background:var(--tlm-panel,#1C1A14);border-top:1px solid var(--tlm-line,#2A2820);
  font-family:"Space Mono",monospace;font-size:10px;color:var(--tlm-dim,#9A9182);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tlm-board .tlm-up{position:absolute;top:8px;left:8px;z-index:820;font-size:15px;line-height:1;background:rgba(28,26,20,.85);color:var(--tlm-ink,#ECE7DA);
  border:1px solid var(--tlm-line,#2A2820);border-radius:6px;padding:3px 9px;cursor:pointer}
.tlm-board .tlm-up:hover{border-color:var(--tlm-gold,#E8C56A);color:var(--tlm-gold,#E8C56A)}
`;

function injectStyle(doc) {
  if (doc.getElementById('tilemon-style')) return;
  const s = doc.createElement('style'); s.id = 'tilemon-style'; s.textContent = STYLE; doc.head.appendChild(s);
}

export function mount(boardEl, controlsEl, opts = {}) {
  const cb = k => opts[k] || (() => {});
  const onStatusChange = cb('onStatusChange'), onWeightChange = cb('onWeightChange');
  const onAddNode = cb('onAddNode'), onRenameNode = cb('onRenameNode'), onDeleteNode = cb('onDeleteNode');
  const onSetToolbar = cb('onSetToolbar'), onOpenBoard = cb('onOpenBoard');
  let boards = opts.boards || [];
  const doc = boardEl.ownerDocument, win = doc.defaultView || globalThis;
  injectStyle(doc);
  boardEl.classList.add('tlm-board');

  let srcState = opts.state || { name: 'Priorities', _board: null, _path: '', children: [] };
  let root, viewRoot, viewRootId = null, showWeights = false, showDone = opts.showDone !== false;   // done shown by default
  let tileEls = {}, drag = null, freeze = false, emptyEl = null, ghostEl = null, popEl = null;
  let toolbarEl = null, statusEl = null, upEl = null, hoverId = null, modDown = false;
  const isShell = () => viewRoot.toolbar !== false;

  const num = (v, d) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : d; };
  function clone(n) {
    const isDone = n.status === 'done';
    if (isDone && !showDone) return null;
    const out = { id: n.id, name: n.name, weight: num(n.weight, 1), status: n.status, note: n.note, toolbar: n.toolbar,
      _board: n._board, _path: n._path, _boardLink: n._boardLink, _ro: n._ro, _missing: n._missing, _cycle: n._cycle,
      heat: STATUS_HEAT[n.status] ?? 0, _done: isDone || undefined };
    const kids = n.children;
    if (kids && kids.length) {
      const cc = []; for (const k of kids) { const c = clone(k); if (c) cc.push(c); }
      if (cc.length) { out.children = cc; return out; }
      if ((n.status && !isDone) || n._boardLink) { out.children = null; return out; }
      return null;
    }
    out.children = null;
    if (!n._boardLink && !n.status) out.status = 'todo';
    return out;
  }
  function buildWorking(src) {
    const top = []; for (const k of (src.children || [])) { const c = clone(k); if (c) top.push(c); }
    return { id: src.id || '__root', name: src.name || 'Priorities', weight: num(src.weight, 1),
      toolbar: src.toolbar, _board: src._board, _path: src._path || '', children: top };
  }
  function rebuild() {
    root = buildWorking(srcState);
    viewRoot = (viewRootId && find(root, viewRootId)) || root;
    viewRootId = viewRoot === root ? null : viewRoot.id;
  }

  // ---- squarified treemap (Bruls/Huizing/van Wijk) ----
  function worstAspect(row, rowArea, side) { const thick = rowArea / side; let w = 1;
    for (const it of row) { const len = (it.area / rowArea) * side; const r = Math.max(thick / len, len / thick); if (r > w) w = r; } return w; }
  function squarify(items, x, y, w, h, out) {
    const rest = items.slice();
    while (rest.length) {
      const side = Math.min(w, h); let row = [], rowArea = 0, worst = Infinity;
      while (rest.length) { const it = rest[0], na = rowArea + it.area, nw = worstAspect(row.concat(it), na, side);
        if (row.length === 0 || nw <= worst) { row.push(rest.shift()); rowArea = na; worst = nw; } else break; }
      let thick = rowArea / side;
      if (w >= h) { thick = Math.min(thick, w); let cy = y;
        for (const it of row) { const ih = (it.area / rowArea) * h; out.push({ node: it.node, x, y: cy, w: thick, h: ih }); cy += ih; } x += thick; w -= thick; }
      else { thick = Math.min(thick, h); let cx = x;
        for (const it of row) { const iw = (it.area / rowArea) * w; out.push({ node: it.node, x: cx, y, w: iw, h: thick }); cx += iw; } y += thick; h -= thick; }
    }
  }
  function layout(node, x, y, w, h, depth, isView) {
    node._rect = { x, y, w, h, depth };
    const ch = node.children; if (!ch || !ch.length) return;
    const header = isView ? 0 : HEADER;
    const ix = x + PAD, iy = y + PAD + header, iw = w - 2 * PAD, ih = h - 2 * PAD - header;
    if (iw < 4 || ih < 4) { ch.forEach(c => { c._parent = node; layout(c, x, y, 0, 0, depth + 1, false); }); return; }
    const total = ch.reduce((s, c) => s + Math.max(c.weight, 1e-6), 0), area = iw * ih;
    const items = ch.map(c => ({ node: c, area: area * (Math.max(c.weight, 1e-6) / total) }));
    if (freeze) items.sort((a, b) => (a.node._ord == null ? 0 : a.node._ord) - (b.node._ord == null ? 0 : b.node._ord));
    else items.sort((a, b) => b.area - a.area || String(a.node.id).localeCompare(String(b.node.id)));
    items.forEach((it, i) => { it.node._ord = i; });
    const out = []; squarify(items, ix, iy, iw, ih, out);
    for (const o of out) { o.node._parent = node; layout(o.node, o.x, o.y, o.w, o.h, depth + 1, false); }
  }
  function calcHeat(node) {
    const own = node.heat || 0, ch = node.children;
    if (!ch || !ch.length) { node._heat = own; return own; }
    let a = 0, s = 0; for (const c of ch) { const ca = Math.max(c._rect.w * c._rect.h, 1e-4); a += ca; s += calcHeat(c) * ca; }
    node._heat = Math.max(own, a ? s / a : 0); return node._heat;
  }

  const lerp = (a, b, t) => a + (b - a) * t;
  function heatColor(h) { h = Math.max(0, Math.min(1, h));
    const st = [[0, [50, 48, 41]], [0.35, [92, 74, 46]], [0.7, [176, 106, 31]], [1, [216, 67, 46]]];
    for (let i = 0; i < st.length - 1; i++) { const [p0, c0] = st[i], [p1, c1] = st[i + 1];
      if (h <= p1) { const t = (h - p0) / (p1 - p0); return `rgb(${Math.round(lerp(c0[0], c1[0], t))},${Math.round(lerp(c0[1], c1[1], t))},${Math.round(lerp(c0[2], c1[2], t))})`; } }
    return 'rgb(216,67,46)'; }
  const textColor = h => h > 0.6 ? '#2A1206' : 'var(--tlm-ink,#ECE7DA)';
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  function find(n, id) { if (n.id === id) return n; for (const c of (n.children || [])) { const f = find(c, id); if (f) return f; } return null; }
  function pathNodes(n) { const p = []; let c = n; while (c) { p.unshift(c); c = c._parent; } return p; }
  // the outermost ancestor of `node` that sits directly inside the current view (the "big" thing)
  function outermostUnderView(node) { let a = node; while (a && a._parent && a._parent !== viewRoot) a = a._parent; return (a && a._parent === viewRoot) ? a : node; }
  const target = n => ({ board: n._board, path: n._path });
  const containerTarget = n => n._boardLink ? { board: n._boardLink, path: '' } : { board: n._board, path: n._path };

  // ---- board render ----
  function renderBoard() {
    const W = boardEl.clientWidth, H = boardEl.clientHeight, shell = isShell();
    const top = shell ? TOOLBAR_H : 0, bot = shell ? STATUS_H : 0;
    layout(viewRoot, 0, top, W, Math.max(1, H - top - bot), 0, shell); calcHeat(viewRoot);
    const vis = shell ? [] : [viewRoot];
    (function walk(n) { (n.children || []).forEach(c => { vis.push(c); walk(c); }); })(viewRoot);
    const seen = new Set();
    for (const node of vis) {
      const r = node._rect;
      if (r.w < 3 || r.h < 3) { if (tileEls[node.id]) { tileEls[node.id].remove(); delete tileEls[node.id]; } continue; }
      seen.add(node.id);
      const isBoard = node._boardLink !== undefined, isParent = node.children && node.children.length;
      let el = tileEls[node.id];
      if (!el) { el = doc.createElement('div'); el.className = 'tile'; el.style.opacity = '0'; el.dataset.id = node.id;
        el.addEventListener('pointerdown', onDown);
        el.addEventListener('dblclick', e => {   // drill the OUTERMOST container under the view, wherever you clicked
          e.stopPropagation();
          const n = find(root, el.dataset.id); if (!n) return;
          const t = outermostUnderView(n);
          // drillable: a non-empty group, OR any board (even empty — so you can go in and populate it),
          // but not a missing/cyclic board.
          const drillable = t !== viewRoot && ((t.children && t.children.length) || (t._boardLink !== undefined && !t._missing && !t._cycle));
          if (drillable) { viewRoot = t; viewRootId = t.id; render(); }
        });
        tileEls[node.id] = el; boardEl.appendChild(el); requestAnimationFrame(() => { if (tileEls[node.id]) el.style.opacity = '1'; }); }
      el.style.left = (r.x + INSET) + 'px'; el.style.top = (r.y + INSET) + 'px';
      el.style.width = Math.max(0, r.w - 2 * INSET) + 'px'; el.style.height = Math.max(0, r.h - 2 * INSET) + 'px';
      el.style.zIndex = r.depth;
      el.style.background = node._done ? DONE_COLOR : heatColor(node._heat);
      el.style.color = node._done ? 'var(--tlm-ink,#ECE7DA)' : textColor(node._heat);
      el.classList.toggle('hot', node._heat > 0.66 && !node._done);
      el.classList.toggle('done', !!node._done);
      el.classList.toggle('board', isBoard);
      const wt = showWeights ? `<span class="wt">${node.weight.toFixed(node.weight < 10 ? 1 : 0)}</span>` : '';
      const bar = el._bar ? el._bar.outerHTML : '';   // preserved below by re-applying hover
      let html = '';
      if (isParent) { if (r.w > 54 && r.h > 30) html = `<div class="hd"><span class="nm">${esc(node.name)}${isBoard ? ' <span class="bl">↳board</span>' : ''}</span>${wt}</div>`; }
      else if (isBoard) { if (r.w > 40 && r.h > 26) { const b = node._missing ? 'missing ⚠' : node._cycle ? 'cycle ⟳' : 'empty board'; html = `<div class="leaf"><span class="nm">${esc(node.name)}</span><span class="badge">${b}</span></div>`; } }
      else { if (r.w > 40 && r.h > 26) html = `<div class="leaf"><span class="nm">${esc(node.name)}</span>${wt}</div>`; }
      if (el._html !== html) { el.innerHTML = html; el._html = html; el._bar = null; }   // wipes any bar; hover re-adds
    }
    for (const id in tileEls) { if (!seen.has(id)) { tileEls[id].remove(); delete tileEls[id]; } }
    if (!(viewRoot.children && viewRoot.children.length)) {
      if (!emptyEl) { emptyEl = doc.createElement('div'); emptyEl.className = 'tlm-empty'; emptyEl.textContent = 'empty — hover the board to add an item, or point an agent here'; boardEl.appendChild(emptyEl); }
    } else if (emptyEl) { emptyEl.remove(); emptyEl = null; }
  }

  // ---- per-tile action bar (revealed on hover, along the ancestry chain) ----
  function buildBarHTML(node) {
    const isBoard = node._boardLink !== undefined, ro = !!node._ro, hasParent = !!node._parent, isLeaf = !(node.children && node.children.length) && !isBoard;
    let h = '';   // icons only — the tile keeps its own name/header, we don't duplicate it
    if (!ro && isLeaf) h += `<select class="bsel" data-a="st" title="status">` + STATUSES.map(s => `<option value="${s}"${node.status === s ? ' selected' : ''}>${STAT_LABEL[s]}</option>`).join('') + `</select>`;
    if (!ro) h += `<button data-a="add" title="add item">＋</button><button data-a="addb" title="add board">⧉</button>`;
    if (!ro) h += `<button data-a="ren" title="rename">✎</button>`;
    if (!ro && hasParent) h += `<button class="del" data-a="del" title="delete">✕</button>`;
    if (!ro && hasParent) h += `<button data-a="less" title="smaller">−</button><button data-a="more" title="bigger">＋</button>`;
    if (node._path === '') h += `<button data-a="tbar" title="toolbar">${node.toolbar !== false ? 'shell:on' : 'shell:off'}</button>`;
    if (isBoard && !node._missing && !node._cycle) h += `<button data-a="open" title="open board">↗</button>`;
    return h;
  }
  function barAction(node, a, ds) {
    if (a === 'st') return setStatus(node, ds);
    if (a === 'add') { const n = win.prompt('New item'); if (n && n.trim()) { const t = containerTarget(node); onAddNode(t.board, t.path, 'item', n.trim()); } return; }
    if (a === 'addb') { const n = win.prompt('New nested board'); if (n && n.trim()) { const t = containerTarget(node); onAddNode(t.board, t.path, 'native', n.trim()); } return; }
    if (a === 'ren') { const n = win.prompt('Rename', node.name); if (n && n.trim()) onRenameNode(node._board, node._path, n.trim()); return; }
    if (a === 'del') { if (win.confirm(`Delete “${node.name}”?`)) onDeleteNode(node._board, node._path); return; }
    if (a === 'less') return nudgeWeight(node, 1 / 1.4);
    if (a === 'more') return nudgeWeight(node, 1.4);
    if (a === 'tbar') return onSetToolbar(node._board, node._path, node.toolbar === false);
    if (a === 'open') return onOpenBoard(node._boardLink);
  }
  function attachBar(el, node) {
    if (el._bar) el._bar.remove();
    const bar = doc.createElement('div'); bar.className = 'tlm-bar'; bar.innerHTML = buildBarHTML(node);
    bar.addEventListener('pointerdown', e => e.stopPropagation());   // don't start a resize from the bar
    bar.addEventListener('click', e => { const b = e.target.closest && e.target.closest('button'); if (b) barAction(node, b.dataset.a, b.dataset.s); });
    bar.addEventListener('change', e => { const t = e.target; if (t && t.dataset && t.dataset.a === 'st') barAction(node, 'st', t.value); });
    el.appendChild(bar); el._bar = bar;
  }
  function applyHover() {
    const chain = new Set();
    let n = hoverId ? find(root, hoverId) : null;
    while (n) { if (tileEls[n.id]) chain.add(n.id); n = n._parent; }
    for (const id in tileEls) {
      const el = tileEls[id], node = find(root, id);
      const active = chain.has(id) && node._rect && node._rect.w >= BAR_MIN_W && node._rect.h >= BAR_MIN_H;
      if (active) { if (!el._bar) attachBar(el, node); } else if (el._bar) { el._bar.remove(); el._bar = null; }
    }
    // tiny innermost tile: fall back to a popover so its controls are still reachable
    const inner = hoverId ? find(root, hoverId) : null;
    if (inner && inner._rect && (inner._rect.w < BAR_MIN_W || inner._rect.h < BAR_MIN_H)) showPop(inner); else hidePop();
    updateTarget();
  }
  // highlight the tile a drag would resize right now — outermost by default, innermost while a
  // modifier is held — so it's obvious what you're about to grab (and it flips with the key).
  function updateTarget() {
    let tid = null;
    if (hoverId && !drag) { const n = find(root, hoverId); if (n) { const t = modDown ? n : outermostUnderView(n); if (t && t._parent && !t._ro) tid = t.id; } }
    for (const id in tileEls) tileEls[id].classList.toggle('target', id === tid);
  }
  function onKey(e) { const m = !!(e.ctrlKey || e.metaKey || e.altKey); if (m !== modDown) { modDown = m; updateTarget(); } }
  function onHover(e) {
    if (drag) return;
    const t = e.target && e.target.closest ? e.target.closest('.tile') : null;
    const id = t ? t.dataset.id : null;
    if (id === hoverId) return;
    hoverId = id; applyHover();
  }

  // ---- tiny-tile popover fallback ----
  function hidePop() { if (popEl) { popEl.remove(); popEl = null; } }
  function showPop(node) {
    hidePop();
    popEl = doc.createElement('div'); popEl.className = 'tlm-bar'; popEl.style.position = 'absolute'; popEl.style.zIndex = '900';
    popEl.style.right = 'auto'; popEl.style.flexWrap = 'wrap'; popEl.style.maxWidth = '240px'; popEl.style.borderRadius = '7px';
    popEl.style.background = 'var(--tlm-panel,#1C1A14)'; popEl.style.border = '1px solid var(--tlm-line,#2A2820)'; popEl.style.padding = '4px';
    popEl.innerHTML = buildBarHTML(node);
    popEl.addEventListener('pointerdown', e => e.stopPropagation());
    popEl.addEventListener('click', e => { const b = e.target.closest && e.target.closest('button'); if (b) barAction(node, b.dataset.a, b.dataset.s); });
    popEl.addEventListener('change', e => { const t = e.target; if (t && t.dataset && t.dataset.a === 'st') barAction(node, 'st', t.value); });
    boardEl.appendChild(popEl);
    const r = node._rect, pw = popEl.offsetWidth || 200, ph = popEl.offsetHeight || 40;
    popEl.style.left = Math.max(6, Math.min(r.x, boardEl.clientWidth - pw - 6)) + 'px';
    popEl.style.top = Math.max(6, Math.min(r.y, boardEl.clientHeight - ph - 6)) + 'px';
  }

  // ---- writes ----
  function setStatus(node, status) { const t = target(node); onStatusChange(t.board, t.path, status); node.status = status; node.heat = STATUS_HEAT[status] ?? 0; renderBoard(); applyHover(); }
  function nudgeWeight(node, f) {
    if (!node._parent || node._ro) return;
    const others = node._parent.children.reduce((s, c) => s + c.weight, 0) - node.weight;
    node.weight = Math.max(others * .01 / .99, Math.min(others * .97 / .03, node.weight * f));
    const t = target(node); onWeightChange(t.board, t.path, node.weight); renderBoard(); applyHover();
  }

  // ---- corner-drag resize: grab a tile, the quadrant picks the moving corner (relative) ----
  function onDown(e) {
    e.stopPropagation();
    if (e.target && e.target.closest && e.target.closest('.tlm-bar')) return;   // clicks on the action bar aren't drags
    const tapped = find(root, e.currentTarget.dataset.id); if (!tapped) return;
    // plain drag resizes the OUTERMOST container under the view (the big thing you can barely grab
    // otherwise); holding a modifier resizes the exact tile you touched (the innermost).
    const inner = e.ctrlKey || e.metaKey || e.altKey;
    const node = inner ? tapped : outermostUnderView(tapped);
    const canResize = !!node._parent && !node._ro;
    drag = { node, moved: false, sx: e.clientX, sy: e.clientY, canResize };
    if (canResize) {
      const r = node._rect, br = boardEl.getBoundingClientRect();
      const px = e.clientX - br.left, py = e.clientY - br.top, left = px < r.x + r.w / 2, top = py < r.y + r.h / 2;
      drag.br = br; drag.anchorX = left ? r.x + r.w : r.x; drag.anchorY = top ? r.y + r.h : r.y;
      drag.cornerX = left ? r.x : r.x + r.w; drag.cornerY = top ? r.y : r.y + r.h;
      freeze = true; boardEl.classList.add('nodrag');
      ghostEl = doc.createElement('div'); ghostEl.className = 'tlm-ghost';
      ghostEl.style.left = r.x + 'px'; ghostEl.style.top = r.y + 'px'; ghostEl.style.width = r.w + 'px'; ghostEl.style.height = r.h + 'px';
      boardEl.appendChild(ghostEl);
    }
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { }
    win.addEventListener('pointermove', onMove); win.addEventListener('pointerup', onUp);
  }
  function onMove(e) {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
    drag.moved = true;
    if (!drag.canResize || !ghostEl) return;
    const cx = Math.max(0, Math.min(boardEl.clientWidth, drag.cornerX + (e.clientX - drag.sx)));
    const cy = Math.max(0, Math.min(boardEl.clientHeight, drag.cornerY + (e.clientY - drag.sy)));
    ghostEl.style.left = Math.min(drag.anchorX, cx) + 'px'; ghostEl.style.top = Math.min(drag.anchorY, cy) + 'px';
    ghostEl.style.width = Math.abs(cx - drag.anchorX) + 'px'; ghostEl.style.height = Math.abs(cy - drag.anchorY) + 'px';
    drag.ghost = { gw: Math.abs(cx - drag.anchorX), gh: Math.abs(cy - drag.anchorY) };
  }
  function onUp() {
    win.removeEventListener('pointermove', onMove); win.removeEventListener('pointerup', onUp);
    boardEl.classList.remove('nodrag'); freeze = false;
    if (ghostEl) { ghostEl.remove(); ghostEl = null; }
    if (drag && drag.moved && drag.canResize && drag.ghost) {
      const sibs = drag.node._parent.children;
      const parentArea = sibs.reduce((s, c) => s + Math.max(c._rect.w * c._rect.h, 0), 0) || 1;
      const share = Math.max(0.02, Math.min(0.95, (drag.ghost.gw * drag.ghost.gh) / parentArea));
      const others = sibs.reduce((s, c) => s + c.weight, 0) - drag.node.weight;
      if (others > 1e-9) { drag.node.weight = share / (1 - share) * others; const t = target(drag.node); onWeightChange(t.board, t.path, drag.node.weight); }
    }
    drag = null; render();
  }

  function goUp() { const p = viewRoot._parent || root; viewRoot = p; viewRootId = p === root ? null : p.id; render(); }
  const rm = el => { if (el) el.remove(); };

  // ---- shell chrome: toolbar (up · name · add · switcher · weights · done) + status footer ----
  function renderChrome() {
    const shell = isShell(), drilled = viewRoot !== root;
    if (!shell) {
      rm(toolbarEl); toolbarEl = null; rm(statusEl); statusEl = null;
      if (drilled) { if (!upEl) { upEl = doc.createElement('div'); upEl.className = 'tlm-up'; upEl.textContent = '‹'; upEl.onclick = goUp; boardEl.appendChild(upEl); } } else { rm(upEl); upEl = null; }
      return;
    }
    rm(upEl); upEl = null;
    if (!toolbarEl) { toolbarEl = doc.createElement('div'); toolbarEl.className = 'tlm-toolbar'; boardEl.appendChild(toolbarEl); }
    const cur = root._board;
    const sw = boards && boards.length ? `<select id="tbBoards">` + boards.map(b => `<option value="${esc(b.slug)}"${b.slug === cur ? ' selected' : ''}>${esc(b.name)}${b.visibility === 'public' ? ' (public)' : ''}</option>`).join('') + `</select>` : '';
    const bc = pathNodes(viewRoot);   // breadcrumb: click any ancestor to climb back out
    const crumb = `<span class="tb-name">` + bc.map((n, i) => i === bc.length - 1 ? `<b>${esc(n.name)}</b>` : `<span class="cr" data-id="${esc(n.id)}">${esc(n.name)}</span> ／ `).join('') + `</span>`;
    toolbarEl.innerHTML = crumb
      + `<button id="tbAdd" title="add item">＋</button><button id="tbAddb" title="add board">⧉</button><span class="tb-spacer"></span>`
      + sw + `<button id="tbWt">weights: ${showWeights ? 'on' : 'off'}</button><button id="tbDone">done: ${showDone ? 'shown' : 'hidden'}</button>`
      + `<button id="tbShell" title="hide the shell chrome for this board">shell</button>`;
    const q = s => toolbarEl.querySelector(s);
    toolbarEl.querySelectorAll('.cr').forEach(s => s.onclick = () => { const t = find(root, s.dataset.id); if (t) { viewRoot = t; viewRootId = t === root ? null : t.id; render(); } });
    q('#tbShell').onclick = () => onSetToolbar(viewRoot._board, viewRoot._path, false);   // turn this board bare
    if (q('#tbBoards')) q('#tbBoards').onchange = () => onOpenBoard(q('#tbBoards').value);
    q('#tbAdd').onclick = () => { const n = win.prompt('New item'); if (n && n.trim()) { const t = containerTarget(viewRoot); onAddNode(t.board, t.path, 'item', n.trim()); } };
    q('#tbAddb').onclick = () => { const n = win.prompt('New nested board'); if (n && n.trim()) { const t = containerTarget(viewRoot); onAddNode(t.board, t.path, 'native', n.trim()); } };
    q('#tbWt').onclick = () => { showWeights = !showWeights; render(); };
    q('#tbDone').onclick = () => { showDone = !showDone; rebuild(); render(); };
    if (!statusEl) { statusEl = doc.createElement('div'); statusEl.className = 'tlm-status'; boardEl.appendChild(statusEl); }
    statusEl.textContent = 'hover for actions · drag = resize its group · ⌘/Ctrl/Alt-drag = resize this tile · double-click = drill in';
  }

  function render() { renderBoard(); renderChrome(); applyHover(); }

  const ro = new ResizeObserver(() => { renderBoard(); applyHover(); }); ro.observe(boardEl);
  boardEl.addEventListener('pointermove', onHover);
  boardEl.addEventListener('pointerleave', () => { hoverId = null; applyHover(); });
  win.addEventListener('keydown', onKey); win.addEventListener('keyup', onKey);   // modifier flips the resize target

  rebuild(); render();

  return {
    update(newState) { if (drag) return; srcState = newState; rebuild(); render(); },
    setBoards(list) { boards = list || []; renderChrome(); },
    setShowDone(v) { showDone = !!v; rebuild(); render(); },
    getState() { return srcState; },
    destroy() { ro.disconnect(); boardEl.removeEventListener('pointermove', onHover); win.removeEventListener('keydown', onKey); win.removeEventListener('keyup', onKey); hidePop(); rm(toolbarEl); rm(statusEl); rm(upEl); for (const id in tileEls) tileEls[id].remove(); tileEls = {}; },
  };
}
