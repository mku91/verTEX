// The page while it is being worked on (npm start): the project's own files,
// straight from the disk, for the window to load (devUrl in
// src-tauri/tauri.conf.json). This machine only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const PORT = 1430;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.ico': 'image/x-icon',
};

http.createServer((request, response) => {
  const wanted = decodeURIComponent(new URL(request.url, 'http://x').pathname);
  const file = path.join(ROOT, wanted === '/' ? 'src/renderer/index.html' : wanted);
  if (!file.startsWith(ROOT + path.sep)) {
    response.writeHead(403).end();
    return;
  }
  fs.readFile(file, (error, bytes) => {
    if (error) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(bytes);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`verTEX's page on http://127.0.0.1:${PORT}`));
