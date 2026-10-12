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

export const PALETTE_FILES = '.aseprite,.ase,.gpl,.pal,.hex,.act,.png';
const MOST = 1024; // colours; a picture that is no palette would give no end of them

// A palette to start with: PICO-8's sixteen.
export const DEFAULT_PALETTE = {
  name: 'PICO-8',
  colors: ['000000', '1d2b53', '7e2553', '008751', 'ab5236', '5f574f', 'c2c3c7', 'fff1e8', 'ff004d', 'ffa300', 'ffec27', '00e436', '29adff', '83769c', 'ff77a8', 'ffccaa']
    .map((hex) => [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16))),
};

const fail = (what) => {
  throw new Error(what);
};
const textOf = (bytes) => new TextDecoder().decode(bytes);
const linesOf = (bytes) => textOf(bytes).split(/\r?\n/).map((line) => line.trim());

// GIMP: a heading, then "r g b" and whatever the colour is called.
function gpl(bytes) {
  const lines = linesOf(bytes);
  if (!/^GIMP Palette/i.test(lines[0] ?? '')) fail('это не палитра GIMP: нет заголовка «GIMP Palette»');
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
  if (bytes.length < 24) fail('файл палитры обрывается');
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
  if (bytes.length < 768) fail('это не таблица цветов .act: в ней меньше 256 цветов');
  const count = bytes.length >= 770 ? (bytes[768] << 8) | bytes[769] || 256 : 256;
  const colors = [];
  for (let i = 0; i < Math.min(count, 256); i++) colors.push([...bytes.subarray(i * 3, i * 3 + 3)]);
  return { colors };
}

// Aseprite's sprite: a header, then frames of chunks; the palette is a chunk
// of the first frame - the new kind (0x2019), or one of the two old ones.
function aseprite(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 128 + 16 || view.getUint16(4, true) !== 0xa5e0) fail('это не файл Aseprite');
  if (view.getUint16(128 + 4, true) !== 0xf1fa) fail('файл Aseprite повреждён: нет первого кадра');
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
  if (colors.length === 0) fail('в этом файле Aseprite нет палитры');
  return { colors };
}

// A picture: every colour it has that is not see-through, as they come.
async function picture(bytes) {
  let image;
  try {
    image = await createImageBitmap(new Blob([bytes]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch {
    fail('картинка не читается');
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
  if (colors.length > MOST) fail(`в картинке больше ${MOST} цветов: это не палитра`);
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
  else if (extension === 'pal') read = starts('RIFF') ? riff(bytes) : starts('JASC-PAL') ? jasc(bytes) : fail('неизвестный вид файла .pal: читаются JASC и RIFF');
  else if (extension === 'hex') read = hex(bytes);
  else if (extension === 'act') read = act(bytes);
  else if (extension === 'png') read = await picture(bytes);
  else fail(`файлы «.${extension}» не читаются: нужен ${PALETTE_FILES.split(',').join(', ')}`);
  // Each colour once, in the order they came.
  const seen = new Set();
  const colors = read.colors.filter((color) => {
    const sound = color.length === 3 && color.every((value) => Number.isInteger(value) && value >= 0 && value <= 255);
    const key = color.join(',');
    if (!sound || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MOST);
  if (colors.length === 0) fail('в файле не нашлось ни одного цвета');
  return { name: read.name || fileName.replace(/\.[^.]*$/, ''), colors };
}
