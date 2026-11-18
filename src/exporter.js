/**
 * Builds the output PDF with pdf-lib.
 *
 * Original pages are copied untouched (text, vectors, links all preserved) and
 * edits are drawn on top as real PDF content:
 *   - text      -> real text in a standard PDF font (selectable/searchable)
 *   - shapes    -> vector paths
 *   - images    -> embedded PNG/JPEG
 *   - anything that can't be expressed natively (e.g. text in a script the
 *     standard fonts can't encode) -> rasterized at 3x as a fallback.
 *
 * Coordinates: the editing layer works in "scene" space = the displayed page
 * at scale 1, y down. invert(viewportTransform) maps scene -> PDF user space,
 * matching pdf.js' rendering exactly, including page rotation.
 */
import {
  PDFDocument,
  rgb,
  degrees,
  BlendMode,
  LineCapStyle,
  LineJoinStyle,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  setLineJoin,
} from 'pdf-lib';
import { util, FabricText, FabricImage, Rect, Ellipse, Line, Path } from 'fabric';
import { totalRotation, hydrateObjects, assets } from './state.js';
import { mul, invert, apply, viewportTransform, parseColor, dataUrlToBytes, FLIP_Y, loadImage } from './util.js';
import { standardFontFor } from './fonts.js';

export async function buildPdf(doc, onProgress) {
  const out = await PDFDocument.create();

  // Copy source pages, one copyPages call per source so shared resources are deduplicated.
  const bySource = new Map();
  doc.pages.forEach((rec, i) => {
    if (!rec.srcId) return;
    if (!bySource.has(rec.srcId)) bySource.set(rec.srcId, []);
    bySource.get(rec.srcId).push(i);
  });
  const copied = new Array(doc.pages.length);
  let first = true;
  for (const [srcId, idxs] of bySource) {
    const src = await PDFDocument.load(doc.sources.get(srcId).bytes, { ignoreEncryption: true, updateMetadata: false });
    if (first) {
      first = false;
      const title = src.getTitle();
      if (title) out.setTitle(title);
      const author = src.getAuthor();
      if (author) out.setAuthor(author);
    }
    const pages = await out.copyPages(src, idxs.map((i) => doc.pages[i].srcIndex));
    idxs.forEach((pageIdx, k) => (copied[pageIdx] = pages[k]));
  }
  out.setProducer('PDF Editor (pdf-lib)');
  out.setModificationDate(new Date());

  const ctx = { out, fonts: new Map(), images: new Map() };
  for (let i = 0; i < doc.pages.length; i++) {
    const rec = doc.pages[i];
    let page;
    if (rec.srcId) {
      page = out.addPage(copied[i]);
    } else {
      const [x0, y0, x1, y1] = rec.view;
      page = out.addPage([x1 - x0, y1 - y0]);
    }
    const rot = totalRotation(rec);
    page.setRotation(degrees(rot));
    if (rec.data.objects.length) await drawAnnotations(page, rec, rot, ctx);
    onProgress?.(i + 1, doc.pages.length);
  }
  return out.save();
}

async function drawAnnotations(page, rec, rot, ctx) {
  isolateExistingContent(page);
  const Vinv = invert(viewportTransform(rec.view, rot));
  const objs = await util.enlivenObjects(hydrateObjects(rec.data.objects));
  for (const o of objs) {
    if (!o.visible || o.opacity === 0) continue;
    try {
      if (o instanceof FabricText) await drawText(page, o, Vinv, ctx);
      else if (o instanceof FabricImage) await drawImageObject(page, o, Vinv, ctx);
      else if (scenePath(o)) drawVector(page, o, Vinv);
      else await drawRaster(page, o, Vinv, ctx);
    } catch (err) {
      console.warn('Exporting object as image instead:', err);
      await drawRaster(page, o, Vinv, ctx);
    }
  }
}

/**
 * Wraps the page's original content in q/Q so any transform it leaves active
 * can't shift our additions.
 */
