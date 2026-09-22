(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PX_PER_MM = 6;
  const HANDLE_R = 1.8;
  const ROTATE_HANDLE_OFFSET = 9;
  const LAYER_COLORS = { cut: '#c0392b', score: '#e08e0b', emboss: '#2e8b57' };
  const MIN_SIZE = 0.5;

  const $ = (id) => document.getElementById(id);

  const els = {
    cardW: $('cardW'),
    cardH: $('cardH'),
    imageInput: $('imageInput'),
    imageVisible: $('imageVisible'),
    toolButtons: $('toolButtons'),
    layerButtons: $('layerButtons'),
    layerVisibility: $('layerVisibility'),
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
  };

  const state = {
    cardW: 88,
    cardH: 63,
    imageDataUrl: null,
    imageVisible: true,
    tool: 'select',
    activeLayer: 'cut',
    layerVisible: { cut: true, score: true, emboss: true },
    shapes: [],
    nextId: 1,
    selectedId: null,
  };

  let history = [];
  let historyIndex = -1;

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
  }

  function updateSvgSize() {
    svg.setAttribute('viewBox', `0 0 ${state.cardW} ${state.cardH}`);
    svg.setAttribute('width', state.cardW * PX_PER_MM);
    svg.setAttribute('height', state.cardH * PX_PER_MM);
    if (imageEl) {
      imageEl.setAttribute('width', state.cardW);
      imageEl.setAttribute('height', state.cardH);
    }
  }

  function svgPoint(evt) {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
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
    return `<g transform="${d.transform}"><${d.tag} ${attrs} fill="none" stroke="${LAYER_COLORS[shape.layer]}" stroke-width="0.15"/></g>`;
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
    prim.setAttribute('stroke', LAYER_COLORS[shape.layer]);
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

  function selectedShape() {
    return state.shapes.find((s) => s.id === state.selectedId) || null;
  }

  function renderOverlay() {
    overlayGroup.innerHTML = '';
    const shape = selectedShape();
    if (!shape) return;

    const corners = [
      worldFromLocal(shape, { x: 0, y: 0 }),
      worldFromLocal(shape, { x: shape.w, y: 0 }),
      worldFromLocal(shape, { x: shape.w, y: shape.h }),
      worldFromLocal(shape, { x: 0, y: shape.h }),
    ];
    const outline = document.createElementNS(SVG_NS, 'polygon');
    outline.setAttribute('points', corners.map((p) => `${p.x},${p.y}`).join(' '));
    outline.setAttribute('fill', 'none');
    outline.setAttribute('stroke', '#4a90d9');
    outline.setAttribute('stroke-width', '0.3');
    outline.setAttribute('stroke-dasharray', '1.2,1');
    outline.setAttribute('vector-effect', 'non-scaling-stroke');
    overlayGroup.appendChild(outline);

    HANDLE_DEFS.forEach((def) => {
      const wp = worldFromLocal(shape, def.local(shape));
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', wp.x);
      c.setAttribute('cy', wp.y);
      c.setAttribute('r', HANDLE_R);
      c.setAttribute('class', 'handle');
      c.setAttribute('data-handle', def.key);
      c.setAttribute('vector-effect', 'non-scaling-stroke');
      overlayGroup.appendChild(c);
    });

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

    const rc = document.createElementNS(SVG_NS, 'circle');
    rc.setAttribute('cx', rotWorld.x);
    rc.setAttribute('cy', rotWorld.y);
    rc.setAttribute('r', HANDLE_R);
    rc.setAttribute('class', 'handle handle-rotate');
    rc.setAttribute('data-handle', 'rotate');
    rc.setAttribute('vector-effect', 'non-scaling-stroke');
    overlayGroup.appendChild(rc);
  }

  // ---------- properties panel ----------

  function refreshProps() {
    const shape = selectedShape();
    if (!shape) {
      els.propsEmpty.hidden = false;
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
    if (!state.selectedId) return;
    state.shapes = state.shapes.filter((s) => s.id !== state.selectedId);
    state.selectedId = null;
    fullRender();
    pushHistory();
  }

  // ---------- tool / layer toolbar ----------

  els.toolButtons.addEventListener('click', (e) => {
    const btn = e.target.closest('.tool-btn');
    if (!btn) return;
    state.tool = btn.dataset.tool;
    [...els.toolButtons.children].forEach((b) => b.classList.toggle('active', b === btn));
    cancelPolygonDraw();
    selectShape(null);
    updateCursor();
  });

  els.layerButtons.addEventListener('click', (e) => {
    const btn = e.target.closest('.layer-btn');
    if (!btn) return;
    state.activeLayer = btn.dataset.layer;
    [...els.layerButtons.children].forEach((b) => b.classList.toggle('active', b === btn));
  });

  els.layerVisibility.addEventListener('change', (e) => {
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
    const handleEl = evt.target.closest('.handle');
    const shapeEl = evt.target.closest('.shape-el');

    if (handleEl) {
      startHandleDrag(handleEl.dataset.handle, evt);
      return;
    }

    if (state.tool === 'select') {
      if (shapeEl) {
        selectShape(parseInt(shapeEl.dataset.id, 10));
        startMoveDrag(evt);
      } else {
        selectShape(null);
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
    const shape = selectedShape();
    if (!shape) return;
    const start = svgPoint(evt);
    const origin = { x: shape.x, y: shape.y };
    drag = { mode: 'move', shape, start, origin };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
  }

  function startHandleDrag(handleKey, evt) {
    const shape = selectedShape();
    if (!shape) return;
    if (handleKey === 'rotate') {
      drag = { mode: 'rotate', shape };
    } else {
      drag = { mode: 'resize', shape, handle: handleKey, box0: { x: shape.x, y: shape.y, w: shape.w, h: shape.h } };
    }
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
    evt.stopPropagation();
  }

  function startCreateDrag(evt) {
    const p = svgPoint(evt);
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
    const shape = drag.shape;

    if (drag.mode === 'move') {
      shape.x = drag.origin.x + (p.x - drag.start.x);
      shape.y = drag.origin.y + (p.y - drag.start.y);
    } else if (drag.mode === 'create') {
      let ex = p.x, ey = p.y;
      if (evt.shiftKey && shape.type === 'line') {
        const dx = ex - drag.start.x, dy = ey - drag.start.y;
        const len = Math.hypot(dx, dy);
        const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        ex = drag.start.x + Math.cos(angle) * len;
        ey = drag.start.y + Math.sin(angle) * len;
      }
      const box = normBox(drag.start.x, drag.start.y, ex, ey);
      shape.x = box.x; shape.y = box.y; shape.w = box.w; shape.h = box.h;
      if (shape.type === 'line') {
        shape.diag = (ex - drag.start.x) * (ey - drag.start.y) >= 0 ? 'tlbr' : 'trbl';
      }
    } else if (drag.mode === 'resize') {
      const box0 = drag.box0;
      const refShape = { x: box0.x, y: box0.y, w: box0.w, h: box0.h, rotation: shape.rotation };
      const Lp = localFromWorld(refShape, p);
      let x1 = box0.x, y1 = box0.y, x2 = box0.x + box0.w, y2 = box0.y + box0.h;
      const h = drag.handle;
      if (h.includes('w')) x1 = Lp.x;
      if (h.includes('e')) x2 = Lp.x;
      if (h.includes('n')) y1 = Lp.y;
      if (h.includes('s')) y2 = Lp.y;
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
    pushHistory();
  }

  // ---------- polygon tool ----------

  function handlePolygonClick(evt) {
    const p = svgPoint(evt);
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
    if (overlayGroup) overlayGroup.querySelectorAll('.poly-draft').forEach((n) => n.remove());
  }

  function renderPolyDraft() {
    overlayGroup.querySelectorAll('.poly-draft').forEach((n) => n.remove());
    if (!polyDraft) return;
    const pl = document.createElementNS(SVG_NS, 'polyline');
    pl.setAttribute('points', polyDraft.points.map((p) => `${p.x},${p.y}`).join(' '));
    pl.setAttribute('fill', 'none');
    pl.setAttribute('stroke', LAYER_COLORS[state.activeLayer]);
    pl.setAttribute('stroke-width', '0.2');
    pl.setAttribute('stroke-dasharray', '1,0.6');
    pl.setAttribute('class', 'poly-draft');
    pl.setAttribute('vector-effect', 'non-scaling-stroke');
    overlayGroup.appendChild(pl);
    polyDraft.points.forEach((p) => {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', p.x); c.setAttribute('cy', p.y); c.setAttribute('r', 1);
      c.setAttribute('class', 'poly-draft');
      c.setAttribute('fill', LAYER_COLORS[state.activeLayer]);
      overlayGroup.appendChild(c);
    });
  }

  document.addEventListener('pointermove', (evt) => {
    if (!polyDraft || state.tool !== 'polygon' || !svg) return;
    if (!svg.contains(evt.target) && evt.target !== svg) return;
    const p = svgPoint(evt);
    const pts = [...polyDraft.points, p];
    overlayGroup.querySelectorAll('.poly-draft').forEach((n) => n.remove());
    const pl = document.createElementNS(SVG_NS, 'polyline');
    pl.setAttribute('points', pts.map((pt) => `${pt.x},${pt.y}`).join(' '));
    pl.setAttribute('fill', 'none');
    pl.setAttribute('stroke', LAYER_COLORS[state.activeLayer]);
    pl.setAttribute('stroke-width', '0.2');
    pl.setAttribute('stroke-dasharray', '1,0.6');
    pl.setAttribute('class', 'poly-draft');
    pl.setAttribute('vector-effect', 'non-scaling-stroke');
    overlayGroup.appendChild(pl);
  });

  // ---------- selection ----------

  function selectShape(id) {
    state.selectedId = id;
    refreshProps();
    renderOverlay();
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
    state.selectedId = null;
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
    if (inField) return;

    if (evt.key === 'Escape') {
      cancelPolygonDraw();
      selectShape(null);
      return;
    }
    if ((evt.key === 'Delete' || evt.key === 'Backspace') && state.selectedId) {
      evt.preventDefault();
      deleteSelected();
      return;
    }
    const shape = selectedShape();
    if (shape && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(evt.key)) {
      evt.preventDefault();
      const step = evt.shiftKey ? 1 : 0.1;
      if (evt.key === 'ArrowUp') shape.y -= step;
      if (evt.key === 'ArrowDown') shape.y += step;
      if (evt.key === 'ArrowLeft') shape.x -= step;
      if (evt.key === 'ArrowRight') shape.x += step;
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
      state.selectedId = null;
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
})();
