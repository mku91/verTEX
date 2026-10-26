// npm run release -- "what is new": puts the built version (npm run build,
// see dist.mjs) on GitHub as a release v<version>, with its installer and
// latest.json - from which the programs already installed learn of it and
// update themselves (see src-tauri/src/update.rs). The text goes with it: the
// release's description, and what the program shows when it offers the update.
//
// Needs a GitHub token allowed to write the repository's contents
// (GITHUB_TOKEN). A version is released once: raise it in package.json first.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const DIST = path.join(ROOT, 'dist');
const REPOSITORY = 'mku91/verTEX';
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const SETUP = `verTEX_${version}_x64-setup.exe`;
const notes = process.argv.slice(2).join(' ').trim();

const fail = (text) => {
  console.error(text);
  process.exit(1);
};
const token = process.env.GITHUB_TOKEN;
if (!token) fail('GITHUB_TOKEN is not set: a token that may write to the repository is needed.');
const latestFile = path.join(DIST, 'latest.json');
if (!fs.existsSync(latestFile) || !fs.existsSync(path.join(DIST, SETUP))) {
  fail(`dist/ has no ${SETUP} with its latest.json: npm run build first (signed, see scripts/tauri.mjs).`);
}
const latest = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
if (latest.version !== version) fail(`dist/ holds ${latest.version}, package.json says ${version}: build again.`);
latest.notes = notes;
latest.pub_date = new Date().toISOString();

const api = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', ...options.headers },
  });
  if (!response.ok) fail(`${options.method ?? 'GET'} ${url}: ${response.status} ${await response.text()}`);
  return response.json();
};

const tag = `v${version}`;
const existing = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/tags/${tag}`, {
  headers: { Authorization: `Bearer ${token}` },
});
if (existing.ok) fail(`${tag} is released already: raise the version in package.json.`);

const release = await api(`https://api.github.com/repos/${REPOSITORY}/releases`, {
  method: 'POST',
  body: JSON.stringify({ tag_name: tag, target_commitish: 'main', name: `verTEX ${version}`, body: notes }),
});
const upload = (name, bytes, type) =>
  api(`https://uploads.github.com/repos/${REPOSITORY}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': type },
    body: bytes,
  });
await upload(SETUP, fs.readFileSync(path.join(DIST, SETUP)), 'application/octet-stream');
await upload('latest.json', `${JSON.stringify(latest, null, 2)}\n`, 'application/json');
console.log(`Released ${tag}: ${release.html_url}`);
