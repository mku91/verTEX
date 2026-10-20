// "Искажение": a picture made retro - its colours corrected, noise put
// over it, brought down to a few colours (a palette, or a few levels of
// each channel) with dithering between them. Done to a piece of an atlas
// (see Editor.beginRetro()), pixel by pixel, in this order:
//
//   1. colour:    brightness, contrast, saturation, gamma;
//   2. noise:     a random amount added to each pixel - the same for the
//                 three channels (mono) or one each - in grains of a few
//                 pixels; from a seed, so that it comes out the same again,
//                 and laid by the atlas' pixels, not the piece's;
//   3. the colours it is brought down to: the palette's nearest - nearest
//                 as the eye has it, in OKLab, not in RGB, in which dark
//                 and blue colours come out wrong - or, without a palette,
//                 each channel to a few levels (posterizing); with neither,
//                 just whole values;
//   4. dithering: what is lost in bringing a pixel down made up for -
//                 ordered (a Bayer matrix: the threshold changes from pixel
//                 to pixel in a fixed pattern) or by error diffusion (the
//                 difference handed on to the pixels after it: Floyd-
//                 Steinberg, or Atkinson's, which hands on three quarters
//                 of it and keeps more contrast).
//
// An atlas is pieces of picture - the charts of faces - not one picture:
// the error is handed on only within a chart (`regions`), never across to
// another face's or the empty room between them. See-through pixels (as
// the surface draws them: alpha under a half) are left as they are.

import { t } from './i18n.js';

// The settings as they are at first, and what each may be.
export const RETRO_DEFAULTS = {
  brightness: 0, // -100 .. 100
  contrast: 0, // -100 .. 100
  saturation: 0, // -100 .. 100
  gamma: 1, // 0.2 .. 5
  noise: 0, // 0 .. 100
  grain: 1, // px, 1 .. 16
  mono: true,
  seed: 1,
  levels: 0, // posterizing: 2 .. 32 levels a channel; 0 off (and with a palette, not used)
  palette: false, // brought down to `colors`
  colors: [],
  dither: 'none', // 'none' | 'bayer2' | 'bayer4' | 'bayer8' | 'floyd' | 'atkinson'
  strength: 100, // % of the dithering
};

export const DITHERS = {
  none: t('retro.dither.none'),
  bayer2: t('retro.dither.bayer2'),
  bayer4: t('retro.dither.bayer4'),
  bayer8: t('retro.dither.bayer8'),
  floyd: t('retro.dither.floyd'),
  atkinson: t('retro.dither.atkinson'),
};

// Palettes of old machines and of pixel artists (lospec.com).
export const PALETTES = {
  'PICO-8': ['#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8', '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa'],
  'Game Boy': ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'],
  'Sweetie 16': ['#1a1c2c', '#5d275d', '#b13e53', '#ef7d57', '#ffcd75', '#a7f070', '#38b764', '#257179', '#29366f', '#3b5dc9', '#41a6f6', '#73eff7', '#f4f4f4', '#94b0c2', '#566c86', '#333c57'],
  'Endesga 32': ['#be4a2f', '#d77643', '#ead4aa', '#e4a672', '#b86f50', '#733e39', '#3e2731', '#a22633', '#e43b44', '#f77622', '#feae34', '#fee761', '#63c74d', '#3e8948', '#265c42', '#193c3e', '#124e89', '#0099db', '#2ce8f5', '#ffffff', '#c0cbdc', '#8b9bb4', '#5a6988', '#3a4466', '#262b44', '#181425', '#ff0044', '#68386c', '#b55088', '#f6757a', '#e8b796', '#c28569'],
  'Commodore 64': ['#000000', '#ffffff', '#68372b', '#70a4b2', '#6f3d86', '#588d43', '#352879', '#b8c76f', '#6f4f25', '#433900', '#9a6759', '#444444', '#6c6c6c', '#9ad284', '#6c5eb5', '#959595'],
  EGA: ['#000000', '#0000aa', '#00aa00', '#00aaaa', '#aa0000', '#aa00aa', '#aa5500', '#aaaaaa', '#555555', '#5555ff', '#55ff55', '#55ffff', '#ff5555', '#ff55ff', '#ffff55', '#ffffff'],
  'ZX Spectrum': ['#000000', '#0000d7', '#d70000', '#d700d7', '#00d700', '#00d7d7', '#d7d700', '#d7d7d7', '#0000ff', '#ff0000', '#ff00ff', '#00ff00', '#00ffff', '#ffff00', '#ffffff'],
  CGA: ['#000000', '#55ffff', '#ff55ff', '#ffffff'],
  [t('retro.palette.1bit')]: ['#000000', '#ffffff'],
};

