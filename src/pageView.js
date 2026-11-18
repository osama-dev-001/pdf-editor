/**
 * One page on screen: a Fabric canvas whose background is the pdf.js render
 * of the page, with the user's edits as Fabric objects on top.
 *
 * Views are mounted lazily (when scrolled near) and unmounted when far away,
 * so large documents stay light. The page record's `data` is always the
 * source of truth; the live canvas is written back to it on every change.
 */
import { Canvas, FabricImage, PencilBrush, Point, util } from 'fabric';
import { displaySize, totalRotation, serializeCanvas, hydrateObjects } from './state.js';
import { extractTextRuns, isCancelled } from './pdf.js';

const MAX_RENDER_PIXELS = 16_000_000;
/** Tools where one finger scrolls the page (unless it lands on an object). */
export const PANNABLE_TOOLS = new Set(['select', 'text', 'editText']);

export class PageView {
  constructor(editor, rec) {
    this.editor = editor;
    this.rec = rec;
    this.el = document.createElement('div');
    this.el.className = 'page';
    this.el.dataset.id = rec.id;
    this.mounted = false;
    this.canvas = null;
    this.pdfCanvas = null;
    this.pdfPage = null;
    this.renderTask = null;
    this.renderToken = 0;
    this.loadToken = 0;
    this.loading = false;
    this.commitQueued = false;
    this.json = '';
    this.loadedData = null;
    this.runsKey = null;
    this.runs = null;
    this.runsResolved = null;
    this.updateSize();
  }

  get size() {
    return displaySize(this.rec);
  }

  updateSize() {
    const { width, height } = this.size;
    const z = this.editor.zoom;
    const w = Math.round(width * z);
    const h = Math.round(height * z);
    this.el.style.width = `${w}px`;
    this.el.style.height = `${h}px`;
    if (this.canvas) {
      this.canvas.setDimensions({ width: w, height: h });
      this.canvas.setZoom(z);
      this.canvas.calcOffset();
      this.canvas.requestRenderAll();
    }
  }

  async mount() {
    if (this.mounted) return;
    this.mounted = true;
    const el = document.createElement('canvas');
    this.el.appendChild(el);
    const { width, height } = this.size;
    const z = this.editor.zoom;
    const c = (this.canvas = new Canvas(el, {
      width: Math.round(width * z),
      height: Math.round(height * z),
      preserveObjectStacking: true,
      selectionColor: 'rgba(37, 99, 235, 0.08)',
      selectionBorderColor: 'rgba(37, 99, 235, 0.8)',
      selectionLineWidth: 1,
      targetFindTolerance: 4,
      stopContextMenu: true,
      enablePointerEvents: true,
    }));
    c.setZoom(z);
    this.hoverEl = document.createElement('div');
    this.hoverEl.className = 'text-hover';
    this.hoverEl.hidden = true;
    this.el.appendChild(this.hoverEl);
    this.bindEvents();
    this.bindTouch();
    this.applyTool();
    await Promise.all([this.renderPdf(), this.loadObjects()]);
  }

  unmount() {
    if (!this.mounted) return;
    this.flush();
    this.mounted = false;
    this.renderToken++;
    this.loadToken++;
    this.renderTask?.cancel();
    this.renderTask = null;
    const c = this.canvas;
    this.canvas = null;
    c.dispose().catch(() => {});
    this.el.replaceChildren();
    this.pdfCanvas = null;
    this.hoverEl = null;
    if (this.editor.activeView === this) {
      this.editor.activeView = null;
      this.editor.onViewLoaded(); // refreshes the properties bar
    }
  }

  destroy() {
    this.unmount();
  }

  /** Called when the page record changed (undo/redo, rotation, external edits). */
  setRecord(rec) {
    const old = this.rec;
    this.rec = rec;
    const geometryChanged = old.rotation !== rec.rotation || old.view !== rec.view || old.baseRotation !== rec.baseRotation;
    if (geometryChanged) {
      this.runsKey = null;
      this.updateSize();
    }
    if (!this.mounted) return;
    if (geometryChanged) this.renderPdf();
    if (rec.data !== this.loadedData) this.loadObjects();
  }

