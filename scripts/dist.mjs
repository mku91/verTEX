// What npm run build leaves in dist/:
//   verTEX.exe - the program itself, one file (the page and all it uses are inside);
//   verTEX_<version>_x64-setup.exe - its installer, what is given to people;
//   and, when the build was signed (see tauri.mjs), what a release needs for
//   the programs already installed to update themselves (see release.mjs):
//   the installer's signature (.sig) and latest.json, which points to it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const DIST = path.join(ROOT, 'dist');
const RELEASE = path.join(ROOT, 'src-tauri/target/release');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const REPOSITORY = 'mku91/verTEX';
const SETUP = `verTEX_${version}_x64-setup.exe`;

fs.mkdirSync(DIST, { recursive: true });
// (The installers of earlier versions go: only this one's is released.)
for (const name of fs.readdirSync(DIST)) {
  if (/^verTEX_.*-setup\.exe(\.sig)?$|^latest\.json$/.test(name)) fs.rmSync(path.join(DIST, name));
}
const copy = (from, name = path.basename(from)) => {
  fs.copyFileSync(from, path.join(DIST, name));
  console.log(`dist/${name}: ${(fs.statSync(from).size / 1048576).toFixed(1)} MB`);
};
copy(path.join(RELEASE, 'verTEX.exe'));
const setup = path.join(RELEASE, 'bundle/nsis', SETUP);
copy(setup);
if (fs.existsSync(`${setup}.sig`)) {
  fs.copyFileSync(`${setup}.sig`, path.join(DIST, `${SETUP}.sig`));
  const latest = {
    version,
    notes: '',
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64': {
        signature: fs.readFileSync(`${setup}.sig`, 'utf8'),
        url: `https://github.com/${REPOSITORY}/releases/download/v${version}/${SETUP}`,
      },
    },
  };
  fs.writeFileSync(path.join(DIST, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
  console.log('dist/latest.json');
}
