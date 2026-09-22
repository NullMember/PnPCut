(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const LAYER_COLORS = { cut: '#c0392b', score: '#e08e0b', emboss: '#2e8b57' };
  const GUIDE_COLOR = '#2b6cb0';

  const $ = (id) => document.getElementById(id);

  const els = {
    cardW: $('cardW'),
    cardH: $('cardH'),
    radius: $('radius'),
    bleed: $('bleed'),
    gap: $('gap'),
    edgeMargin: $('edgeMargin'),
    paperPreset: $('paperPreset'),
    paperW: $('paperW'),
    paperH: $('paperH'),
    landscape: $('landscape'),
    machineMargin: $('machineMargin'),
    autoFit: $('autoFit'),
    cols: $('cols'),
    rowsInput: $('rowsInput'),
    warning: $('warning'),
    canvasWrap: $('canvasWrap'),
    projectInput: $('projectInput'),
    projectList: $('projectList'),
    cellAssignment: $('cellAssignment'),
    fillAllRow: $('fillAllRow'),
    fillAllSelect: $('fillAllSelect'),
    fillAllBtn: $('fillAllBtn'),
    mirrorSheet: $('mirrorSheet'),
    exportAllBtn: $('exportAllBtn'),
    exportCutBtn: $('exportCutBtn'),
    exportScoreBtn: $('exportScoreBtn'),
    exportEmbossBtn: $('exportEmbossBtn'),
  };

  const PAPER_PRESETS = {
    a4: { w: 210, h: 297 },
    letter: { w: 215.9, h: 279.4 },
  };

  const state = {
    projects: {},       // filename -> parsed project JSON
    assignments: {},    // "row-col" -> filename | null
  };

  let gapTouched = false;
  let edgeMarginTouched = false;

  function num(el) {
    const v = parseFloat(el.value);
    return Number.isFinite(v) ? v : 0;
  }

  function round(n) {
    return Math.round(n * 1000) / 1000;
  }

  function cellKey(cell) {
    return `${cell.row}-${cell.col}`;
  }

  // ---------- grid params (mirrors app.js) ----------

  function applyPaperPreset() {
    const preset = els.paperPreset.value;
    if (preset === 'custom') return;
    const { w, h } = PAPER_PRESETS[preset];
    els.paperW.value = w;
    els.paperH.value = h;
  }

  function getPaperSize() {
    let w = num(els.paperW);
    let h = num(els.paperH);
    if (els.landscape.checked && w < h) [w, h] = [h, w];
    if (!els.landscape.checked && w > h) [w, h] = [h, w];
    return { w, h };
  }

  function computeLayout() {
    const { w: paperW, h: paperH } = getPaperSize();
    const layout = computeGridLayout({
      cardW: num(els.cardW),
      cardH: num(els.cardH),
      bleed: num(els.bleed),
      gap: num(els.gap),
      edgeMargin: num(els.edgeMargin),
      machineMargin: num(els.machineMargin),
      paperW, paperH,
      autoFit: els.autoFit.checked,
      colsOverride: num(els.cols),
      rowsOverride: num(els.rowsInput),
    });
    if (els.autoFit.checked) {
      els.cols.value = layout.cols;
      els.rowsInput.value = layout.rows;
    }
    return { ...layout, radius: num(els.radius) };
  }

  // ---------- shape markup (mirrors editor.js's describeShape/shapeMarkup) ----------

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

  function shapeMarkup(shape, layerColors) {
    const d = describeShape(shape);
    if (!d) return '';
    const attrs = Object.entries(d.attrs).map(([k, v]) => `${k}="${round(v)}"`).join(' ');
    const color = (layerColors && layerColors[shape.layer]) || LAYER_COLORS[shape.layer];
    return `<g transform="${d.transform}"><${d.tag} ${attrs} fill="none" stroke="${color}" stroke-width="0.15"/></g>`;
  }

  function cutRectMarkup(cell, cardW, cardH, radius) {
    const r = Math.max(0, Math.min(radius, cardW / 2, cardH / 2));
    return `<rect x="${round(cell.x)}" y="${round(cell.y)}" width="${round(cardW)}" height="${round(cardH)}" rx="${round(r)}" ry="${round(r)}" fill="none" stroke="${LAYER_COLORS.cut}" stroke-width="0.1"/>`;
  }

  // ---------- sheet body assembly ----------

  // A loaded project's shapes were drawn against ITS OWN cardW/cardH (whatever
  // the card editor had at save time). The sheet's own Card panel can be set
  // to a different size — the project list even flags that mismatch with a
  // ⚠ — but shapes were still only translated into place, never rescaled to
  // match, so any mismatch silently drew everything at the wrong size versus
  // the cut outline. Scale each shape into the sheet's own card size (a
  // no-op, sx=sy=1, whenever the sizes already match).
  function scaleShapeToCard(shape, sx, sy) {
    const scaled = {
      ...shape,
      x: shape.x * sx,
      y: shape.y * sy,
      w: shape.w * sx,
      h: shape.h * sy,
    };
    if (typeof shape.radius === 'number') scaled.radius = shape.radius * Math.min(sx, sy);
    return scaled;
  }

  function buildBodyMarkup(layout, layers) {
    let content = '';
    layout.cards.forEach((cell) => {
      if (layers.includes('cut')) {
        content += cutRectMarkup(cell, layout.cardW, layout.cardH, layout.radius) + '\n';
      }
      if (layers.includes('score') || layers.includes('emboss')) {
        const filename = state.assignments[cellKey(cell)];
        const project = filename ? state.projects[filename] : null;
        if (project) {
          const sx = project.cardW ? layout.cardW / project.cardW : 1;
          const sy = project.cardH ? layout.cardH / project.cardH : 1;
          project.shapes
            .filter((s) => layers.includes(s.layer))
            .forEach((s) => {
              const scaled = scaleShapeToCard(s, sx, sy);
              const shifted = { ...scaled, x: scaled.x + cell.x, y: scaled.y + cell.y };
              content += shapeMarkup(shifted, project.layerColors) + '\n';
            });
        }
      }
    });
    return content;
  }

  function buildExportSVG(layout, layers, mirror) {
    const guideRect = `<rect x="0" y="0" width="${round(layout.guideW)}" height="${round(layout.guideH)}" fill="none" stroke="${GUIDE_COLOR}" stroke-width="0.1"/>\n`;
    const body = buildBodyMarkup(layout, layers);
    const content = mirror
      ? `${guideRect}<g transform="translate(${round(layout.guideW)},0) scale(-1,1)">\n${body}</g>`
      : guideRect + body;
    return `<svg xmlns="${SVG_NS}" width="${round(layout.guideW)}mm" height="${round(layout.guideH)}mm" viewBox="0 0 ${round(layout.guideW)} ${round(layout.guideH)}">\n${content}</svg>`;
  }

  // ---------- rendering ----------

  function renderCanvas(layout) {
    const body = buildBodyMarkup(layout, ['cut', 'score', 'emboss']);
    const guideRect = `<rect x="0" y="0" width="${round(layout.guideW)}" height="${round(layout.guideH)}" fill="none" stroke="${GUIDE_COLOR}" stroke-width="0.1"/>`;
    els.canvasWrap.innerHTML =
      `<svg xmlns="${SVG_NS}" width="${round(layout.guideW)}mm" height="${round(layout.guideH)}mm" viewBox="0 0 ${round(layout.guideW)} ${round(layout.guideH)}">` +
      guideRect + body + `</svg>`;
  }

  function renderWarning(layout) {
    els.warning.hidden = !layout.overflow;
    if (layout.overflow) {
      els.warning.textContent =
        `Grid (${layout.gridW.toFixed(1)} × ${layout.gridH.toFixed(1)} mm) is larger than the usable guide area ` +
        `(${layout.guideW.toFixed(1)} × ${layout.guideH.toFixed(1)} mm). Reduce columns/rows or spacing.`;
    }
  }

  function renderProjectList() {
    const names = Object.keys(state.projects);
    if (names.length === 0) {
      els.projectList.innerHTML = '<p class="props-empty">No projects loaded.</p>';
      return;
    }
    els.projectList.innerHTML = names.map((name) => {
      const p = state.projects[name];
      const mismatch = Math.abs(p.cardW - num(els.cardW)) > 0.5 || Math.abs(p.cardH - num(els.cardH)) > 0.5;
      return `<div class="project-row${mismatch ? ' mismatch' : ''}">` +
        `<span class="project-name" title="${name}">${name}</span>` +
        `<span class="project-size">${round(p.cardW)}×${round(p.cardH)}mm${mismatch ? ' ⚠' : ''}</span>` +
        `<button type="button" class="remove-btn" data-remove="${name}">&times;</button>` +
        `</div>`;
    }).join('');
  }

  function renderCellAssignment(layout) {
    const names = Object.keys(state.projects);
    els.cellAssignment.innerHTML = layout.cards.map((cell) => {
      const key = cellKey(cell);
      const current = state.assignments[key] || '';
      const options = ['<option value="">— none —</option>']
        .concat(names.map((n) => `<option value="${n}" ${n === current ? 'selected' : ''}>${n}</option>`));
      return `<div class="cell-row">` +
        `<span class="cell-label">Cell ${cell.row + 1},${cell.col + 1}</span>` +
        `<select data-cell="${key}">${options.join('')}</select>` +
        `</div>`;
    }).join('');

    els.fillAllRow.hidden = names.length === 0;
    els.fillAllSelect.innerHTML = names.map((n) => `<option value="${n}">${n}</option>`).join('');
  }

  function pruneAssignments() {
    Object.keys(state.assignments).forEach((key) => {
      const filename = state.assignments[key];
      if (filename && !state.projects[filename]) delete state.assignments[key];
    });
  }

  function render() {
    const layout = computeLayout();
    renderWarning(layout);
    renderCanvas(layout);
    pruneAssignments();
    renderProjectList();
    renderCellAssignment(layout);
    return layout;
  }

  // ---------- project upload ----------

  els.projectInput.addEventListener('change', () => {
    const files = [...els.projectInput.files];
    let remaining = files.length;
    if (remaining === 0) return;
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          state.projects[file.name] = JSON.parse(reader.result);
        } catch (e) {
          console.error('Failed to parse project file', file.name, e);
        }
        remaining--;
        if (remaining === 0) {
          els.projectInput.value = '';
          render();
        }
      };
      reader.readAsText(file);
    });
  });

  els.projectList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    delete state.projects[btn.dataset.remove];
    render();
  });

  els.cellAssignment.addEventListener('change', (e) => {
    const select = e.target.closest('select[data-cell]');
    if (!select) return;
    state.assignments[select.dataset.cell] = select.value || null;
    render();
  });

  els.fillAllBtn.addEventListener('click', () => {
    const filename = els.fillAllSelect.value;
    if (!filename) return;
    const layout = computeLayout();
    layout.cards.forEach((cell) => {
      const key = cellKey(cell);
      if (!state.assignments[key]) state.assignments[key] = filename;
    });
    render();
  });

  // ---------- grid param wiring (mirrors app.js) ----------

  els.paperPreset.addEventListener('change', () => { applyPaperPreset(); render(); });

  ['paperW', 'paperH'].forEach((id) => {
    els[id].addEventListener('input', () => { els.paperPreset.value = 'custom'; render(); });
  });

  els.bleed.addEventListener('input', () => {
    if (!gapTouched) els.gap.value = num(els.bleed) * 2;
    if (!edgeMarginTouched) els.edgeMargin.value = num(els.bleed);
    render();
  });
  els.gap.addEventListener('input', () => { gapTouched = true; render(); });
  els.edgeMargin.addEventListener('input', () => { edgeMarginTouched = true; render(); });

  els.autoFit.addEventListener('change', () => {
    const manual = !els.autoFit.checked;
    els.cols.disabled = !manual;
    els.rowsInput.disabled = !manual;
    render();
  });

  ['cardW', 'cardH', 'radius', 'landscape', 'machineMargin', 'cols', 'rowsInput'].forEach((id) => {
    els[id].addEventListener('input', render);
    els[id].addEventListener('change', render);
  });

  // ---------- export ----------

  function downloadSVG(markup, suffix) {
    const layout = computeLayout();
    const blob = new Blob([markup], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sheet_${round(layout.cardW)}x${round(layout.cardH)}mm_${layout.cols}x${layout.rows}_${suffix}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  els.exportAllBtn.addEventListener('click', () => {
    const layout = computeLayout();
    downloadSVG(buildExportSVG(layout, ['cut', 'score', 'emboss'], els.mirrorSheet.checked), 'all');
  });
  els.exportCutBtn.addEventListener('click', () => {
    const layout = computeLayout();
    downloadSVG(buildExportSVG(layout, ['cut'], els.mirrorSheet.checked), 'cut');
  });
  els.exportScoreBtn.addEventListener('click', () => {
    const layout = computeLayout();
    downloadSVG(buildExportSVG(layout, ['score'], els.mirrorSheet.checked), 'score');
  });
  els.exportEmbossBtn.addEventListener('click', () => {
    const layout = computeLayout();
    downloadSVG(buildExportSVG(layout, ['emboss'], els.mirrorSheet.checked), 'emboss');
  });

  // ---------- init ----------

  applyPaperPreset();
  render();
})();
