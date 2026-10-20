// The page as the built program carries it (npm run build): build/web, laid
// out as the project is, with only what it uses of node_modules: the modules
// its scripts import, followed import by import from the ones it names (see
// the import map in index.html). They go into vendor/ - Tauri will not take
// a folder named node_modules - and the import map is told so.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const OUT = path.join(ROOT, 'build/web');
const PAGE = ['src/renderer', 'src/locales', 'src/fonts'];
const ENTRIES = [
  'node_modules/three/build/three.module.js',
  'node_modules/@dimforge/rapier3d-compat/dist/rapier.mjs',
  'node_modules/fflate/esm/browser.js',
];

fs.rmSync(OUT, { recursive: true, force: true });
for (const folder of PAGE) fs.cpSync(path.join(ROOT, folder), path.join(OUT, folder), { recursive: true });

// The three.js addons the page uses: whatever it imports as three/addons/...
const ADDONS = 'node_modules/three/examples/jsm/';
for (const file of fs.readdirSync(path.join(ROOT, 'src/renderer'))) {
  if (!file.endsWith('.js')) continue;
  const text = fs.readFileSync(path.join(ROOT, 'src/renderer', file), 'utf8');
  for (const [, name] of text.matchAll(/from\s+'three\/addons\/([^']+)'/g)) ENTRIES.push(ADDONS + name);
}

// Each module, and the ones it imports by a relative path.
const seen = new Set();
const queue = [...ENTRIES];
while (queue.length) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const [, name] of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    queue.push(path.posix.join(path.posix.dirname(file), name));
  }
}
const VENDOR = (file) => file.replace(/^node_modules\//, 'vendor/');
for (const file of seen) {
  fs.mkdirSync(path.dirname(path.join(OUT, VENDOR(file))), { recursive: true });
  fs.copyFileSync(path.join(ROOT, file), path.join(OUT, VENDOR(file)));
}
const page = path.join(OUT, 'src/renderer/index.html');
fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replaceAll('../../node_modules/', '../../vendor/'));
console.log(`build/web: the page and ${seen.size} modules of node_modules`);
