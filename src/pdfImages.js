/**
 * Images that are part of the original PDF: where each one is drawn on a page,
 * and extracting one at its native resolution (for Copy / Save image).
 *
 * pdf.js doesn't report image positions, so we walk the page's operator list
 * and track the current transformation matrix the same way its canvas
 * renderer does. Pixels come from the decoded image objects pdf.js already
 * holds, so nothing is decoded twice.
 */
import { OPS, ImageKind } from 'pdfjs-dist';
import { mul, invert, apply, viewportTransform } from './util.js';
import { totalRotation } from './state.js';

const IDENTITY = [1, 0, 0, 1, 0, 0];
const MAX_SIDE = 8192;
const MAX_PIXELS = 16_000_000; // iOS Safari refuses larger canvases
const MIN_SIZE = 3; // pt; ignore spacer pixels and hairlines

/** Page (PDF user space) → scene (displayed page at scale 1, y down). */
export function sceneTransform(rec) {
  return viewportTransform(rec.view, totalRotation(rec));
}

/**
 * Lists the images painted on a page, in paint order (topmost last).
 * Each entry is { ref, ctm }: `ref` is a pdf.js object id or inline image data,
 * and `ctm` maps the image's unit square into PDF user space.
 */
export async function findPageImages(pdfPage, optionalContent = null) {
  const { fnArray, argsArray } = renderedOperatorList(pdfPage) ?? (await pdfPage.getOperatorList());
  const images = [];
  const stack = [];
  const marked = []; // visibility of open marked-content sections (optional content layers)
  let ctm = IDENTITY;
  const push = () => stack.push(ctm);
  const pop = () => {
    if (stack.length) ctm = stack.pop();
  };
  const visible = () => !marked.includes(false);

  for (let i = 0; i < fnArray.length; i++) {
    const args = argsArray[i];
    switch (fnArray[i]) {
      case OPS.save:
      case OPS.beginGroup:
        push();
        break;
      case OPS.restore:
      case OPS.endGroup:
      case OPS.paintFormXObjectEnd:
      case OPS.endAnnotation:
        pop();
        break;
      case OPS.transform:
        ctm = mul(ctm, args);
        break;
      case OPS.paintFormXObjectBegin: // (matrix, bbox)
        push();
        if (args[0]) ctm = mul(ctm, args[0]);
        break;
      case OPS.beginAnnotation: // (id, rect, transform, matrix): annotations start from the page's own space
        push();
        ctm = mul(args[2], args[3]);
        break;
      case OPS.beginMarkedContent:
        marked.push(true);
        break;
      case OPS.beginMarkedContentProps:
        marked.push(args[0] !== 'OC' || !optionalContent || optionalContent.isVisible(args[1]));
        break;
      case OPS.endMarkedContent:
        marked.pop();
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
        if (visible()) images.push({ ref: args[0], ctm });
        break;
      case OPS.paintImageXObjectRepeat: {
        const [ref, sx, sy, positions] = args;
        if (!visible()) break;
        for (let k = 0; k < positions.length; k += 2) {
          images.push({ ref, ctm: mul(ctm, [sx, 0, 0, sy, positions[k], positions[k + 1]]) });
        }
        break;
      }
      default:
    }
  }
  return images;
}

/**
 * The operator list pdf.js already built to render the page, whose images are
 * already decoded. Uses a pdf.js internal, so callers fall back to
 * getOperatorList() (which decodes the images again) when it isn't there.
 */
function renderedOperatorList(pdfPage) {
  try {
    for (const state of pdfPage._intentStates?.values?.() ?? []) {
      const list = state?.operatorList;
      if (list?.lastChunk && list.fnArray?.length) return list;
    }
  } catch {
    /* internals changed: use the public API */
  }
  return null;
}

