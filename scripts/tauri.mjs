// The Tauri CLI (npm run build), with Rust's tools found (see cargo-env.mjs).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cargoEnv } from './cargo-env.mjs';

const cli = createRequire(import.meta.url).resolve('@tauri-apps/cli/tauri.js');
const { status } = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit', env: cargoEnv() });
process.exit(status ?? 1);
