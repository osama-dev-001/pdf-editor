# PDF Editor

A PDF editor that runs in your browser. Files are processed locally and never uploaded anywhere.

**Live:** <https://osama-dev-001.github.io/pdf-editor/> (works on phones; can be installed to the home screen and used offline)

## Run it

```bash
npm install
npm run dev        # opens http://localhost:5173
```

`npm run build` produces a static site in `dist/` that you can host anywhere (`npm run preview` serves it locally).

## Use it on your phone

The editor works on phones and tablets:

- One finger scrolls (Select / Edit text / Add text tools).
- One finger draws (Draw, Highlight, Shapes, Whiteout).
- Two fingers pinch-zoom and pan with any tool.
- Tools sit in a bottom bar, pages open from the grid button, and **Download** offers the system share sheet (WhatsApp, Mail, Files, Drive…).

**Quick try on the same Wi-Fi:** run `npm run phone` and open the "Network" address it prints (e.g. `http://192.168.1.20:5173`) on your phone. If Windows Firewall asks, allow Node on private networks. This mode needs your PC running and doesn't work offline.

**Permanent link (recommended):** host the built site for free. It's just static files, and documents still never leave the device. Over HTTPS the app can be **installed to the home screen** and **works offline**.

- **Netlify Drop (no setup):** run `npm run build`, then drag the `dist` folder onto <https://app.netlify.com/drop>. Sign up (free) to keep the site.
- **GitHub Pages (set up for this repo):** every push to `main` runs `.github/workflows/deploy.yml`, which builds the site and publishes it to the live link above. It takes about a minute; check progress on the repo's *Actions* tab. For a fork or copy, enable *Settings → Pages → Source: GitHub Actions* once.

To install it on your phone, open the link, then:

- **iPhone:** Share → *Add to Home Screen*
- **Android/Chrome:** ⋮ → *Install app*

## Features

| Tool | What it does |
| --- | --- |
| **Select** (V) | Move, resize, rotate, and restyle anything you've added. Click a picture in the PDF to copy or save it. Double-click page text to edit it. |
| **Edit text** (E) | Click a line of existing text to change it. The original is covered with a patch of the page's own background color, and an editable copy is placed exactly on the original baseline in the closest standard font (bold/italic detected). |
| **Add text** (T) | Click anywhere to type. Font, size, bold/italic/underline, color, alignment. |
| **Draw** (D) | Freehand pen. |
| **Highlight** (H) | Click a line of text to highlight it, or drag over any area. Highlights multiply like a real marker, so the text stays crisp. |
| **Shapes** (R / O / L / A) | Rectangle, ellipse, line, arrow. Shift constrains. |
| **Whiteout** (W) | Cover anything on the page. |
| **Image** (I) | Insert PNG/JPEG/WebP/GIF. You can also paste images from the clipboard or drop them on the page. |
| **Sign** (S) | Draw or type a signature. Recent signatures are remembered on this computer. |

**Pictures in the PDF:** with **Select**, click (or tap) a picture that's part of the PDF, then choose **Copy** (Ctrl+C) or **Save image** (PNG; on phones this opens the share sheet). Copies are full resolution, keep transparency, and are turned the way the picture appears on the page. Paste with Ctrl+V or the **Paste** button to put a movable copy on any page, or paste it into another app.

**Pages:** reorder by dragging thumbnails; rotate, duplicate, delete, insert blank pages; **Merge PDF** appends another document.

**General:** undo/redo for everything (Ctrl+Z / Ctrl+Y), copy/paste/duplicate (Ctrl+C / Ctrl+V / Ctrl+D), arrow keys nudge (Shift = 10pt), Ctrl+wheel zoom, Ctrl+S saves back to the file you opened (Chrome/Edge), **Download** always gives you a copy.

## How it works

```
pdf.js      renders each page + extracts text positions (for Edit text / Highlight)
Fabric.js   an interactive layer per page holding your edits
pdf-lib     writes the result: original pages are copied untouched, and edits are drawn on top
```

Edits are exported as real PDF content: text becomes real, selectable/searchable text, and shapes become vectors. The only exception is characters the 14 standard PDF fonts can't encode (e.g. Arabic, Chinese, emoji); those are embedded as high-resolution images so they still look right.

Source layout (`src/`):

- `editor.js` — document lifecycle, page operations, zoom, selection, clipboard
- `pageView.js` — one page on screen (lazy-loaded as you scroll)
- `tools.js` — what each tool does with the mouse; the Edit-text logic
- `exporter.js` — builds the output PDF (handles rotated pages and odd content streams)
- `state.js` — document model + undo history (immutable page records)
- `thumbnails.js`, `props.js`, `signature.js` — sidebar, properties bar, signature dialog
- `pdf.js` — pdf.js wrapper and text-line detection
- `pdfImages.js` — finds where the PDF's pictures sit on a page and extracts them at full resolution
- `imagePicker.js` — selecting a PDF picture; Copy / Save image
- `gestures.js` — two-finger pinch-zoom / pan on touch screens
- `../sw/sw-template.js` — service worker (offline + installable); the build fills in the file list

## Limitations (be aware)

- **Whiteout / Edit text are not redaction.** They hide content visually, but the original text is still inside the file and can be copied out. Don't use them to remove passwords, personal data, etc.
- Edited/added text uses Helvetica, Times or Courier, so it won't always match an unusual original font exactly.
- Your edits are flattened into the PDF on save. Reopening the saved file shows them as regular page content, so you can't move them anymore (you can still edit text on top with Edit text).
- Password-protected PDFs and form filling are not supported yet.
- Copy / Save image works on pictures (photos, scans, most logos). Graphics drawn as vector shapes or text, and rare one-color "stencil" images, can't be selected that way.
- Phone support was tested in an emulator (iPhone-sized touch screen in Edge), not on a physical device. The iPhone keyboard hand-off for typing is the part most worth checking on a real iPhone.

## Notes for this machine (Windows)

- `package.json` has `"overrides": { "rollup": "npm:@rollup/wasm-node" }` because Windows Application Control blocks Rollup's native `.node` binary. The WebAssembly build is slightly slower but needs no native binary.
- `vite.config.js` normalizes the drive letter of the project root. When the terminal starts in `c:\` (lowercase, as VS Code does), Vite otherwise loads some modules twice.
