// Card line-art editor page: hosts the shared PnPTools vector editor
// (shared/pnp-editor.js) and adds what is specific to PnPCut — card size,
// reference image, templates, the .json card project and per-layer export.

(() => {
  const $ = (id) => document.getElementById(id);

  const LAYERS = [
    { id: 'cut', label: 'Cut', color: '#c0392b' },
    { id: 'score', label: 'Score/Fold', color: '#e08e0b' },
    { id: 'emboss', label: 'Emboss', color: '#2e8b57' },
  ];

  const cardSize = () => ({ w: parseFloat($('cardW').value) || 63, h: parseFloat($('cardH').value) || 88 });

  const editor = PnPEditor.create({
    stage: $('editorStage'),
    props: $('editorProps'),
    options: $('editorOptions'),
    layers: LAYERS,
    docSize: cardSize(),
    viewKey: 'pnp:PnPCut-editor:view',
    importSvg: true,
  });

  // ---------- card size / reference image ----------

  ['cardW', 'cardH'].forEach((id) => $(id).addEventListener('change', () => {
    const { w, h } = cardSize();
    editor.setDocSize(w, h);
  }));

  $('imageInput').addEventListener('change', () => {
    const file = $('imageInput').files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => editor.setImage(reader.result);
    reader.readAsDataURL(file);
  });

  $('imageVisible').addEventListener('change', () => editor.setImageVisible($('imageVisible').checked));

  // ---------- export ----------

  function downloadSVG(layers, suffix) {
    const { w, h } = cardSize();
    const markup = editor.exportSvg(layers, $('mirrorExport').checked);
    PnP.downloadBlob(new Blob([markup], { type: 'image/svg+xml' }), `card_${w}x${h}mm_${suffix}.svg`);
  }

  $('exportAllBtn').addEventListener('click', () => downloadSVG(['cut', 'score', 'emboss'], 'all'));
  $('exportCutBtn').addEventListener('click', () => downloadSVG(['cut'], 'cut'));
  $('exportScoreBtn').addEventListener('click', () => downloadSVG(['score'], 'score'));
  $('exportEmbossBtn').addEventListener('click', () => downloadSVG(['emboss'], 'emboss'));

  // ---------- card project (.json, also read by the sheet assembler) ----------

  let savedShapes = JSON.stringify(editor.getShapes());

  $('saveProjectBtn').addEventListener('click', () => {
    const { w, h } = cardSize();
    const project = {
      cardW: w,
      cardH: h,
      imageDataUrl: editor.state.imageDataUrl,
      shapes: editor.getShapes(),
      nextId: editor.state.nextId,
      layerColors: editor.layerColors,
      guides: editor.guides,
    };
    PnP.downloadBlob(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }), `card-project_${w}x${h}mm.json`);
    savedShapes = JSON.stringify(editor.getShapes());
  });

  $('loadProjectInput').addEventListener('change', async () => {
    const file = $('loadProjectInput').files[0];
    $('loadProjectInput').value = '';
    if (!file) return;
    try {
      const project = JSON.parse(await file.text());
      $('cardW').value = project.cardW;
      $('cardH').value = project.cardH;
      editor.setDocSize(project.cardW, project.cardH);
      editor.setImage(project.imageDataUrl || null);
      editor.setLayerColors(project.layerColors);
      editor.setGuides(project.guides);
      editor.setShapes(project.shapes || [], { resetHistory: true });
      savedShapes = JSON.stringify(editor.getShapes());
    } catch (err) {
      PnP.toast(`Could not open the project: ${err.message}`, 'error');
    }
  });

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
      const nodes = [];
      for (let i = 0; i < 6; i++) {
        const a = ((-90 + 60 * i) * Math.PI) / 180;
        nodes.push({ fx: 0.5 + (R * Math.cos(a)) / w, fy: 0.5 + (R * Math.sin(a)) / h });
      }
      return [{ type: 'path', closed: true, layer: 'cut', x: (W - w) / 2, y: (H - h) / 2, w, h, nodes }];
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
    const { w, h } = cardSize();
    editor.addShapes(make(w, h));
  });

  // ---------- Shared PnPTools wiring ----------

  PnP.bindPreset($('cardPreset'), $('cardW'), $('cardH'), 'card');
  PnP.init({
    tool: 'PnPCut',
    settingsKey: 'PnPCut-editor',
    hasUnsavedWork: () => {
      const shapes = editor.getShapes();
      return shapes.length > 0 && JSON.stringify(shapes) !== savedShapes;
    },
  });
  // Restored settings may have changed the card size.
  editor.setDocSize(cardSize().w, cardSize().h);
})();
