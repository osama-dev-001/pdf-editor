/**
 * Contextual properties bar: shows controls for the selected objects, or for
 * the active tool when nothing is selected. Edits apply to the selection and
 * become the defaults for new objects.
 */
import { FabricText } from 'fabric';
import { $, $$, toHex, parseColor } from './util.js';
import { FONT_CSS, fontKey, isBold, isItalic } from './fonts.js';
import { on } from './state.js';

const KIND_CTX = {
  text: 'text',
  rect: 'shape',
  ellipse: 'shape',
  line: 'shape',
  arrow: 'shape',
  ink: 'draw',
  highlight: 'highlight',
  whiteout: 'whiteout',
  image: 'image',
  signature: 'image',
};

const TOOL_CTX = {
  text: 'text',
  rect: 'shape',
  ellipse: 'shape',
  line: 'shape',
  arrow: 'shape',
  draw: 'draw',
  highlight: 'highlight',
  whiteout: 'whiteout',
};

const CTX_GROUPS = {
  text: ['font', 'color', 'opacity'],
  shape: ['color', 'width', 'fill', 'opacity'],
  draw: ['color', 'width', 'opacity'],
  highlight: ['highlight', 'opacity'],
  whiteout: ['color'],
  image: ['opacity'],
};

const HINTS = {
  select: 'Click an object to select it · double-click any page text to edit it',
  editText: 'Click any text on the page to edit it',
  text: 'Click on the page where you want to add text',
  draw: 'Draw freehand on the page',
  highlight: 'Click a line of text, or drag over an area',
  rect: 'Drag to draw a rectangle · Shift for a square',
  ellipse: 'Drag to draw an ellipse · Shift for a circle',
  line: 'Drag to draw a line · Shift snaps to 45°',
  arrow: 'Drag to draw an arrow · Shift snaps to 45°',
  whiteout: 'Drag over content to cover it · covered text still exists in the file, so don’t use this to redact secrets',
};

const TOUCH_HINTS = {
  select: 'Tap an object to select it · drag to scroll · pinch to zoom',
  editText: 'Tap any text on the page to edit it',
  text: 'Tap where you want to add text',
  draw: 'Draw with one finger · two fingers to scroll or zoom',
  highlight: 'Tap a line of text or drag over an area · two fingers to scroll',
  rect: 'Drag to draw a rectangle · two fingers to scroll',
  ellipse: 'Drag to draw an ellipse · two fingers to scroll',
  line: 'Drag to draw a line · two fingers to scroll',
  arrow: 'Drag to draw an arrow · two fingers to scroll',
  whiteout: 'Drag over content to cover it (it still exists in the file) · two fingers to scroll',
};

const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches;

export function kindOf(o) {
  if (o.kind) return o.kind;
  if (o instanceof FabricText) return 'text';
  return o.isType?.('Image') ? 'image' : 'rect';
}

export class Props {
  constructor(editor) {
    this.editor = editor;
    this.ctx = null;
    this.objects = [];
    this.view = null;
    this.bind();
    on('selection', () => this.refresh());
    on('tool', () => this.refresh());
    on('document', () => this.refresh());
    this.refresh();
  }

  get settings() {
    return this.editor.settings[this.ctx];
  }

  refresh() {
    const { view, objects } = this.editor.getSelection();
    let ctx = null;
    if (objects.length) {
      const ctxs = new Set(objects.map((o) => KIND_CTX[kindOf(o)]));
      ctx = ctxs.size === 1 ? [...ctxs][0] : null;
    } else {
      ctx = TOOL_CTX[this.editor.tool] || null;
    }
    this.ctx = ctx;
    this.view = view;
    this.objects = ctx ? objects : [];

    const groups = new Set(ctx ? CTX_GROUPS[ctx] : []);
    if (ctx === 'shape') {
      const kinds = objects.length ? objects.map(kindOf) : [this.editor.tool];
      if (!kinds.some((k) => k === 'rect' || k === 'ellipse')) groups.delete('fill');
    }
    $$('[data-group]').forEach((g) => {
      g.hidden = g.dataset.group === 'actions' ? !objects.length : !groups.has(g.dataset.group);
    });
    const hint = $('#tool-hint');
    hint.textContent = (IS_TOUCH && TOUCH_HINTS[this.editor.tool]) || HINTS[this.editor.tool] || '';
    hint.hidden = groups.size > 0 || objects.length > 0 || !this.editor.hasDocument;
    if (ctx) this.fill();
  }

  /** Populates the controls from the first selected object, or the tool defaults. */
  fill() {
    const s = this.settings;
    const o = this.objects[0];
    const opacity = o ? o.opacity : s.opacity ?? 1;
    $('#p-opacity').value = opacity;
    $('#p-opacity-out').textContent = `${Math.round(opacity * 100)}%`;

    const label = { text: 'Color', shape: 'Stroke', draw: 'Color', whiteout: 'Fill' }[this.ctx] || 'Color';
    $('#p-color-label').textContent = label;

    switch (this.ctx) {
      case 'text': {
        $('#p-font').value = o ? fontKey(o.fontFamily) : s.fontFamily;
        $('#p-size').value = Math.round((o ? o.fontSize : s.fontSize) * 10) / 10;
        $('#p-bold').classList.toggle('active', o ? isBold(o.fontWeight) : s.bold);
        $('#p-italic').classList.toggle('active', o ? isItalic(o.fontStyle) : s.italic);
        $('#p-underline').classList.toggle('active', o ? !!o.underline : s.underline);
        const align = o ? o.textAlign : s.align;
        $$('[data-align]').forEach((b) => b.classList.toggle('active', b.dataset.align === align));
        $('#p-color').value = toHex(o ? o.fill : s.fill);
        break;
      }
      case 'shape':
      case 'draw': {
        $('#p-color').value = toHex(o ? o.stroke : s.stroke);
        const w = o ? o.strokeWidth : s.strokeWidth;
        $('#p-width').value = w;
        $('#p-width-out').textContent = `${w} pt`;
        if (this.ctx === 'shape') {
          const filled = o ? !!parseColor(o.fill) : s.fillOn;
          $('#p-fill-on').checked = filled;
          $('#p-fill').value = toHex(o && filled ? o.fill : s.fill);
          $('#p-fill').disabled = !filled;
        }
        break;
      }
      case 'highlight': {
        const c = toHex(o ? o.fill : s.fill);
        $$('#p-hl-swatches [data-color]').forEach((b) => b.classList.toggle('active', b.dataset.color === c));
        break;
      }
      case 'whiteout':
        $('#p-color').value = toHex(o ? o.fill : s.fill);
        break;
      default:
    }
  }

