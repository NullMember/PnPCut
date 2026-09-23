(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PX_PER_MM = 6;
  const ROTATE_HANDLE_OFFSET = 9;
  const DEFAULT_LAYER_COLORS = { cut: '#c0392b', score: '#e08e0b', emboss: '#2e8b57' };
  const MIN_SIZE = 0.5;
  const MIN_ZOOM = 0.1;
  const MAX_ZOOM = 16;
  const SNAP_PX = 8;
  const HANDLE_R_PX = 6;

  const $ = (id) => document.getElementById(id);

  const els = {
    cardW: $('cardW'),
    cardH: $('cardH'),
    imageInput: $('imageInput'),
    imageVisible: $('imageVisible'),
    toolButtons: $('toolButtons'),
    layerBar: $('layerBar'),
    saveProjectBtn: $('saveProjectBtn'),
    loadProjectInput: $('loadProjectInput'),
    mirrorExport: $('mirrorExport'),
    exportAllBtn: $('exportAllBtn'),
    exportCutBtn: $('exportCutBtn'),
    exportScoreBtn: $('exportScoreBtn'),
    exportEmbossBtn: $('exportEmbossBtn'),
    canvasWrap: $('canvasWrap'),
    propsEmpty: $('propsEmpty'),
    propsForm: $('propsForm'),
    propLayer: $('propLayer'),
    propX: $('propX'),
    propY: $('propY'),
    propW: $('propW'),
    propH: $('propH'),
    propRadiusWrap: $('propRadiusWrap'),
    propRadius: $('propRadius'),
    propRot: $('propRot'),
    deleteShapeBtn: $('deleteShapeBtn'),
    undoBtn: $('undoBtn'),
    redoBtn: $('redoBtn'),
    zoomOutBtn: $('zoomOutBtn'),
    zoomInBtn: $('zoomInBtn'),
    zoomResetBtn: $('zoomResetBtn'),
    zoomFitBtn: $('zoomFitBtn'),
    zoomLevel: $('zoomLevel'),
    snapToggle: $('snapToggle'),
  };

  const state = {
    cardW: 63,
    cardH: 88,
    imageDataUrl: null,
    imageVisible: true,
    tool: 'select',
    activeLayer: 'cut',
    layerVisible: { cut: true, score: true, emboss: true },
    layerColors: { ...DEFAULT_LAYER_COLORS },
    shapes: [],
    nextId: 1,
    selectedIds: [],
    zoom: 1,
  };

  let history = [];
  let historyIndex = -1;
  let snapEnabled = true;

  // ---------- geometry helpers ----------

  function rotateVec(v, deg) {
    const r = (deg * Math.PI) / 180;
    const cos = Math.cos(r), sin = Math.sin(r);
    return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos };
  }

  function worldCenter(shape) {
    return { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 };
  }

  function worldFromLocal(shape, Lp) {
    const wc = worldCenter(shape);
    const lc = { x: shape.w / 2, y: shape.h / 2 };
    const rv = rotateVec({ x: Lp.x - lc.x, y: Lp.y - lc.y }, shape.rotation);
    return { x: wc.x + rv.x, y: wc.y + rv.y };
  }

  function localFromWorld(shape, Wp) {
    const wc = worldCenter(shape);
    const lc = { x: shape.w / 2, y: shape.h / 2 };
    const rv = rotateVec({ x: Wp.x - wc.x, y: Wp.y - wc.y }, -shape.rotation);
    return { x: lc.x + rv.x, y: lc.y + rv.y };
  }

  function normBox(x1, y1, x2, y2) {
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      w: Math.abs(x2 - x1),
      h: Math.abs(y2 - y1),
    };
  }

  // ---------- snapping ----------

  function snapThresholdMm() {
    return SNAP_PX / (PX_PER_MM * state.zoom);
  }

  function shapePoints(shape) {
    const local = [
      { x: 0, y: 0 }, { x: shape.w, y: 0 }, { x: shape.w, y: shape.h }, { x: 0, y: shape.h },
      { x: shape.w / 2, y: 0 }, { x: shape.w, y: shape.h / 2 }, { x: shape.w / 2, y: shape.h }, { x: 0, y: shape.h / 2 },
      { x: shape.w / 2, y: shape.h / 2 },
    ];
    if (shape.type === 'line') {
      const p1 = shape.diag === 'tlbr' ? { x: 0, y: 0 } : { x: shape.w, y: 0 };
      const p2 = shape.diag === 'tlbr' ? { x: shape.w, y: shape.h } : { x: 0, y: shape.h };
      local.push(p1, p2);
    }
    if (shape.type === 'polygon' && shape.points) {
      shape.points.forEach((p) => local.push({ x: p.fx * shape.w, y: p.fy * shape.h }));
    }
    return local.map((lp) => worldFromLocal(shape, lp));
  }

  function collectSnapCandidates(excludeIds) {
    const pts = [];
    const cw = state.cardW, ch = state.cardH;
    [0, cw / 2, cw].forEach((x) => [0, ch / 2, ch].forEach((y) => pts.push({ x, y })));
    state.shapes.forEach((shape) => {
      if (excludeIds.includes(shape.id)) return;
      pts.push(...shapePoints(shape));
    });
    return pts;
  }

  function resolvePointSnap(rawPoint, excludeIds, enabled, extraPoints) {
    if (!enabled) return { x: rawPoint.x, y: rawPoint.y, guides: [] };
    const thresh = snapThresholdMm();
    const candidates = collectSnapCandidates(excludeIds).concat(extraPoints || []);
    let bestX = null, bestXDist = thresh;
    let bestY = null, bestYDist = thresh;
    candidates.forEach((c) => {
      const dx = Math.abs(c.x - rawPoint.x);
      if (dx < bestXDist) { bestXDist = dx; bestX = c.x; }
      const dy = Math.abs(c.y - rawPoint.y);
      if (dy < bestYDist) { bestYDist = dy; bestY = c.y; }
    });
    const guides = [];
    if (bestX != null) guides.push({ type: 'v', x: bestX });
    if (bestY != null) guides.push({ type: 'h', y: bestY });
    return { x: bestX != null ? bestX : rawPoint.x, y: bestY != null ? bestY : rawPoint.y, guides };
  }

  // The 8 octant directions for 45deg-step constraining, as exact
  // coordinates rather than cos/sin of a reconstructed angle: Math.PI isn't
  // exactly pi, so e.g. Math.sin(Math.round(...) * (Math.PI/4)) for a
  // "horizontal" 180deg step comes out ~1e-16 instead of exactly 0. That
  // tiny residue used to survive as a non-zero shape.h/w on straight lines
  // and get floored back up to MIN_SIZE by group-scale, kinking the line.
  const OCTANT_DIRS = [
    { x: 1, y: 0 }, { x: Math.SQRT1_2, y: Math.SQRT1_2 },
    { x: 0, y: 1 }, { x: -Math.SQRT1_2, y: Math.SQRT1_2 },
    { x: -1, y: 0 }, { x: -Math.SQRT1_2, y: -Math.SQRT1_2 },
    { x: 0, y: -1 }, { x: Math.SQRT1_2, y: -Math.SQRT1_2 },
  ];

  // Constrains a point to 45deg steps from `fixed`, while still letting the
  // distance along that locked direction snap to nearby points that lie
  // close to the line (so Shift-straightening a line doesn't kill snapping).
  function angleConstrainedPoint(fixed, rawPoint, excludeIds, enabled) {
    const dx = rawPoint.x - fixed.x, dy = rawPoint.y - fixed.y;
    const octant = ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
    const dir = OCTANT_DIRS[octant];
    let t = dx * dir.x + dy * dir.y;
    const guides = [];
    if (enabled) {
      const thresh = snapThresholdMm();
      let bestT = null, bestDist = thresh, bestPoint = null;
      collectSnapCandidates(excludeIds).forEach((c) => {
        const vx = c.x - fixed.x, vy = c.y - fixed.y;
        const ct = vx * dir.x + vy * dir.y;
        const perp = Math.abs(vx * dir.y - vy * dir.x);
        if (perp < thresh) {
          const d = Math.abs(ct - t);
          if (d < bestDist) { bestDist = d; bestT = ct; bestPoint = c; }
        }
      });
      if (bestT != null) {
        t = bestT;
        guides.push({ type: 'v', x: bestPoint.x }, { type: 'h', y: bestPoint.y });
      }
    }
    return { point: { x: fixed.x + dir.x * t, y: fixed.y + dir.y * t }, guides };
  }

  function boxesIntersect(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // Shared core: given a set of world points that would move rigidly together
  // and a set of candidate points to align to, finds the single best x/y
  // offset (independently per axis) that would snap ANY of those points onto
  // a candidate. Used for both single-shape and whole-group moves so every
  // member of a group gets to contribute its own edges/corners, not just one.
  function snapOffsetForPoints(points, candidates, thresh) {
    let bestDx = 0, bestDxAbs = thresh, bestDxGuide = null;
    let bestDy = 0, bestDyAbs = thresh, bestDyGuide = null;
    points.forEach((p) => {
      candidates.forEach((c) => {
        const dx = c.x - p.x;
        if (Math.abs(dx) < bestDxAbs) { bestDxAbs = Math.abs(dx); bestDx = dx; bestDxGuide = c.x; }
        const dy = c.y - p.y;
        if (Math.abs(dy) < bestDyAbs) { bestDyAbs = Math.abs(dy); bestDy = dy; bestDyGuide = c.y; }
      });
    });
    const guides = [];
    if (bestDxGuide != null) guides.push({ type: 'v', x: bestDxGuide });
    if (bestDyGuide != null) guides.push({ type: 'h', y: bestDyGuide });
    return { dx: bestDx, dy: bestDy, guides };
  }

  function snapMoveShape(shape, rawX, rawY, enabled, excludeIds) {
    if (!enabled) return { x: rawX, y: rawY, guides: [] };
    const thresh = snapThresholdMm();
    const candidates = collectSnapCandidates(excludeIds || [shape.id]);
    const pts = shapePoints({ ...shape, x: rawX, y: rawY });
    const res = snapOffsetForPoints(pts, candidates, thresh);
    return { x: rawX + res.dx, y: rawY + res.dy, guides: res.guides };
  }

  // Moves a whole selection rigidly: tests every shape's own points (not
  // just one representative shape) against the rest of the canvas, so a
  // group's left/right/top/bottom/center edges can all snap, regardless of
  // which member happens to be first in the selection.
  function snapMoveGroup(ids, origins, rawDx, rawDy, enabled) {
    if (!enabled) return { dx: rawDx, dy: rawDy, guides: [] };
    const thresh = snapThresholdMm();
    const candidates = collectSnapCandidates(ids);
    let pts = [];
    ids.forEach((id) => {
      const s = state.shapes.find((sh) => sh.id === id);
      const o = origins.get(id);
      if (!s || !o) return;
      pts = pts.concat(shapePoints({ ...s, x: o.x + rawDx, y: o.y + rawDy }));
    });
    const res = snapOffsetForPoints(pts, candidates, thresh);
    return { dx: rawDx + res.dx, dy: rawDy + res.dy, guides: res.guides };
  }

  function renderSnapGuides(guides) {
    overlayGroup.querySelectorAll('.snap-guide').forEach((n) => n.remove());
    if (!guides || !guides.length) return;
    const margin = Math.max(state.cardW, state.cardH) * 2;
    guides.forEach((g) => {
      const line = document.createElementNS(SVG_NS, 'line');
      if (g.type === 'v') {
        line.setAttribute('x1', g.x); line.setAttribute('y1', -margin);
        line.setAttribute('x2', g.x); line.setAttribute('y2', state.cardH + margin);
      } else {
        line.setAttribute('x1', -margin); line.setAttribute('y1', g.y);
        line.setAttribute('x2', state.cardW + margin); line.setAttribute('y2', g.y);
      }
      line.setAttribute('class', 'snap-guide');
      line.setAttribute('vector-effect', 'non-scaling-stroke');
      overlayGroup.appendChild(line);
    });
  }

  function renderSnapPointMarker(point) {
    overlayGroup.querySelectorAll('.snap-point').forEach((n) => n.remove());
    if (!point) return;
    const r = HANDLE_R_PX * 0.55 / (PX_PER_MM * state.zoom);
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', point.x);
    c.setAttribute('cy', point.y);
    c.setAttribute('r', r);
    c.setAttribute('class', 'snap-point');
    c.setAttribute('vector-effect', 'non-scaling-stroke');
    overlayGroup.appendChild(c);
  }

  // ---------- SVG canvas setup ----------

  let svg, layerGroups = {}, imageEl, overlayGroup;

  function buildCanvas() {
    els.canvasWrap.innerHTML = '';
    svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('id', 'canvasSvg');

    const bg = document.createElementNS(SVG_NS, 'rect');
    bg.setAttribute('x', '0'); bg.setAttribute('y', '0');
    bg.setAttribute('fill', '#ffffff');
    bg.setAttribute('width', '100%'); bg.setAttribute('height', '100%');
    svg.appendChild(bg);

    imageEl = document.createElementNS(SVG_NS, 'image');
    imageEl.setAttribute('x', '0');
    imageEl.setAttribute('y', '0');
    imageEl.setAttribute('preserveAspectRatio', 'none');
    svg.appendChild(imageEl);

    updateSvgSize();

    ['cut', 'score', 'emboss'].forEach((layer) => {
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('data-layer-group', layer);
      layerGroups[layer] = g;
      svg.appendChild(g);
    });

    overlayGroup = document.createElementNS(SVG_NS, 'g');
    overlayGroup.setAttribute('id', 'overlayGroup');
    svg.appendChild(overlayGroup);

    els.canvasWrap.appendChild(svg);

    svg.addEventListener('pointerdown', onCanvasPointerDown);
    svg.addEventListener('pointerleave', () => {
      if (drag) return;
      renderSnapGuides([]);
      renderSnapPointMarker(null);
    });
  }

  function updateSvgSize() {
    svg.setAttribute('viewBox', `0 0 ${state.cardW} ${state.cardH}`);
    svg.setAttribute('width', state.cardW * PX_PER_MM * state.zoom);
    svg.setAttribute('height', state.cardH * PX_PER_MM * state.zoom);
    if (imageEl) {
      imageEl.setAttribute('width', state.cardW);
      imageEl.setAttribute('height', state.cardH);
    }
    if (els.zoomLevel) els.zoomLevel.textContent = `${Math.round(state.zoom * 100)}%`;
  }

  function svgPoint(evt) {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }

  // ---------- zoom / pan ----------

  function clampZoom(z) {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
  }

  function setZoom(newZoom, clientX, clientY) {
    newZoom = clampZoom(newZoom);
    if (Math.abs(newZoom - state.zoom) < 0.001) return;
    const wrap = els.canvasWrap;
    const rect = wrap.getBoundingClientRect();
    const ax = clientX != null ? clientX : rect.left + rect.width / 2;
    const ay = clientY != null ? clientY : rect.top + rect.height / 2;

    const before = svg.createSVGPoint();
    before.x = ax; before.y = ay;
    const mm = before.matrixTransform(svg.getScreenCTM().inverse());

    state.zoom = newZoom;
    updateSvgSize();

    const after = svg.createSVGPoint();
    after.x = mm.x; after.y = mm.y;
    const screenPos = after.matrixTransform(svg.getScreenCTM());

    wrap.scrollLeft += screenPos.x - ax;
    wrap.scrollTop += screenPos.y - ay;
    renderOverlay();
  }

  function zoomBy(factor, clientX, clientY) {
    setZoom(state.zoom * factor, clientX, clientY);
  }

  function fitZoom() {
    const wrap = els.canvasWrap;
    const availW = Math.max(40, wrap.clientWidth - 32);
    const availH = Math.max(40, wrap.clientHeight - 32);
    const z = Math.min(availW / (state.cardW * PX_PER_MM), availH / (state.cardH * PX_PER_MM));
    state.zoom = clampZoom(z || 1);
    updateSvgSize();
    wrap.scrollLeft = 0;
    wrap.scrollTop = 0;
    renderOverlay();
  }

  els.zoomInBtn.addEventListener('click', () => zoomBy(1.25));
  els.zoomOutBtn.addEventListener('click', () => zoomBy(0.8));
  els.zoomResetBtn.addEventListener('click', () => setZoom(1));
  els.zoomFitBtn.addEventListener('click', fitZoom);

  els.canvasWrap.addEventListener('wheel', (evt) => {
    if (!(evt.ctrlKey || evt.metaKey)) return;
    evt.preventDefault();
    const factor = Math.exp(-evt.deltaY * 0.0018);
    zoomBy(factor, evt.clientX, evt.clientY);
  }, { passive: false });

  els.snapToggle.addEventListener('change', () => {
    snapEnabled = els.snapToggle.checked;
  });

  // ---- space / middle-click panning ----

  let spaceDown = false;
  let panDrag = null;

  function startPanDrag(evt) {
    const wrap = els.canvasWrap;
    panDrag = { startX: evt.clientX, startY: evt.clientY, scrollLeft: wrap.scrollLeft, scrollTop: wrap.scrollTop };
    wrap.classList.add('panning');
    window.addEventListener('pointermove', onPanMove);
    window.addEventListener('pointerup', onPanEnd);
  }

  function onPanMove(evt) {
    if (!panDrag) return;
    const wrap = els.canvasWrap;
    wrap.scrollLeft = panDrag.scrollLeft - (evt.clientX - panDrag.startX);
    wrap.scrollTop = panDrag.scrollTop - (evt.clientY - panDrag.startY);
  }

  function onPanEnd() {
    panDrag = null;
    els.canvasWrap.classList.remove('panning');
    window.removeEventListener('pointermove', onPanMove);
    window.removeEventListener('pointerup', onPanEnd);
  }

  // ---------- shape rendering ----------

  function describeShape(shape) {
    const transform = `translate(${shape.x} ${shape.y}) rotate(${shape.rotation} ${shape.w / 2} ${shape.h / 2})`;
    if (shape.type === 'rect') {
      const r = Math.max(0, Math.min(shape.radius || 0, shape.w / 2, shape.h / 2));
      return { transform, tag: 'rect', attrs: { x: 0, y: 0, width: shape.w, height: shape.h, rx: r, ry: r } };
    }
    if (shape.type === 'ellipse') {
      return { transform, tag: 'ellipse', attrs: { cx: shape.w / 2, cy: shape.h / 2, rx: shape.w / 2, ry: shape.h / 2 } };
    }
    if (shape.type === 'line') {
      const p1 = shape.diag === 'tlbr' ? { x: 0, y: 0 } : { x: shape.w, y: 0 };
      const p2 = shape.diag === 'tlbr' ? { x: shape.w, y: shape.h } : { x: 0, y: shape.h };
      return { transform, tag: 'line', attrs: { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y } };
    }
    if (shape.type === 'polygon') {
      const points = shape.points.map((p) => `${p.fx * shape.w},${p.fy * shape.h}`).join(' ');
      return { transform, tag: 'polygon', attrs: { points } };
    }
    return null;
  }

  function shapeMarkup(shape) {
    const d = describeShape(shape);
    if (!d) return '';
    const attrs = Object.entries(d.attrs).map(([k, v]) => `${k}="${round(v)}"`).join(' ');
    return `<g transform="${d.transform}"><${d.tag} ${attrs} fill="none" stroke="${state.layerColors[shape.layer]}" stroke-width="0.15"/></g>`;
  }

  function round(n) {
    return typeof n === 'number' ? Math.round(n * 1000) / 1000 : n;
  }

  function createShapeElement(shape) {
    const d = describeShape(shape);
    if (!d) return null;
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('transform', d.transform);
    g.setAttribute('data-id', shape.id);
    g.classList.add('shape-el');
    const prim = document.createElementNS(SVG_NS, d.tag);
    Object.entries(d.attrs).forEach(([k, v]) => prim.setAttribute(k, v));
    prim.setAttribute('fill', 'none');
    prim.setAttribute('stroke', state.layerColors[shape.layer]);
    prim.setAttribute('stroke-width', '0.15');
    prim.setAttribute('vector-effect', 'non-scaling-stroke');
    prim.classList.add('shape-hit');
    g.appendChild(prim);
    return g;
  }

  function renderShapes() {
    ['cut', 'score', 'emboss'].forEach((layer) => {
      layerGroups[layer].innerHTML = '';
      layerGroups[layer].style.display = state.layerVisible[layer] ? '' : 'none';
    });
    state.shapes.forEach((shape) => {
      const el = createShapeElement(shape);
      if (!el) return;
      layerGroups[shape.layer].appendChild(el);
    });
  }

  // ---------- selection overlay ----------

  const HANDLE_DEFS = [
    { key: 'nw', local: (s) => ({ x: 0, y: 0 }) },
    { key: 'n', local: (s) => ({ x: s.w / 2, y: 0 }) },
    { key: 'ne', local: (s) => ({ x: s.w, y: 0 }) },
    { key: 'e', local: (s) => ({ x: s.w, y: s.h / 2 }) },
    { key: 'se', local: (s) => ({ x: s.w, y: s.h }) },
    { key: 's', local: (s) => ({ x: s.w / 2, y: s.h }) },
    { key: 'sw', local: (s) => ({ x: 0, y: s.h }) },
    { key: 'w', local: (s) => ({ x: 0, y: s.h / 2 }) },
  ];

  function shapeCorners(shape) {
    return [
      worldFromLocal(shape, { x: 0, y: 0 }),
      worldFromLocal(shape, { x: shape.w, y: 0 }),
      worldFromLocal(shape, { x: shape.w, y: shape.h }),
      worldFromLocal(shape, { x: 0, y: shape.h }),
    ];
  }

  function lineEndpointsWorld(shape) {
    const p1 = shape.diag === 'tlbr' ? { x: 0, y: 0 } : { x: shape.w, y: 0 };
    const p2 = shape.diag === 'tlbr' ? { x: shape.w, y: shape.h } : { x: 0, y: shape.h };
    return { p1: worldFromLocal(shape, p1), p2: worldFromLocal(shape, p2) };
  }

  const BOX_HANDLE_DEFS = [
    { key: 'nw', get: (b) => ({ x: b.x, y: b.y }) },
    { key: 'n', get: (b) => ({ x: b.x + b.w / 2, y: b.y }) },
    { key: 'ne', get: (b) => ({ x: b.x + b.w, y: b.y }) },
    { key: 'e', get: (b) => ({ x: b.x + b.w, y: b.y + b.h / 2 }) },
    { key: 'se', get: (b) => ({ x: b.x + b.w, y: b.y + b.h }) },
    { key: 's', get: (b) => ({ x: b.x + b.w / 2, y: b.y + b.h }) },
    { key: 'sw', get: (b) => ({ x: b.x, y: b.y + b.h }) },
    { key: 'w', get: (b) => ({ x: b.x, y: b.y + b.h / 2 }) },
  ];

  function groupBoundingBox(ids) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ids.forEach((id) => {
      const s = state.shapes.find((sh) => sh.id === id);
      if (!s) return;
      shapePoints(s).forEach((p) => {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      });
    });
    if (!isFinite(minX)) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function selectedShape() {
    if (state.selectedIds.length !== 1) return null;
    return state.shapes.find((s) => s.id === state.selectedIds[0]) || null;
  }

  function addHandleCircle(key, wp, handleR, extraClass) {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', wp.x);
    c.setAttribute('cy', wp.y);
    c.setAttribute('r', handleR);
    c.setAttribute('class', extraClass ? `handle ${extraClass}` : 'handle');
    c.setAttribute('data-handle', key);
    c.setAttribute('vector-effect', 'non-scaling-stroke');
    overlayGroup.appendChild(c);
  }

  function renderOverlay() {
    overlayGroup.innerHTML = '';

    if (state.selectedIds.length > 1) {
      state.selectedIds.forEach((id) => {
        const s = state.shapes.find((sh) => sh.id === id);
        if (!s) return;
        const outline = document.createElementNS(SVG_NS, 'polygon');
        outline.setAttribute('points', shapeCorners(s).map((p) => `${p.x},${p.y}`).join(' '));
        outline.setAttribute('class', 'multi-select-outline');
        outline.setAttribute('vector-effect', 'non-scaling-stroke');
        overlayGroup.appendChild(outline);
      });

      const box = groupBoundingBox(state.selectedIds);
      if (box) {
        const groupOutline = document.createElementNS(SVG_NS, 'rect');
        groupOutline.setAttribute('x', box.x);
        groupOutline.setAttribute('y', box.y);
        groupOutline.setAttribute('width', box.w);
        groupOutline.setAttribute('height', box.h);
        groupOutline.setAttribute('class', 'group-select-outline');
        groupOutline.setAttribute('vector-effect', 'non-scaling-stroke');
        overlayGroup.appendChild(groupOutline);

        const handleR = HANDLE_R_PX / (PX_PER_MM * state.zoom);
        BOX_HANDLE_DEFS.forEach((def) => addHandleCircle(def.key, def.get(box), handleR));
        addHandleCircle('move', { x: box.x + box.w / 2, y: box.y + box.h / 2 }, handleR, 'handle-move');
      }
      return;
    }

    const shape = selectedShape();
    if (!shape) return;

    const isLine = shape.type === 'line';

    if (!isLine) {
      const corners = shapeCorners(shape);
      const outline = document.createElementNS(SVG_NS, 'polygon');
      outline.setAttribute('points', corners.map((p) => `${p.x},${p.y}`).join(' '));
      outline.setAttribute('fill', 'none');
      outline.setAttribute('stroke', '#4a90d9');
      outline.setAttribute('stroke-width', '0.3');
      outline.setAttribute('stroke-dasharray', '1.2,1');
      outline.setAttribute('vector-effect', 'non-scaling-stroke');
      overlayGroup.appendChild(outline);
    }

    const handleR = HANDLE_R_PX / (PX_PER_MM * state.zoom);
    const addHandle = (key, wp, extraClass) => addHandleCircle(key, wp, handleR, extraClass);

    if (isLine) {
      const { p1, p2 } = lineEndpointsWorld(shape);
      addHandle('p1', p1);
      addHandle('p2', p2);
    } else {
      HANDLE_DEFS.forEach((def) => addHandle(def.key, worldFromLocal(shape, def.local(shape))));

      const rotLocal = { x: shape.w / 2, y: -ROTATE_HANDLE_OFFSET };
      const rotWorld = worldFromLocal(shape, rotLocal);
      const nWorld = worldFromLocal(shape, { x: shape.w / 2, y: 0 });
      const connector = document.createElementNS(SVG_NS, 'line');
      connector.setAttribute('x1', nWorld.x); connector.setAttribute('y1', nWorld.y);
      connector.setAttribute('x2', rotWorld.x); connector.setAttribute('y2', rotWorld.y);
      connector.setAttribute('stroke', '#4a90d9');
      connector.setAttribute('stroke-width', '0.3');
      connector.setAttribute('vector-effect', 'non-scaling-stroke');
      overlayGroup.appendChild(connector);

      addHandle('rotate', rotWorld, 'handle-rotate');
    }

    addHandle('move', worldCenter(shape), 'handle-move');
  }

  // ---------- properties panel ----------

  function refreshProps() {
    if (state.selectedIds.length > 1) {
      els.propsEmpty.hidden = false;
      els.propsEmpty.textContent = `${state.selectedIds.length} shapes selected. Press Delete to remove.`;
      els.propsForm.hidden = true;
      return;
    }
    const shape = selectedShape();
    if (!shape) {
      els.propsEmpty.hidden = false;
      els.propsEmpty.textContent = 'No shape selected.';
      els.propsForm.hidden = true;
      return;
    }
    els.propsEmpty.hidden = true;
    els.propsForm.hidden = false;
    els.propLayer.value = shape.layer;
    els.propX.value = round(shape.x);
    els.propY.value = round(shape.y);
    els.propW.value = round(shape.w);
    els.propH.value = round(shape.h);
    els.propRot.value = round(shape.rotation);
    els.propRadiusWrap.hidden = shape.type !== 'rect';
    if (shape.type === 'rect') els.propRadius.value = round(shape.radius || 0);
  }

  function applyPropsToShape() {
    const shape = selectedShape();
    if (!shape) return;
    shape.layer = els.propLayer.value;
    shape.x = parseFloat(els.propX.value) || 0;
    shape.y = parseFloat(els.propY.value) || 0;
    shape.w = Math.max(MIN_SIZE, parseFloat(els.propW.value) || MIN_SIZE);
    shape.h = Math.max(MIN_SIZE, parseFloat(els.propH.value) || MIN_SIZE);
    shape.rotation = parseFloat(els.propRot.value) || 0;
    if (shape.type === 'rect') shape.radius = Math.max(0, parseFloat(els.propRadius.value) || 0);
    fullRender();
    pushHistory();
  }

  [els.propLayer, els.propX, els.propY, els.propW, els.propH, els.propRadius, els.propRot].forEach((el) => {
    el.addEventListener('change', applyPropsToShape);
  });

  els.deleteShapeBtn.addEventListener('click', () => {
    deleteSelected();
  });

  function deleteSelected() {
    if (!state.selectedIds.length) return;
    const idSet = new Set(state.selectedIds);
    state.shapes = state.shapes.filter((s) => !idSet.has(s.id));
    state.selectedIds = [];
    fullRender();
    pushHistory();
  }

  // ---------- clipboard ----------

  let clipboard = [];
  let pasteCount = 0;

  function copySelected() {
    if (!state.selectedIds.length) return;
    const idSet = new Set(state.selectedIds);
    clipboard = state.shapes.filter((s) => idSet.has(s.id)).map((s) => JSON.parse(JSON.stringify(s)));
    pasteCount = 0;
  }

  function cutSelected() {
    if (!state.selectedIds.length) return;
    copySelected();
    deleteSelected();
  }

  function pasteClipboard() {
    if (!clipboard.length) return;
    pasteCount += 1;
    const offset = 4 * pasteCount;
    const newIds = [];
    clipboard.forEach((c) => {
      const s = JSON.parse(JSON.stringify(c));
      s.id = state.nextId++;
      s.x += offset;
      s.y += offset;
      state.shapes.push(s);
      newIds.push(s.id);
    });
    selectShapes(newIds);
    fullRender();
    pushHistory();
  }

  function selectAll() {
    selectShapes(state.shapes.map((s) => s.id));
  }

  // ---------- tool / layer toolbar ----------

  els.toolButtons.addEventListener('click', (e) => {
    const btn = e.target.closest('.tool-btn');
    if (!btn) return;
    state.tool = btn.dataset.tool;
    [...els.toolButtons.children].forEach((b) => b.classList.toggle('active', b === btn));
    cancelPolygonDraw();
    selectShape(null);
    renderSnapGuides([]);
    renderSnapPointMarker(null);
    updateCursor();
  });

  els.layerBar.addEventListener('click', (e) => {
    const btn = e.target.closest('.layer-btn');
    if (!btn) return;
    state.activeLayer = btn.dataset.layer;
    els.layerBar.querySelectorAll('.layer-btn').forEach((b) => b.classList.toggle('active', b === btn));
  });

  els.layerBar.addEventListener('change', (e) => {
    const colorInput = e.target.closest('.layer-color');
    if (colorInput) {
      state.layerColors[colorInput.dataset.layer] = colorInput.value;
      renderShapes();
      if (polyDraft) renderPolyDraft();
      return;
    }
    const cb = e.target.closest('input[data-vis]');
    if (!cb) return;
    state.layerVisible[cb.dataset.vis] = cb.checked;
    renderShapes();
  });

  function updateCursor() {
    svg.style.cursor = state.tool === 'select' ? 'default' : 'crosshair';
  }

  // ---------- drawing interactions ----------

  let drag = null; // { mode, ... }
  let polyDraft = null; // { points: [{x,y}] }

  function onCanvasPointerDown(evt) {
    if (spaceDown || evt.button === 1) {
      evt.preventDefault();
      startPanDrag(evt);
      return;
    }

    const handleEl = evt.target.closest('.handle');
    const shapeEl = evt.target.closest('.shape-el');

    if (handleEl) {
      const handleKey = handleEl.dataset.handle;
      if (state.selectedIds.length > 1) {
        if (handleKey === 'move') {
          startMoveDrag(evt);
        } else {
          startGroupHandleDrag(handleKey, evt);
        }
      } else {
        startHandleDrag(handleKey, evt);
      }
      evt.stopPropagation();
      return;
    }

    if (state.tool === 'select') {
      if (shapeEl) {
        const id = parseInt(shapeEl.dataset.id, 10);
        if (evt.shiftKey) {
          toggleSelect(id);
          return;
        }
        if (!state.selectedIds.includes(id)) selectShape(id);
        startMoveDrag(evt);
      } else {
        if (!evt.shiftKey) selectShape(null);
        startMarqueeDrag(evt);
      }
      return;
    }

    if (state.tool === 'line' || state.tool === 'rect' || state.tool === 'ellipse') {
      startCreateDrag(evt);
      return;
    }

    if (state.tool === 'polygon') {
      handlePolygonClick(evt);
      return;
    }
  }

  function startMoveDrag(evt) {
    const start = svgPoint(evt);
    if (state.selectedIds.length > 1) {
      const origins = new Map();
      state.selectedIds.forEach((id) => {
        const s = state.shapes.find((sh) => sh.id === id);
        if (s) origins.set(id, { x: s.x, y: s.y });
      });
      drag = { mode: 'move-multi', ids: [...state.selectedIds], origins, start };
    } else {
      const shape = selectedShape();
      if (!shape) return;
      const origin = { x: shape.x, y: shape.y };
      drag = { mode: 'move', shape, start, origin };
    }
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
  }

  function startHandleDrag(handleKey, evt) {
    const shape = selectedShape();
    if (!shape) return;
    if (handleKey === 'move') {
      drag = { mode: 'move', shape, start: svgPoint(evt), origin: { x: shape.x, y: shape.y } };
    } else if (handleKey === 'rotate') {
      drag = { mode: 'rotate', shape };
    } else if (shape.type === 'line' && (handleKey === 'p1' || handleKey === 'p2')) {
      const { p1, p2 } = lineEndpointsWorld(shape);
      const fixed = handleKey === 'p1' ? p2 : p1;
      drag = { mode: 'line-endpoint', shape, fixed };
    } else {
      drag = { mode: 'resize', shape, handle: handleKey, box0: { x: shape.x, y: shape.y, w: shape.w, h: shape.h } };
    }
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
    evt.stopPropagation();
  }

  function startGroupHandleDrag(handleKey, evt) {
    const ids = [...state.selectedIds];
    const box0 = groupBoundingBox(ids);
    if (!box0) return;
    const origins = new Map();
    ids.forEach((id) => {
      const s = state.shapes.find((sh) => sh.id === id);
      if (s) origins.set(id, { x: s.x, y: s.y, w: s.w, h: s.h });
    });
    drag = { mode: 'resize-group', ids, origins, handle: handleKey, box0 };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
    evt.stopPropagation();
  }

  function startCreateDrag(evt) {
    let p = svgPoint(evt);
    const snapOn = snapEnabled && !evt.altKey;
    const snapped = resolvePointSnap(p, [], snapOn);
    p = { x: snapped.x, y: snapped.y };
    const id = state.nextId++;
    const shape = {
      id, type: state.tool, layer: state.activeLayer,
      x: p.x, y: p.y, w: 0, h: 0, rotation: 0,
      radius: 0, diag: 'tlbr',
    };
    state.shapes.push(shape);
    drag = { mode: 'create', shape, start: p };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
  }

  function onDragMove(evt) {
    if (!drag) return;
    const p = svgPoint(evt);
    const snapOn = snapEnabled && !evt.altKey;
    let guides = [];

    if (drag.mode === 'move-multi') {
      const rawDx = p.x - drag.start.x;
      const rawDy = p.y - drag.start.y;
      const res = snapMoveGroup(drag.ids, drag.origins, rawDx, rawDy, snapOn);
      drag.ids.forEach((id) => {
        const s = state.shapes.find((sh) => sh.id === id);
        const o = drag.origins.get(id);
        if (s && o) { s.x = o.x + res.dx; s.y = o.y + res.dy; }
      });
      guides = res.guides;
      fullRender();
      renderSnapGuides(guides);
      return;
    }

    if (drag.mode === 'resize-group') {
      const box0 = drag.box0;
      const res = resolvePointSnap(p, drag.ids, snapOn);
      guides = res.guides;
      let x1 = box0.x, y1 = box0.y, x2 = box0.x + box0.w, y2 = box0.y + box0.h;
      const hk = drag.handle;
      if (hk.includes('w')) x1 = res.x;
      if (hk.includes('e')) x2 = res.x;
      if (hk.includes('n')) y1 = res.y;
      if (hk.includes('s')) y2 = res.y;
      const box = normBox(x1, y1, x2, y2);
      const newW = Math.max(MIN_SIZE, box.w);
      const newH = Math.max(MIN_SIZE, box.h);
      // Guard against a near-zero group bbox dimension blowing the scale
      // factor up to something huge (e.g. a group of only-horizontal lines
      // has box0.h ~ 0 until you actually drag a vertical handle).
      const sx = box0.w > MIN_SIZE ? newW / box0.w : 1;
      const sy = box0.h > MIN_SIZE ? newH / box0.h : 1;
      drag.ids.forEach((id) => {
        const s = state.shapes.find((sh) => sh.id === id);
        const o = drag.origins.get(id);
        if (!s || !o) return;
        s.x = box.x + (o.x - box0.x) * sx;
        s.y = box.y + (o.y - box0.y) * sy;
        s.w = o.w === 0 ? 0 : Math.max(MIN_SIZE, o.w * sx);
        s.h = o.h === 0 ? 0 : Math.max(MIN_SIZE, o.h * sy);
      });
      fullRender();
      renderSnapGuides(guides);
      return;
    }

    const shape = drag.shape;

    if (drag.mode === 'move') {
      const rawX = drag.origin.x + (p.x - drag.start.x);
      const rawY = drag.origin.y + (p.y - drag.start.y);
      const res = snapMoveShape(shape, rawX, rawY, snapOn);
      shape.x = res.x; shape.y = res.y;
      guides = res.guides;
    } else if (drag.mode === 'create') {
      let ex = p.x, ey = p.y;
      if (evt.shiftKey && shape.type === 'line') {
        const res = angleConstrainedPoint(drag.start, p, [shape.id], snapOn);
        ex = res.point.x; ey = res.point.y;
        guides = res.guides;
      } else {
        const res = resolvePointSnap({ x: ex, y: ey }, [shape.id], snapOn);
        ex = res.x; ey = res.y;
        guides = res.guides;
      }
      const box = normBox(drag.start.x, drag.start.y, ex, ey);
      shape.x = box.x; shape.y = box.y; shape.w = box.w; shape.h = box.h;
      if (shape.type === 'line') {
        shape.diag = (ex - drag.start.x) * (ey - drag.start.y) >= 0 ? 'tlbr' : 'trbl';
      }
    } else if (drag.mode === 'line-endpoint') {
      const fixed = drag.fixed;
      let moved;
      if (evt.shiftKey) {
        const res = angleConstrainedPoint(fixed, p, [shape.id], snapOn);
        moved = res.point;
        guides = res.guides;
      } else {
        const res = resolvePointSnap(p, [shape.id], snapOn, [fixed]);
        guides = res.guides;
        moved = { x: res.x, y: res.y };
      }
      const box = normBox(fixed.x, fixed.y, moved.x, moved.y);
      shape.x = box.x; shape.y = box.y;
      shape.w = box.w;
      shape.h = box.h;
      shape.diag = (fixed.x - moved.x) * (fixed.y - moved.y) >= 0 ? 'tlbr' : 'trbl';
    } else if (drag.mode === 'resize') {
      const box0 = drag.box0;
      const refShape = { x: box0.x, y: box0.y, w: box0.w, h: box0.h, rotation: shape.rotation };
      const res = resolvePointSnap(p, [shape.id], snapOn);
      guides = res.guides;
      // localFromWorld() returns a LOCAL coordinate (0..box0.w, 0..box0.h);
      // x1/x2/y1/y2 below are WORLD coordinates (box0.x/box0.y-based), so the
      // local value has to be re-based by box0.x/box0.y before mixing with
      // them — omitting that (as this used to) mixes the two coordinate
      // frames and throws the box to an unrelated position/size the moment
      // box0.x or box0.y isn't 0.
      const Lp = localFromWorld(refShape, { x: res.x, y: res.y });
      let x1 = box0.x, y1 = box0.y, x2 = box0.x + box0.w, y2 = box0.y + box0.h;
      const h = drag.handle;
      if (h.includes('w')) x1 = box0.x + Lp.x;
      if (h.includes('e')) x2 = box0.x + Lp.x;
      if (h.includes('n')) y1 = box0.y + Lp.y;
      if (h.includes('s')) y2 = box0.y + Lp.y;
      const box = normBox(x1, y1, x2, y2);
      shape.x = box.x; shape.y = box.y;
      shape.w = Math.max(MIN_SIZE, box.w);
      shape.h = Math.max(MIN_SIZE, box.h);
    } else if (drag.mode === 'rotate') {
      const wc = worldCenter(shape);
      let deg = (Math.atan2(p.y - wc.y, p.x - wc.x) * 180) / Math.PI + 90;
      if (evt.shiftKey) deg = Math.round(deg / 15) * 15;
      shape.rotation = ((deg % 360) + 360) % 360;
      if (shape.rotation > 180) shape.rotation -= 360;
    }

    fullRender();
    renderSnapGuides(guides);
  }

  function onDragEnd() {
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    if (drag && drag.mode === 'create') {
      if (drag.shape.w < 1 && drag.shape.h < 1) {
        state.shapes = state.shapes.filter((s) => s.id !== drag.shape.id);
      } else {
        selectShape(drag.shape.id);
        [...els.toolButtons.children].forEach((b) => b.classList.toggle('active', b.dataset.tool === 'select'));
        state.tool = 'select';
        updateCursor();
      }
    }
    drag = null;
    fullRender();
    renderSnapGuides([]);
    renderSnapPointMarker(null);
    pushHistory();
  }

  // ---------- polygon tool ----------

  function handlePolygonClick(evt) {
    const raw = svgPoint(evt);
    const snapOn = snapEnabled && !evt.altKey;
    const snapped = resolvePointSnap(raw, [], snapOn);
    const p = { x: snapped.x, y: snapped.y };
    renderSnapGuides(snapped.guides);
    if (!polyDraft) {
      polyDraft = { points: [p] };
      renderPolyDraft();
      return;
    }
    const first = polyDraft.points[0];
    const distToFirst = Math.hypot(p.x - first.x, p.y - first.y);
    if (polyDraft.points.length >= 3 && distToFirst < 2) {
      finishPolygon();
      return;
    }
    polyDraft.points.push(p);
    renderPolyDraft();
  }

  function finishPolygon() {
    const pts = polyDraft.points;
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const box = normBox(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
    const w = Math.max(MIN_SIZE, box.w), h = Math.max(MIN_SIZE, box.h);
    const id = state.nextId++;
    const shape = {
      id, type: 'polygon', layer: state.activeLayer,
      x: box.x, y: box.y, w, h, rotation: 0,
      points: pts.map((p) => ({ fx: (p.x - box.x) / w, fy: (p.y - box.y) / h })),
    };
    state.shapes.push(shape);
    polyDraft = null;
    overlayGroup.querySelectorAll('.poly-draft').forEach((n) => n.remove());
    selectShape(id);
    state.tool = 'select';
    [...els.toolButtons.children].forEach((b) => b.classList.toggle('active', b.dataset.tool === 'select'));
    updateCursor();
    fullRender();
    pushHistory();
  }

  function cancelPolygonDraw() {
    polyDraft = null;
    if (overlayGroup) {
      overlayGroup.querySelectorAll('.poly-draft').forEach((n) => n.remove());
      overlayGroup.querySelectorAll('.snap-guide').forEach((n) => n.remove());
      overlayGroup.querySelectorAll('.snap-point').forEach((n) => n.remove());
    }
  }

  function renderPolyDraft() {
    overlayGroup.querySelectorAll('.poly-draft').forEach((n) => n.remove());
    if (!polyDraft) return;
    const pl = document.createElementNS(SVG_NS, 'polyline');
    pl.setAttribute('points', polyDraft.points.map((p) => `${p.x},${p.y}`).join(' '));
    pl.setAttribute('fill', 'none');
    pl.setAttribute('stroke', state.layerColors[state.activeLayer]);
    pl.setAttribute('stroke-width', '0.2');
    pl.setAttribute('stroke-dasharray', '1,0.6');
    pl.setAttribute('class', 'poly-draft');
    pl.setAttribute('vector-effect', 'non-scaling-stroke');
    overlayGroup.appendChild(pl);
    polyDraft.points.forEach((p) => {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', p.x); c.setAttribute('cy', p.y); c.setAttribute('r', 1);
      c.setAttribute('class', 'poly-draft');
      c.setAttribute('fill', state.layerColors[state.activeLayer]);
      overlayGroup.appendChild(c);
    });
  }

  document.addEventListener('pointermove', (evt) => {
    if (!polyDraft || state.tool !== 'polygon' || !svg) return;
    if (!svg.contains(evt.target) && evt.target !== svg) return;
    const raw = svgPoint(evt);
    const snapOn = snapEnabled && !evt.altKey;
    const snapped = resolvePointSnap(raw, [], snapOn);
    const p = { x: snapped.x, y: snapped.y };
    renderSnapGuides(snapped.guides);
    renderSnapPointMarker(snapped.guides.length ? p : null);
    const pts = [...polyDraft.points, p];
    overlayGroup.querySelectorAll('.poly-draft').forEach((n) => n.remove());
    const pl = document.createElementNS(SVG_NS, 'polyline');
    pl.setAttribute('points', pts.map((pt) => `${pt.x},${pt.y}`).join(' '));
    pl.setAttribute('fill', 'none');
    pl.setAttribute('stroke', state.layerColors[state.activeLayer]);
    pl.setAttribute('stroke-width', '0.2');
    pl.setAttribute('stroke-dasharray', '1,0.6');
    pl.setAttribute('class', 'poly-draft');
    pl.setAttribute('vector-effect', 'non-scaling-stroke');
    overlayGroup.appendChild(pl);
  });

  document.addEventListener('pointermove', (evt) => {
    if (drag || panDrag || marquee || polyDraft) return;
    if (!svg || !overlayGroup) return;
    if (!['line', 'rect', 'ellipse'].includes(state.tool)) return;
    if (!svg.contains(evt.target) && evt.target !== svg) return;
    const raw = svgPoint(evt);
    const snapOn = snapEnabled && !evt.altKey;
    const snapped = resolvePointSnap(raw, [], snapOn);
    renderSnapGuides(snapped.guides);
    renderSnapPointMarker(snapped.guides.length ? { x: snapped.x, y: snapped.y } : null);
  });

  // ---------- selection ----------

  function selectShapes(ids) {
    state.selectedIds = [...new Set(ids)];
    refreshProps();
    renderOverlay();
  }

  function selectShape(id) {
    selectShapes(id == null ? [] : [id]);
  }

  function toggleSelect(id) {
    const set = new Set(state.selectedIds);
    if (set.has(id)) set.delete(id); else set.add(id);
    selectShapes([...set]);
  }

  // ---- marquee (click-drag box selection) ----

  let marquee = null;

  function startMarqueeDrag(evt) {
    const p = svgPoint(evt);
    marquee = { start: p, additive: evt.shiftKey, base: evt.shiftKey ? [...state.selectedIds] : [] };
    window.addEventListener('pointermove', onMarqueeMove);
    window.addEventListener('pointerup', onMarqueeEnd);
  }

  function onMarqueeMove(evt) {
    if (!marquee) return;
    const p = svgPoint(evt);
    const box = normBox(marquee.start.x, marquee.start.y, p.x, p.y);
    const hits = state.shapes.filter((s) => boxesIntersect(s, box)).map((s) => s.id);
    const ids = marquee.additive ? [...new Set([...marquee.base, ...hits])] : hits;
    selectShapes(ids);
    renderMarqueeRect(box);
  }

  function onMarqueeEnd() {
    window.removeEventListener('pointermove', onMarqueeMove);
    window.removeEventListener('pointerup', onMarqueeEnd);
    marquee = null;
    renderMarqueeRect(null);
  }

  function renderMarqueeRect(box) {
    overlayGroup.querySelectorAll('.marquee-rect').forEach((n) => n.remove());
    if (!box) return;
    const r = document.createElementNS(SVG_NS, 'rect');
    r.setAttribute('x', box.x);
    r.setAttribute('y', box.y);
    r.setAttribute('width', box.w);
    r.setAttribute('height', box.h);
    r.setAttribute('class', 'marquee-rect');
    r.setAttribute('vector-effect', 'non-scaling-stroke');
    overlayGroup.appendChild(r);
  }

  // ---------- full render ----------

  function fullRender() {
    renderShapes();
    renderOverlay();
    refreshProps();
  }

  // ---------- history ----------

  function snapshot() {
    return JSON.stringify({ shapes: state.shapes, nextId: state.nextId });
  }

  function pushHistory() {
    const snap = snapshot();
    if (history[historyIndex] === snap) return;
    history = history.slice(0, historyIndex + 1);
    history.push(snap);
    if (history.length > 100) history.shift();
    historyIndex = history.length - 1;
  }

  function restoreSnapshot(snap) {
    const data = JSON.parse(snap);
    state.shapes = data.shapes;
    state.nextId = data.nextId;
    state.selectedIds = [];
    fullRender();
  }

  function undo() {
    if (historyIndex <= 0) return;
    historyIndex--;
    restoreSnapshot(history[historyIndex]);
  }

  function redo() {
    if (historyIndex >= history.length - 1) return;
    historyIndex++;
    restoreSnapshot(history[historyIndex]);
  }

  els.undoBtn.addEventListener('click', undo);
  els.redoBtn.addEventListener('click', redo);

  window.addEventListener('keyup', (evt) => {
    if (evt.key === ' ') {
      spaceDown = false;
      els.canvasWrap.classList.remove('pan-ready');
    }
  });

  // ---------- keyboard ----------

  window.addEventListener('keydown', (evt) => {
    const tag = document.activeElement && document.activeElement.tagName;
    const inField = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';

    if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === 'z') {
      evt.preventDefault();
      if (evt.shiftKey) redo(); else undo();
      return;
    }
    if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === 'y') {
      evt.preventDefault();
      redo();
      return;
    }
    if ((evt.ctrlKey || evt.metaKey) && (evt.key === '=' || evt.key === '+')) {
      evt.preventDefault();
      zoomBy(1.25);
      return;
    }
    if ((evt.ctrlKey || evt.metaKey) && evt.key === '-') {
      evt.preventDefault();
      zoomBy(0.8);
      return;
    }
    if ((evt.ctrlKey || evt.metaKey) && evt.key === '0') {
      evt.preventDefault();
      setZoom(1);
      return;
    }
    if (!inField && evt.key === ' ' && !spaceDown) {
      spaceDown = true;
      evt.preventDefault();
      els.canvasWrap.classList.add('pan-ready');
      return;
    }
    if (inField) return;

    if (evt.shiftKey && evt.key === '1') {
      evt.preventDefault();
      fitZoom();
      return;
    }

    if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === 'a') {
      evt.preventDefault();
      selectAll();
      return;
    }
    if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === 'c') {
      evt.preventDefault();
      copySelected();
      return;
    }
    if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === 'x') {
      evt.preventDefault();
      cutSelected();
      return;
    }
    if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === 'v') {
      evt.preventDefault();
      pasteClipboard();
      return;
    }

    if (evt.key === 'Escape') {
      cancelPolygonDraw();
      selectShape(null);
      return;
    }
    if ((evt.key === 'Delete' || evt.key === 'Backspace') && state.selectedIds.length) {
      evt.preventDefault();
      deleteSelected();
      return;
    }
    if (state.selectedIds.length && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(evt.key)) {
      evt.preventDefault();
      const step = evt.shiftKey ? 1 : 0.1;
      let dx = 0, dy = 0;
      if (evt.key === 'ArrowUp') dy = -step;
      if (evt.key === 'ArrowDown') dy = step;
      if (evt.key === 'ArrowLeft') dx = -step;
      if (evt.key === 'ArrowRight') dx = step;
      state.selectedIds.forEach((id) => {
        const s = state.shapes.find((sh) => sh.id === id);
        if (s) { s.x += dx; s.y += dy; }
      });
      fullRender();
      pushHistory();
    }
  });

  // ---------- card size / image ----------

  els.cardW.addEventListener('change', () => {
    state.cardW = parseFloat(els.cardW.value) || state.cardW;
    updateSvgSize();
    fullRender();
  });
  els.cardH.addEventListener('change', () => {
    state.cardH = parseFloat(els.cardH.value) || state.cardH;
    updateSvgSize();
    fullRender();
  });

  els.imageInput.addEventListener('change', () => {
    const file = els.imageInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      state.imageDataUrl = reader.result;
      imageEl.setAttribute('href', state.imageDataUrl);
    };
    reader.readAsDataURL(file);
  });

  els.imageVisible.addEventListener('change', () => {
    state.imageVisible = els.imageVisible.checked;
    imageEl.style.display = state.imageVisible ? '' : 'none';
  });

  // ---------- export ----------

  function buildExportSVG(layers, mirror) {
    const fmt = (n) => Math.round(n * 1000) / 1000;
    const shapesMarkup = state.shapes
      .filter((s) => layers.includes(s.layer))
      .map(shapeMarkup)
      .join('\n');
    const content = mirror
      ? `<g transform="translate(${fmt(state.cardW)},0) scale(-1,1)">\n${shapesMarkup}\n</g>`
      : shapesMarkup;
    return `<svg xmlns="${SVG_NS}" width="${fmt(state.cardW)}mm" height="${fmt(state.cardH)}mm" viewBox="0 0 ${fmt(state.cardW)} ${fmt(state.cardH)}">\n${content}\n</svg>`;
  }

  function downloadSVG(markup, suffix) {
    const blob = new Blob([markup], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `card_${state.cardW}x${state.cardH}mm_${suffix}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  els.exportAllBtn.addEventListener('click', () => {
    downloadSVG(buildExportSVG(['cut', 'score', 'emboss'], els.mirrorExport.checked), 'all');
  });
  els.exportCutBtn.addEventListener('click', () => {
    downloadSVG(buildExportSVG(['cut'], els.mirrorExport.checked), 'cut');
  });
  els.exportScoreBtn.addEventListener('click', () => {
    downloadSVG(buildExportSVG(['score'], els.mirrorExport.checked), 'score');
  });
  els.exportEmbossBtn.addEventListener('click', () => {
    downloadSVG(buildExportSVG(['emboss'], els.mirrorExport.checked), 'emboss');
  });

  // ---------- project save/load ----------

  els.saveProjectBtn.addEventListener('click', () => {
    const project = {
      cardW: state.cardW,
      cardH: state.cardH,
      imageDataUrl: state.imageDataUrl,
      shapes: state.shapes,
      nextId: state.nextId,
      layerColors: state.layerColors,
    };
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `card-project_${state.cardW}x${state.cardH}mm.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  els.loadProjectInput.addEventListener('change', () => {
    const file = els.loadProjectInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const project = JSON.parse(reader.result);
      state.cardW = project.cardW;
      state.cardH = project.cardH;
      state.imageDataUrl = project.imageDataUrl || null;
      state.shapes = project.shapes || [];
      state.nextId = project.nextId || 1;
      state.selectedIds = [];
      state.layerColors = { ...DEFAULT_LAYER_COLORS, ...(project.layerColors || {}) };
      els.layerBar.querySelectorAll('.layer-color').forEach((input) => {
        input.value = state.layerColors[input.dataset.layer];
      });
      els.cardW.value = state.cardW;
      els.cardH.value = state.cardH;
      updateSvgSize();
      if (state.imageDataUrl) imageEl.setAttribute('href', state.imageDataUrl);
      fullRender();
      history = []; historyIndex = -1;
      pushHistory();
    };
    reader.readAsText(file);
    els.loadProjectInput.value = '';
  });

  // ---------- init ----------

  buildCanvas();
  updateCursor();
  fullRender();
  pushHistory();

  // ---------- templates ----------

  // Starting shapes sized to the current card; added as normal, editable shapes.
  const TEMPLATES = {
    outline: (W, H) => [{ type: 'rect', layer: 'cut', x: 0, y: 0, w: W, h: H, radius: 3 }],
    round: (W, H) => {
      const d = Math.min(W, H);
      return [{ type: 'ellipse', layer: 'cut', x: (W - d) / 2, y: (H - d) / 2, w: d, h: d }];
    },
    hex: (W, H) => {
      // Pointy-top regular hexagon, as large as fits the card
      const R = Math.min(W / Math.sqrt(3), H / 2);
      const w = Math.sqrt(3) * R, h = 2 * R;
      const points = [];
      for (let i = 0; i < 6; i++) {
        const a = ((-90 + 60 * i) * Math.PI) / 180;
        points.push({ fx: 0.5 + (R * Math.cos(a)) / w, fy: 0.5 + (R * Math.sin(a)) / h });
      }
      return [{ type: 'polygon', layer: 'cut', x: (W - w) / 2, y: (H - h) / 2, w, h, points }];
    },
    foldMiddle: (W, H) => [{ type: 'line', layer: 'score', x: W / 2, y: 0, w: 0, h: H, diag: 'tlbr' }],
    standee: (W, H) => {
      const base = Math.min(15, H * 0.2);
      return [
        { type: 'rect', layer: 'cut', x: 0, y: 0, w: W, h: H, radius: 0 },
        { type: 'line', layer: 'score', x: 0, y: H - base, w: W, h: 0, diag: 'tlbr' },
      ];
    },
  };

  $('addTemplateBtn').addEventListener('click', () => {
    const make = TEMPLATES[$('templateSelect').value];
    if (!make) return;
    const ids = make(state.cardW, state.cardH).map((shape) => {
      const full = { rotation: 0, radius: 0, diag: 'tlbr', ...shape, id: state.nextId++ };
      state.shapes.push(full);
      return full.id;
    });
    selectShapes(ids);
    fullRender();
    pushHistory();
  });

  // ---------- Shared PnPTools wiring ----------

  // The editor keeps its own .json project format (the sheet assembler reads
  // it), so only the top bar, settings, presets and the leave warning are shared.
  let savedShapes = JSON.stringify(state.shapes);
  els.saveProjectBtn.addEventListener('click', () => { savedShapes = JSON.stringify(state.shapes); });
  els.loadProjectInput.addEventListener('change', () => setTimeout(() => { savedShapes = JSON.stringify(state.shapes); }, 500));

  PnP.bindPreset($('cardPreset'), els.cardW, els.cardH, 'card');
  PnP.init({
    tool: 'PnPCut',
    settingsKey: 'PnPCut-editor',
    hasUnsavedWork: () => state.shapes.length > 0 && JSON.stringify(state.shapes) !== savedShapes,
  });
})();