  /* --------------------------- rendering --------------------------- */

  async renderPdf() {
    if (!this.canvas) return;
    const token = ++this.renderToken;
    this.renderTask?.cancel();
    this.renderTask = null;
    const { width, height } = this.size;
    let scale = this.editor.zoom * (window.devicePixelRatio || 1);
    scale = Math.min(scale, Math.sqrt(MAX_RENDER_PIXELS / (width * height)));
    const pc = document.createElement('canvas');
    const ctx = pc.getContext('2d');

    if (!this.rec.srcId) {
      pc.width = Math.ceil(width * scale);
      pc.height = Math.ceil(height * scale);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, pc.width, pc.height);
    } else {
      const page = await this.editor.getPdfPage(this.rec);
      if (token !== this.renderToken || !this.canvas) return;
      this.pdfPage = page;
      const viewport = page.getViewport({ scale, rotation: totalRotation(this.rec) });
      pc.width = Math.ceil(viewport.width);
      pc.height = Math.ceil(viewport.height);
      this.renderTask = page.render({ canvasContext: ctx, viewport });
      try {
        await this.renderTask.promise;
      } catch (err) {
        if (!isCancelled(err)) console.error('Render failed', err);
        return;
      }
      if (token !== this.renderToken || !this.canvas) return;
      this.renderTask = null;
    }

