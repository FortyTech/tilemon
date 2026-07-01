// board.js — Tilemon renderer. Framework-agnostic, zero dependencies, ESM.
//
//   import { mount } from './board.js'
//   const board = mount(boardEl, controlsEl, {
//     state,                                        // resolved tree from the server (nodes stamped _board/_path)
//     onStatusChange: (board, path, status) => {},  // a node's status changed -> persist
//     onWeightChange: (board, path, weight) => {},  // human resized a node -> persist
//     onAddNode:      (board, parentPath, kind, name) => {},  // kind: 'item' | 'native'
//     onRenameNode:   (board, path, name) => {},
//     onDeleteNode:   (board, path) => {},
//     onOpenBoard:    (slug) => {},                 // open a nested board standalone
//   })
//   board.update(newState)                          // re-render (drill/selection preserved)
//
// The renderer owns NO storage. It announces *what changed* via callbacks; the host persists.
// Every node carries its owning board (`_board`) and local path (`_path`) — so a write lands on
// the right board even when nested boards are inlined. A node with `_boardLink` is a nested-board
// boundary (its children belong to that sub-board). `_ro` marks read-only (e.g. Jira) nodes.

const PAD = 5, HEADER = 22, INSET = 2;
const STATUS_HEAT = { todo: 0, in_progress: 0.5, blocked: 1 }; // `done` => dropped, no heat
const STATUSES = ['todo', 'in_progress', 'blocked', 'done'];
const DONE_COLOR = 'rgb(74,92,58)'; // muted sage — "complete", off the heat ramp

const STYLE = `
.tlm-board{position:relative;width:100%;height:100%;overflow:hidden;background:var(--tlm-bg,#14120D);touch-action:none}
.tlm-board .tile{position:absolute;border-radius:5px;overflow:hidden;cursor:grab;user-select:none;outline:0 solid transparent;
  transition:left .18s ease,top .18s ease,width .18s ease,height .18s ease,background .25s ease,opacity .2s ease}
.tlm-board.nodrag .tile{transition:background .25s ease}
.tlm-board .tile:active{cursor:grabbing}
.tlm-board .tile.sel{outline:2px solid var(--tlm-gold,#E8C56A);outline-offset:-2px;z-index:600!important}
.tlm-board .tile.armed{outline:2px dashed var(--tlm-gold,#E8C56A);outline-offset:-2px;z-index:600!important}
.tlm-board .tile.board{outline:1px dashed var(--tlm-gold,#E8C56A);outline-offset:-3px}
.tlm-board .tile .hd{position:absolute;top:0;left:0;right:0;height:22px;display:flex;align-items:center;
  justify-content:space-between;padding:0 8px;gap:6px;pointer-events:none}
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
.tlm-board .tlm-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  font-family:"Space Mono",monospace;font-size:12.5px;color:var(--tlm-dim,#9A9182);text-align:center;padding:24px;pointer-events:none}
.tlm-pop{position:absolute;z-index:900;min-width:180px;max-width:240px;background:var(--tlm-panel,#1C1A14);
  border:1px solid var(--tlm-line,#2A2820);border-radius:8px;padding:9px;display:flex;flex-direction:column;gap:7px;
  box-shadow:0 8px 24px rgba(0,0,0,.45);font-family:"Space Grotesk",system-ui,sans-serif}
.tlm-pop .pt{font-size:12.5px;font-weight:600;color:var(--tlm-ink,#ECE7DA);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tlm-pop .note{font-family:"Space Mono",monospace;font-size:10.5px;color:var(--tlm-ink,#ECE7DA);border-left:2px solid var(--tlm-gold,#E8C56A);
  padding-left:7px;line-height:1.45;white-space:normal}
.tlm-pop .row{display:flex;gap:4px;flex-wrap:wrap;align-items:center}
.tlm-pop .row .lbl{font-family:"Space Mono",monospace;font-size:9.5px;color:var(--tlm-dim,#9A9182);width:100%}
.tlm-pop button{font-family:"Space Mono",monospace;font-size:11px;background:var(--tlm-bg,#14120D);color:var(--tlm-ink,#ECE7DA);
  border:1px solid var(--tlm-line,#2A2820);border-radius:5px;padding:5px 8px;cursor:pointer;transition:border-color .12s,color .12s}
.tlm-pop button:hover{border-color:var(--tlm-gold,#E8C56A);color:var(--tlm-gold,#E8C56A)}
.tlm-pop button.on{border-color:var(--tlm-gold,#E8C56A);color:var(--tlm-gold,#E8C56A)}
.tlm-pop button.danger:hover{border-color:#b0563a;color:#d8674a}
.tlm-controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-height:30px}
.tlm-controls .crumb{font-size:14px;color:var(--tlm-dim,#9A9182);display:flex;align-items:center;gap:6px;flex:1;min-width:180px}
.tlm-controls .crumb b{color:var(--tlm-ink,#ECE7DA);font-weight:500}
.tlm-controls .crumb span.c{cursor:pointer}.tlm-controls .crumb span.c:hover{color:var(--tlm-gold,#E8C56A)}
.tlm-controls .crumb .sep{color:var(--tlm-line,#2A2820)}
.tlm-controls button,.tlm-controls .tog{font-family:"Space Mono",monospace;font-size:11.5px;background:var(--tlm-panel,#1C1A14);
  color:var(--tlm-ink,#ECE7DA);border:1px solid var(--tlm-line,#2A2820);border-radius:6px;padding:6px 9px;cursor:pointer;
  transition:border-color .15s,color .15s,opacity .15s}
.tlm-controls button:hover:not(:disabled){border-color:var(--tlm-gold,#E8C56A);color:var(--tlm-gold,#E8C56A)}
.tlm-controls button:disabled{opacity:.32;cursor:default}
.tlm-controls .grp{display:flex;gap:4px;align-items:center}
.tlm-controls .grp .lbl{font-family:"Space Mono",monospace;font-size:10.5px;color:var(--tlm-dim,#9A9182);margin-right:2px}
`;

