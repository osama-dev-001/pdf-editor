/**
 * pdf.js wrapper: loading documents, rendering pages, and extracting text
 * "runs" (lines of same-styled text) so existing text can be edited.
 */
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const BASE = import.meta.env.BASE_URL;

export async function openPdf(bytes) {
  const task = pdfjsLib.getDocument({
    data: bytes.slice(), // pdf.js transfers (detaches) the buffer, so keep our own copy intact
    cMapUrl: `${BASE}pdfjs/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${BASE}pdfjs/standard_fonts/`,
    isEvalSupported: false,
  });
  return task.promise;
}

export function isPasswordError(err) {
  return err?.name === 'PasswordException';
}

export function isCancelled(err) {
  return err?.name === 'RenderingCancelledException';
}

/**
 * Merges pdf.js text items into runs: consecutive pieces of text that share a
 * font, size and baseline. Coordinates are in display space at scale 1 (the
 * same space as the editing layer), with y pointing down.
 */
export async function extractTextRuns(pdfPage, rotation) {
  const vp = pdfPage.getViewport({ scale: 1, rotation });
  const tc = await pdfPage.getTextContent();
  const items = [];
  for (const it of tc.items) {
    if (typeof it.str !== 'string' || !it.str.length) continue;
    const style = tc.styles[it.fontName] || {};
    if (style.vertical) continue;
    const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
    const size = Math.hypot(tx[2], tx[3]);
    if (!(size > 0.5) || !(it.width > 0)) continue;
    const descent = style.descent ? Math.min(0.5, Math.abs(style.descent)) : 0.21;
    const ascent = style.ascent ? Math.min(1.2, style.ascent) : 1 - descent;
    items.push({
      str: it.str,
      ox: tx[4], // baseline origin
      oy: tx[5],
      angle: Math.atan2(tx[1], tx[0]),
      size,
      width: it.width,
      ascent,
      descent,
      fontName: it.fontName,
      family: style.fontFamily || '',
    });
  }

  const runs = [];
  let cur = null;
  for (const it of items) {
    const gap = cur ? mergeGap(cur, it) : null;
    if (gap !== null) {
      const needsSpace = gap > cur.size * 0.15 && !/\s$/.test(cur.str) && !/^\s/.test(it.str);
      cur.str += (needsSpace ? ' ' : '') + it.str;
      cur.width = Math.max(cur.width, cur.width + gap + it.width);
    } else {
      cur = { ...it };
      runs.push(cur);
    }
  }

  return runs
    .filter((r) => r.str.trim().length)
    .map((r) => {
      r.str = r.str.replace(/\s+$/, '');
      const cos = Math.cos(r.angle);
      const sin = Math.sin(r.angle);
      // "up" (perpendicular to the baseline) in a y-down space is (sin, -cos)
      r.tlx = r.ox + sin * r.ascent * r.size;
      r.tly = r.oy - cos * r.ascent * r.size;
      r.height = (r.ascent + r.descent) * r.size;
      r.cos = cos;
      r.sin = sin;
      return r;
    });
}

/** Returns the horizontal gap if `it` continues `run` on the same line, else null. */
function mergeGap(run, it) {
  if (it.fontName !== run.fontName) return null;
  if (Math.abs(it.size - run.size) > run.size * 0.1) return null;
  if (Math.abs(it.angle - run.angle) > 0.02) return null;
  const cos = Math.cos(run.angle);
  const sin = Math.sin(run.angle);
  const dx = it.ox - run.ox;
  const dy = it.oy - run.oy;
  const along = dx * cos + dy * sin;
  const perp = -dx * sin + dy * cos;
  if (Math.abs(perp) > run.size * 0.2) return null;
  const gap = along - run.width;
  if (gap < -run.size * 0.5 || gap > run.size * 1.2) return null;
  return gap;
}

export function hitTestRuns(runs, p, tolerance = 2) {
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i];
    const dx = p.x - r.tlx;
    const dy = p.y - r.tly;
    const along = dx * r.cos + dy * r.sin;
    const down = -dx * r.sin + dy * r.cos;
    if (along >= -tolerance && along <= r.width + tolerance && down >= -tolerance && down <= r.height + tolerance) {
      return r;
    }
  }
  return null;
}

/** Best-effort font info for a run (family/bold/italic) from the loaded font object. */
export function runFontInfo(pdfPage, run) {
  let name = '';
  let bold = false;
  let italic = false;
  try {
    const objs = pdfPage?.commonObjs;
    if (objs?.has(run.fontName)) {
      const f = objs.get(run.fontName);
      name = String(f?.name || '');
      bold = !!f?.bold;
      italic = !!f?.italic;
    }
  } catch {
    /* font not loaded yet — fall back to guesses */
  }
  const n = name.toLowerCase();
  bold ||= /bold|black|heavy|semibold|demi/.test(n);
  italic ||= /italic|oblique/.test(n);
  let family = 'sans';
  if (/courier|mono|consol/.test(n) || run.family === 'monospace') family = 'mono';
  else if (/sans|arial|helvetica|calibri|verdana|segoe|roboto/.test(n)) family = 'sans';
  else if (/times|georgia|garamond|cambria|serif|roman|minion|palatino|book/.test(n) || run.family === 'serif') family = 'serif';
  return { family, bold, italic };
}