    this.pdfCanvas = pc;
    this.canvas.backgroundImage = new FabricImage(pc, {
      left: 0,
      top: 0,
      originX: 'left',
      originY: 'top',
      scaleX: width / pc.width,
      scaleY: height / pc.height,
      excludeFromExport: true,
      selectable: false,
      evented: false,
      objectCaching: false,
    });
    this.canvas.requestRenderAll();
  }

  async loadObjects() {
    const token = ++this.loadToken;
    const data = this.rec.data;
    const objs = data.objects.length ? await util.enlivenObjects(hydrateObjects(data.objects)) : [];
    if (token !== this.loadToken || !this.canvas) return;
    const c = this.canvas;
    this.loading = true;
    try {
      c.discardActiveObject();
      c.remove(...c.getObjects());
      if (objs.length) c.add(...objs);
    } finally {
      this.loading = false;
    }
    this.loadedData = data;
    this.json = JSON.stringify(serializeCanvas(c));
    c.requestRenderAll();
    this.editor.onViewLoaded(this);
  }

  /* --------------------------- editing --------------------------- */

  bindEvents() {
    const c = this.canvas;
    const tools = this.editor.tools;
    c.on('object:added', () => this.scheduleCommit());
    c.on('object:removed', () => this.scheduleCommit());
    c.on('object:modified', () => this.scheduleCommit());
    c.on('path:created', (e) => tools.onPathCreated(this, e.path));
    c.on('text:editing:exited', (e) => tools.onTextEditingExited(this, e.target));
    c.on('selection:created', () => this.editor.onSelectionChanged(this));
    c.on('selection:updated', () => this.editor.onSelectionChanged(this));
    c.on('selection:cleared', () => this.editor.onSelectionChanged(this));
    c.on('mouse:down', (e) => tools.onMouseDown(this, e));
    c.on('mouse:move', (e) => tools.onMouseMove(this, e));
    c.on('mouse:up', (e) => tools.onMouseUp(this, e));
    c.on('mouse:out', () => tools.onMouseOut(this));
    c.on('mouse:dblclick', (e) => tools.onDoubleClick(this, e));
  }

  /**
   * Touch handling. With the Select/Text/Edit tools a finger drag scrolls the
   * document (native, with momentum) unless it starts on an object or handle,
   * in which case we block scrolling so the object can be dragged. With drawing
   * tools, one finger draws; two-finger pinch/pan is handled in gestures.js.
   */
  bindTouch() {
    const c = this.canvas;
    c.upperCanvasEl.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length !== 1 || !PANNABLE_TOOLS.has(this.editor.tool)) return;
        if (this.touchHitsObject(e.touches[0])) e.preventDefault();
      },
      { passive: false },
    );
    // Runs before Fabric's own pointerdown handler: no rubber-band selection
    // for touch, since a finger drag on empty space means "scroll".
    this.el.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.canvas) return;
        this.canvas.selection = e.pointerType !== 'touch' && this.editor.tool === 'select';
        if (e.isPrimary) this.gestureTainted = false;
      },
      { capture: true },
    );
  }

  touchHitsObject(touch) {
    const c = this.canvas;
    if (!c) return false;
    const r = c.upperCanvasEl.getBoundingClientRect();
    const vp = new Point(touch.clientX - r.left, touch.clientY - r.top);
    const z = this.editor.zoom;
    const scene = new Point(vp.x / z, vp.y / z);
    const active = c.getActiveObject();
    if (active && (active.findControl(vp, true) || active.containsPoint(scene))) return true;
    return c.getObjects().some((o) => o.visible && o.evented && o.selectable && o.containsPoint(scene));
  }

  applyTool() {
    const c = this.canvas;
    if (!c) return;
    const tool = this.editor.tool;
    const s = this.editor.settings;
    const touchAction = PANNABLE_TOOLS.has(tool) ? 'pan-x pan-y' : 'none';
    for (const el of [c.upperCanvasEl, c.lowerCanvasEl, c.wrapperEl]) el.style.touchAction = touchAction;
    if (tool === 'editText' || tool === 'highlight') this.getTextRuns(); // warm up for instant taps
    c.isDrawingMode = tool === 'draw';
    if (tool === 'draw') {
      const brush = new PencilBrush(c);
      brush.color = s.draw.stroke;
      brush.width = s.draw.strokeWidth;
      brush.decimate = 0.6;
      c.freeDrawingBrush = brush;
    }
    const interactive = tool === 'select' || tool === 'text' || tool === 'editText';
    c.selection = tool === 'select';
    c.skipTargetFind = !interactive;
    const cursor = { select: 'default', text: 'text', editText: 'text' }[tool] || 'crosshair';
    c.defaultCursor = cursor;
    c.hoverCursor = tool === 'select' ? 'move' : cursor;
    if (!interactive && c.getActiveObject()) {
      c.discardActiveObject();
      c.requestRenderAll();
    }
    if (tool !== 'editText' && tool !== 'highlight') this.hideHover();
  }

  scheduleCommit() {
    if (this.loading || this.commitQueued) return;
    this.commitQueued = true;
    queueMicrotask(() => {
      this.commitQueued = false;
      this.flush();
    });
  }

  /** Writes the canvas back into the page record (one undo step) if anything changed. */
  flush() {
    if (!this.canvas || this.loading) return;
    const data = serializeCanvas(this.canvas);
    const json = JSON.stringify(data);
    if (json === this.json) return;
    this.json = json;
    this.loadedData = data;
    this.rec = { ...this.rec, data };
    this.editor.onPageEdited(this.rec);
  }

  /* --------------------------- text runs --------------------------- */

  /** Lines of existing PDF text on this page, in scene coordinates. Cached per rotation. */
  getTextRuns() {
    const key = totalRotation(this.rec);
    if (this.runsKey !== key) {
      this.runsKey = key;
      this.runsResolved = null;
      this.runs = (async () => {
        if (!this.rec.srcId) return [];
        const page = await this.editor.getPdfPage(this.rec);
        const runs = await extractTextRuns(page, key);
        if (this.runsKey === key) this.runsResolved = runs;
        return runs;
      })().catch((err) => {
        console.warn('Text extraction failed', err);
        return [];
      });
    }
    return this.runs;
  }

  showHover(run) {
    if (!this.hoverEl) return;
    if (!run) return this.hideHover();
    const z = this.editor.zoom;
    const s = this.hoverEl.style;
    s.left = `${run.tlx * z}px`;
    s.top = `${run.tly * z}px`;
    s.width = `${run.width * z}px`;
    s.height = `${run.height * z}px`;
    s.transform = `rotate(${run.angle}rad)`;
    this.hoverEl.hidden = false;
  }

  hideHover() {
    if (this.hoverEl) this.hoverEl.hidden = true;
  }
}
