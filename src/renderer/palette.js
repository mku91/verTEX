// Palettes: lists of colours for the brush, read from the files that pixel
// art programs keep them in. Aseprite saves a palette in any of these:
//
//   .aseprite .ase   a sprite; the palette is the one it is painted with
//   .gpl             GIMP's palette, text - Aseprite's own palettes are these
//   .pal             JASC (text) or Microsoft's RIFF (binary)
//   .hex             text, a colour a line: rrggbb
//   .act             Adobe's colour table: 256 colours, three bytes each
//   .png             a picture: its colours, in the order they are met
//
// A palette is { name, colors }, the colours [r, g, b] each (0..255).

import { t } from './i18n.js';

export const PALETTE_FILES = '.aseprite,.ase,.gpl,.pal,.hex,.act,.png';
const MOST = 1024; // colours; a picture that is no palette would give no end of them

// A palette to start with: Famicube's sixty-four, by Arne.
export const DEFAULT_PALETTE = {
  name: 'Famicube',
  colors: [
    '000000', 'e03c28', 'ffffff', 'd7d7d7', 'a8a8a8', '7b7b7b', '343434', '151515',
    '0d2030', '415d66', '71a6a1', 'bdffca', '25e2cd', '0a98ac', '005280', '00604b',
    '20b562', '58d332', '139d08', '004e00', '172808', '376d03', '6ab417', '8cd612',
    'beeb71', 'eeffa9', 'b6c121', '939717', 'cc8f15', 'ffbb31', 'ffe737', 'f68f37',
    'ad4e1a', '231712', '5c3c0d', 'ae6c37', 'c59782', 'e2d7b5', '4f1507', '823c3d',
    'da655e', 'e18289', 'f5b784', 'ffe9c5', 'ff82ce', 'cf3c71', '871646', 'a328b3',
    'cc69e4', 'd59cfc', 'fec9ed', 'e2c9ff', 'a675fe', '6a31ca', '5a1991', '211640',
    '3d34a5', '6264dc', '9ba0ef', '98dcff', '5ba8ff', '0a89ff', '024aca', '00177d',
  ].map((hex) => [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16))),
};

// A palette in the manner of Moebius (Jean Giraud): twice Famicube's, 128 -
// sixteen ramps of eight tones, dark to light, the shadows leaning to blue
// and violet, the lights to warm yellow, in even steps of lightness (built in
// OKLCH); the dusty pastels of a desert and its skies, a few bright notes
// (coral, magenta, turquoise, lemon), blue-black ink and a warm paper. A row
// a ramp: ink / paper, warm stone, sand, ochre, terracotta, coral, peach / skin, dusty rose, magenta, lilac, indigo, sky, turquoise, lemon, jade, olive / moss.
export const MOEBIUS_PALETTE = {
  name: 'Moebius 128',
  colors: [
    '060912', '1f2330', '3b4150', '5b6173', '7d8396', 'a6a5b9', 'd0c9da', 'fbeffc',
    '211416', '3c2b2b', '584441', '755f59', '907d71', 'ad9b8f', 'cbbbb0', 'e9dbd1',
    '391e1a', '55352a', '724e3b', '8d6a4e', 'a18b63', 'bda882', 'd9c7a5', 'f7e6c8',
    '410300', '5d2004', '7b3a02', '97570d', 'a57c08', 'c2993c', 'dcb86b', 'f6d794',
    '37001c', '57122b', '792739', '9b3f48', 'ba5d49', 'd47c65', 'eb9e84', 'ffc1a9',
    '420126', '650633', '89133d', 'a92b47', 'c8483c', 'de6855', 'f18a70', 'ffad92',
    '2d050f', '4e1e20', '723831', '955645', 'b37a52', 'd29c76', 'f0c09e', 'feeadc',
    '300f23', '4f2439', '6f3b50', '905468', 'b27079', 'd08f93', 'ebb1af', 'ffd7d0',
    '2f0028', '530143', '78095d', '9a2675', 'bf4082', 'dd6290', 'f8869d', 'feb4b5',
    '2b163c', '452c5a', '624479', '7f5d99', '9f78b5', 'c394c9', 'e7b2da', 'fed9e8',
    '0f073c', '231f5d', '393780', '5151a2', '6f6cc2', '9b85d6', 'c89fe3', 'f4bced',
    '01213a', '013b61', '105786', '2b75a8', '3f95c6', '5cb8dc', '82daec', 'adfcfb',
    '001e2a', '043947', '035667', '107486', '0596a0', '3cb7b6', '78d5c7', 'abf3d9',
    '434302', '5c5a07', '767209', '928b17', 'b3a319', 'cdbe47', 'e6d978', 'fff5aa',
    '022729', '05423f', '0c5e54', '0e7d67', '4a9a68', '72b582', '9bd09f', 'c2ecbc',
    '001610', '02321f', '134f26', '3e6b33', '798136', '979f5b', 'b7be82', 'd7dda8',
  ].map((hex) => [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16))),
};