  /** Applies setting changes to the defaults and to the selected objects. */
  apply(changes, { commit = true } = {}) {
    if (!this.ctx) return;
    const s = this.settings;
    Object.assign(s, changes);
    for (const o of this.objects) {
      o.set(toObjectProps(this.ctx, changes, s, o));
      o.setCoords();
      if (o.editSession) o.editSession.touched = true;
    }
    if (this.objects.length && this.view?.canvas) {
      this.view.canvas.requestRenderAll();
      if (commit) this.view.scheduleCommit();
    }
    if (this.ctx === 'draw') for (const v of this.editor.views.values()) v.applyTool();
    this.fill();
  }

  toggle(key) {
    if (this.ctx !== 'text') return;
    const o = this.objects[0];
    const current = o ? { bold: isBold(o.fontWeight), italic: isItalic(o.fontStyle), underline: !!o.underline }[key] : this.settings[key];
    this.apply({ [key]: !current });
  }

  bind() {
    $('#p-font').addEventListener('change', (e) => this.apply({ fontFamily: e.target.value }));
    $('#p-size').addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      if (v > 0) this.apply({ fontSize: Math.min(400, v) });
    });
    $('#p-bold').addEventListener('click', () => this.toggle('bold'));
    $('#p-italic').addEventListener('click', () => this.toggle('italic'));
    $('#p-underline').addEventListener('click', () => this.toggle('underline'));
    $$('[data-align]').forEach((b) => b.addEventListener('click', () => this.apply({ align: b.dataset.align })));

    const colorKey = () => ({ text: 'fill', shape: 'stroke', draw: 'stroke', whiteout: 'fill' })[this.ctx];
    $('#p-color').addEventListener('input', (e) => this.apply({ [colorKey()]: e.target.value }, { commit: false }));
    $('#p-color').addEventListener('change', (e) => this.apply({ [colorKey()]: e.target.value }));

    $('#p-width').addEventListener('input', (e) => this.apply({ strokeWidth: parseFloat(e.target.value) }, { commit: false }));
    $('#p-width').addEventListener('change', (e) => this.apply({ strokeWidth: parseFloat(e.target.value) }));

    $('#p-fill-on').addEventListener('change', (e) => this.apply({ fillOn: e.target.checked }));
    $('#p-fill').addEventListener('input', (e) => this.apply({ fill: e.target.value, fillOn: true }, { commit: false }));
    $('#p-fill').addEventListener('change', (e) => this.apply({ fill: e.target.value, fillOn: true }));

    $('#p-opacity').addEventListener('input', (e) => this.apply({ opacity: parseFloat(e.target.value) }, { commit: false }));
    $('#p-opacity').addEventListener('change', (e) => this.apply({ opacity: parseFloat(e.target.value) }));

    $$('#p-hl-swatches [data-color]').forEach((b) => b.addEventListener('click', () => this.apply({ fill: b.dataset.color })));

    $('#a-duplicate').addEventListener('click', () => this.editor.duplicateSelection());
    $('#a-front').addEventListener('click', () => this.editor.arrange('front'));
    $('#a-back').addEventListener('click', () => this.editor.arrange('back'));
    $('#a-delete').addEventListener('click', () => this.editor.deleteSelection());
  }
}

function toObjectProps(ctx, ch, s, o) {
  const p = {};
  if (ctx === 'text') {
    if ('fontFamily' in ch) p.fontFamily = FONT_CSS[ch.fontFamily];
    if ('fontSize' in ch) p.fontSize = ch.fontSize;
    if ('bold' in ch) p.fontWeight = ch.bold ? 'bold' : 'normal';
    if ('italic' in ch) p.fontStyle = ch.italic ? 'italic' : 'normal';
    if ('underline' in ch) p.underline = ch.underline;
    if ('align' in ch) p.textAlign = ch.align;
    if ('fill' in ch) p.fill = ch.fill;
  } else if (ctx === 'shape' || ctx === 'draw') {
    if ('stroke' in ch) p.stroke = ch.stroke;
    if ('strokeWidth' in ch) p.strokeWidth = ch.strokeWidth;
    const k = kindOf(o);
    if (('fill' in ch || 'fillOn' in ch) && (k === 'rect' || k === 'ellipse')) p.fill = s.fillOn ? s.fill : 'transparent';
  } else if (ctx === 'highlight' || ctx === 'whiteout') {
    if ('fill' in ch) p.fill = ch.fill;
  }
  if ('opacity' in ch) p.opacity = ch.opacity;
  return p;
}
