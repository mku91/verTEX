const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate');

// A project file (.vertex) is a zip archive: a manifest, the scene as JSON
// and folders of resources. This module only packs and unpacks it; what the
// entries mean is the editor's business.
//
//   manifest.json    { format, version, app, saved }
//   model.json       the mesh and the scene tree
//   view.json        the camera
//   materials.json   materials (none yet)
//   textures/        texture files: atlas.png, the project's atlas

const EXTENSION = 'vertex';
const isText = (name) => name.endsWith('.json');

// { name: string | Uint8Array } -> the archive's bytes. A name ending in '/'
// is a folder and is kept even when empty.
function pack(files) {
  const entries = {};
  for (const [name, content] of Object.entries(files)) {
    entries[name] = typeof content === 'string' ? strToU8(content) : new Uint8Array(content ?? 0);
  }
  return Buffer.from(zipSync(entries, { level: 6 }));
}

// The archive's bytes -> { name: string | Uint8Array }: JSON entries as text,
// the rest as bytes. Throws if the bytes are not a zip archive.
function unpack(buffer) {
  const files = {};
  for (const [name, bytes] of Object.entries(unzipSync(new Uint8Array(buffer)))) {
    files[name] = isText(name) ? strFromU8(bytes) : bytes;
  }
  return files;
}

module.exports = { EXTENSION, pack, unpack };
