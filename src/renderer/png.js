import { zlibSync } from 'fflate';

// Pictures made PNG files here, not by the canvas (toBlob, convertToBlob):
// the webview's own encoder waits for the page to be idle - and in the
// editor's window it never is, so every picture took a second (a project
// saved: two). Here it takes milliseconds.
//
// RGBA, 8 bits a channel, no interlacing; each row filtered the way that
// leaves the least to compress (the usual guess: the smallest sum of the
// filtered bytes taken as signed), then deflated.

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
  return out;
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

// `image`: an ImageData (or { width, height, data } as one) -> the file's bytes.
export function encodePNG({ width, height, data }) {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  const trial = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const above = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null;
    let bestCost = Infinity;
    for (let filter = 0; filter < 5; filter++) {
      let cost = 0;
      for (let i = 0; i < stride; i++) {
        const left = i >= 4 ? row[i - 4] : 0;
        const up = above ? above[i] : 0;
        const corner = above && i >= 4 ? above[i - 4] : 0;
        const predicted = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, corner);
        const value = (row[i] - predicted) & 0xff;
        trial[i] = value;
        cost += value < 128 ? value : 256 - value;
      }
      if (cost < bestCost) {
        bestCost = cost;
        raw[y * (stride + 1)] = filter;
        raw.set(trial, y * (stride + 1) + 1);
      }
      if (cost === 0) break; // (nothing to beat)
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA, deflate, adaptive filtering, no interlacing
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlibSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// A 2D canvas' picture as a PNG file's bytes.
export function canvasPNG(canvas) {
  return encodePNG(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height));
}
