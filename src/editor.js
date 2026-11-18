/**
 * Editor: owns the page views, tools, zoom, selection and page operations.
 */
import { util, ActiveSelection, FabricImage } from 'fabric';
import {
  doc,
  assets,
  emit,
  commit,
  undo as historyUndo,
  redo as historyRedo,
  resetHistory,
  setDirty,
  makePageRecord,
  displaySize,
  replacePage,
  hydrateObjects,
  serializeObjects,
} from './state.js';
import { openPdf } from './pdf.js';
import { PageView } from './pageView.js';
import { Tools } from './tools.js';
import { Thumbnails } from './thumbnails.js';
import { buildPdf } from './exporter.js';
import { mul, clamp, debounce, uid, toast } from './util.js';

const SHAPES = ['rect', 'ellipse', 'line', 'arrow'];
const A4 = [0, 0, 595.28, 841.89];
const PAGE_GAP = 20;

export class Editor {
  constructor({ scroller, pagesEl, thumbsEl }) {
    this.scroller = scroller;
    this.pagesEl = pagesEl;
    this.views = new Map();
    this.zoom = 1;
    this.tool = 'select';
    this.shape = 'rect';
    this.activeView = null;
    this.currentIndex = 0;
    this.clipboard = null;
    this.settings = {
      text: { fontFamily: 'sans', fontSize: 14, bold: false, italic: false, underline: false, fill: '#111111', align: 'left', opacity: 1 },
      shape: { stroke: '#dc2626', strokeWidth: 2, fill: '#fde68a', fillOn: false, opacity: 1 },
      draw: { stroke: '#1d4ed8', strokeWidth: 2, opacity: 1 },
      highlight: { fill: '#facc15', opacity: 0.45 },
      whiteout: { fill: '#ffffff' },
      image: { opacity: 1 },
    };
    this.tools = new Tools(this);
    this.thumbs = new Thumbnails(this, thumbsEl);
    this.observer = new IntersectionObserver((entries) => this.onIntersect(entries), {
      root: scroller,
      rootMargin: '1200px 0px',
    });
    this.rerender = debounce(() => {
      for (const v of this.views.values()) if (v.mounted) v.renderPdf();
    }, 160);
    this.gestureActive = false;
    // On phones the on-screen keyboard can cover the text being typed.
    window.visualViewport?.addEventListener('resize', () => this.keepEditingTextVisible());
    let scrollQueued = false;
    scroller.addEventListener(
      'scroll',
      () => {
        if (scrollQueued) return;
        scrollQueued = true;
        requestAnimationFrame(() => {
          scrollQueued = false;
          this.updateCurrentPage();
        });
      },
      { passive: true },
    );
  }

  get hasDocument() {
    return doc.pages.length > 0;
  }

  /* ============================ documents ============================ */

  async loadDocument(bytes, name, fileHandle = null) {
    const pdf = await openPdf(bytes); // throws on invalid/encrypted files, before we discard anything
    this.reset();
    const src = this.addSource(pdf, bytes, name);
    doc.pages = await this.recordsForSource(src);
    doc.name = name;
    doc.fileHandle = fileHandle;
    this.afterLoad();
  }

  newBlankDocument() {
    this.reset();
    doc.pages = [makePageRecord({ view: A4.slice() })];
    doc.name = 'Untitled.pdf';
    doc.fileHandle = null;
    this.afterLoad();
  }

  afterLoad() {
    resetHistory();
    setDirty(false);
    this.zoom = this.fitZoom('width', 1.5);
    this.sync();
    this.scroller.scrollTop = 0;
    this.scroller.scrollLeft = 0;
    this.setTool('select');
    emit('document');
    emit('zoom', this.zoom);
  }

  /** Appends all pages of another PDF (undoable). */
  async appendDocument(bytes, name) {
    const pdf = await openPdf(bytes);
    const src = this.addSource(pdf, bytes, name);
    const recs = await this.recordsForSource(src);
    doc.pages = [...doc.pages, ...recs];
    commit();
    this.sync();
    return recs.length;
  }

  reset() {
    for (const v of this.views.values()) {
      this.observer.unobserve(v.el);
      v.destroy();
      v.el.remove();
    }
    this.views.clear();
    for (const s of doc.sources.values()) s.pdf.destroy();
    doc.sources.clear();
    assets.clear();
    this.clipboard = null;
    this.thumbs.reset();
    this.activeView = null;
    this.currentIndex = 0;
    doc.pages = [];
  }

  addSource(pdf, bytes, name) {
    const src = { id: uid('src'), name, bytes, pdf, pages: new Map() };
    doc.sources.set(src.id, src);
    return src;
  }

