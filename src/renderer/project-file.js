import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

// A project file (.vertex) is a zip archive: a manifest, the scene as JSON
// and folders of resources. This module only packs and unpacks it; what the
// entries mean is the editor's business.
//
//   manifest.json    { format, version, app, saved }
//   model.json       the mesh and the scene tree
//   view.json        the camera
//   materials.json   materials (none yet)
//   textures/        texture files: atlas.png, the project's atlas
//   preview.png      a small picture of the model, for the welcome screen

export const EXTENSION = 'vertex';
const PREVIEW = 'preview.png';
const isText = (name) => name.endsWith('.json');

// { name: string | Uint8Array } -> the archive's bytes. A name ending in '/'
// is a folder and is kept even when empty.
export function pack(files) {
  const entries = {};
  for (const [name, content] of Object.entries(files)) {
    entries[name] = typeof content === 'string' ? strToU8(content) : new Uint8Array(content ?? 0);
  }
  return zipSync(entries, { level: 6 });
}

// The archive's bytes -> { name: string | Uint8Array }: JSON entries as text,
// the rest as bytes. Throws if the bytes are not a zip archive.
export function unpack(bytes) {
  const files = {};
  for (const [name, content] of Object.entries(unzipSync(bytes))) {
    files[name] = isText(name) ? strFromU8(content) : content;
  }
  return files;
}

// The archive's bytes -> its picture of the model alone (the rest is not even
// unpacked), or null if it has none. Throws if the bytes are not a zip archive.
export function preview(bytes) {
  const found = unzipSync(bytes, { filter: (file) => file.name === PREVIEW });
  return found[PREVIEW]?.length ? found[PREVIEW] : null;
}
