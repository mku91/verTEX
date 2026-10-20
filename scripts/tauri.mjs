// The Tauri CLI (npm start, npm run build), with Rust's tools found even in a
// terminal started before Rust was installed: such a terminal keeps the
// PATH it began with, without ~/.cargo/bin.
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const cargo = path.join(os.homedir(), '.cargo', 'bin');
const PATH = process.env.PATH ?? process.env.Path ?? '';
const paths = PATH.split(path.delimiter).map((folder) => path.resolve(folder).toLowerCase());
const env = { ...process.env };
if (!paths.includes(cargo.toLowerCase())) {
  delete env.Path; // (Windows spells it either way; one is enough)
  env.PATH = `${cargo}${path.delimiter}${PATH}`;
}
const cli = createRequire(import.meta.url).resolve('@tauri-apps/cli/tauri.js');
const { status } = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit', env });
process.exit(status ?? 1);
