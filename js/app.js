(() => {
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
    summary: $('summary'),
    svgWrap: $('svgWrap'),
    downloadBtn: $('downloadBtn'),
  };

  const PAPER_PRESETS = {
    a4: { w: 210, h: 297 },
    letter: { w: 215.9, h: 279.4 },
  };

  let gapTouched = false;
  let edgeMarginTouched = false;

  function num(el) {
    const v = parseFloat(el.value);
    return Number.isFinite(v) ? v : 0;
  }

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
    const radius = num(els.radius);
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

    return { ...layout, radius };
  }

  function buildSVG(layout) {
    const { guideW, guideH, cardW, cardH, radius, cards } = layout;
    const fmt = (n) => Math.round(n * 1000) / 1000;

    const cardRects = cards.map(({ x, y }) =>
      `  <rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(cardW)}" height="${fmt(cardH)}" rx="${fmt(radius)}" ry="${fmt(radius)}" fill="none" stroke="#c0392b" stroke-width="0.1"/>`
    ).join('\n');

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(guideW)}mm" height="${fmt(guideH)}mm" viewBox="0 0 ${fmt(guideW)} ${fmt(guideH)}">
  <rect x="0" y="0" width="${fmt(guideW)}" height="${fmt(guideH)}" fill="none" stroke="#2b6cb0" stroke-width="0.1"/>
${cardRects}
</svg>`;
  }

  function render() {
    const layout = computeLayout();
    const svgMarkup = buildSVG(layout);

    els.svgWrap.innerHTML = svgMarkup;

    els.warning.hidden = !layout.overflow;
    if (layout.overflow) {
      els.warning.textContent =
        `Grid (${layout.gridW.toFixed(1)} × ${layout.gridH.toFixed(1)} mm) is larger than the usable guide area ` +
        `(${layout.guideW.toFixed(1)} × ${layout.guideH.toFixed(1)} mm). Reduce columns/rows or spacing.`;
    }

    els.summary.innerHTML =
      `${layout.cols} × ${layout.rows} = ${layout.cols * layout.rows} cards<br>` +
      `Guide area: ${layout.guideW.toFixed(1)} × ${layout.guideH.toFixed(1)} mm<br>` +
      `Paper: ${layout.paperW.toFixed(1)} × ${layout.paperH.toFixed(1)} mm`;

    els.downloadBtn.dataset.svg = svgMarkup;
  }

  function downloadSVG() {
    const svgMarkup = els.downloadBtn.dataset.svg;
    if (!svgMarkup) return;
    const blob = new Blob([svgMarkup], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const cardW = num(els.cardW);
    const cardH = num(els.cardH);
    const cols = num(els.cols);
    const rows = num(els.rowsInput);
    a.href = url;
    a.download = `card-grid_${cardW}x${cardH}mm_${cols}x${rows}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  els.paperPreset.addEventListener('change', () => {
    applyPaperPreset();
    render();
  });

  ['paperW', 'paperH'].forEach((id) => {
    els[id].addEventListener('input', () => {
      els.paperPreset.value = 'custom';
      render();
    });
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

  els.downloadBtn.addEventListener('click', downloadSVG);

  ['cardW', 'cardH', 'radius', 'landscape', 'machineMargin', 'cols', 'rowsInput'].forEach((id) => {
    els[id].addEventListener('input', render);
    els[id].addEventListener('change', render);
  });

  applyPaperPreset();
  render();
})();