// The palettes there are to choose from without a file (see ColorPopup).
export const BUILT_IN_PALETTES = [DEFAULT_PALETTE, MOEBIUS_PALETTE];

const fail = (what) => {
  throw new Error(what);
};
const textOf = (bytes) => new TextDecoder().decode(bytes);
const linesOf = (bytes) => textOf(bytes).split(/\r?\n/).map((line) => line.trim());

// GIMP: a heading, then "r g b" and whatever the colour is called.
function gpl(bytes) {
  const lines = linesOf(bytes);
  if (!/^GIMP Palette/i.test(lines[0] ?? '')) fail(t('palette.error.gpl'));
  let name = null;
  const colors = [];
  for (const line of lines.slice(1)) {
    const named = /^Name:\s*(.*)$/i.exec(line);
    if (named) name = named[1];
    const color = /^(\d+)\s+(\d+)\s+(\d+)/.exec(line);
    if (color) colors.push(color.slice(1, 4).map(Number));
  }
  return { name, colors };
}

// JASC: "JASC-PAL", a version, how many, then "r g b" a line.
function jasc(bytes) {
  const lines = linesOf(bytes);
  return { colors: lines.slice(3).map((line) => /^(\d+)\s+(\d+)\s+(\d+)/.exec(line)).filter(Boolean).map((found) => found.slice(1, 4).map(Number)) };
}

// Microsoft's: "RIFF", a size, "PAL data", a size, a version, how many, then r g b and a flag each.
function riff(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 24) fail(t('palette.error.truncated'));
  const count = view.getUint16(22, true);
  const colors = [];
  for (let i = 0; i < count && 24 + i * 4 + 3 <= bytes.length; i++) colors.push([...bytes.subarray(24 + i * 4, 27 + i * 4)]);
  return { colors };
}

