/**
 * Two-finger pinch-zoom and pan for touch screens.
 *
 * While the fingers move, the page stack is scaled with a cheap CSS transform;
 * when they lift, the real zoom is applied once (pages re-render sharply).
 * Any drawing that the first finger started is cancelled.
 */
import { clamp } from './util.js';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;

export function installTouchGestures(editor, viewer, pagesEl) {
  let g = null;

  const pt = (t, r) => ({ x: t.clientX - r.left, y: t.clientY - r.top });
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) || 1;

  function start(e) {
    const r = viewer.getBoundingClientRect();
    const a = pt(e.touches[0], r);
    const b = pt(e.touches[1], r);
    const m0 = mid(a, b);
    g = { r, d0: dist(a, b), m0, m: m0, k: 1, z0: editor.zoom, applied: false };
    editor.beginGesture();
    // Scale around the content point under the fingers.
    pagesEl.style.transformOrigin = `${viewer.scrollLeft + m0.x - pagesEl.offsetLeft}px ${viewer.scrollTop + m0.y - pagesEl.offsetTop}px`;
  }

  function move(e) {
    if (e.touches.length < 2) return;
    if (!e.cancelable) {
      // The browser already committed to native scrolling; let it.
      if (!g.applied) cancel();
      return;
    }
    e.preventDefault();
    const a = pt(e.touches[0], g.r);
    const b = pt(e.touches[1], g.r);
    g.m = mid(a, b);
    g.k = clamp(dist(a, b) / g.d0, MIN_ZOOM / g.z0, MAX_ZOOM / g.z0);
    g.applied = true;
    pagesEl.style.transform = `translate(${g.m.x - g.m0.x}px, ${g.m.y - g.m0.y}px) scale(${g.k})`;
  }

  function finish() {
    const { k, z0, m0, m, applied } = g;
    g = null;
    pagesEl.style.transform = '';
    pagesEl.style.transformOrigin = '';
    if (applied) {
      editor.setZoom(z0 * k, m0); // keeps the content under m0 at m0...
      viewer.scrollBy(-(m.x - m0.x), -(m.y - m0.y)); // ...then follow the fingers' pan
    }
    editor.endGesture();
  }

  function cancel() {
    g = null;
    pagesEl.style.transform = '';
    pagesEl.style.transformOrigin = '';
    editor.endGesture();
  }

  viewer.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 2 && !g) {
        if (e.cancelable) e.preventDefault();
        start(e);
      }
    },
    { passive: false, capture: true },
  );
  viewer.addEventListener('touchmove', (e) => g && move(e), { passive: false, capture: true });
  const end = (e) => {
    if (g && e.touches.length < 2) finish();
  };
  viewer.addEventListener('touchend', end, { capture: true });
  viewer.addEventListener('touchcancel', end, { capture: true });

  // While a gesture is active, keep the first finger's moves away from the
  // drawing layer so it doesn't keep drawing / dragging.
  window.addEventListener(
    'pointermove',
    (e) => {
      if (editor.gestureActive && e.pointerType === 'touch') e.stopImmediatePropagation();
    },
    { capture: true },
  );

  // Safari: block its own page-zoom gesture (we zoom the document instead).
  document.addEventListener('gesturestart', (e) => e.preventDefault());
}
