// npm start: the program as it is being worked on - its page straight from
// the disk (serve.mjs), its core built for debugging - with the start shown
// as it goes, in per cent:
//
//    0 →  5   the page's server
//    5 → 80   the core built: cargo tells of every piece it has done (fresh
//             or compiled); how many there are, the last build told (kept
//             in src-tauri/target), the first time Cargo.lock guesses
//   82        the program started
//   85 → 90   its page loading, loaded
//   93        the window shown (the splash)
//  100        the editor's scripts all loaded
//
// The program's own lines (the core's [vertex] ones aside) go through. A
// build that fails shows what cargo said. The page's changes are taken by
// reloading it (Ctrl+R); the core's, by starting again.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { cargoEnv } from './cargo-env.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const CORE = path.join(ROOT, 'src-tauri');
const UNITS = path.join(CORE, 'target', '.start-units'); // how many pieces the last build had
const env = cargoEnv();
const children = new Set();

// --- the line that shows it ---------------------------------------------------
const tty = process.stdout.isTTY;
let shown = -1;
let lineOpen = false;
function progress(percent, what) {
  const value = Math.max(shown, Math.min(100, Math.round(percent)));
  if (!tty && value === shown) return;
  shown = value;
  const filled = Math.round(value / 5);
  const text = `verTEX: [${'='.repeat(filled)}${' '.repeat(20 - filled)}] ${String(value).padStart(3)}%  ${what}`;
  if (tty) {
    process.stdout.write(`\r${text.padEnd(process.stdout.columns ? process.stdout.columns - 1 : 80)}`);
    lineOpen = true;
  } else {
    process.stdout.write(`${text}\n`);
  }
}
// Anything else said: on a line of its own, not over the bar.
function say(text) {
  if (lineOpen) process.stdout.write('\n');
  lineOpen = false;
  process.stdout.write(`${text}\n`);
}

function stop(code) {
  for (const child of children) child.kill();
  process.exit(code);
}
process.on('SIGINT', () => stop(130));

function lines(stream, each) {
  readline.createInterface({ input: stream }).on('line', each);
}

// --- 1. the page's server ------------------------------------------------------
progress(0, 'starting the page server');
const server = spawn(process.execPath, [path.join(ROOT, 'scripts/serve.mjs')], { env });
children.add(server);
await new Promise((resolve) => {
  lines(server.stdout, (line) => { if (line.includes("verTEX's page on")) resolve(); });
  lines(server.stderr, (line) => {
    if (line.includes('EADDRINUSE')) {
      say('The page server\'s port (1430) is taken: is verTEX already started with npm start?');
      stop(1);
    }
  });
  server.on('exit', (code) => {
    say(`The page server stopped (${code}).`);
    stop(1);
  });
});
progress(5, 'building the core');

// --- 2. the core ------------------------------------------------------------------
function guessUnits() {
  try {
    return Number(fs.readFileSync(UNITS, 'utf8')) || 0;
  } catch {
    const lock = fs.readFileSync(path.join(CORE, 'Cargo.lock'), 'utf8');
    return Math.round((lock.match(/^\[\[package\]\]/gm)?.length ?? 400) * 1.3);
  }
}
const expected = guessUnits();
let units = 0;
const problems = [];
const built = await new Promise((resolve) => {
  const cargo = spawn('cargo', ['build', '--message-format=json-render-diagnostics', '--color', 'never'], { cwd: CORE, env });
  children.add(cargo);
  lines(cargo.stdout, (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.reason === 'compiler-artifact' || message.reason === 'build-script-executed') {
      units++;
      // (named when it is compiled now; done before, it is only counted)
      const name = message.reason === 'compiler-artifact' && !message.fresh ? ` ${message.target.name}` : '';
      progress(5 + 75 * Math.min(1, units / Math.max(expected, units)), `building the core (${units}/${Math.max(expected, units)})${name}`);
    }
  });
  // The rendered diagnostics, and cargo's own words: kept for a failure.
  lines(cargo.stderr, (line) => problems.push(line));
  cargo.on('exit', (code) => {
    children.delete(cargo);
    resolve(code === 0);
  });
});
if (!built) {
  say(problems.join('\n'));
  say('The core did not build.');
  stop(1);
}
fs.writeFileSync(UNITS, String(units));
progress(80, 'built');

// --- 3. the program ------------------------------------------------------------------
const STAGES = {
  page: [85, 'loading the page'],
  'page-done': [90, 'the page loaded, its scripts loading'],
  shown: [93, 'the window shown'],
  loaded: [100, 'ready'],
};
const program = spawn(path.join(CORE, 'target', 'debug', 'vertex.exe'), [], { cwd: ROOT, env });
children.add(program);
progress(82, 'starting');
lines(program.stdout, (line) => {
  const stage = /^\[vertex\] (\S+)/.exec(line)?.[1];
  if (stage) {
    if (STAGES[stage] && shown < 100) {
      progress(...STAGES[stage]);
      if (stage === 'loaded') say('');
    }
    return;
  }
  say(line);
});
lines(program.stderr, (line) => say(line));
program.on('exit', (code) => {
  children.delete(program);
  if (shown < 100) say(`verTEX stopped before it was ready (${code}).`);
  stop(code ?? 0);
});
