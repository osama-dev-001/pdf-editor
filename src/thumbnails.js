/**
 * Sidebar page thumbnails: navigation, drag-to-reorder, and per-page actions.
 * Thumbnails include the user's edits, re-composited (cheaply) after each change.
 */
import { StaticCanvas, FabricImage, util } from 'fabric';
import { createElement, RotateCcw, RotateCw, CopyPlus, Trash2, ArrowUp, ArrowDown } from 'lucide';
import { doc, displaySize, totalRotation, hydrateObjects } from './state.js';

const THUMB_W = 112;

const baseKey = (rec) => `${rec.srcId}:${rec.srcIndex}:${totalRotation(rec)}:${rec.view.join(',')}`;

function actionButton(act, icon, tip, className = '') {
  const b = document.createElement('button');
  b.dataset.act = act;
  b.dataset.tip = tip;
  b.setAttribute('aria-label', tip);
  if (className) b.className = className;
  b.appendChild(createElement(icon));
  return b;
}

export class Thumbnails {
  constructor(editor, el) {
    this.editor = editor;
    this.el = el;
    this.items = new Map();
    this.queue = new Set();
    this.running = false;
    this.timer = null;
    this.dragId = null;
    el.addEventListener('click', (e) => this.onClick(e));
    this.bindDragAndDrop();
  }

  reset() {
    this.items.clear();
    this.queue.clear();
    this.el.replaceChildren();
  }

  sync() {
    const seen = new Set();
    doc.pages.forEach((rec, i) => {
      let it = this.items.get(rec.id);
      if (!it) {
        it = this.create(rec);
        this.items.set(rec.id, it);
        this.enqueue(it);
      } else if (it.rec !== rec) {
        it.rec = rec;
        this.sizeFrame(it);
        this.enqueue(it);
      }
      it.index = i;
      it.num.textContent = String(i + 1);
      const ref = this.el.children[i];
      if (ref !== it.el) this.el.insertBefore(it.el, ref || null);
      seen.add(rec.id);
    });
    for (const [id, it] of this.items) {
      if (!seen.has(id)) {
        it.el.remove();
        this.items.delete(id);
        this.queue.delete(it);
      }
    }
    this.setCurrent(this.editor.currentIndex);
  }

  /** A page's edits changed. */
  refresh(rec) {
    const it = this.items.get(rec.id);
    if (!it) return;
    it.rec = rec;
    this.enqueue(it, 350);
  }

  setCurrent(index) {
    for (const it of this.items.values()) {
      const cur = it.index === index;
      it.el.classList.toggle('current', cur);
      if (cur && !this.dragId) it.el.scrollIntoView({ block: 'nearest' });
    }
  }

  create(rec) {
    const el = document.createElement('div');
    el.className = 'thumb';
    el.draggable = true;
    el.dataset.id = rec.id;
    const frame = document.createElement('div');
    frame.className = 'thumb-frame';
    const actions = document.createElement('div');
    actions.className = 'thumb-actions';
    actions.append(
      // Touch screens can't drag-and-drop, so they get move buttons instead.
      actionButton('up', ArrowUp, 'Move page up', 'touch-only'),
      actionButton('down', ArrowDown, 'Move page down', 'touch-only'),
      actionButton('rotl', RotateCcw, 'Rotate left'),
      actionButton('rotr', RotateCw, 'Rotate right'),
      actionButton('dup', CopyPlus, 'Duplicate page'),
      actionButton('del', Trash2, 'Delete page'),
    );
    const num = document.createElement('div');
    num.className = 'thumb-num';
    el.append(frame, actions, num);
    const it = { el, frame, num, rec, base: null, baseKey: '', index: 0 };
    this.sizeFrame(it);
    return it;
  }

  sizeFrame(it) {
    const { width, height } = displaySize(it.rec);
    const h = Math.round((THUMB_W * height) / width);
    it.frame.style.width = `${THUMB_W}px`;
    it.frame.style.height = `${h}px`;
    it.el.style.setProperty('--frame-h', `${h}px`); // lets CSS overlay the action bar on the frame
  }

