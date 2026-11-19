/**
 * Pointer behaviour for each editing tool.
 */
import { IText, Rect, Ellipse, Line, Path } from 'fabric';
import { hitTestRuns, runFontInfo } from './pdf.js';
import { FONT_CSS } from './fonts.js';
import { toast } from './util.js';

const DRAG_TOOLS = new Set(['rect', 'ellipse', 'line', 'arrow', 'highlight', 'whiteout']);
/** Tools that stay active after use (others switch back to Select). */
const STICKY_TOOLS = new Set(['highlight', 'whiteout', 'draw']);

const isTouch = (e) => e?.pointerType === 'touch' || (typeof TouchEvent !== 'undefined' && e instanceof TouchEvent);

/**
 * Mobile browsers (iOS especially) only open the on-screen keyboard if an input
 * is focused during the tap itself. We focus this invisible proxy synchronously
 * in the tap, then hand focus to the real text box once it exists; the
 * keyboard stays open across the hand-off.
 */
function focusKeyboardProxy() {
  document.getElementById('keyboard-proxy')?.focus({ preventScroll: true });
}

function releaseKeyboardProxy() {
  const p = document.getElementById('keyboard-proxy');
  if (p && document.activeElement === p) p.blur();
}

export class Tools {
  constructor(editor) {
    this.editor = editor;
    this.drag = null;
  }

  get s() {
    return this.editor.settings;
  }

  /* --------------------------- pointer events --------------------------- */

  onMouseDown(view, e) {
    const tool = this.editor.tool;
    if (!DRAG_TOOLS.has(tool)) return;
    if (e.e && 'button' in e.e && e.e.button !== 0) return;
    this.drag = { view, tool, start: e.scenePoint, obj: null };
  }

  onMouseMove(view, e) {
    const d = this.drag;
    if (d && d.view === view) {
      const p = e.scenePoint;
      if (!d.obj) {
        if (Math.hypot(p.x - d.start.x, p.y - d.start.y) * this.editor.zoom < 4) return;
        d.obj = this.createShape(d.tool, d.start);
        d.obj.excludeFromExport = true; // a preview isn't part of the document until released
        view.canvas.add(d.obj);
      }
      this.updateShape(d.obj, d.tool, d.start, p, e.e?.shiftKey);
      view.canvas.requestRenderAll();
      view.hideHover();
      return;
    }
    const tool = this.editor.tool;
    if (tool === 'select' && !e.target && !isTouch(e.e) && !view.canvas._currentTransform) {
      // Pictures in the PDF can be clicked to copy them.
      if (this.editor.imagePicker.hoverHit(view, e.scenePoint)) view.canvas.setCursor('pointer');
      return;
    }
    if (tool === 'editText' || tool === 'highlight') {
      if (tool === 'editText' && e.target) return view.hideHover();
      view.getTextRuns();
      view.showHover(view.runsResolved ? hitTestRuns(view.runsResolved, e.scenePoint) : null);
    }
  }

  onMouseOut(view) {
    view.hideHover();
  }

  /** Abandons an in-progress drag (e.g. when a two-finger gesture starts). */
  cancelInteraction() {
    const d = this.drag;
    this.drag = null;
    if (d?.obj && d.view.canvas) {
      d.view.canvas.remove(d.obj);
      d.view.canvas.requestRenderAll();
    }
    for (const v of this.editor.views.values()) v.hideHover();
  }

  onMouseUp(view, e) {
    if (view.gestureTainted) {
      this.drag = null; // this finger was part of a pinch, not a tap
      return;
    }
    const tool = this.editor.tool;
    const d = this.drag;
    if (d) {
      this.drag = null;
      if (d.view !== view) return;
      if (d.obj) this.finishShape(view, d, e.scenePoint);
      else this.clickWithShapeTool(view, d.tool, d.start);
      return;
    }
    if (!e.isClick) return;
    const touch = isTouch(e.e);
    if (tool === 'select') {
      // Clicking a picture in the PDF selects it (for Copy / Save image).
      if (!e.target && !view.selectedAtPointerDown) this.editor.imagePicker.selectAt(view, e.scenePoint);
      else this.editor.imagePicker.clear();
      return;
    }
    if (tool === 'text' && !(e.target instanceof IText)) {
      if (touch) focusKeyboardProxy();
      // Defer so Fabric finishes its own mouse-up handling first.
      const p = e.scenePoint;
      setTimeout(() => this.addText(view, p), 0);
    } else if (tool === 'editText' && !e.target) {
      // Only summon the keyboard if there's text under the finger (or we can't tell yet).
      if (touch && (!view.runsResolved || hitTestRuns(view.runsResolved, e.scenePoint, 6))) focusKeyboardProxy();
      this.editTextAt(view, e.scenePoint, { tolerance: touch ? 6 : 2 });
    }
  }

