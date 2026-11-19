import './styles.css';
import { InteractiveFabricObject, IText } from 'fabric';
import {
  createIcons,
  createElement,
  MousePointer2,
  TextCursorInput,
  Type,
  Pencil,
  Highlighter,
  Square,
  Circle,
  Minus,
  MoveUpRight,
  Eraser,
  Image,
  Signature,
  FolderOpen,
  FilePlus2,
  FilePlus,
  Files,
  Undo2,
  Redo2,
  Save,
  Download,
  RotateCw,
  Trash2,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  FileText,
  X,
  Upload,
  Bold,
  Italic,
  Underline,
  AlignLeft,
  AlignCenter,
  AlignRight,
  CopyPlus,
  BringToFront,
  SendToBack,
  LayoutGrid,
  Share2,
  FileCheck2,
  Copy,
  ClipboardPaste,
  ImageDown,
} from 'lucide';
import { doc, on, setDirty, canUndo, canRedo } from './state.js';
import { Editor } from './editor.js';
import { Props } from './props.js';
import { SignatureDialog } from './signature.js';
import { isPasswordError } from './pdf.js';
import { installTouchGestures } from './gestures.js';
import { $, $$, toast, withBusy, confirmDialog, isTypingTarget, loadImageFile, downloadBytes } from './util.js';

/* ------------------------------ setup ------------------------------ */

createIcons({
  icons: {
    MousePointer2, TextCursorInput, Type, Pencil, Highlighter, Square, Circle, Minus, MoveUpRight, Eraser,
    Image, Signature, FolderOpen, FilePlus2, FilePlus, Files, Undo2, Redo2, Save, Download, RotateCw, Trash2,
    ChevronLeft, ChevronRight, ZoomIn, ZoomOut, FileText, X, Upload, Bold, Italic, Underline, AlignLeft,
    AlignCenter, AlignRight, CopyPlus, BringToFront, SendToBack, LayoutGrid, Share2, FileCheck2, Copy,
    ClipboardPaste, ImageDown,
  },
});

const isTouchUI = window.matchMedia('(pointer: coarse)').matches;

// Selection handles styling for all editable objects.
Object.assign(InteractiveFabricObject.ownDefaults, {
  borderColor: '#2563eb',
  cornerColor: '#ffffff',
  cornerStrokeColor: '#2563eb',
  cornerStyle: 'circle',
  cornerSize: 10,
  transparentCorners: false,
  borderScaleFactor: 1.5,
  padding: 2,
});
Object.assign(IText.ownDefaults, {
  cursorColor: '#2563eb',
  editingBorderColor: 'rgba(37, 99, 235, 0.6)',
  selectionColor: 'rgba(37, 99, 235, 0.25)',
});

const editor = new Editor({ scroller: $('#viewer'), pagesEl: $('#pages'), thumbsEl: $('#thumbs') });
installTouchGestures(editor, $('#viewer'), $('#pages'));
const props = new Props(editor);
const signature = new SignatureDialog((url) => editor.placeImage(url, 'signature', 180));
const SHAPES = ['rect', 'ellipse', 'line', 'arrow'];
const SHAPE_ICONS = { rect: Square, ellipse: Circle, line: Minus, arrow: MoveUpRight };
const PDF_TYPES = [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }];

/* ------------------------------ files ------------------------------ */

const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

async function confirmDiscard() {
  if (!doc.dirty) return true;
  return confirmDialog({
    title: 'Discard unsaved changes?',
    message: 'Your edits to this document have not been saved.',
    confirmText: 'Discard changes',
    danger: true,
  });
}

async function openFile(file, handle = null) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await withBusy('Opening…', () => editor.loadDocument(bytes, file.name, handle));
  } catch (err) {
    console.error(err);
    toast(
      isPasswordError(err)
        ? 'This PDF is password-protected. Remove the password first, then open it here.'
        : `Couldn't open “${file.name}”. Is it a valid PDF?`,
      'error',
      5000,
    );
  }
}

async function pickAndOpen() {
  if (!(await confirmDiscard())) return;
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({ types: PDF_TYPES });
      await openFile(await handle.getFile(), handle);
    } catch (err) {
      if (err.name !== 'AbortError') toast(err.message, 'error');
    }
  } else {
    $('#file-pdf').click();
  }
}

async function appendFiles(files) {
  for (const f of files) {
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const n = await withBusy(`Adding ${f.name}…`, () => editor.appendDocument(bytes, f.name));
      toast(`Added ${n} page${n === 1 ? '' : 's'} from ${f.name}`, 'success');
    } catch (err) {
      console.error(err);
      toast(isPasswordError(err) ? `${f.name} is password-protected.` : `Couldn't read ${f.name}.`, 'error');
    }
  }
  if (files.length) editor.scrollToPage(doc.pages.length - 1);
}