function isolateExistingContent(page) {
  const { context } = page.doc;
  page.node.normalize();
  const start = context.register(context.contentStream([pushGraphicsState()]));
  const end = context.register(context.contentStream([popGraphicsState()]));
  page.node.wrapContentStreams(start, end);
}

function within(page, matrix, draw) {
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...matrix));
  draw();
  page.pushOperators(popGraphicsState());
}

const alpha = (a) => (a < 0.999 ? a : undefined);

/* ------------------------------ text ------------------------------ */

async function getFont(ctx, name) {
  if (!ctx.fonts.has(name)) ctx.fonts.set(name, ctx.out.embedFont(name));
  return ctx.fonts.get(name);
}

async function drawText(page, o, Vinv, ctx) {
  const font = await getFont(ctx, standardFontFor(o));
  const size = o.fontSize;
  const lines = o.textLines.map((l) => l.replace(/\t/g, '    '));
  // Measuring first also validates that the standard font can encode every
  // character; if not, this throws before anything is drawn and we rasterize.
  const widths = lines.map((l) => font.widthOfTextAtSize(l, size));
  const c = parseColor(o.fill) || { r: 0, g: 0, b: 0, a: 1 };
  const color = rgb(c.r, c.g, c.b);
  const opacity = alpha(c.a * o.opacity);

  // Local object space with y up, centered on the object.
  const M = mul(Vinv, mul(o.calcTransformMatrix(), FLIP_Y));
  within(page, M, () => {
    let top = -o.height / 2;
    lines.forEach((line, i) => {
      // Same baseline math Fabric uses to render the text.
      const baseline = top + o.getHeightOfLineImpl(i) * (1 - o._fontSizeFraction);
      const w = widths[i];
      let x = -o.width / 2;
      if (o.textAlign === 'center') x = -w / 2;
      else if (o.textAlign === 'right') x = o.width / 2 - w;
      if (line.length) page.drawText(line, { x, y: -baseline, size, font, color, opacity });
      const deco = (offset) =>
        page.drawLine({
          start: { x, y: -(baseline + offset) },
          end: { x: x + w, y: -(baseline + offset) },
          thickness: Math.max(0.5, size / 15),
          color,
          opacity,
        });
      if (o.underline && w > 0) deco(size * 0.12);
      if (o.linethrough && w > 0) deco(-size * 0.28);
      top += o.getHeightOfLine(i);
    });
  });
}

/* ------------------------------ images ------------------------------ */

async function embedDataUrl(ctx, src) {
  if (ctx.images.has(src)) return ctx.images.get(src);
  let promise;
  if (/^data:image\/jpe?g/i.test(src)) promise = ctx.out.embedJpg(dataUrlToBytes(src));
  else if (/^data:image\/png/i.test(src)) promise = ctx.out.embedPng(dataUrlToBytes(src));
  else {
    // Any other format: re-encode through a canvas as PNG.
    promise = loadImage(src).then((img) => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return ctx.out.embedPng(dataUrlToBytes(c.toDataURL('image/png')));
    });
  }
  ctx.images.set(src, promise);
  return promise;
}

async function drawImageObject(page, o, Vinv, ctx) {
  const src = (o.assetId && assets.get(o.assetId)) || o.getSrc();
  const img = await embedDataUrl(ctx, src);
  const M = mul(Vinv, mul(o.calcTransformMatrix(), FLIP_Y));
  within(page, M, () =>
    page.drawImage(img, { x: -o.width / 2, y: -o.height / 2, width: o.width, height: o.height, opacity: alpha(o.opacity) }),
  );
}

/* ------------------------------ vectors ------------------------------ */

const K = 0.5522847498; // bezier circle constant
const fmt = (n) => (Math.round(n * 1000) / 1000).toString();