  onDoubleClick(view, e) {
    // Shortcut: double-clicking page text with the Select tool edits it.
    if (this.editor.tool === 'select' && !e.target) this.editTextAt(view, e.scenePoint, { quiet: true });
  }

  onPathCreated(view, path) {
    if (view.gestureTainted) {
      // Stroke made by a finger that turned into a pinch: drop it.
      view.canvas.remove(path);
      return;
    }
    path.set({
      kind: 'ink',
      strokeUniform: true,
      opacity: this.s.draw.opacity,
      strokeLineCap: 'round',
      strokeLineJoin: 'round',
    });
  }

  /* --------------------------- shapes --------------------------- */

  shapeStyle(closed) {
    const sh = this.s.shape;
    return {
      stroke: sh.stroke,
      strokeWidth: sh.strokeWidth,
      fill: closed && sh.fillOn ? sh.fill : 'transparent',
      opacity: sh.opacity,
      strokeUniform: true,
      strokeLineJoin: 'round',
    };
  }

  createShape(tool, p) {
    const box = { originX: 'left', originY: 'top', left: p.x, top: p.y };
    switch (tool) {
      case 'rect':
        return new Rect({ ...box, width: 1, height: 1, ...this.shapeStyle(true), kind: 'rect' });
      case 'ellipse':
        return new Ellipse({ ...box, rx: 0.5, ry: 0.5, ...this.shapeStyle(true), kind: 'ellipse' });
      case 'line':
      case 'arrow':
        return new Line([p.x, p.y, p.x, p.y], { ...this.shapeStyle(false), strokeLineCap: 'round', kind: tool });
      case 'highlight':
        return new Rect({
          ...box,
          width: 1,
          height: 1,
          fill: this.s.highlight.fill,
          opacity: this.s.highlight.opacity,
          strokeWidth: 0,
          globalCompositeOperation: 'multiply',
          kind: 'highlight',
        });
      case 'whiteout':
        return new Rect({ ...box, width: 1, height: 1, fill: this.s.whiteout.fill, strokeWidth: 0, kind: 'whiteout' });
      default:
        throw new Error(`Unknown shape ${tool}`);
    }
  }

