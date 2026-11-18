/**
 * Document model + undo history.
 *
 * A document is an ordered list of immutable page records. A record points at a
 * page in a source PDF (or is a blank page) and carries the user's edits as
 * serialized Fabric objects. Because records are never mutated, a history
 * snapshot is just a shallow copy of the page array — cheap enough to take on
 * every change.
 */
import { FabricObject } from 'fabric';
import { uid } from './util.js';

// Custom properties we store on Fabric objects (serialized with them).
FabricObject.customProperties = ['kind', 'assetId'];

export const EMPTY_DATA = Object.freeze({ objects: Object.freeze([]) });

export const doc = {
  /** id -> { id, name, bytes: Uint8Array, pdf: PDFDocumentProxy, pages: Map<index, PDFPageProxy> } */
  sources: new Map(),
  /** PageRecord[]: { id, srcId|null, srcIndex, view:[x0,y0,x1,y1], baseRotation, rotation, data } */
  pages: [],
  name: 'Untitled.pdf',
  fileHandle: null,
  dirty: false,
};

/** Image data URLs, stored once and referenced by id so history snapshots stay small. */
export const assets = new Map();

/* --------------------------- events --------------------------- */
const listeners = new Map();
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, []);
  listeners.get(evt).push(fn);
}
export function emit(evt, ...args) {
  (listeners.get(evt) || []).forEach((fn) => fn(...args));
}

/* --------------------------- records --------------------------- */
export function makePageRecord({ srcId = null, srcIndex = 0, view, baseRotation = 0 }) {
  return { id: uid('pg'), srcId, srcIndex, view, baseRotation, rotation: 0, data: EMPTY_DATA };
}

export function totalRotation(rec) {
  return (((rec.baseRotation + rec.rotation) % 360) + 360) % 360;
}

/** Size of the page as displayed (after rotation), in PDF points. */
export function displaySize(rec) {
  const [x0, y0, x1, y1] = rec.view;
  const w = Math.abs(x1 - x0);
  const h = Math.abs(y1 - y0);
  return totalRotation(rec) % 180 ? { width: h, height: w } : { width: w, height: h };
}

export function setPages(pages) {
  doc.pages = pages;
}

export function replacePage(rec) {
  const i = doc.pages.findIndex((p) => p.id === rec.id);
  if (i >= 0) doc.pages[i] = rec;
}

/* ----------------------- serialization ----------------------- */
/** Serializes a Fabric canvas' objects, replacing embedded image data with asset ids. */
export function serializeCanvas(canvas) {
  const { objects } = canvas.toObject();
  return { objects: objects.map(stripAsset) };
}

export function serializeObjects(objs) {
  return { objects: objs.map((o) => stripAsset(o.toObject())) };
}

function stripAsset(o) {
  if (o.assetId && assets.has(o.assetId)) delete o.src;
  return o;
}

/** Inverse of serialize: puts image data back so Fabric can load the objects. */
export function hydrateObjects(objects) {
  return objects.map((o) => (o.assetId && assets.has(o.assetId) ? { ...o, src: assets.get(o.assetId) } : o));
}

/* --------------------------- history --------------------------- */
const MAX_HISTORY = 300;
const undoStack = [];
const redoStack = [];
let current = [];

export function resetHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  current = doc.pages.slice();
  emit('history');
}

/** Records the current doc.pages as a new history state. */
export function commit() {
  undoStack.push(current);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  current = doc.pages.slice();
  redoStack.length = 0;
  setDirty(true);
  emit('history');
}

export function undo() {
  if (!undoStack.length) return false;
  redoStack.push(current);
  current = undoStack.pop();
  doc.pages = current.slice();
  setDirty(true);
  emit('history');
  return true;
}

export function redo() {
  if (!redoStack.length) return false;
  undoStack.push(current);
  current = redoStack.pop();
  doc.pages = current.slice();
  setDirty(true);
  emit('history');
  return true;
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

export function setDirty(v) {
  doc.dirty = v;
  emit('dirty', v);
}
