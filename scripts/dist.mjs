// The built program, where npm run build leaves it: dist/verTEX.exe, the one
// file it is (the page and all it uses are inside).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const BUILT = path.join(ROOT, 'src-tauri/target/release/verTEX.exe');
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.copyFileSync(BUILT, path.join(ROOT, 'dist/verTEX.exe'));
console.log(`dist/verTEX.exe: ${(fs.statSync(BUILT).size / 1048576).toFixed(1)} MB`);