function injectStyle(doc) {
  if (doc.getElementById('tilemon-style')) return;
  const s = doc.createElement('style');
  s.id = 'tilemon-style'; s.textContent = STYLE;
  doc.head.appendChild(s);
}

export function mount(boardEl, controlsEl, opts = {}) {
  const onStatusChange = opts.onStatusChange || (() => {});
  const onWeightChange = opts.onWeightChange || (() => {});
  const onAddNode = opts.onAddNode || (() => {});
  const onRenameNode = opts.onRenameNode || (() => {});
  const onDeleteNode = opts.onDeleteNode || (() => {});
  const onOpenBoard = opts.onOpenBoard || (() => {});
  const doc = boardEl.ownerDocument;
  const win = doc.defaultView || globalThis;
  injectStyle(doc);
  boardEl.classList.add('tlm-board');
  if (controlsEl) controlsEl.classList.add('tlm-controls');

  let srcState = opts.state || { name: 'Priorities', _board: null, _path: '', children: [] };
  let root, viewRoot;
  let viewRootId = null, selId = null, showWeights = false, showDone = !!opts.showDone;
  let tileEls = {}, drag = null, freeze = false, emptyEl = null, popEl = null;

  const num = (v, d) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : d; };

  // ---- derive the working tree; drops `done` (unless showDone), keeps all stamps ----
  function clone(n) {
    const isDone = n.status === 'done';
    if (isDone && !showDone) return null;
    const out = {
      id: n.id, name: n.name, weight: num(n.weight, 1), status: n.status, note: n.note,
      _board: n._board, _path: n._path, _boardLink: n._boardLink, _ro: n._ro,
      _missing: n._missing, _cycle: n._cycle, heat: STATUS_HEAT[n.status] ?? 0, _done: isDone || undefined,
    };
    const kids = n.children;
    if (kids && kids.length) {
      const cc = [];
      for (const k of kids) { const c = clone(k); if (c) cc.push(c); }
      if (cc.length) { out.children = cc; return out; }
      // emptied by done-hiding: keep as a tile only if it carries its own status or is a board boundary
      if ((n.status && !isDone) || n._boardLink) { out.children = null; return out; }
      return null;
    }
    out.children = null;
    if (!n._boardLink && !n.status) out.status = 'todo';
    return out;
  }
  function buildWorking(src) {
    const top = [];
    for (const k of (src.children || [])) { const c = clone(k); if (c) top.push(c); }
    return { id: src.id || '__root', name: src.name || 'Priorities', weight: num(src.weight, 1),
             _board: src._board, _path: src._path || '', children: top };
  }
  function rebuild() {
    root = buildWorking(srcState);
    viewRoot = (viewRootId && find(root, viewRootId)) || root;
    viewRootId = viewRoot === root ? null : viewRoot.id;
    if (selId && !find(root, selId)) selId = null;
  }

  // ---- squarified treemap (Bruls/Huizing/van Wijk) — proven ----
  function worstAspect(row, rowArea, side) {
    const thick = rowArea / side; let worst = 1;
    for (const it of row) { const len = (it.area / rowArea) * side; const r = Math.max(thick / len, len / thick); if (r > worst) worst = r; }
    return worst;
  }
  function squarify(items, x, y, w, h, out) {
    const rest = items.slice();
    while (rest.length) {
      const side = Math.min(w, h); let row = [], rowArea = 0, worst = Infinity;
      while (rest.length) {
        const it = rest[0], na = rowArea + it.area, nw = worstAspect(row.concat(it), na, side);
        if (row.length === 0 || nw <= worst) { row.push(rest.shift()); rowArea = na; worst = nw; } else break;
      }
      let thick = rowArea / side;
      if (w >= h) { thick = Math.min(thick, w); let cy = y;
        for (const it of row) { const ih = (it.area / rowArea) * h; out.push({ node: it.node, x, y: cy, w: thick, h: ih }); cy += ih; }
        x += thick; w -= thick;
      } else { thick = Math.min(thick, h); let cx = x;
        for (const it of row) { const iw = (it.area / rowArea) * w; out.push({ node: it.node, x: cx, y, w: iw, h: thick }); cx += iw; }
        y += thick; h -= thick;
      }
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
    const own = node.heat || 0;
    const ch = node.children;
    if (!ch || !ch.length) { node._heat = own; return node._heat; }
    let a = 0, s = 0;
    for (const c of ch) { const ca = Math.max(c._rect.w * c._rect.h, 1e-4), hc = calcHeat(c); a += ca; s += hc * ca; }
    node._heat = Math.max(own, a ? s / a : 0);
    return node._heat;
  }

  // ---- colour ----
  const lerp = (a, b, t) => a + (b - a) * t;
  function heatColor(h) {
    h = Math.max(0, Math.min(1, h));
    const st = [[0, [50, 48, 41]], [0.35, [92, 74, 46]], [0.7, [176, 106, 31]], [1, [216, 67, 46]]];
    for (let i = 0; i < st.length - 1; i++) {
      const [p0, c0] = st[i], [p1, c1] = st[i + 1];
      if (h <= p1) { const t = (h - p0) / (p1 - p0); return `rgb(${Math.round(lerp(c0[0], c1[0], t))},${Math.round(lerp(c0[1], c1[1], t))},${Math.round(lerp(c0[2], c1[2], t))})`; }
    }
    return 'rgb(216,67,46)';
  }
  const textColor = h => h > 0.6 ? '#2A1206' : 'var(--tlm-ink,#ECE7DA)';
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  // ---- tree helpers ----
  function find(n, id) { if (n.id === id) return n; for (const c of (n.children || [])) { const f = find(c, id); if (f) return f; } return null; }
  const selected = () => selId ? find(root, selId) : null;
  const activeContainer = () => { const s = selected(); return (s && s.children && s.children.length) ? s : viewRoot; };
  function resizeTarget(node, ac) { let a = node; while (a && a._parent && a._parent !== ac) a = a._parent; return (a && a._parent === ac) ? a : null; }
  function pathNodes(n) { const p = []; let c = n; while (c) { p.unshift(c); c = c._parent; } return p; }
  // write target: the board that owns this node + its local path (stamped by the server)
  const target = n => ({ board: n._board, path: n._path });

  // ---- board render ----
  function renderBoard() {
    const W = boardEl.clientWidth, H = boardEl.clientHeight;
    layout(viewRoot, 0, 0, W, H, 0, true); calcHeat(viewRoot);
    const vis = []; (function walk(n) { (n.children || []).forEach(c => { vis.push(c); walk(c); }); })(viewRoot);
    const seen = new Set();
    for (const node of vis) {
      const r = node._rect;
      if (r.w < 3 || r.h < 3) { if (tileEls[node.id]) { tileEls[node.id].remove(); delete tileEls[node.id]; } continue; }
      seen.add(node.id);
      const isBoard = node._boardLink !== undefined;
      const isParent = node.children && node.children.length;
      let el = tileEls[node.id];
      if (!el) {
        el = doc.createElement('div'); el.className = 'tile'; el.style.opacity = '0';
        el.dataset.id = node.id; attach(el); tileEls[node.id] = el; boardEl.appendChild(el);
        requestAnimationFrame(() => { if (tileEls[node.id]) el.style.opacity = '1'; });
      }
      el.style.left = (r.x + INSET) + 'px'; el.style.top = (r.y + INSET) + 'px';
      el.style.width = Math.max(0, r.w - 2 * INSET) + 'px'; el.style.height = Math.max(0, r.h - 2 * INSET) + 'px';
      el.style.zIndex = r.depth;
      el.style.background = node._done ? DONE_COLOR : heatColor(node._heat);
      el.style.color = node._done ? 'var(--tlm-ink,#ECE7DA)' : textColor(node._heat);
      const isSel = selId === node.id;
      el.classList.toggle('sel', isSel && !isParent);
      el.classList.toggle('armed', isSel && !!isParent);
      el.classList.toggle('hot', node._heat > 0.66 && !node._done);
      el.classList.toggle('done', !!node._done);
      el.classList.toggle('board', isBoard);
      const wt = showWeights ? `<span class="wt">${node.weight.toFixed(node.weight < 10 ? 1 : 0)}</span>` : '';
      let html = '';
      if (isParent) {                                   // container (incl. an inlined board): header label
        if (r.w > 54 && r.h > 30) html = `<div class="hd"><span class="nm">${esc(node.name)}${isBoard ? ' <span class="bl">↳board</span>' : ''}</span>${wt}</div>`;
      } else if (isBoard) {                             // empty / missing / cyclic nested board
        if (r.w > 40 && r.h > 26) { const badge = node._missing ? 'missing ⚠' : node._cycle ? 'cycle ⟳' : 'empty board'; html = `<div class="leaf"><span class="nm">${esc(node.name)}</span><span class="badge">${badge}</span></div>`; }
      } else {                                          // leaf
        if (r.w > 40 && r.h > 26) html = `<div class="leaf"><span class="nm">${esc(node.name)}</span>${wt}</div>`;
      }
      if (el._html !== html) { el.innerHTML = html; el._html = html; }
    }
    for (const id in tileEls) { if (!seen.has(id)) { tileEls[id].remove(); delete tileEls[id]; } }
    if (!seen.size) {
      if (!emptyEl) { emptyEl = doc.createElement('div'); emptyEl.className = 'tlm-empty';
        emptyEl.textContent = 'empty — add an item, or point an agent at this board'; boardEl.appendChild(emptyEl); }
    } else if (emptyEl) { emptyEl.remove(); emptyEl = null; }
  }

  function attach(el) {
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('dblclick', e => {                       // drill into any container (incl. a nested board)
      e.stopPropagation();
      const n = find(root, el.dataset.id);
      if (n && n.children && n.children.length) { viewRoot = n; viewRootId = n.id; selId = null; render(); }
    });
  }
  function onDown(e) {
    e.stopPropagation();
    const id = e.currentTarget.dataset.id, node = find(root, id); if (!node) return;
    let ac = activeContainer(), tgt = resizeTarget(node, ac);
    if (!tgt) { ac = viewRoot; tgt = resizeTarget(node, ac) || node; }
    const p = tgt._parent, others = p ? p.children.reduce((s, c) => s + c.weight, 0) - tgt.weight : 0;
    drag = { tappedId: id, node: tgt, p, others, sx: e.clientX, sy: e.clientY, sw: tgt.weight, moved: false };
    freeze = true; boardEl.classList.add('nodrag'); hidePop();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { }
    win.addEventListener('pointermove', onMove);
    win.addEventListener('pointerup', onUp);
  }
  function onMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    if (drag.p && drag.others > 0 && !drag.node._ro) {
      const delta = dx + dy;
      const w = drag.sw * Math.exp(delta / 220);
      const minW = drag.others * 0.01 / 0.99, maxW = drag.others * 0.97 / 0.03;
      drag.node.weight = Math.max(minW, Math.min(maxW, w));
      renderBoard();
    }
  }
  function onUp() {
    win.removeEventListener('pointermove', onMove);
    win.removeEventListener('pointerup', onUp);
    boardEl.classList.remove('nodrag'); freeze = false;
    if (drag && !drag.moved) { selId = drag.tappedId; }
    else if (drag && drag.moved && drag.node && !drag.node._ro) { const t = target(drag.node); onWeightChange(t.board, t.path, drag.node.weight); }
    drag = null; render();
  }

  // ---- writes ----
  function setStatus(node, status) {
    const t = target(node);
    onStatusChange(t.board, t.path, status);           // persist; SSE refresh will reconcile structure (e.g. done-drop)
    node.status = status; node.heat = STATUS_HEAT[status] ?? 0;  // optimistic colour
    renderBoard();
  }
  function nudgeWeight(node, factor) {
    if (!node._parent || node._ro) return;
    const others = node._parent.children.reduce((s, c) => s + c.weight, 0) - node.weight;
    const minW = others * 0.01 / 0.99, maxW = others * 0.97 / 0.03;
    node.weight = Math.max(minW, Math.min(maxW, node.weight * factor));
    const t = target(node); onWeightChange(t.board, t.path, node.weight);
    renderBoard(); positionPop(node);
  }

  // ---- per-tile popover: the actions live on the selected item, not a global bar ----
  function hidePop() { if (popEl) { popEl.remove(); popEl = null; } }
  function positionPop(node) {
    if (!popEl || !node._rect) return;
    const r = node._rect, pw = popEl.offsetWidth || 200, ph = popEl.offsetHeight || 120;
    let x = Math.min(r.x + 6, boardEl.clientWidth - pw - 6);
    let y = Math.min(r.y + 6, boardEl.clientHeight - ph - 6);
    popEl.style.left = Math.max(6, x) + 'px'; popEl.style.top = Math.max(6, y) + 'px';
  }
  function renderPopover() {
    hidePop();
    const sel = selected(); if (!sel) return;
    const isBoard = sel._boardLink !== undefined, ro = !!sel._ro, canDel = !!sel._parent;
    popEl = doc.createElement('div'); popEl.className = 'tlm-pop';
    let h = `<div class="pt">${esc(sel.name)}${isBoard ? ' <span class="bl">↳board</span>' : ''}</div>`;
    if (sel.note) h += `<div class="note">${esc(sel.note)}</div>`;
    if (ro) h += `<div class="row"><span class="lbl">read-only source — view only</span></div>`;
    if (!ro && !isBoard) h += `<div class="row"><span class="lbl">status</span>` +
      STATUSES.map(s => `<button class="st${sel.status === s ? ' on' : ''}" data-s="${s}">${s.replace('_', ' ')}</button>`).join('') + `</div>`;
    if (!ro) h += `<div class="row"><span class="lbl">size</span><button id="wless">– smaller</button><button id="wmore">+ bigger</button></div>`;
    if (!ro && !isBoard) h += `<div class="row"><button id="pAddItem">+ item</button><button id="pAddBoard">+ board</button></div>`;
    if (!ro) h += `<div class="row">` +
      `<button id="pRename">rename</button>` +
      (canDel ? `<button id="pDel" class="danger">delete</button>` : '') + `</div>`;
    if (isBoard && !sel._missing && !sel._cycle) h += `<div class="row"><button id="pOpen">open ${esc(sel.name)} ↗</button></div>`;
    popEl.innerHTML = h;
    boardEl.appendChild(popEl);
    positionPop(sel);
    const q = s => popEl.querySelector(s);
    popEl.querySelectorAll('.st').forEach(b => b.onclick = () => setStatus(sel, b.dataset.s));
    if (q('#wless')) q('#wless').onclick = () => nudgeWeight(sel, 1 / 1.4);
    if (q('#wmore')) q('#wmore').onclick = () => nudgeWeight(sel, 1.4);
    if (q('#pAddItem')) q('#pAddItem').onclick = () => { const n = win.prompt('New item'); if (n && n.trim()) onAddNode(sel._board, sel._path, 'item', n.trim()); };
    if (q('#pAddBoard')) q('#pAddBoard').onclick = () => { const n = win.prompt('New nested board'); if (n && n.trim()) onAddNode(sel._board, sel._path, 'native', n.trim()); };
    if (q('#pRename')) q('#pRename').onclick = () => { const n = win.prompt('Rename', sel.name); if (n && n.trim()) onRenameNode(sel._board, sel._path, n.trim()); };
    if (q('#pDel')) q('#pDel').onclick = () => { if (win.confirm(`Delete “${sel.name}”?`)) onDeleteNode(sel._board, sel._path); };
    if (q('#pOpen')) q('#pOpen').onclick = () => onOpenBoard(sel._boardLink);
  }

  // ---- header: navigation + add-to-current-board + view toggles (no per-item actions) ----
  function renderControls() {
    if (!controlsEl) return;
    const bc = pathNodes(viewRoot);
    const crumb = bc.map((n, i) => i === bc.length - 1 ? `<b>${esc(n.name)}</b>`
      : `<span class="c" data-id="${esc(n.id)}">${esc(n.name)}</span><span class="sep">/</span>`).join(' ');
    const viewRo = !!viewRoot._ro;
    let html = `<div class="crumb">${crumb}</div>`;
    if (!viewRo) html += `<div class="grp"><span class="lbl">add</span><button id="addItem">+ item</button><button id="addBoard">+ board</button></div>`;
    html += `<div class="grp"><button id="wtTog" class="tog">weights: ${showWeights ? 'on' : 'off'}</button>` +
            `<button id="doneTog" class="tog">done: ${showDone ? 'shown' : 'hidden'}</button></div>`;
    controlsEl.innerHTML = html;
    controlsEl.querySelectorAll('.c').forEach(s => s.onclick = () => { const t = find(root, s.dataset.id); if (t) { viewRoot = t; viewRootId = t.id; selId = null; render(); } });
    controlsEl.querySelector('#wtTog').onclick = () => { showWeights = !showWeights; render(); };
    controlsEl.querySelector('#doneTog').onclick = () => { showDone = !showDone; rebuild(); render(); };
    if (!viewRo) {
      controlsEl.querySelector('#addItem').onclick = () => { const n = win.prompt('New item'); if (n && n.trim()) onAddNode(viewRoot._board, viewRoot._path, 'item', n.trim()); };
      controlsEl.querySelector('#addBoard').onclick = () => { const n = win.prompt('New nested board'); if (n && n.trim()) onAddNode(viewRoot._board, viewRoot._path, 'native', n.trim()); };
    }
  }

  function render() { renderControls(); renderBoard(); renderPopover(); }

  const onBgDown = e => { if (e.target === boardEl) { selId = null; render(); } };
  boardEl.addEventListener('pointerdown', onBgDown);
  const ro = new ResizeObserver(() => { renderBoard(); const s = selected(); if (s) positionPop(s); }); ro.observe(boardEl);

  rebuild(); render();

  return {
    update(newState) { if (drag) return; srcState = newState; rebuild(); render(); },
    setShowDone(v) { showDone = !!v; rebuild(); render(); },
    getState() { return srcState; },
    destroy() { ro.disconnect(); boardEl.removeEventListener('pointerdown', onBgDown); hidePop(); for (const id in tileEls) tileEls[id].remove(); tileEls = {}; if (controlsEl) controlsEl.innerHTML = ''; },
  };
}