  async recordsForSource(src) {
    const recs = [];
    for (let i = 0; i < src.pdf.numPages; i++) {
      const page = await src.pdf.getPage(i + 1);
      src.pages.set(i, page);
      recs.push(makePageRecord({ srcId: src.id, srcIndex: i, view: page.view.slice(), baseRotation: page.rotate }));
    }
    return recs;
  }

  async getPdfPage(rec) {
    const src = doc.sources.get(rec.srcId);
    if (!src.pages.has(rec.srcIndex)) src.pages.set(rec.srcIndex, await src.pdf.getPage(rec.srcIndex + 1));
    return src.pages.get(rec.srcIndex);
  }

  async exportPdf(onProgress) {
    this.finishEditing();
    return buildPdf(doc, onProgress);
  }

  /* ============================ views ============================ */

  /** Reconciles page views (and thumbnails) with doc.pages. */
  sync() {
    const seen = new Set();
    doc.pages.forEach((rec, i) => {
      let v = this.views.get(rec.id);
      if (!v) {
        v = new PageView(this, rec);
        this.views.set(rec.id, v);
        this.observer.observe(v.el);
      } else if (v.rec !== rec) {
        v.setRecord(rec);
      }
      v.index = i;
      const ref = this.pagesEl.children[i];
      if (ref !== v.el) this.pagesEl.insertBefore(v.el, ref || null);
      seen.add(rec.id);
    });
    for (const [id, v] of this.views) {
      if (seen.has(id)) continue;
      this.observer.unobserve(v.el);
      v.destroy();
      v.el.remove();
      this.views.delete(id);
    }
    if (this.activeView && !this.views.has(this.activeView.rec.id)) this.activeView = null;
    this.currentIndex = clamp(this.currentIndex, 0, Math.max(0, doc.pages.length - 1));
    this.thumbs.sync();
    this.updateCurrentPage();
    emit('pages');
    emit('selection');
  }

  onIntersect(entries) {
    for (const entry of entries) {
      const v = this.views.get(entry.target.dataset.id);
      if (!v) continue;
      if (entry.isIntersecting) v.mount().catch((err) => console.error('Page failed to load', err));
      else if (!v.canvas?.getActiveObject()?.isEditing) v.unmount();
    }
  }

  onViewLoaded() {
    emit('selection');
  }

  /** A view wrote its edits back into its page record. */
  onPageEdited(rec) {
    replacePage(rec);
    commit();
    this.thumbs.refresh(rec);
  }

  onSelectionChanged(view) {
    const objs = view.canvas?.getActiveObjects() ?? [];
    if (objs.length) {
      const prev = this.activeView;
      this.activeView = view;
      if (prev && prev !== view && prev.canvas?.getActiveObject()) {
        prev.canvas.discardActiveObject();
        prev.canvas.requestRenderAll();
      }
    }
    emit('selection');
  }

  getSelection() {
    const view = this.activeView;
    const objects = view?.canvas?.getActiveObjects() ?? [];
    return { view, objects };
  }

  viewAt(index) {
    const rec = doc.pages[index];
    return rec ? this.views.get(rec.id) : null;
  }

  /** The page to put new content on: the selected page, else the current one. */
  async targetView() {
    const { view, objects } = this.getSelection();
    const v = objects.length ? view : this.viewAt(this.currentIndex);
    if (!v) return null;
    if (!v.mounted) await v.mount();
    return v;
  }

  /** Center of the visible part of a page, in page (scene) coordinates. */
  visibleCenter(view) {
    const pr = view.el.getBoundingClientRect();
    const sr = this.scroller.getBoundingClientRect();
    const left = Math.max(pr.left, sr.left);
    const right = Math.min(pr.right, sr.right);
    const top = Math.max(pr.top, sr.top);
    const bottom = Math.min(pr.bottom, sr.bottom);
    const { width, height } = view.size;
    if (right <= left || bottom <= top) return { x: width / 2, y: height / 2 };
    return {
      x: clamp(((left + right) / 2 - pr.left) / this.zoom, 0, width),
      y: clamp(((top + bottom) / 2 - pr.top) / this.zoom, 0, height),
    };
  }

  finishEditing() {
    for (const v of this.views.values()) {
      const o = v.canvas?.getActiveObject();
      if (o?.isEditing) o.exitEditing();
      v.flush();
    }
  }

  /** A two-finger touch gesture started: cancel whatever one finger began. */
  beginGesture() {
    this.gestureActive = true;
    this.tools.cancelInteraction();
    for (const v of this.views.values()) if (v.canvas) v.gestureTainted = true;
  }