async function insertImageFiles(files) {
  for (const f of files) {
    try {
      const { dataUrl } = await loadImageFile(f);
      await editor.placeImage(dataUrl, 'image');
    } catch (err) {
      console.error(err);
      toast(`Couldn't insert ${f.name || 'image'}.`, 'error');
    }
  }
}

async function handleDroppedFiles(files) {
  const pdfs = files.filter(isPdf);
  const images = files.filter((f) => f.type.startsWith('image/'));
  if (!pdfs.length && !images.length) {
    toast('Drop a PDF to open it, or an image to place it on the page.', 'info');
    return;
  }
  if (!editor.hasDocument) {
    if (!pdfs.length) return toast('Open a PDF first, then drop images onto it.', 'info');
    await openFile(pdfs.shift());
  }
  if (pdfs.length) await appendFiles(pdfs);
  if (images.length) await insertImageFiles(images);
}

async function writeToHandle(handle, bytes) {
  const w = await handle.createWritable();
  await w.write(bytes);
  await w.close();
}

async function buildBytes() {
  try {
    return await withBusy('Preparing PDF…', () => editor.exportPdf());
  } catch (err) {
    console.error(err);
    toast(`Couldn't create the PDF: ${err.message}`, 'error', 6000);
    return null;
  }
}

async function save({ saveAs = false } = {}) {
  if (!editor.hasDocument) return;
  const bytes = await buildBytes();
  if (!bytes) return;
  try {
    if (!saveAs && doc.fileHandle?.createWritable) {
      await writeToHandle(doc.fileHandle, bytes);
    } else if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({ suggestedName: doc.name, types: PDF_TYPES });
      await writeToHandle(handle, bytes);
      doc.fileHandle = handle;
      doc.name = handle.name;
    } else {
      deliver(bytes);
      return;
    }
    setDirty(false);
    toast(`Saved ${doc.name}`, 'success');
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    toast(`Couldn't save: ${err.message}. Try Download instead.`, 'error', 6000);
  }
}

async function download() {
  if (!editor.hasDocument) return;
  const bytes = await buildBytes();
  if (bytes) deliver(bytes);
}

/**
 * Hands the finished PDF to the user. On phones that can share files, show a
 * sheet whose button starts the system share (WhatsApp, Mail, Files, Drive…);
 * the share has to start from a tap, which the build step's delay would break.
 */
function deliver(bytes) {
  const file = new File([bytes], doc.name, { type: 'application/pdf' });
  let canShare = false;
  try {
    canShare = isTouchUI && !!navigator.canShare?.({ files: [file] });
  } catch {
    canShare = false;
  }
  if (!canShare) {
    downloadBytes(bytes, doc.name);
    setDirty(false);
    return;
  }
  const modal = $('#ready-modal');
  $('#ready-name').textContent = doc.name;
  modal.hidden = false;
  $('#ready-share').onclick = async () => {
    try {
      await navigator.share({ files: [file], title: doc.name });
      modal.hidden = true;
      setDirty(false);
    } catch (err) {
      if (err.name !== 'AbortError') toast(`Couldn't share: ${err.message}`, 'error');
    }
  };
  $('#ready-download').onclick = () => {
    downloadBytes(bytes, doc.name);
    modal.hidden = true;
    setDirty(false);
  };
}

$('#ready-modal').addEventListener('click', (e) => {
  if (e.target.id === 'ready-modal' || e.target.closest('[data-close]')) $('#ready-modal').hidden = true;
});

/* ------------------------------ pages drawer (phones) ------------------------------ */

const setPagesOpen = (open) => document.body.classList.toggle('pages-open', open);
$('#btn-pages').addEventListener('click', () => setPagesOpen(!document.body.classList.contains('pages-open')));
$('#btn-close-pages').addEventListener('click', () => setPagesOpen(false));
$('#drawer-backdrop').addEventListener('click', () => setPagesOpen(false));
editor.thumbs.onNavigate = () => {
  if (window.matchMedia('(max-width: 760px)').matches) setPagesOpen(false);
};

/* ------------------------------ buttons ------------------------------ */

$('#btn-open').addEventListener('click', pickAndOpen);
$('#empty-open').addEventListener('click', pickAndOpen);
const newDoc = async () => (await confirmDiscard()) && editor.newBlankDocument();
$('#btn-new').addEventListener('click', newDoc);
$('#empty-new').addEventListener('click', newDoc);
$('#btn-add-pdf').addEventListener('click', () => $('#file-merge').click());
$('#btn-undo').addEventListener('click', () => editor.undo());
$('#btn-redo').addEventListener('click', () => editor.redo());
$('#btn-save').addEventListener('click', () => save());
$('#btn-download').addEventListener('click', download);

$('#file-pdf').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) await openFile(f);
});
$('#file-merge').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  await appendFiles(files);
});
$('#file-image').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  await insertImageFiles(files);
});