  updateShape(obj, tool, a, b, shift) {
    if (tool === 'line' || tool === 'arrow') {
      let { x, y } = b;
      if (shift) {
        // Snap to 45° increments.
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 4)) * (Math.PI / 4);
        x = a.x + len * Math.cos(ang);
        y = a.y + len * Math.sin(ang);
      }
      obj.set({ x2: x, y2: y });
      obj.setCoords();
      return;
    }
    let w = Math.abs(b.x - a.x);
    let h = Math.abs(b.y - a.y);
    if (shift && (tool === 'rect' || tool === 'ellipse')) w = h = Math.max(w, h);
    const left = b.x < a.x ? a.x - w : a.x;
    const top = b.y < a.y ? a.y - h : a.y;
    if (tool === 'ellipse') obj.set({ left, top, rx: w / 2, ry: h / 2 });
    else obj.set({ left, top, width: w, height: h });
    obj.setCoords();
  }

  makeArrow(x1, y1, x2, y2) {
    const st = this.shapeStyle(false);
    const head = Math.max(9, st.strokeWidth * 3.5);
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const spread = Math.PI / 7;
    const hx1 = x2 - head * Math.cos(ang - spread);
    const hy1 = y2 - head * Math.sin(ang - spread);
    const hx2 = x2 - head * Math.cos(ang + spread);
    const hy2 = y2 - head * Math.sin(ang + spread);
    const d = `M ${x1} ${y1} L ${x2} ${y2} M ${hx1} ${hy1} L ${x2} ${y2} L ${hx2} ${hy2}`;
    return new Path(d, { ...st, fill: '', strokeLineCap: 'round', kind: 'arrow' });
  }

  finishShape(view, d) {
    const c = view.canvas;
    let obj = d.obj;
    if (d.tool === 'arrow') {
      c.remove(obj);
      obj = this.makeArrow(obj.x1, obj.y1, obj.x2, obj.y2);
      c.add(obj);
    }
    obj.excludeFromExport = false;
    obj.setCoords();
    view.scheduleCommit();
    this.afterCreate(view, obj, d.tool);
  }

  /** A click (no drag) with a shape tool. */
  async clickWithShapeTool(view, tool, p) {
    const c = view.canvas;
    if (tool === 'highlight') {
      const runs = await view.getTextRuns();
      const run = hitTestRuns(runs, p);
      if (!run) return;
      const pad = run.size * 0.06;
      const hl = this.createShape('highlight', p);
      hl.set({
        left: run.tlx - run.cos * pad + run.sin * pad,
        top: run.tly - run.sin * pad - run.cos * pad,
        width: run.width + pad * 2,
        height: run.height + pad * 2,
        angle: (run.angle * 180) / Math.PI,
      });
      hl.setCoords();
      c.add(hl);
      c.requestRenderAll();
      return;
    }
    if (tool === 'whiteout') return;
    let obj;
    if (tool === 'line') obj = new Line([p.x - 60, p.y, p.x + 60, p.y], { ...this.shapeStyle(false), strokeLineCap: 'round', kind: 'line' });
    else if (tool === 'arrow') obj = this.makeArrow(p.x - 60, p.y, p.x + 60, p.y);
    else {
      obj = this.createShape(tool, { x: p.x - 60, y: p.y - 40 });
      if (tool === 'ellipse') obj.set({ rx: 60, ry: 40 });
      else obj.set({ width: 120, height: 80 });
    }
    obj.setCoords();
    c.add(obj);
    this.afterCreate(view, obj, tool);
  }

  afterCreate(view, obj, tool) {
    if (STICKY_TOOLS.has(tool)) return;
    this.editor.setTool('select');
    view.canvas.setActiveObject(obj);
    view.canvas.requestRenderAll();
  }

  /* --------------------------- text --------------------------- */

  addText(view, p) {
    if (!view.canvas) return;
    const s = this.s.text;
    const t = new IText('', {
      originX: 'left',
      originY: 'top',
      left: p.x,
      top: p.y - s.fontSize * 0.6,
      fontSize: s.fontSize,
      fontFamily: FONT_CSS[s.fontFamily],
      fontWeight: s.bold ? 'bold' : 'normal',
      fontStyle: s.italic ? 'italic' : 'normal',
      underline: s.underline,
      fill: s.fill,
      textAlign: s.align,
      opacity: s.opacity,
      strokeWidth: 0,
      kind: 'text',
      excludeFromExport: true, // becomes part of the document once it has content
    });
    t.editSession = { isNew: true };
    view.canvas.add(t);
    this.editor.setTool('select');
    this.beginEditing(view, t);
  }

  beginEditing(view, t, selectAll = false) {
    const c = view.canvas;
    c.setActiveObject(t);
    t.enterEditing();
    if (selectAll) t.selectAll();
    t.hiddenTextarea?.focus();
    c.requestRenderAll();
  }

  /**
   * "Edit text": covers the original text with a patch of the page's background
   * color and puts an editable copy on top in the closest matching font.
   */
  async editTextAt(view, p, { quiet = false, tolerance = 2 } = {}) {
    const runs = await view.getTextRuns();
    const c = view.canvas;
    if (!c) return releaseKeyboardProxy();
    const run = hitTestRuns(runs, p, tolerance);
    if (!run) {
      releaseKeyboardProxy();
      if (!quiet) {
        toast(
          runs.length
            ? 'No text there. Click directly on a line of text, or use Add text.'
            : 'This page has no editable text (it may be a scanned image). Use Whiteout + Add text instead.',
          'info',
          4200,
        );
      }
      return;
    }
    if (quiet) this.editor.setTool('select');
    const { bg, fg } = sampleColors(view, run);
    const font = runFontInfo(view.pdfPage, run);
    const deg = (run.angle * 180) / Math.PI;
    const pad = Math.max(1, run.size * 0.1);

    const cover = new Rect({
      originX: 'left',
      originY: 'top',
      left: run.tlx - run.cos * pad + run.sin * pad,
      top: run.tly - run.sin * pad - run.cos * pad,
      width: run.width + pad * 2,
      height: run.height + pad * 2,
      angle: deg,
      fill: bg,
      strokeWidth: 0,
      kind: 'whiteout',
      excludeFromExport: true,
    });

    const text = new IText(run.str, {
      originX: 'left',
      originY: 'top',
      fontSize: run.size,
      fontFamily: FONT_CSS[font.family],
      fontWeight: font.bold ? 'bold' : 'normal',
      fontStyle: font.italic ? 'italic' : 'normal',
      fill: fg,
      angle: deg,
      strokeWidth: 0,
      kind: 'text',
      excludeFromExport: true,
    });
    // Put the new text's baseline exactly on the original baseline.
    const baseline = text.fontSize * text._fontSizeMult * (1 - text._fontSizeFraction);
    text.set({ left: run.ox + run.sin * baseline, top: run.oy - run.cos * baseline });
    text.setCoords();
    text.editSession = { cover, original: run.str };

    c.add(cover, text);
    view.hideHover();
    this.beginEditing(view, text, true);
  }

  onTextEditingExited(view, t) {
    const sess = t.editSession;
    t.editSession = null;
    let remove = [];
    if (sess?.cover) {
      if (!sess.touched && t.text === sess.original) remove = [t, sess.cover]; // unchanged: restore original
      else sess.cover.excludeFromExport = false;
    }
    if (!remove.length) {
      if (!t.text.trim()) remove = [t];
      else t.excludeFromExport = false;
    }
    // Exclude now (so the commit below is correct) and remove after Fabric
    // finishes its exit-editing work — removing inside this event breaks it.
    remove.forEach((o) => (o.excludeFromExport = true));
    view.scheduleCommit();
    if (remove.length) {
      const c = view.canvas;
      setTimeout(() => {
        if (view.canvas !== c) return;
        const present = remove.filter((o) => c.contains(o));
        if (present.length) c.remove(...present);
        c.requestRenderAll();
      }, 0);
    }
  }
}

