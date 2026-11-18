/**
 * Signature dialog: draw with mouse/pen/touch or type a name. Produces a
 * tightly-cropped transparent PNG. Recent signatures are remembered locally.
 */
import { $, $$ } from './util.js';

const STORE_KEY = 'pdf-editor.signatures';
const SCRIPT_FONT = '"Segoe Script", "Brush Script MT", "Lucida Handwriting", "Snell Roundhand", cursive';

export class SignatureDialog {
  constructor(onInsert) {
    this.onInsert = onInsert;
    this.modal = $('#sig-modal');
    this.pad = $('#sig-pad');
    this.color = '#111827';
    this.mode = 'draw';
    this.strokes = [];
    this.current = null;
    this.bind();
  }

  open() {
    this.modal.hidden = false;
    this.strokes = [];
    $('#sig-text').value = '';
    this.updatePreview();
    this.setMode('draw');
    this.renderSaved();
    requestAnimationFrame(() => this.resizePad());
  }

  close() {
    this.modal.hidden = true;
  }

  get isOpen() {
    return !this.modal.hidden;
  }

  setMode(mode) {
    this.mode = mode;
    $$('.tabs [data-tab]', this.modal).forEach((b) => b.classList.toggle('active', b.dataset.tab === mode));
    $$('.tab-pane', this.modal).forEach((p) => (p.hidden = p.dataset.pane !== mode));
    if (mode === 'type') setTimeout(() => $('#sig-text').focus(), 0);
    else requestAnimationFrame(() => this.resizePad());
  }

  bind() {
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal || e.target.closest('[data-close]')) this.close();
      const tab = e.target.closest('[data-tab]');
      if (tab) this.setMode(tab.dataset.tab);
    });
    this.modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
      }
    });
    $$('#sig-colors [data-color]').forEach((b) =>
      b.addEventListener('click', () => {
        this.color = b.dataset.color;
        $$('#sig-colors [data-color]').forEach((x) => x.classList.toggle('active', x === b));
        this.redraw();
        this.updatePreview();
      }),
    );
    $('#sig-clear').addEventListener('click', () => {
      this.strokes = [];
      $('#sig-text').value = '';
      this.redraw();
      this.updatePreview();
    });
    $('#sig-text').addEventListener('input', () => this.updatePreview());
    $('#sig-text').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.insert();
    });
    $('#sig-insert').addEventListener('click', () => this.insert());

    // Drawing
    const pad = this.pad;
    const point = (e) => {
      const r = pad.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pressure || 0.5 };
    };
    pad.addEventListener('pointerdown', (e) => {
      pad.setPointerCapture(e.pointerId);
      this.current = [point(e)];
      this.strokes.push(this.current);
      this.redraw();
    });
    pad.addEventListener('pointermove', (e) => {
      if (!this.current) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      evs.forEach((ev) => this.current.push(point(ev)));
      this.redraw();
    });
    const end = () => (this.current = null);
    pad.addEventListener('pointerup', end);
    pad.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => this.isOpen && this.resizePad());
  }

  resizePad() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.pad.getBoundingClientRect();
    if (!r.width) return;
    this.pad.width = Math.round(r.width * dpr);
    this.pad.height = Math.round(r.height * dpr);
    this.redraw();
  }

  redraw() {
    const ctx = this.pad.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.pad.width, this.pad.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawStrokes(ctx, this.strokes, this.color, 1);
    $('#sig-placeholder').hidden = this.strokes.length > 0;
  }

  updatePreview() {
    const el = $('#sig-type-preview');
    el.textContent = $('#sig-text').value || 'Your signature';
    el.style.fontFamily = SCRIPT_FONT;
    el.style.color = this.color;
    el.classList.toggle('empty', !$('#sig-text').value);
  }

  /** Renders the current signature to a cropped PNG data URL, or null if empty. */
  toDataUrl() {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    if (this.mode === 'draw') {
      if (!this.strokes.length) return null;
      const r = this.pad.getBoundingClientRect();
      const k = 3; // export at 3x for crisp printing
      c.width = Math.round(r.width * k);
      c.height = Math.round(r.height * k);
      ctx.scale(k, k);
      drawStrokes(ctx, this.strokes, this.color, 1);
    } else {
      const text = $('#sig-text').value.trim();
      if (!text) return null;
      const size = 120;
      ctx.font = `${size}px ${SCRIPT_FONT}`;
      const w = Math.ceil(ctx.measureText(text).width) + size;
      c.width = w;
      c.height = Math.round(size * 2);
      ctx.font = `${size}px ${SCRIPT_FONT}`;
      ctx.fillStyle = this.color;
      ctx.textBaseline = 'middle';
      ctx.fillText(text, size / 2, c.height / 2);
    }
    return trimCanvas(c);
  }

  insert() {
    const url = this.toDataUrl();
    if (!url) {
      (this.mode === 'draw' ? this.pad : $('#sig-text')).classList.add('shake');
      setTimeout(() => $$('.shake').forEach((n) => n.classList.remove('shake')), 400);
      return;
    }
    this.remember(url);
    this.close();
    this.onInsert(url);
  }

  /* ---------------- recent signatures (localStorage) ---------------- */

  loadSaved() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    } catch {
      return [];
    }
  }

  remember(url) {
    try {
      const list = [url, ...this.loadSaved().filter((u) => u !== url)].slice(0, 4);
      localStorage.setItem(STORE_KEY, JSON.stringify(list));
    } catch {
      /* storage full or unavailable: not critical */
    }
  }

  renderSaved() {
    const list = this.loadSaved();
    const host = $('#sig-saved');
    host.replaceChildren();
    $('#sig-saved-wrap').hidden = !list.length;
    list.forEach((url, i) => {
      const item = document.createElement('div');
      item.className = 'sig-saved-item';
      const use = document.createElement('button');
      use.className = 'sig-use';
      use.dataset.tip = 'Insert this signature';
      const img = document.createElement('img');
      img.src = url;
      img.alt = 'Saved signature';
      use.appendChild(img);
      use.addEventListener('click', () => {
        this.remember(url);
        this.close();
        this.onInsert(url);
      });
      const del = document.createElement('button');
      del.className = 'sig-del';
      del.textContent = '×';
      del.dataset.tip = 'Forget';
      del.addEventListener('click', () => {
        try {
          const next = this.loadSaved().filter((_, j) => j !== i);
          localStorage.setItem(STORE_KEY, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        this.renderSaved();
      });
      item.append(use, del);
      host.appendChild(item);
    });
  }
}

function drawStrokes(ctx, strokes, color, scale) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const pts of strokes) {
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, 1.6 * scale, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.lineWidth = 2.6 * scale;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    // Smooth with quadratic curves through midpoints.
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }
}

/** Crops transparent margins (keeping a small padding) and returns a PNG data URL. */
function trimCanvas(c) {
  const { width, height } = c;
  const data = c.getContext('2d').getImageData(0, 0, width, height).data;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad);
  y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}