function hex(bytes) {
  const colors = linesOf(bytes).map((line) => /^#?([0-9a-f]{6})$/i.exec(line)).filter(Boolean)
    .map((found) => [0, 2, 4].map((at) => parseInt(found[1].slice(at, at + 2), 16)));
  return { colors };
}

// Adobe's: 256 colours; a longer file says after them how many of those are meant.
function act(bytes) {
  if (bytes.length < 768) fail(t('palette.error.act'));
  const count = bytes.length >= 770 ? (bytes[768] << 8) | bytes[769] || 256 : 256;
  const colors = [];
  for (let i = 0; i < Math.min(count, 256); i++) colors.push([...bytes.subarray(i * 3, i * 3 + 3)]);
  return { colors };
}

// Aseprite's sprite: a header, then frames of chunks; the palette is a chunk
// of the first frame - the new kind (0x2019), or one of the two old ones.
function aseprite(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 128 + 16 || view.getUint16(4, true) !== 0xa5e0) fail(t('palette.error.aseprite'));
  if (view.getUint16(128 + 4, true) !== 0xf1fa) fail(t('palette.error.aseprite-frame'));
  const frameEnd = Math.min(bytes.length, 128 + view.getUint32(128, true));
  const chunks = view.getUint32(128 + 12, true) || view.getUint16(128 + 6, true);
  let fresh = null;
  let old = null;
  let at = 128 + 16;
  for (let n = 0; n < chunks && at + 6 <= frameEnd; n++) {
    const size = view.getUint32(at, true);
    const kind = view.getUint16(at + 4, true);
    const end = Math.min(frameEnd, at + size);
    let p = at + 6;
    if (kind === 0x2019 && p + 20 <= end) {
      const first = view.getUint32(p + 4, true);
      const last = view.getUint32(p + 8, true);
      p += 20;
      fresh ??= [];
      for (let i = first; i <= last && p + 6 <= end; i++) {
        const named = view.getUint16(p, true) & 1;
        fresh[i] = [bytes[p + 2], bytes[p + 3], bytes[p + 4]];
        p += 6;
        if (named) p += 2 + view.getUint16(p, true);
      }
    } else if ((kind === 0x0004 || kind === 0x0011) && p + 2 <= end) {
      // In packets: skip so many, then so many colours (0 = 256); the older of the two counts to 63.
      const packets = view.getUint16(p, true);
      p += 2;
      old ??= [];
      let index = 0;
      for (let packet = 0; packet < packets && p + 2 <= end; packet++) {
        index += bytes[p];
        const count = bytes[p + 1] || 256;
        p += 2;
        for (let i = 0; i < count && p + 3 <= end; i++, p += 3) {
          old[index++] = [...bytes.subarray(p, p + 3)].map((value) => (kind === 0x0011 ? Math.round((value * 255) / 63) : value));
        }
      }
    }
    if (size < 6) break;
    at += size;
  }
  const colors = (fresh ?? old ?? []).filter(Boolean);
  if (colors.length === 0) fail(t('palette.error.aseprite-palette'));
  return { colors };
}

// A picture: every colour it has that is not see-through, as they come.
async function picture(bytes) {
  let image;
  try {
    image = await createImageBitmap(new Blob([bytes]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch {
    fail(t('palette.error.picture'));
  }
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);
  const seen = new Set();
  const colors = [];
  for (let i = 0; i < data.length && colors.length <= MOST; i += 4) {
    if (data[i + 3] === 0) continue;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    if (seen.has(key)) continue;
    seen.add(key);
    colors.push([data[i], data[i + 1], data[i + 2]]);
  }
  if (colors.length > MOST) fail(t('palette.error.too-many', { most: MOST }));
  return { colors };
}

// The palette in a file, by the file's name and its bytes (a Uint8Array).
// What is not a palette is refused with an Error that says what is wrong.
export async function readPalette(fileName, bytes) {
  const extension = /\.([^.]+)$/.exec(fileName)?.[1].toLowerCase() ?? '';
  const starts = (word) => textOf(bytes.subarray(0, word.length)) === word;
  let read;
  if (extension === 'aseprite' || extension === 'ase') read = aseprite(bytes);
  else if (extension === 'gpl') read = gpl(bytes);
  else if (extension === 'pal') read = starts('RIFF') ? riff(bytes) : starts('JASC-PAL') ? jasc(bytes) : fail(t('palette.error.pal'));
  else if (extension === 'hex') read = hex(bytes);
  else if (extension === 'act') read = act(bytes);
  else if (extension === 'png') read = await picture(bytes);
  else fail(t('palette.error.extension', { extension, files: PALETTE_FILES.split(',').join(', ') }));
  // Each colour once, in the order they came.
  const seen = new Set();
  const colors = read.colors.filter((color) => {
    const sound = color.length === 3 && color.every((value) => Number.isInteger(value) && value >= 0 && value <= 255);
    const key = color.join(',');
    if (!sound || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MOST);
  if (colors.length === 0) fail(t('palette.error.no-colors'));
  return { name: read.name || fileName.replace(/\.[^.]*$/, ''), colors };
}