/** Axis-aligned box of the unit square under M. */
function unitSquareBox(M) {
  const pts = [apply(M, 0, 0), apply(M, 1, 0), apply(M, 0, 1), apply(M, 1, 1)];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * The topmost image under scene point `p`, or null.
 * Returns { image, index, box } with `box` in scene coordinates.
 */
export function hitTestImages(images, V, p) {
  for (let i = images.length - 1; i >= 0; i--) {
    const M = mul(V, images[i].ctm);
    if (Math.abs(M[0] * M[3] - M[1] * M[2]) < 1e-9) continue;
    const u = apply(invert(M), p.x, p.y);
    if (u.x < 0 || u.x > 1 || u.y < 0 || u.y > 1) continue;
    const box = unitSquareBox(M);
    if (box.width < MIN_SIZE || box.height < MIN_SIZE) continue;
    return { image: images[i], index: i, box };
  }
  return null;
}

/** Waits for a pdf.js image object to arrive from the worker. */
function getImageObject(pdfPage, id, timeout = 15000) {
  const pool = id.startsWith('g_') ? pdfPage.commonObjs : pdfPage.objs;
  if (pool.has(id)) return Promise.resolve(pool.get(id));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The image data is not available.')), timeout);
    pool.get(id, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/** Turns a pdf.js image object into something drawImage accepts. */
function drawable(data) {
  if (data.bitmap) {
    if (!data.bitmap.width) throw new Error('The image data is no longer available.');
    return data.bitmap;
  }
  if (typeof HTMLElement === 'function' && data instanceof HTMLElement) return data;
  const imageData = data instanceof ImageData ? data : toImageData(data);
  const c = document.createElement('canvas');
  c.width = imageData.width;
  c.height = imageData.height;
  c.getContext('2d').putImageData(imageData, 0, 0);
  return c;
}

/** pdf.js raw image data (1-bit gray, RGB or RGBA) → RGBA ImageData. */
function toImageData({ width, height, kind, data }) {
  const out = new ImageData(width, height);
  const d = out.data;
  const n = width * height;
  if (kind === ImageKind.RGBA_32BPP) {
    d.set(data.subarray(0, n * 4));
  } else if (kind === ImageKind.RGB_24BPP) {
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      d[j] = data[i * 3];
      d[j + 1] = data[i * 3 + 1];
      d[j + 2] = data[i * 3 + 2];
      d[j + 3] = 255;
    }
  } else if (kind === ImageKind.GRAYSCALE_1BPP) {
    const rowBytes = (width + 7) >> 3;
    for (let y = 0, j = 0; y < height; y++) {
      for (let x = 0; x < width; x++, j += 4) {
        const v = data[y * rowBytes + (x >> 3)] & (128 >> (x & 7)) ? 255 : 0;
        d[j] = d[j + 1] = d[j + 2] = v;
        d[j + 3] = 255;
      }
    }
  } else {
    throw new Error(`Unsupported image format (${kind})`);
  }
  return out;
}

/**
 * Draws an image the way it appears on the page (same orientation, flips and
 * aspect ratio) at its native resolution, onto a new canvas.
 */
export async function renderImage(pdfPage, image, V) {
  const data = typeof image.ref === 'string' ? await getImageObject(pdfPage, image.ref) : image.ref;
  const src = drawable(data);
  const w = data.width ?? src.width;
  const h = data.height ?? src.height;
  // Image pixel (u, v), v counted down from the top row → unit square → page → scene.
  const D = mul(mul(V, image.ctm), [1 / w, 0, 0, -1 / h, 0, 1]);
  const box = unitSquareBox(mul(D, [w, 0, 0, h, 0, 0]));
  // Output pixels per scene unit: enough that neither image axis loses detail.
  let k = Math.max(1 / Math.hypot(D[0], D[1]), 1 / Math.hypot(D[2], D[3]));
  const full = box.width * k * box.height * k;
  k *= Math.min(1, MAX_SIDE / (Math.max(box.width, box.height) * k), Math.sqrt(MAX_PIXELS / full));
  const W = Math.max(1, Math.round(box.width * k));
  const H = Math.max(1, Math.round(box.height * k));

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  // Fill the canvas exactly (no half-transparent edge from rounding).
  const sx = W / box.width;
  const sy = H / box.height;
  ctx.setTransform(...mul([sx, 0, 0, sy, -box.x * sx, -box.y * sy], D));
  ctx.drawImage(src, 0, 0);
  return canvas;
}

/** True if any part of the canvas is see-through (checked on a small copy). */
export function hasTransparency(canvas) {
  const s = Math.min(1, 256 / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * s));
  const h = Math.max(1, Math.round(canvas.height * s));
  const probe = document.createElement('canvas');
  probe.width = w;
  probe.height = h;
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}

/**
 * Encodes an extracted image for placing back into the document: PNG when it
 * has transparency or is small, otherwise JPEG (on white) to keep the PDF small.
 */
export function encodeForDocument(canvas, maxSide = 3000) {
  const s = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  let c = canvas;
  if (s < 1) {
    c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(canvas.width * s));
    c.height = Math.max(1, Math.round(canvas.height * s));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, c.width, c.height);
  }
  if (c.width * c.height <= 500_000 || hasTransparency(c)) return c.toDataURL('image/png');
  const flat = document.createElement('canvas');
  flat.width = c.width;
  flat.height = c.height;
  const ctx = flat.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, flat.width, flat.height);
  ctx.drawImage(c, 0, 0);
  return flat.toDataURL('image/jpeg', 0.92);
}

export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image'))), type, quality),
  );
}