/** The object's outline as an SVG path in scene coordinates, or null if not a vector shape. */
function scenePath(o) {
  const T = o.calcTransformMatrix();
  const pt = (x, y) => {
    const q = apply(T, x, y);
    return `${fmt(q.x)} ${fmt(q.y)}`;
  };
  if (o instanceof Rect) {
    const w = o.width / 2;
    const h = o.height / 2;
    return `M ${pt(-w, -h)} L ${pt(w, -h)} L ${pt(w, h)} L ${pt(-w, h)} Z`;
  }
  if (o instanceof Ellipse) {
    const { rx, ry } = o;
    return [
      `M ${pt(rx, 0)}`,
      `C ${pt(rx, K * ry)} ${pt(K * rx, ry)} ${pt(0, ry)}`,
      `C ${pt(-K * rx, ry)} ${pt(-rx, K * ry)} ${pt(-rx, 0)}`,
      `C ${pt(-rx, -K * ry)} ${pt(-K * rx, -ry)} ${pt(0, -ry)}`,
      `C ${pt(K * rx, -ry)} ${pt(rx, -K * ry)} ${pt(rx, 0)} Z`,
    ].join(' ');
  }
  if (o instanceof Line) {
    const p = o.calcLinePoints();
    return `M ${pt(p.x1, p.y1)} L ${pt(p.x2, p.y2)}`;
  }
  if (o instanceof Path) {
    const { x: ox, y: oy } = o.pathOffset;
    return o.path
      .map(([cmd, ...nums]) => {
        if (cmd === 'Z' || cmd === 'z') return 'Z';
        const pts = [];
        for (let i = 0; i + 1 < nums.length; i += 2) pts.push(pt(nums[i] - ox, nums[i + 1] - oy));
        return `${cmd} ${pts.join(' ')}`;
      })
      .join(' ');
  }
  return null;
}

function drawVector(page, o, Vinv) {
  const d = scenePath(o);
  const closed = o instanceof Rect || o instanceof Ellipse || (o instanceof Path && /Z\s*$/i.test(d));
  const fill = closed || o instanceof Path ? parseColor(o.fill) : null;
  const stroke = o.strokeWidth > 0 ? parseColor(o.stroke) : null;
  if (!fill && !stroke) return;
  const T = o.calcTransformMatrix();
  const sw = o.strokeUniform ? o.strokeWidth : o.strokeWidth * Math.sqrt(Math.abs(T[0] * T[3] - T[1] * T[2]));
  const cap = { round: LineCapStyle.Round, square: LineCapStyle.Projecting }[o.strokeLineCap];
  const options = { x: 0, y: 0 };
  if (fill) Object.assign(options, { color: rgb(fill.r, fill.g, fill.b), opacity: alpha(fill.a * o.opacity) });
  if (stroke) {
    Object.assign(options, {
      borderColor: rgb(stroke.r, stroke.g, stroke.b),
      borderWidth: sw,
      borderOpacity: alpha(stroke.a * o.opacity),
      borderLineCap: cap,
    });
  }
  if (o.globalCompositeOperation === 'multiply') options.blendMode = BlendMode.Multiply;
  // drawSvgPath flips y itself, so pre-flip to keep SVG (scene) coordinates as-is.
  within(page, mul(Vinv, FLIP_Y), () => {
    if (o.strokeLineJoin === 'round') page.pushOperators(setLineJoin(LineJoinStyle.Round));
    page.drawSvgPath(d, options);
  });
}

/* ------------------------------ fallback ------------------------------ */

async function drawRaster(page, o, Vinv, ctx) {
  const scale = 3;
  const url = o.toDataURL({ format: 'png', multiplier: scale, withoutTransform: true, enableRetinaScaling: false });
  const png = await ctx.out.embedPng(dataUrlToBytes(url));
  const w = png.width / scale;
  const h = png.height / scale;
  const M = mul(Vinv, mul(o.calcTransformMatrix(), FLIP_Y));
  // Opacity is already baked into the rendered image.
  within(page, M, () => page.drawImage(png, { x: -w / 2, y: -h / 2, width: w, height: h }));
}
