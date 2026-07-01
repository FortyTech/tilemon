// board.js — Tilemon renderer. Framework-agnostic, zero dependencies, ESM.
//
//   import { mount } from './board.js'
//   const board = mount(boardEl, controlsEl, {
//     state,                                 // the tree (see SPEC §4.1)
//     onWeightChange: (path, weight) => {},  // human resized a node -> persist
//     onStatusChange: (path, status) => {},  // a leaf's status changed -> persist
//   })
//   board.update(newState)                   // re-render from fresh state (drill/selection preserved)
//
// The renderer owns NO storage. It announces *what changed* via callbacks; the host
// decides where that goes (a file via POST in the npx tool, a DB in the hosted app).
// That seam is the whole reason this is a separate module — see SPEC §3.
//
// Data model: a node is { id, name, weight, children } (parent) or
// { id, name, weight, status } (leaf). status ∈ todo|in_progress|blocked|done.
// `done` leaves drop off the board; status maps to heat for colour; heat rolls up
// area-weighted through parents. Weight is the node's share vs. its siblings.

const PAD = 5, HEADER = 22, INSET = 2;
const STATUS_HEAT = { todo: 0, in_progress: 0.5, blocked: 1 }; // `done` => dropped, no heat
const STATUSES = ['todo', 'in_progress', 'blocked', 'done'];
const DONE_COLOR = 'rgb(74,92,58)'; // muted sage — "complete", off the heat ramp, fits the warm-dark palette

const STYLE = `
.tlm-board{position:relative;width:100%;height:100%;overflow:hidden;background:var(--tlm-bg,#14120D);touch-action:none}
.tlm-board .tile{position:absolute;border-radius:5px;overflow:hidden;cursor:grab;user-select:none;outline:0 solid transparent;
  transition:left .18s ease,top .18s ease,width .18s ease,height .18s ease,background .25s ease,opacity .2s ease}
.tlm-board.nodrag .tile{transition:background .25s ease}
.tlm-board .tile:active{cursor:grabbing}
.tlm-board .tile.sel{outline:2px solid var(--tlm-gold,#E8C56A);outline-offset:-2px;z-index:600!important}
.tlm-board .tile.armed{outline:2px dashed var(--tlm-gold,#E8C56A);outline-offset:-2px;z-index:600!important}
.tlm-board .tile .hd{position:absolute;top:0;left:0;right:0;height:22px;display:flex;align-items:center;
  justify-content:space-between;padding:0 8px;gap:6px;pointer-events:none}
.tlm-board .tile .leaf{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
  text-align:center;padding:6px;gap:3px;pointer-events:none}
.tlm-board .nm{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.tlm-board .wt{font-family:"Space Mono",monospace;font-size:10.5px;opacity:.6;white-space:nowrap}
.tlm-board .tile.done{opacity:.6}
.tlm-board .tile.include{outline:1px dashed var(--tlm-gold,#E8C56A);outline-offset:-3px;cursor:pointer}
.tlm-board .tile .badge{font-family:"Space Mono",monospace;font-size:9.5px;opacity:.75;letter-spacing:.03em}
.tlm-board .tile.hot{animation:tlm-pulse 1.7s ease-in-out infinite}
@keyframes tlm-pulse{0%,100%{filter:brightness(1)}50%{filter:brightness(1.22)}}
@media (prefers-reduced-motion:reduce){.tlm-board .tile.hot{animation:none}}
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
.tlm-controls button.on{border-color:var(--tlm-gold,#E8C56A);color:var(--tlm-gold,#E8C56A)}
.tlm-controls .grp{display:flex;gap:4px;align-items:center}
.tlm-controls .grp .lbl{font-family:"Space Mono",monospace;font-size:10.5px;color:var(--tlm-dim,#9A9182);margin-right:2px}
.tlm-sizebar{display:flex;align-items:center;gap:10px;background:var(--tlm-panel,#1C1A14);border:1px solid var(--tlm-line,#2A2820);
  border-radius:8px;padding:7px 12px;font-family:"Space Mono",monospace;font-size:11.5px;color:var(--tlm-dim,#9A9182);width:100%}
.tlm-sizebar b{color:var(--tlm-ink,#ECE7DA);font-weight:400}
.tlm-sizebar input[type=range]{flex:1;min-width:120px;accent-color:var(--tlm-gold,#E8C56A)}
.tlm-sizebar .pct{color:var(--tlm-gold,#E8C56A);min-width:38px;text-align:right}
.tlm-note{width:100%;background:var(--tlm-panel,#1C1A14);border:1px solid var(--tlm-line,#2A2820);border-left:2px solid var(--tlm-gold,#E8C56A);
  border-radius:6px;padding:7px 11px;font-family:"Space Mono",monospace;font-size:11.5px;color:var(--tlm-ink,#ECE7DA);line-height:1.45}
`;

