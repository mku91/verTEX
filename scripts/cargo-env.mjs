// The environment with Rust's tools found even in a terminal started before
// Rust was installed: such a terminal keeps the PATH it began with, without
// ~/.cargo/bin.
import os from 'node:os';
import path from 'node:path';

export function cargoEnv(base = process.env) {
  const cargo = path.join(os.homedir(), '.cargo', 'bin');
  const PATH = base.PATH ?? base.Path ?? '';
  const paths = PATH.split(path.delimiter).map((folder) => path.resolve(folder).toLowerCase());
  const env = { ...base };
  if (!paths.includes(cargo.toLowerCase())) {
    delete env.Path; // (Windows spells it either way; one is enough)
    env.PATH = `${cargo}${path.delimiter}${PATH}`;
  }
  return env;
}
