/**
 * Selecting a picture that is part of the original PDF (Select tool: click or
 * tap it), then copying it to the clipboard or saving it as a PNG.
 *
 * A copied picture also goes on the editor's own clipboard as a regular image
 * object, so pasting it into the document keeps its size and position.
 */
import { FabricImage } from 'fabric';
import { doc, assets, emit, totalRotation } from './state.js';
import { sceneTransform, hitTestImages, renderImage, encodeForDocument, canvasToBlob } from './pdfImages.js';
import { toast, uid, downloadBytes } from './util.js';

const isTouchUI = window.matchMedia('(pointer: coarse)').matches;

export class ImagePicker {
  constructor(editor) {
    this.editor = editor;
    this.selection = null;
  }

  /** Selects the PDF picture under scene point `p`; clears the selection if there is none. */
  async selectAt(view, p) {
    const images = await view.getPdfImages();
    if (!view.canvas) return false;
    const hit = hitTestImages(images, sceneTransform(view.rec), p);
    if (!hit) {
      this.clear();
      return false;
    }
    const cur = this.selection;
    if (cur?.view === view && cur.hit.image === hit.image) return true;
    this.select(view, hit);
    return true;
  }

  /** The topmost PDF picture under `p`, if this page's pictures are already known. */
  hoverHit(view, p) {
    const images = view.pdfImagesResolved;
    if (!images) {
      if (view.pdfCanvas) view.getPdfImages(); // rendered: listing is cheap now
      return null;
    }
    return images.length ? hitTestImages(images, sceneTransform(view.rec), p) : null;
  }

  select(view, hit) {
    this.clear({ silent: true });
    // One selection at a time.
    const { view: active } = this.editor.getSelection();
    if (active?.canvas?.getActiveObject()) {
      active.canvas.discardActiveObject();
      active.canvas.requestRenderAll();
    }
    const sel = { view, hit, rotation: totalRotation(view.rec), canvas: null, png: null, el: null };
    // Extract right away, so Copy/Save can run inside the tap that triggers
    // them (iOS only allows clipboard writes and sharing during a tap).
    sel.ready = (async () => {
      const page = await this.editor.getPdfPage(view.rec);
      sel.canvas = await renderImage(page, hit.image, sceneTransform(view.rec));
      sel.png = await canvasToBlob(sel.canvas);
      return sel.png;
    })();
    sel.ready.catch((err) => console.warn('Image extraction failed', err));

    const { width: W, height: H } = view.size;
    const b = hit.box;
    const x0 = Math.max(0, b.x);
    const y0 = Math.max(0, b.y);
    const x1 = Math.min(W, b.x + b.width);
    const y1 = Math.min(H, b.y + b.height);
    sel.el = document.createElement('div');
    sel.el.className = 'pdf-image-sel';
    Object.assign(sel.el.style, {
      left: `${(x0 / W) * 100}%`,
      top: `${(y0 / H) * 100}%`,
      width: `${((x1 - x0) / W) * 100}%`,
      height: `${((y1 - y0) / H) * 100}%`,
    });
    view.el.appendChild(sel.el);

    this.selection = sel;
    emit('selection');
  }

  clear({ silent = false } = {}) {
    const sel = this.selection;
    if (!sel) return;
    this.selection = null;
    sel.el?.remove();
    if (!silent) emit('selection');
  }

  /** Drops the selection if its page went away or changed shape. */
  validate() {
    const sel = this.selection;
    if (!sel) return;
    const v = this.editor.views.get(sel.view.rec.id);
    if (v !== sel.view || !v.mounted || totalRotation(v.rec) !== sel.rotation) this.clear();
  }

  /**
   * Copies the selected picture to the system clipboard (for other apps) and
   * to the editor's clipboard (for pasting into the document).
   * Must be called directly from a click/keypress: the clipboard write starts
   * before anything is awaited.
   */
  async copy() {
    const sel = this.selection;
    if (!sel) return;
    const system = writeImageToClipboard(sel.png ?? sel.ready);
    let canvas;
    try {
      await sel.ready;
      canvas = sel.canvas;
    } catch (err) {
      console.error(err);
      toast(`Couldn't copy this image: ${err.message}`, 'error', 5000);
      return;
    }
    const obj = await toImageObject(canvas, sel.hit.box);
    const copiedToSystem = await system;
    this.editor.setClipboard(obj, { width: canvas.width, height: canvas.height, preferInternal: !copiedToSystem });
    const pasteHow = isTouchUI ? 'Tap Paste to add it to a page' : 'Press Ctrl+V to paste it on a page';
    toast(`Image copied. ${pasteHow}${copiedToSystem ? ', or paste it into another app' : ''}.`, 'success', 4200);
  }

  /** Saves the selected picture as a PNG (share sheet on phones, download elsewhere). */
  async save() {
    const sel = this.selection;
    if (!sel) return;
    const name = `${doc.name.replace(/\.pdf$/i, '') || 'image'}-page${sel.view.index + 1}-image${sel.hit.index + 1}.png`;
    let blob = sel.png;
    if (!blob) {
      try {
        blob = await sel.ready;
      } catch (err) {
        console.error(err);
        toast(`Couldn't save this image: ${err.message}`, 'error', 5000);
        return;
      }
    }
    const file = new File([blob], name, { type: 'image/png' });
    let canShare = false;
    try {
      canShare = isTouchUI && !!navigator.canShare?.({ files: [file] });
    } catch {
      canShare = false;
    }
    if (!canShare) {
      downloadBytes(blob, name, 'image/png');
      return;
    }
    try {
      await navigator.share({ files: [file] });
    } catch (err) {
      if (err.name === 'AbortError') return;
      // The tap's permission can expire while a big image is encoded: download instead.
      downloadBytes(blob, name, 'image/png');
    }
  }
}

/** Writes a PNG (or a promise of one) to the system clipboard. Resolves to success. */
async function writeImageToClipboard(png) {
  if (!window.isSecureContext || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    return true;
  } catch (err) {
    try {
      // Older engines only accept a finished Blob here.
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': await png })]);
      return true;
    } catch {
      console.warn('Clipboard write failed', err);
      return false;
    }
  }
}

/** A movable image object showing `canvas`, covering scene box `box`. */
async function toImageObject(canvas, box) {
  const url = encodeForDocument(canvas);
  const assetId = uid('img');
  assets.set(assetId, url);
  const img = await FabricImage.fromURL(url);
  img.set({
    left: box.x + box.width / 2,
    top: box.y + box.height / 2,
    scaleX: box.width / img.width,
    scaleY: box.height / img.height,
    kind: 'image',
    assetId,
  });
  img.setCoords();
  return img;
}