// Tools
$('#tools').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tool]');
  if (!b) return;
  const tool = b.dataset.tool;
  if (tool === 'image') return $('#file-image').click();
  if (tool === 'signature') return signature.open();
  if (tool === 'shape') {
    const menu = $('#shape-menu');
    const wasOpen = !menu.hidden;
    editor.setTool('shape');
    menu.hidden = wasOpen;
    return;
  }
  editor.setTool(tool);
});
$('#shape-menu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-shape]');
  if (!b) return;
  editor.setTool(b.dataset.shape);
  $('#shape-menu').hidden = true;
});
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.tool-flyout')) $('#shape-menu').hidden = true;
});

// Pages
$('#btn-insert-blank').addEventListener('click', () => editor.insertBlankPage(editor.currentIndex));
$('#btn-rotate-page').addEventListener('click', () => editor.rotatePage(editor.currentIndex, 90));
$('#btn-delete-page').addEventListener('click', () => editor.deletePage(editor.currentIndex));
$('#btn-prev').addEventListener('click', () => editor.scrollToPage(editor.currentIndex - 1));
$('#btn-next').addEventListener('click', () => editor.scrollToPage(editor.currentIndex + 1));
$('#page-input').addEventListener('change', (e) => {
  const n = parseInt(e.target.value, 10);
  if (n >= 1) editor.scrollToPage(n - 1);
  e.target.value = editor.currentIndex + 1;
  e.target.blur();
});
$('#page-input').addEventListener('keydown', (e) => e.key === 'Enter' && e.target.blur());
$('#btn-zoom-in').addEventListener('click', () => editor.zoomBy(1.2));
$('#btn-zoom-out').addEventListener('click', () => editor.zoomBy(1 / 1.2));
$('#zoom-label').addEventListener('click', () => editor.setZoom(editor.fitZoom('width')));

$('#viewer').addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const r = $('#viewer').getBoundingClientRect();
    editor.zoomBy(Math.exp(-e.deltaY * 0.0025), { x: e.clientX - r.left, y: e.clientY - r.top });
  },
  { passive: false },
);

/* ------------------------------ state → UI ------------------------------ */

function updateDocUI() {
  const has = editor.hasDocument;
  document.body.classList.toggle('no-doc', !has);
  $$('.needs-doc').forEach((b) => (b.disabled = !has));
  $('#empty').hidden = has;
  $('#doc-title').hidden = !has;
  $('#doc-name').textContent = doc.name;
  $('#dirty-dot').hidden = !doc.dirty;
  document.title = has ? `${doc.dirty ? '• ' : ''}${doc.name} — PDF Editor` : 'PDF Editor';
  updateHistoryUI();
}

function updateHistoryUI() {
  $('#btn-undo').disabled = !editor.hasDocument || !canUndo();
  $('#btn-redo').disabled = !editor.hasDocument || !canRedo();
}

on('document', updateDocUI);
on('dirty', updateDocUI);
on('history', updateHistoryUI);
on('pages', () => {
  $('#page-count').textContent = doc.pages.length;
  $('#btn-delete-page').disabled = doc.pages.length <= 1;
});
on('current', (i) => {
  if (document.activeElement !== $('#page-input')) $('#page-input').value = i + 1;
});
on('zoom', (z) => ($('#zoom-label').textContent = `${Math.round(z * 100)}%`));
on('tool', (tool) => {
  $$('#tools [data-tool]').forEach((b) => {
    const t = b.dataset.tool;
    b.classList.toggle('active', t === tool || (t === 'shape' && SHAPES.includes(tool)));
  });
  const icon = $('#shape-tool svg');
  if (icon) icon.replaceWith(createElement(SHAPE_ICONS[editor.shape]));
  $$('#shape-menu [data-shape]').forEach((b) => b.classList.toggle('active', b.dataset.shape === tool));
});