  enqueue(it, delay = 30) {
    this.queue.add(it);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.pump(), delay);
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.size) {
        const it = this.queue.values().next().value;
        this.queue.delete(it);
        if (this.items.get(it.rec.id) !== it) continue;
        try {
          await this.render(it);
        } catch (err) {
          console.warn('Thumbnail render failed', err);
        }
      }
    } finally {
      this.running = false;
    }
  }

  async render(it) {
    const rec = it.rec;
    const { width, height } = displaySize(rec);
    const s = THUMB_W / width;
    const th = Math.max(1, Math.round(height * s));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.round(THUMB_W * dpr);
    const ph = Math.round(th * dpr);

    if (!it.base || it.baseKey !== baseKey(rec)) {
      const base = document.createElement('canvas');
      base.width = pw;
      base.height = ph;
      const bctx = base.getContext('2d');
      bctx.fillStyle = '#fff';
      bctx.fillRect(0, 0, pw, ph);
      if (rec.srcId) {
        const page = await this.editor.getPdfPage(rec);
        const viewport = page.getViewport({ scale: s * dpr, rotation: totalRotation(rec) });
        await page.render({ canvasContext: bctx, viewport }).promise;
      }
      it.base = base;
      it.baseKey = baseKey(rec);
    }

    let out = it.base;
    if (rec.data.objects.length) {
      // Composite edits over the page (StaticCanvas so highlights can multiply).
      const el = document.createElement('canvas');
      const sc = new StaticCanvas(el, { width: pw, height: ph, enableRetinaScaling: false, renderOnAddRemove: false });
      sc.backgroundImage = new FabricImage(it.base, {
        originX: 'left',
        originY: 'top',
        left: 0,
        top: 0,
        scaleX: 1 / (s * dpr),
        scaleY: 1 / (s * dpr),
      });
      sc.setZoom(s * dpr);
      const objs = await util.enlivenObjects(hydrateObjects(rec.data.objects));
      sc.add(...objs);
      sc.renderAll();
      out = document.createElement('canvas');
      out.width = pw;
      out.height = ph;
      out.getContext('2d').drawImage(el, 0, 0);
      sc.backgroundImage = undefined; // keep the cached base canvas alive
      sc.dispose();
    } else {
      out = document.createElement('canvas');
      out.width = pw;
      out.height = ph;
      out.getContext('2d').drawImage(it.base, 0, 0);
    }
    if (it.rec !== rec) return; // a newer version is queued
    out.className = 'thumb-canvas';
    out.style.width = `${THUMB_W}px`;
    out.style.height = `${th}px`;
    it.frame.querySelector('.thumb-canvas')?.remove();
    it.frame.prepend(out);
  }

  onClick(e) {
    const t = e.target.closest('.thumb');
    if (!t) return;
    const it = this.items.get(t.dataset.id);
    if (!it) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    const ed = this.editor;
    if (act === 'rotl') ed.rotatePage(it.index, -90);
    else if (act === 'rotr') ed.rotatePage(it.index, 90);
    else if (act === 'dup') ed.duplicatePage(it.index);
    else if (act === 'del') ed.deletePage(it.index);
    else if (act === 'up' && it.index > 0) ed.movePage(it.index, it.index - 1);
    else if (act === 'down' && it.index < doc.pages.length - 1) ed.movePage(it.index, it.index + 1);
    else if (!act) {
      ed.scrollToPage(it.index);
      this.onNavigate?.();
    }
  }

  bindDragAndDrop() {
    const clearMarks = () =>
      this.el.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
    let target = null;

    this.el.addEventListener('dragstart', (e) => {
      const t = e.target.closest?.('.thumb');
      if (!t) return;
      this.dragId = t.dataset.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-pdf-page', t.dataset.id);
      t.classList.add('dragging');
    });
    this.el.addEventListener('dragend', () => {
      this.el.querySelector('.dragging')?.classList.remove('dragging');
      clearMarks();
      this.dragId = null;
      target = null;
    });
    this.el.addEventListener('dragover', (e) => {
      if (!this.dragId) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      const t = e.target.closest('.thumb');
      clearMarks();
      if (!t) return;
      const r = t.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      t.classList.add(after ? 'drop-after' : 'drop-before');
      target = { id: t.dataset.id, after };
    });
    this.el.addEventListener('drop', (e) => {
      if (!this.dragId) return;
      e.preventDefault();
      e.stopPropagation();
      clearMarks();
      if (!target) return;
      const from = this.items.get(this.dragId)?.index;
      const over = this.items.get(target.id)?.index;
      if (from == null || over == null) return;
      let to = target.after ? over + 1 : over;
      if (from < to) to -= 1;
      if (to !== from) this.editor.movePage(from, to);
    });
  }
}
