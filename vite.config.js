import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

// On Windows, a lowercase drive letter in the working directory (e.g. "c:\" from
// VS Code's terminal) makes Vite resolve some modules as "c:/..." and others as
// "C:/...", which loads two copies of the same module. Normalize the root.
const root = dirname(fileURLToPath(import.meta.url)).replace(/^[a-z]:/, (d) => d.toUpperCase());

/** Emits sw.js with the list of built files to pre-cache for offline use. */
function serviceWorker() {
  return {
    name: 'service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      const precache = [
        './',
        ...files.map((f) => `./${f}`),
        './manifest.webmanifest',
        './icons/icon-192.png',
        './icons/icon-512.png',
      ];
      const template = readFileSync(join(root, 'sw', 'sw-template.js'), 'utf8');
      const source = template
        .replaceAll('__VERSION__', Date.now().toString(36))
        .replaceAll('__PRECACHE__', JSON.stringify(precache, null, 2));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  root,
  // Relative paths so the built site works from any folder or host (e.g. GitHub Pages).
  base: './',
  plugins: [serviceWorker()],
  // pdf.js uses top-level await, which needs an ES2022 target.
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  server: { port: 5173, open: true },
});