function injectStyle(doc) {
  if (doc.getElementById('tilemon-style')) return;
  const s = doc.createElement('style');
  s.id = 'tilemon-style';
  s.textContent = STYLE;
  doc.head.appendChild(s);
}

export function mount(boardEl, controlsEl, opts = {}) {
  const onWeightChange = opts.onWeightChange || (() => {});
  const onStatusChange = opts.onStatusChange || (() => {});
  const onOpenBoard = opts.onOpenBoard || (() => {});   // navigate to an included board by slug
  injectStyle(boardEl.ownerDocument);
  boardEl.classList.add('tlm-board');
  if (controlsEl) controlsEl.classList.add('tlm-controls');

  let srcState = opts.state || { name: 'Priorities', children: [] };
  let root, viewRoot;
  let viewRootId = null, selId = null, showWeights = false, showDone = !!opts.showDone;
  let tileEls = {}, drag = null, freeze = false;

  // ---- derive the working tree from source state ----
  // Any node (at any depth) may carry a status — the tree is uniformly recursive, not
  // leaf-only. A node's own status maps to heat and acts as a *floor* (see calcHeat);
  // `done` at any level drops that node and its whole subtree, unless `showDone` is on
  // (then it renders dimmed, so `done` is reversible from the board, not a trapdoor).
  // Stable ids are preserved so callback paths address the real underlying nodes.
  const num = (v, d) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : d; };
  function clone(n) {
    // an include is a navigable summary tile — its heat is the included board's rolled-up
    // summary (computed server-side); it has no inline children (navigate, don't splice).
    if (n._include !== undefined) {
      return { id: n.id, name: n.name, weight: num(n.weight, 1), _include: n._include,
               _missing: n._missing, _cycle: n._cycle, heat: n._summaryHeat || 0, children: null };
    }
    const isDone = n.status === 'done';
    if (isDone && !showDone) return null;                // done node (any level) drops its subtree
    const ownHeat = STATUS_HEAT[n.status] ?? 0;          // done -> 0 (calm); shown dimmed via _done
    const kids = n.children;
    if (kids && kids.length) {
      const cc = [];
      for (const k of kids) { const c = clone(k); if (c) cc.push(c); }
      if (cc.length) return { id: n.id, name: n.name, weight: num(n.weight, 1),
                              status: n.status, note: n.note, heat: ownHeat, _done: isDone, children: cc };
      // every child was dropped (all done, hidden): keep this node as a single tile if it
      // carries its own status, else the empty container is effectively done — drop it.
      if (n.status && !isDone) return { id: n.id, name: n.name, weight: num(n.weight, 1),
                                        status: n.status, note: n.note, heat: ownHeat, children: null };
      return null;
    }
    return { id: n.id, name: n.name, weight: num(n.weight, 1),
             status: n.status || 'todo', note: n.note, heat: ownHeat, _done: isDone, children: null };
  }
  function buildWorking(src) {
    const top = [];
    for (const k of (src.children || [])) { const c = clone(k); if (c) top.push(c); }
    return { id: src.id, name: src.name || 'Priorities', weight: num(src.weight, 1), children: top };
  }
  // resolve a dotted-id path back to the node in the SOURCE tree (so local edits mirror
  // into srcState and survive a rebuild) — mirrors server.mjs resolvePath.
  function resolveInSrc(path) {
    let node = srcState;
    for (const part of path.split('.')) { const k = (node.children || []).find(c => c.id === part); if (!k) return null; node = k; }
    return node;
  }
  function rebuild() {
    root = buildWorking(srcState);
    viewRoot = (viewRootId && find(root, viewRootId)) || root;
    viewRootId = viewRoot === root ? null : viewRoot.id;
    if (selId && !find(root, selId)) selId = null;
  }

  // ---- squarified treemap (Bruls/Huizing/van Wijk) — proven, unchanged ----
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
    const own = node.heat || 0;                          // this node's own status-heat (0 if none)
    const ch = node.children;
    if (!ch || !ch.length) { node._heat = own; return node._heat; }
    let a = 0, s = 0;
    for (const c of ch) { const ca = Math.max(c._rect.w * c._rect.h, 1e-4), hc = calcHeat(c); a += ca; s += hc * ca; }
    const rollup = a ? s / a : 0;
    node._heat = Math.max(own, rollup);                  // own status is a floor; children can only push hotter
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

  // ---- tree helpers (stable string ids) ----
  function find(n, id) { if (n.id === id) return n; for (const c of (n.children || [])) { const f = find(c, id); if (f) return f; } return null; }
  const selected = () => selId ? find(root, selId) : null;
  const activeContainer = () => { const s = selected(); return (s && s.children && s.children.length) ? s : viewRoot; };
  function resizeTarget(node, ac) { let a = node; while (a && a._parent && a._parent !== ac) a = a._parent; return (a && a._parent === ac) ? a : null; }
  function pathNodes(n) { const p = []; let c = n; while (c) { p.unshift(c); c = c._parent; } return p; }
  function buildPath(n) { const p = []; let c = n; while (c && c._parent) { p.unshift(c.id); c = c._parent; } return p.join('.'); }
  function shareOf(node) { const p = node._parent; if (!p) return 100; const s = p.children.reduce((a, c) => a + c.weight, 0); return s ? node.weight / s * 100 : 100; }
  function setShare(node, pct) {
    const p = node._parent; if (!p) return;
    const others = p.children.reduce((s, c) => s + c.weight, 0) - node.weight; if (others <= 1e-9) return;
    const f = Math.max(0.02, Math.min(0.97, pct / 100)); node.weight = f / (1 - f) * others;
  }

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
      const isParent = node.children && node.children.length;
      let el = tileEls[node.id];
      if (!el) {
        el = boardEl.ownerDocument.createElement('div'); el.className = 'tile'; el.style.opacity = '0';
        el.dataset.id = node.id; attach(el); tileEls[node.id] = el; boardEl.appendChild(el);
        requestAnimationFrame(() => { if (tileEls[node.id]) el.style.opacity = '1'; });
      }
      el.style.left = (r.x + INSET) + 'px'; el.style.top = (r.y + INSET) + 'px';
      el.style.width = Math.max(0, r.w - 2 * INSET) + 'px'; el.style.height = Math.max(0, r.h - 2 * INSET) + 'px';
      el.style.zIndex = r.depth;
      el.style.background = node._done ? DONE_COLOR : heatColor(node._heat);
      el.style.color = node._done ? 'var(--tlm-ink,#ECE7DA)' : textColor(node._heat);
      const isSel = selId === node.id, isPar = node.children && node.children.length, isInc = node._include !== undefined;
      el.classList.toggle('sel', isSel && !isPar); el.classList.toggle('armed', isSel && !!isPar);
      el.classList.toggle('hot', node._heat > 0.66 && !node._done);
      el.classList.toggle('done', !!node._done);
      el.classList.toggle('include', isInc);
      const wt = showWeights ? `<span class="wt">${node.weight.toFixed(node.weight < 10 ? 1 : 0)}</span>` : '';
      let html = '';
      if (isInc) {
        if (r.w > 40 && r.h > 26) {
          const badge = node._missing ? 'missing ⚠' : node._cycle ? 'cycle ⟳' : 'board ↗';
          html = `<div class="leaf"><span class="nm">${esc(node.name)}</span><span class="badge">${badge}</span></div>`;
        }
      } else if (isParent) { if (r.w > 54 && r.h > 30) html = `<div class="hd"><span class="nm">${esc(node.name)}</span>${wt}</div>`; }
      else { if (r.w > 40 && r.h > 26) html = `<div class="leaf"><span class="nm">${esc(node.name)}</span>${wt}</div>`; }
      if (el._html !== html) { el.innerHTML = html; el._html = html; }
    }
    for (const id in tileEls) { if (!seen.has(id)) { tileEls[id].remove(); delete tileEls[id]; } }
  }

  function attach(el) {
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('dblclick', e => {
      e.stopPropagation();
      const n = find(root, el.dataset.id);
      if (n && n._include !== undefined) { if (!n._missing && !n._cycle) onOpenBoard(n._include); return; }  // navigate, don't inline
      if (n && n.children && n.children.length) { viewRoot = n; viewRootId = n.id; selId = null; render(); }
    });
  }
  function onDown(e) {
    e.stopPropagation();
    const id = e.currentTarget.dataset.id, node = find(root, id); if (!node) return;
    let ac = activeContainer(), target = resizeTarget(node, ac);
    if (!target) { ac = viewRoot; target = resizeTarget(node, ac) || node; }   // dragged outside armed parent -> top level
    const p = target._parent, others = p ? p.children.reduce((s, c) => s + c.weight, 0) - target.weight : 0;
    drag = { tappedId: id, node: target, p, others, sx: e.clientX, sy: e.clientY, sw: target.weight, moved: false };
    freeze = true; boardEl.classList.add('nodrag');
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }
  function onMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    if (drag.p && drag.others > 0) {
      const delta = dx + dy;                          // right and down grow
      let w = drag.sw * Math.exp(delta / 220);
      const minW = drag.others * 0.01 / 0.99, maxW = drag.others * 0.97 / 0.03;
      drag.node.weight = Math.max(minW, Math.min(maxW, w));
      renderBoard();
    }
  }
  function onUp() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    boardEl.classList.remove('nodrag'); freeze = false;
    if (drag && !drag.moved) { selId = drag.tappedId; }
    else if (drag && drag.moved && drag.node) {
      const p = buildPath(drag.node); onWeightChange(p, drag.node.weight);
      const sn = resolveInSrc(p); if (sn) sn.weight = drag.node.weight;   // mirror into source
    }
    drag = null; render();
  }

  function setStatus(node, status) {
    const p = buildPath(node);
    onStatusChange(p, status);                        // persist (host turns this into a write)
    const sn = resolveInSrc(p); if (sn) sn.status = status;
    rebuild(); render();                              // rebuild from source so done-drop / show-done stay consistent
  }

  // ---- controls (breadcrumb · status buttons for a selected leaf · weight toggle · size slider) ----
  function clearSizebar() { if (!controlsEl) return; const o = controlsEl.querySelector('.tlm-sizebar'); if (o) o.remove(); }
  function renderControls() {
    if (!controlsEl) return;
    const sel = selected(), bc = pathNodes(viewRoot);
    const crumb = bc.map((n, i) => i === bc.length - 1 ? `<b>${esc(n.name)}</b>`
      : `<span class="c" data-id="${esc(n.id)}">${esc(n.name)}</span><span class="sep">/</span>`).join(' ');
    const isInc = sel && sel._include !== undefined;
    let html = `<div class="crumb">${crumb}</div>`;
    if (sel && !isInc) html += `<div class="grp"><span class="lbl">status</span>` +     // any item, at any level, can hold a status
      STATUSES.map(s => `<button class="st${sel.status === s ? ' on' : ''}" data-s="${s}">${s.replace('_', ' ')}</button>`).join('') + `</div>`;
    if (isInc && !sel._missing && !sel._cycle) html += `<div class="grp"><button id="openBoard" class="tog">open ${esc(sel.name)} ↗</button></div>`;
    html += `<div class="grp"><button id="wtTog" class="tog">weights: ${showWeights ? 'on' : 'off'}</button>` +
            `<button id="doneTog" class="tog">done: ${showDone ? 'shown' : 'hidden'}</button></div>`;
    if (sel && sel.note) html += `<div class="tlm-note">📝 ${esc(sel.note)}</div>`;   // agent's message on the selected item
    controlsEl.innerHTML = html;
    clearSizebar();
    if (sel && sel._parent) {
      const only = sel._parent.children.length === 1;
      const sb = controlsEl.ownerDocument.createElement('div'); sb.className = 'tlm-sizebar';
      sb.innerHTML = `fine-tune <b>${esc(sel.name)}</b> in <b>${esc(sel._parent.name)}</b>
        <input type="range" id="sizeR" min="2" max="95" value="${Math.round(shareOf(sel))}" ${only ? 'disabled' : ''}>
        <span class="pct" id="sizeP">${Math.round(shareOf(sel))}%</span>`;
      controlsEl.appendChild(sb);
      const rg = sb.querySelector('#sizeR'), lab = sb.querySelector('#sizeP');
      rg.addEventListener('input', () => { setShare(sel, +rg.value); lab.textContent = Math.round(shareOf(sel)) + '%'; renderBoard(); });
      rg.addEventListener('change', () => { const p = buildPath(sel); onWeightChange(p, sel.weight); const sn = resolveInSrc(p); if (sn) sn.weight = sel.weight; });
    }
    controlsEl.querySelectorAll('.c').forEach(s => s.onclick = () => { const t = find(root, s.dataset.id); if (t) { viewRoot = t; viewRootId = t.id; selId = null; render(); } });
    controlsEl.querySelector('#wtTog').onclick = () => { showWeights = !showWeights; render(); };
    controlsEl.querySelector('#doneTog').onclick = () => { showDone = !showDone; rebuild(); render(); };
    if (sel && !isInc) controlsEl.querySelectorAll('.st').forEach(b => b.onclick = () => setStatus(sel, b.dataset.s));
    if (isInc) { const ob = controlsEl.querySelector('#openBoard'); if (ob) ob.onclick = () => onOpenBoard(sel._include); }
  }

  function render() { renderControls(); renderBoard(); }

  // ---- background click clears selection; observe resize ----
  const onBgDown = e => { if (e.target === boardEl) { selId = null; render(); } };
  boardEl.addEventListener('pointerdown', onBgDown);
  const ro = new ResizeObserver(() => renderBoard()); ro.observe(boardEl);

  rebuild(); render();

  return {
    update(newState) {
      if (drag) return;                               // never yank the board out from under a drag
      srcState = newState; rebuild(); render();
    },
    setShowDone(v) { showDone = !!v; rebuild(); render(); },
    getState() { return srcState; },
    destroy() {
      ro.disconnect();
      boardEl.removeEventListener('pointerdown', onBgDown);
      for (const id in tileEls) { tileEls[id].remove(); delete tileEls[id]; }
      if (controlsEl) controlsEl.innerHTML = '';
    },
  };
}
