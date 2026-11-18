import { Color } from 'fabric';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function uid(prefix = 'id') {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`;
}

export function debounce(fn, ms) {
  let t;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

/* ------------------------------------------------------------------ */
/* 2D affine matrices, [a, b, c, d, e, f] as used by PDF and canvas:   */
/*   x' = a*x + c*y + e,  y' = b*x + d*y + f                           */
/* ------------------------------------------------------------------ */

/** Returns A∘B (apply B first, then A). */
export function mul(A, B) {
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}

export function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function apply(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export const FLIP_Y = [1, 0, 0, -1, 0, 0];

/**
 * The transform pdf.js uses (at scale 1) to map PDF user space to the
 * on-screen page, where y points down and the page may be rotated.
 * Mirrors pdf.js' PageViewport so export coordinates match the display exactly.
 */
export function viewportTransform(view, rotation) {
  const [x0, y0, x1, y1] = view;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  let a, b, c, d;
  switch (((rotation % 360) + 360) % 360) {
    case 90: a = 0; b = 1; c = 1; d = 0; break;
    case 180: a = -1; b = 0; c = 0; d = 1; break;
    case 270: a = 0; b = -1; c = -1; d = 0; break;
    default: a = 1; b = 0; c = 0; d = -1;
  }
  let offX, offY;
  if (c === 0) {
    offX = Math.abs(cx - x0);
    offY = Math.abs(cy - y0);
  } else {
    offX = Math.abs(cy - y0);
    offY = Math.abs(cx - x0);
  }
  return [a, b, c, d, offX - a * cx - c * cy, offY - b * cx - d * cy];
}

/* ------------------------------------------------------------------ */
/* Colors                                                              */
/* ------------------------------------------------------------------ */

/** Parses any CSS color to {r,g,b,a} with channels 0..1, or null for none/transparent. */
export function parseColor(str) {
  if (!str || typeof str !== 'string' || str === 'transparent' || str === 'none') return null;
  const [r, g, b, a] = new Color(str).getSource();
  if (a === 0) return null;
  return { r: r / 255, g: g / 255, b: b / 255, a: a ?? 1 };
}

export function toHex(str, fallback = '#000000') {
  try {
    const c = new Color(str);
    return `#${c.toHex().slice(0, 6).toLowerCase()}`;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* Files & images                                                      */
/* ------------------------------------------------------------------ */

export function dataUrlToBytes(url) {
  const base64 = url.slice(url.indexOf(',') + 1);
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * Reads an image file into a PNG or JPEG data URL (the two formats a PDF can embed),
 * downscaling very large images to keep the document size reasonable.
 */
export async function loadImageFile(file, maxDim = 2400) {
  const url = await readAsDataUrl(file);
  const img = await loadImage(url);
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const isJpeg = file.type === 'image/jpeg';
  if (scale === 1 && (isJpeg || file.type === 'image/png')) {
    return { dataUrl: url, width: img.naturalWidth, height: img.naturalHeight };
  }
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return { dataUrl: isJpeg ? c.toDataURL('image/jpeg', 0.92) : c.toDataURL('image/png'), width: w, height: h };
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load image'));
    img.src = src;
  });
}

export function downloadBytes(bytes, name, type = 'application/pdf') {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/* ------------------------------------------------------------------ */
/* UI feedback                                                         */
/* ------------------------------------------------------------------ */

export function toast(message, type = 'info', ms = 3200) {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, ms);
}

let busyDepth = 0;
export async function withBusy(text, fn) {
  const el = $('#busy');
  $('#busy-text').textContent = text;
  busyDepth++;
  el.hidden = false;
  try {
    return await fn();
  } finally {
    if (--busyDepth === 0) el.hidden = true;
  }
}

/** Promise-based confirm dialog (native confirm() is blocking and unstyled). */
export function confirmDialog({ title, message, confirmText = 'OK', cancelText = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `
      <div class="modal-card confirm-card" role="alertdialog" aria-modal="true">
        <h2></h2><p></p>
        <footer>
          <button class="btn" data-v="0"></button>
          <button class="btn ${danger ? 'danger-fill' : 'primary'}" data-v="1"></button>
        </footer>
      </div>`;
    wrap.querySelector('h2').textContent = title;
    wrap.querySelector('p').textContent = message;
    wrap.querySelector('[data-v="0"]').textContent = cancelText;
    wrap.querySelector('[data-v="1"]').textContent = confirmText;
    const done = (v) => {
      document.removeEventListener('keydown', onKey, true);
      wrap.remove();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
      if (e.key === 'Enter') { e.stopPropagation(); done(true); }
    };
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (b) done(b.dataset.v === '1');
      else if (e.target === wrap) done(false);
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(wrap);
    wrap.querySelector('[data-v="1"]').focus();
  });
}

export function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