window.addEventListener('beforeunload', (e) => {
  if (doc.dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/* ------------------------------ keyboard ------------------------------ */

const TOOL_KEYS = { v: 'select', e: 'editText', t: 'text', d: 'draw', h: 'highlight', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', w: 'whiteout' };

document.addEventListener('keydown', (e) => {
  if (signature.isOpen || document.querySelector('.confirm-card') || !$('#ready-modal').hidden) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (mod && key === 'o') {
    e.preventDefault();
    pickAndOpen();
    return;
  }
  if (!editor.hasDocument) return;
  if (mod && key === 's') {
    e.preventDefault();
    save({ saveAs: e.shiftKey });
    return;
  }
  // Formatting shortcuts also work while typing in a text box.
  if (mod && (key === 'b' || key === 'i' || key === 'u') && props.ctx === 'text' && props.objects.length) {
    e.preventDefault();
    props.toggle({ b: 'bold', i: 'italic', u: 'underline' }[key]);
    return;
  }
  if (isTypingTarget(e.target)) return;

  if (mod) {
    if (key === 'z') e.shiftKey ? editor.redo() : editor.undo();
    else if (key === 'y') editor.redo();
    else if (key === 'd') editor.duplicateSelection();
    else if (key === '=' || key === '+') editor.zoomBy(1.2);
    else if (key === '-') editor.zoomBy(1 / 1.2);
    else if (key === '0') editor.setZoom(editor.fitZoom('width'));
    else return;
    e.preventDefault();
    return;
  }

  if (key === 'delete' || key === 'backspace') {
    e.preventDefault();
    editor.deleteSelection();
    return;
  }
  if (key === 'escape') {
    const { view } = editor.getSelection();
    view?.canvas?.discardActiveObject();
    view?.canvas?.requestRenderAll();
    editor.setTool('select');
    $('#shape-menu').hidden = true;
    return;
  }
  const arrows = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
  if (arrows[key]) {
    const step = e.shiftKey ? 10 : 1;
    if (editor.nudge(arrows[key][0] * step, arrows[key][1] * step)) e.preventDefault();
    return;
  }
  if (key === 'pagedown') {
    e.preventDefault();
    editor.scrollToPage(editor.currentIndex + 1);
    return;
  }
  if (key === 'pageup') {
    e.preventDefault();
    editor.scrollToPage(editor.currentIndex - 1);
    return;
  }
  if (TOOL_KEYS[key]) editor.setTool(TOOL_KEYS[key]);
  else if (key === 'i') $('#file-image').click();
  else if (key === 's') signature.open();
});

// Copy / paste objects and pictures from the PDF, and paste images from the system clipboard.
document.addEventListener('copy', (e) => {
  if (!editor.hasDocument || isTypingTarget(e.target)) return;
  if (editor.getSelection().objects.length) {
    e.preventDefault();
    editor.copySelection();
  } else if (editor.imagePicker.selection) {
    e.preventDefault();
    editor.imagePicker.copy();
  }
});
document.addEventListener('paste', async (e) => {
  if (!editor.hasDocument || isTypingTarget(e.target)) return;
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) {
    e.preventDefault();
    // Our own copied PDF picture comes back as a file: paste our copy instead,
    // which keeps its size and position.
    if (files.length === 1 && (await isCopiedPdfImage(files[0]))) editor.paste();
    else await insertImageFiles(files);
  } else if (editor.clipboard) {
    e.preventDefault();
    editor.paste();
  }
});

async function isCopiedPdfImage(file) {
  const info = editor.clipboardImage;
  if (!info) return false;
  if (info.preferInternal) return true; // the system clipboard couldn't take our copy
  try {
    const bmp = await createImageBitmap(file);
    const same = bmp.width === info.width && bmp.height === info.height;
    bmp.close();
    return same;
  } catch {
    return false;
  }
}

// Clicking the gray area around the pages drops a selected PDF picture.
$('#viewer').addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.page')) editor.imagePicker.clear();
});

/* ------------------------------ drag & drop ------------------------------ */

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  $('#drop-text').textContent = editor.hasDocument ? 'Drop a PDF to add its pages, or an image to place it' : 'Drop a PDF to open it';
  $('#drop-overlay').hidden = false;
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('#drop-overlay').hidden = true;
  }
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').hidden = true;
  const files = [...e.dataTransfer.files];
  if (!editor.hasDocument && !(await confirmDiscard())) return;
  await handleDroppedFiles(files);
});

/* ------------------------------ tooltips ------------------------------ */

const tip = document.createElement('div');
tip.className = 'tooltip';
tip.hidden = true;
document.body.appendChild(tip);
let tipTimer = null;
document.addEventListener('pointerover', (e) => {
  const t = e.pointerType === 'touch' ? null : e.target.closest?.('[data-tip]');
  clearTimeout(tipTimer);
  if (!t) {
    tip.hidden = true;
    return;
  }
  tipTimer = setTimeout(() => {
    if (!t.isConnected) return;
    tip.textContent = t.dataset.tip;
    tip.hidden = false;
    const r = t.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    let top = r.bottom + 8;
    if (top + tr.height > window.innerHeight - 8) top = r.top - tr.height - 8;
    const left = Math.min(window.innerWidth - tr.width - 8, Math.max(8, r.left + r.width / 2 - tr.width / 2));
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }, 450);
});
document.addEventListener('pointerdown', () => {
  clearTimeout(tipTimer);
  tip.hidden = true;
});

/* ------------------------------ start ------------------------------ */

updateDocUI();
editor.setTool('select');

// Offline support + "install as app" (only in production builds served over HTTPS/localhost).
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service worker not registered', err));
  });
}

// Expose for debugging in the browser console.
window.pdfEditor = { editor, doc };
