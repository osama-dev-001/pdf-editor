// Copies pdf.js character maps and standard fonts into /public so pdf.js can
// render PDFs that rely on them (CJK text, non-embedded standard fonts).
import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pdfjs-dist');
if (!existsSync(src)) process.exit(0);
for (const dir of ['cmaps', 'standard_fonts']) {
  cpSync(join(src, dir), join(root, 'public', 'pdfjs', dir), { recursive: true });
}
console.log('Copied pdf.js cmaps and standard fonts to public/pdfjs');