  endGesture() {
    this.gestureActive = false;
  }

  keepEditingTextVisible() {
    const { view } = this.getSelection();
    const o = view?.canvas?.getActiveObject();
    const vv = window.visualViewport;
    if (!o?.isEditing || !vv) return;
    const pr = view.el.getBoundingClientRect();
    const sr = this.scroller.getBoundingClientRect();
    const br = o.getBoundingRect();
    const top = pr.top + br.top * this.zoom;
    const bottom = pr.top + (br.top + br.height) * this.zoom;
    const visibleBottom = Math.min(sr.bottom, vv.offsetTop + vv.height) - 16;
    if (bottom > visibleBottom) this.scroller.scrollBy({ top: bottom - visibleBottom + 24 });
    else if (top < sr.top + 8) this.scroller.scrollBy({ top: top - sr.top - 24 });
  }

  /* ============================ tools ============================ */

  setTool(tool) {
    if (tool === 'shape') tool = this.shape;
    if (SHAPES.includes(tool)) this.shape = tool;
    this.tool = tool;
    for (const v of this.views.values()) v.applyTool();
    emit('tool', tool);
  }

  async placeImage(dataUrl, kind = 'image', maxWidth = null) {
    const view = await this.targetView();
    if (!view) return;
    const assetId = uid('img');
    assets.set(assetId, dataUrl);
    const img = await FabricImage.fromURL(dataUrl);
    const { width: pw, height: ph } = view.size;
    const scale = Math.min(1, (maxWidth ?? pw * 0.5) / img.width, (ph * 0.6) / img.height);
    const center = this.visibleCenter(view);
    img.set({ left: center.x, top: center.y, scaleX: scale, scaleY: scale, kind, assetId });
    img.setCoords();
    view.canvas.add(img);
    this.setTool('select');
    view.canvas.setActiveObject(img);
    view.canvas.requestRenderAll();
  }

  /* ============================ object ops ============================ */

  deleteSelection() {
    const { view, objects } = this.getSelection();
    if (!objects.length || view.canvas.getActiveObject()?.isEditing) return;
    view.canvas.discardActiveObject();
    view.canvas.remove(...objects);
    view.canvas.requestRenderAll();
  }

  async copySelection() {
    const { view } = this.getSelection();
    const active = view?.canvas?.getActiveObject();
    if (!active || active.isEditing) return false;
    this.clipboard = await active.clone();
    return true;
  }

  async paste() {
    if (!this.clipboard) return;
    const view = await this.targetView();
    if (!view) return;
    const c = view.canvas;
    const clone = await this.clipboard.clone();
    c.discardActiveObject();
    clone.set({ left: clone.left + 12, top: clone.top + 12, evented: true });
    if (clone instanceof ActiveSelection) {
      clone.canvas = c;
      clone.forEachObject((o) => c.add(o));
      clone.setCoords();
    } else {
      c.add(clone);
    }
    this.clipboard.set({ left: this.clipboard.left + 12, top: this.clipboard.top + 12 });
    c.setActiveObject(clone);
    c.requestRenderAll();
  }

  async duplicateSelection() {
    if (await this.copySelection()) await this.paste();
  }

  arrange(where) {
    const { view, objects } = this.getSelection();
    if (!objects.length) return;
    const c = view.canvas;
    const list = where === 'front' ? objects : [...objects].reverse();
    list.forEach((o) => (where === 'front' ? c.bringObjectToFront(o) : c.sendObjectToBack(o)));
    c.requestRenderAll();
    view.scheduleCommit();
  }

  nudge(dx, dy) {
    const { view } = this.getSelection();
    const o = view?.canvas?.getActiveObject();
    if (!o || o.isEditing) return false;
    o.set({ left: o.left + dx, top: o.top + dy });
    o.setCoords();
    view.canvas.requestRenderAll();
    view.scheduleCommit();
    return true;
  }

  /* ============================ page ops ============================ */

  async rotatePage(index, delta) {
    this.finishEditing();
    const rec = doc.pages[index];
    if (!rec) return;
    const { width: W, height: H } = displaySize(rec);
    // Rotate the edits with the page so they stay on the same content.
    const R = delta > 0 ? [0, 1, -1, 0, H, 0] : [0, -1, 1, 0, 0, W];
    let data = rec.data;
    if (data.objects.length) {
      const objs = await util.enlivenObjects(hydrateObjects(data.objects));
      objs.forEach((o) => util.applyTransformToObject(o, mul(R, o.calcTransformMatrix())));
      data = serializeObjects(objs);
    }
    const i = doc.pages.indexOf(rec);
    if (i < 0) return;
    doc.pages[i] = { ...rec, rotation: (((rec.rotation + delta) % 360) + 360) % 360, data };
    commit();
    this.sync();
  }