/**
 * Samples the rendered page under a text run: the dominant border color is the
 * background, and the pixel that contrasts most with it is the text color.
 */
function sampleColors(view, run) {
  const fallback = { bg: '#ffffff', fg: '#000000' };
  const pc = view.pdfCanvas;
  if (!pc) return fallback;
  const k = pc.width / view.size.width;
  const corners = [
    [run.tlx, run.tly],
    [run.tlx + run.cos * run.width, run.tly + run.sin * run.width],
    [run.tlx - run.sin * run.height, run.tly + run.cos * run.height],
    [run.tlx + run.cos * run.width - run.sin * run.height, run.tly + run.sin * run.width + run.cos * run.height],
  ];
  const xs = corners.map((q) => q[0] * k);
  const ys = corners.map((q) => q[1] * k);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 2);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 2);
  const x1 = Math.min(pc.width, Math.ceil(Math.max(...xs)) + 2);
  const y1 = Math.min(pc.height, Math.ceil(Math.max(...ys)) + 2);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 2 || h < 2) return fallback;
  let data;
  try {
    data = pc.getContext('2d').getImageData(x0, y0, w, h).data;
  } catch {
    return fallback;
  }
  const px = (x, y) => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const counts = new Map();
  const vote = (x, y) => {
    const [r, g, b] = px(x, y);
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const e = counts.get(key);
    if (e) e.n++;
    else counts.set(key, { n: 1, rgb: [r, g, b] });
  };
  for (let x = 0; x < w; x++) {
    vote(x, 0);
    vote(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    vote(0, y);
    vote(w - 1, y);
  }
  let best = null;
  for (const e of counts.values()) if (!best || e.n > best.n) best = e;
  const bgc = best.rgb;
  let fgc = null;
  let maxD = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = px(x, y);
      const dist = Math.abs(c[0] - bgc[0]) + Math.abs(c[1] - bgc[1]) + Math.abs(c[2] - bgc[2]);
      if (dist > maxD) {
        maxD = dist;
        fgc = c;
      }
    }
  }
  const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  return {
    bg: hex(bgc),
    fg: fgc && maxD > 90 ? hex(fgc) : lum(bgc) > 128 ? '#000000' : '#ffffff',
  };
}
