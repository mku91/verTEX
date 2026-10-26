// The Tauri CLI (npm run build), with Rust's tools found (see cargo-env.mjs).
// A build signs what updates the program (see src-tauri/src/update.rs) with
// the key in ~/.tauri/verTEX.key; without it - another machine - it is built
// all the same, only with nothing to update from.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cargoEnv } from './cargo-env.mjs';

const cli = createRequire(import.meta.url).resolve('@tauri-apps/cli/tauri.js');
const args = process.argv.slice(2);
const env = cargoEnv();
const KEY = path.join(os.homedir(), '.tauri', 'verTEX.key');
if (args[0] === 'build' && !env.TAURI_SIGNING_PRIVATE_KEY) {
  if (fs.existsSync(KEY)) {
    env.TAURI_SIGNING_PRIVATE_KEY = KEY;
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= '';
  } else {
    console.log(`(no ${KEY}: built without the update files)`);
    args.push('--config', JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
  }
}
const { status } = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit', env });
process.exit(status ?? 1);