  deletePage(index) {
    if (doc.pages.length <= 1) {
      toast('A PDF needs at least one page.', 'info');
      return;
    }
    this.finishEditing();
    doc.pages.splice(index, 1);
    commit();
    this.sync();
  }

  duplicatePage(index) {
    this.finishEditing();
    const rec = doc.pages[index];
    doc.pages.splice(index + 1, 0, { ...rec, id: uid('pg') });
    commit();
    this.sync();
  }

  insertBlankPage(afterIndex) {
    this.finishEditing();
    const ref = doc.pages[afterIndex];
    const { width, height } = ref ? displaySize(ref) : { width: A4[2], height: A4[3] };
    doc.pages.splice(afterIndex + 1, 0, makePageRecord({ view: [0, 0, width, height] }));
    commit();
    this.sync();
    this.scrollToPage(afterIndex + 1);
  }

  movePage(from, to) {
    this.finishEditing();
    const [rec] = doc.pages.splice(from, 1);
    doc.pages.splice(to, 0, rec);
    commit();
    this.sync();
    this.scrollToPage(to);
  }

  /* ============================ history ============================ */

  undo() {
    this.finishEditing();
    if (historyUndo()) this.sync();
  }

  redo() {
    this.finishEditing();
    if (historyRedo()) this.sync();
  }

  /* ============================ navigation & zoom ============================ */

  updateCurrentPage() {
    const els = doc.pages.map((r) => this.views.get(r.id)?.el).filter(Boolean);
    if (!els.length) return;
    const probe = this.scroller.scrollTop + this.scroller.clientHeight * 0.35;
    let lo = 0;
    let hi = els.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (els[mid].offsetTop <= probe) lo = mid;
      else hi = mid - 1;
    }
    if (lo !== this.currentIndex || !this._announced) {
      this._announced = true;
      this.currentIndex = lo;
      this.thumbs.setCurrent(lo);
      emit('current', lo);
    }
  }

  scrollToPage(index, smooth = true) {
    const v = this.viewAt(clamp(index, 0, doc.pages.length - 1));
    if (!v) return;
    this.scroller.scrollTo({ top: v.el.offsetTop - PAGE_GAP, behavior: smooth ? 'smooth' : 'auto' });
  }

  fitZoom(mode = 'width', max = 4) {
    if (!doc.pages.length) return 1;
    const narrow = this.scroller.clientWidth < 600;
    const margin = narrow ? 16 : 64; // phones: use the full width
    const availW = this.scroller.clientWidth - margin;
    const availH = this.scroller.clientHeight - 2 * PAGE_GAP - 56;
    const cur = doc.pages[this.currentIndex] || doc.pages[0];
    // Desktop fits the widest page; phones fit the current page so one sideways
    // page doesn't shrink every other page.
    const fitW = narrow ? displaySize(cur).width : Math.max(...doc.pages.map((r) => displaySize(r).width));
    let z = availW / fitW;
    if (mode === 'page') z = Math.min(z, availH / displaySize(cur).height);
    return clamp(z, 0.25, max);
  }

  /** Changes zoom while keeping the point under `anchor` (viewport coords) fixed. */
  setZoom(z, anchor = null) {
    z = clamp(z, 0.25, 5);
    if (Math.abs(z - this.zoom) < 0.001) return;
    const sc = this.scroller;
    const ax = anchor?.x ?? sc.clientWidth / 2;
    const ay = anchor?.y ?? sc.clientHeight / 2;
    // Remember which page (and where in it) is under the anchor.
    const contentY = sc.scrollTop + ay;
    let ref = null;
    for (const r of doc.pages) {
      const v = this.views.get(r.id);
      if (v && v.el.offsetTop + v.el.offsetHeight >= contentY) {
        ref = { v, fy: (contentY - v.el.offsetTop) / v.el.offsetHeight };
        break;
      }
    }
    const fx = (sc.scrollLeft + ax) / Math.max(1, sc.scrollWidth);
    this.zoom = z;
    for (const v of this.views.values()) v.updateSize();
    if (ref) sc.scrollTop = ref.v.el.offsetTop + ref.fy * ref.v.el.offsetHeight - ay;
    sc.scrollLeft = fx * sc.scrollWidth - ax;
    this.rerender();
    emit('zoom', z);
  }

  zoomBy(factor, anchor) {
    this.setZoom(this.zoom * factor, anchor);
  }
}