// --- colours ---------------------------------------------------------------------

const clamp = (value) => (value < 0 ? 0 : value > 255 ? 255 : value);
export const hexOf = ([r, g, b]) => `#${[r, g, b].map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
export const rgbOf = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));

// A colour (sRGB, 0..255) in OKLab: [L, a, b].
function oklab(r, g, b) {
  const linear = (value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

// The nearest colour of a palette ([[r, g, b]]) to (r, g, b), as the eye
// has it: a function, remembering what it has found.
function nearestOf(palette) {
  const labs = palette.map(([r, g, b]) => oklab(r, g, b));
  const found = new Map();
  return (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    let best = found.get(key);
    if (best === undefined) {
      const [L, A, B] = oklab(r, g, b);
      let least = Infinity;
      labs.forEach(([l, a, bb], k) => {
        const d = (L - l) ** 2 + (A - a) ** 2 + (B - bb) ** 2;
        if (d < least) {
          least = d;
          best = k;
        }
      });
      found.set(key, best);
    }
    return palette[best];
  };
}

// A number from -1 to 1 for (x, y, channel), always the same for the same seed.
function hashed(seed, x, y, channel) {
  let h = Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(x | 0, 0x85ebca77) ^ Math.imul(y | 0, 0xc2b2ae3d) ^ Math.imul(channel + 1, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

// The Bayer matrix of size n (2, 4, 8), its thresholds from 0 to n² - 1.
function bayer(n) {
  if (n === 1) return [0];
  const half = bayer(n / 2);
  const h = n / 2;
  const out = new Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const base = 4 * half[(y % h) * h + (x % h)];
      const quadrant = [0, 2, 3, 1][(y < h ? 0 : 2) + (x < h ? 0 : 1)];
      out[y * n + x] = base + quadrant;
    }
  }
  return out;
}

// --- the picture made retro --------------------------------------------------------

// `image` (an ImageData) made retro by `settings` (see RETRO_DEFAULTS): a
// new ImageData. `origin` is where it is on the atlas (its noise and its
// ordered dithering are laid by the atlas' pixels); `regions` (an
// Int32Array, a number for every pixel of it: whose chart it is) keeps the
// diffused error within a chart - null: the whole of it is one.
export function retrofy(image, settings, { origin = { x: 0, y: 0 }, regions = null } = {}) {
  const s = { ...RETRO_DEFAULTS, ...settings };
  const { width, height } = image;
  const source = image.data;
  const out = new ImageData(new Uint8ClampedArray(source), width, height);
  const data = out.data;
  const count = width * height;
  const solid = (i) => source[i * 4 + 3] >= 128;

  // 1-2. Colour and noise, as fractions of 0..255 still (the bringing down follows).
  const values = new Float32Array(count * 3);
  const brightness = s.brightness * 2.55;
  const contrast = (100 + s.contrast) / 100;
  const saturation = 1 + s.saturation / 100;
  const gamma = 1 / Math.max(0.05, s.gamma);
  const noise = s.noise * 1.28;
  const grain = Math.max(1, Math.round(s.grain));
  for (let i = 0; i < count; i++) {
    if (!solid(i)) continue;
    let r = source[i * 4];
    let g = source[i * 4 + 1];
    let b = source[i * 4 + 2];
    r += brightness;
    g += brightness;
    b += brightness;
    r = (r - 128) * contrast + 128;
    g = (g - 128) * contrast + 128;
    b = (b - 128) * contrast + 128;
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    r = luma + (r - luma) * saturation;
    g = luma + (g - luma) * saturation;
    b = luma + (b - luma) * saturation;
    r = 255 * (clamp(r) / 255) ** gamma;
    g = 255 * (clamp(g) / 255) ** gamma;
    b = 255 * (clamp(b) / 255) ** gamma;
    if (noise > 0) {
      const gx = Math.floor((origin.x + (i % width)) / grain);
      const gy = Math.floor((origin.y + Math.floor(i / width)) / grain);
      if (s.mono) {
        const n = hashed(s.seed, gx, gy, 0) * noise;
        r += n;
        g += n;
        b += n;
      } else {
        r += hashed(s.seed, gx, gy, 0) * noise;
        g += hashed(s.seed, gx, gy, 1) * noise;
        b += hashed(s.seed, gx, gy, 2) * noise;
      }
    }
    values[i * 3] = r;
    values[i * 3 + 1] = g;
    values[i * 3 + 2] = b;
  }

  // 3. What a colour is brought down to - and how far apart the colours it
  // may come out are, a channel (the spread ordered dithering wobbles by).
  const palette = s.palette ? s.colors.map(rgbOf).filter((color) => color.every(Number.isFinite)) : [];
  const levels = palette.length === 0 && s.levels >= 2 ? Math.round(s.levels) : 0;
  let pick;
  let spread;
  if (palette.length) {
    const nearest = nearestOf(palette);
    pick = (r, g, b) => nearest(Math.round(clamp(r)), Math.round(clamp(g)), Math.round(clamp(b)));
    spread = 255 / Math.max(1, Math.cbrt(palette.length));
  } else if (levels) {
    const step = 255 / (levels - 1);
    const level = (value) => Math.round(clamp(value) / step) * step;
    pick = (r, g, b) => [level(r), level(g), level(b)];
    spread = step;
  } else {
    pick = (r, g, b) => [Math.round(clamp(r)), Math.round(clamp(g)), Math.round(clamp(b))];
    spread = 0;
  }
  const strength = Math.max(0, s.strength) / 100;

  // 4. Brought down, dithered.
  const write = (i, [r, g, b]) => {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
  };
  const ordered = { bayer2: 2, bayer4: 4, bayer8: 8 }[s.dither];
  if (ordered && spread > 0) {
    const matrix = bayer(ordered);
    const cells = ordered * ordered;
    for (let i = 0; i < count; i++) {
      if (!solid(i)) continue;
      const ax = origin.x + (i % width);
      const ay = origin.y + Math.floor(i / width);
      const t = ((matrix[(ay % ordered) * ordered + (ax % ordered)] + 0.5) / cells - 0.5) * spread * strength;
      write(i, pick(values[i * 3] + t, values[i * 3 + 1] + t, values[i * 3 + 2] + t));
    }
    return out;
  }
  const spreads = {
    floyd: [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]],
    atkinson: [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]],
  }[s.dither];
  if (spreads && spread > 0) {
    for (let i = 0; i < count; i++) {
      if (!solid(i)) continue;
      const r = values[i * 3];
      const g = values[i * 3 + 1];
      const b = values[i * 3 + 2];
      const chosen = pick(r, g, b);
      write(i, chosen);
      const er = (r - chosen[0]) * strength;
      const eg = (g - chosen[1]) * strength;
      const eb = (b - chosen[2]) * strength;
      const x = i % width;
      const y = Math.floor(i / width);
      const region = regions ? regions[i] : 0;
      for (const [dx, dy, share] of spreads) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (!solid(j) || (regions && regions[j] !== region)) continue; // (within its chart only)
        values[j * 3] += er * share;
        values[j * 3 + 1] += eg * share;
        values[j * 3 + 2] += eb * share;
      }
    }
    return out;
  }
  for (let i = 0; i < count; i++) if (solid(i)) write(i, pick(values[i * 3], values[i * 3 + 1], values[i * 3 + 2]));
  return out;
}

// The `count` colours a picture is best brought down to (median cut: the
// colours of its pixels - those not see-through - split again and again at
// the middle of the channel they vary most in, the box with the most
// spread first, and each box's mean taken): ['#rrggbb'].
export function paletteOf(image, count) {
  const pixels = [];
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] >= 128) pixels.push([data[i], data[i + 1], data[i + 2]]);
  if (pixels.length === 0) return [];
  const rangeOf = (box) => {
    let best = { channel: 0, range: -1 };
    for (let channel = 0; channel < 3; channel++) {
      let low = 255;
      let high = 0;
      for (const pixel of box) {
        low = Math.min(low, pixel[channel]);
        high = Math.max(high, pixel[channel]);
      }
      if (high - low > best.range) best = { channel, range: high - low };
    }
    return best;
  };
  const boxes = [pixels];
  while (boxes.length < count) {
    let widest = -1;
    let at = -1;
    boxes.forEach((box, k) => {
      if (box.length < 2) return;
      const { range } = rangeOf(box);
      if (range > widest) {
        widest = range;
        at = k;
      }
    });
    if (at < 0 || widest <= 0) break;
    const box = boxes[at];
    const { channel } = rangeOf(box);
    box.sort((a, b) => a[channel] - b[channel]);
    // At the middle - moved to the nearest place the channel changes: one
    // colour is never split between two boxes.
    const changes = (k) => k > 0 && k < box.length && box[k - 1][channel] !== box[k][channel];
    const middle = Math.floor(box.length / 2);
    let cut = -1;
    for (let d = 0; d <= box.length && cut < 0; d++) {
      if (changes(middle - d)) cut = middle - d;
      else if (changes(middle + d)) cut = middle + d;
    }
    boxes.splice(at, 1, box.slice(0, cut), box.slice(cut));
  }
  const colors = boxes.map((box) => hexOf([0, 1, 2].map((channel) => box.reduce((sum, pixel) => sum + pixel[channel], 0) / box.length)));
  return [...new Set(colors)];
}
