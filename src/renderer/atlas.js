import * as THREE from 'three';
import { START_SIZE, PADDING } from './unwrap.js';
import { ATLAS } from './mesh.js';

// A texture atlas: a picture the model's objects are painted with - those
// whose `atlas` is its id. A project has one, or several (see Editor.atlases),
// each with its own pixels per unit of length (`ppu`) and its own layout of
// the faces on it (see unwrap()).
//
// It is pixel art: shown with its pixels as they are (no smoothing, no
// smaller copies for the distance), and see-through pixels are holes. The
// picture itself is painted outside this program; here it is kept, moved
// about when a chart moves, swept of whatever no face shows when asked (see sweep()),
// and marked up so that the painter can see what is where:
//   - the template: room given to a new chart is filled with a colour of its
//     own, every face in it outlined;
//   - the guide: a picture of the same size with nothing but the faces'
//     outlines, to lay over the atlas in the painting program.
//
// Every chart has room for a rim round it (see PADDING in unwrap.js), in
// which its edge pixels can be repeated outwards against bleeding. That is
// not done to the picture that is painted - it is an export's to do, if it is
// asked to, with extrude() on a copy.

const OUTLINE = 0.72; // how much of the fill's brightness a template outline has

// Whether the point is inside the polygon (even-odd).
function inside(polygon, x, y) {
  let within = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[i];
    const [bx, by] = polygon[j];
    if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) within = !within;
  }
  return within;
}

// Whether the segment touches the inside of the unit square at (x, y).
function crosses(ax, ay, bx, by, x, y) {
  // Liang-Barsky, against the square shrunk a little so that a face's edge
  // lying along a pixel's edge does not claim the pixel beyond it.
  const e = 1e-4;
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  for (const [p, q] of [[-dx, ax - (x + e)], [dx, x + 1 - e - ax], [-dy, ay - (y + e)], [dy, y + 1 - e - ay]]) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      if (t0 > t1) return false;
    }
  }
  return true;
}

// The pixels a face covers, however little of them: every pixel it shows any
// part of must be painted, or its edge shows a hole. As a Set of "x,y".
export function facePixels(polygon) {
  const xs = polygon.map(([x]) => x);
  const ys = polygon.map(([, y]) => y);
  const pixels = new Set();
  for (let y = Math.floor(Math.min(...ys)); y < Math.ceil(Math.max(...ys)); y++) {
    for (let x = Math.floor(Math.min(...xs)); x < Math.ceil(Math.max(...xs)); x++) {
      const covered = inside(polygon, x + 0.5, y + 0.5) ||
        polygon.some(([ax, ay], k) => {
          const [bx, by] = polygon[(k + 1) % polygon.length];
          return crosses(ax, ay, bx, by, x, y);
        });
      if (covered) pixels.add(`${x},${y}`);
    }
  }
  return pixels;
}

// Of those pixels, the ones on the face's edge: with a neighbour that is not the face's.
function outlineOf(pixels) {
  const edge = [];
  for (const key of pixels) {
    const [x, y] = key.split(',').map(Number);
    const open = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !pixels.has(`${x + dx},${y + dy}`));
    if (open) edge.push([x, y]);
  }
  return edge;
}

// The pixels of a shape drawn from one pixel to another ({ x, y } each, the
// corners of the box it stands in): a rectangle or an ellipse, the whole of
// it or its outline only. As [x, y] each.
export function shapePixels(kind, from, to, filled) {
  const left = Math.min(from.x, to.x);
  const right = Math.max(from.x, to.x);
  const top = Math.min(from.y, to.y);
  const bottom = Math.max(from.y, to.y);
  // An ellipse: the pixels whose middles are within it.
  const cx = (left + right + 1) / 2;
  const cy = (top + bottom + 1) / 2;
  const within = (x, y) =>
    x >= left && x <= right && y >= top && y <= bottom &&
    (kind !== 'ellipse' || ((x + 0.5 - cx) / ((right - left + 1) / 2)) ** 2 + ((y + 0.5 - cy) / ((bottom - top + 1) / 2)) ** 2 <= 1);
  const pixels = [];
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      if (!within(x, y)) continue;
      // The outline: what has a neighbour, by a side, that is not of the shape.
      if (filled || !within(x - 1, y) || !within(x + 1, y) || !within(x, y - 1) || !within(x, y + 1)) pixels.push([x, y]);
    }
  }
  return pixels;
}

// The pixels of a straight line from one pixel to another ({ x, y } each),
// both ends included: one pixel a step, none twice (Bresenham's). As [x, y] each.
export function linePixels(from, to) {
  const dx = Math.abs(to.x - from.x);
  const dy = -Math.abs(to.y - from.y);
  const sx = from.x < to.x ? 1 : -1;
  const sy = from.y < to.y ? 1 : -1;
  let { x, y } = from;
  let error = dx + dy;
  const pixels = [[x, y]];
  while (x !== to.x || y !== to.y) {
    const twice = 2 * error;
    if (twice >= dy) {
      error += dy;
      x += sx;
    }
    if (twice <= dx) {
      error += dx;
      y += sy;
    }
    pixels.push([x, y]);
  }
  return pixels;
}

// A piece of picture (an ImageData) turned a quarter turn - clockwise for
// `turn` 1, back for -1 - or turned over (`flip` 'h': left to right, 'v':
// top to bottom). Pixel for pixel: nothing is resampled. A new ImageData.
export function turnedImage(image, { turn = 0, flip = null }) {
  const { width, height, data } = image;
  const quarter = turn !== 0;
  const out = new ImageData(quarter ? height : width, quarter ? width : height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let [tx, ty] = [x, y];
      if (turn > 0) [tx, ty] = [height - 1 - y, x];
      else if (turn < 0) [tx, ty] = [y, width - 1 - x];
      else if (flip === 'h') tx = width - 1 - x;
      else if (flip === 'v') ty = height - 1 - y;
      out.data.set(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), (ty * out.width + tx) * 4);
    }
  }
  return out;
}

// A colour for a chart, told by where it is: the same chart keeps its colour.
function tint(rect) {
  const hue = ((rect.x * 47 + rect.y * 89 + rect.w * 13) % 360) / 360;
  return new THREE.Color().setHSL(hue, 0.42, 0.64, THREE.SRGBColorSpace);
}

export class Atlas extends EventTarget {
  constructor({ id = ATLAS, name = id, ppu = 16 } = {}) {
    super();
    this.id = id;
    this.name = name; // (Latin, as the scene's names: it names the picture's file)
    this.ppu = ppu;
    this.canvas = document.createElement('canvas');
    this.context = this.canvas.getContext('2d', { willReadFrequently: true });
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.template = true; // new charts are filled in, see paintTemplate()
    this.charts = []; // of the last unwrap, for the guide
    this.reset();
  }

  get width() {
    return this.canvas.width;
  }

  get height() {
    return this.canvas.height;
  }

  // An empty atlas of the starting size.
  reset(width = START_SIZE, height = START_SIZE) {
    this.canvas.width = width;
    this.canvas.height = height;
    this.texture.dispose(); // a texture of another size is another texture
    this.charts = [];
    this.touch();
  }

  // Makes the canvas the given size; what is painted stays at its top left.
  resize(width, height) {
    if (width === this.width && height === this.height) return;
    const kept = this.context.getImageData(0, 0, this.width, this.height);
    this.canvas.width = width;
    this.canvas.height = height;
    this.context.putImageData(kept, 0, 0);
    this.texture.dispose(); // a texture of another size is another texture
  }

  // The picture as it is now, to keep (an undo step does): an ImageData that
  // is not written to afterwards. The same one is given until the picture changes.
  pixels() {
    this.kept ??= this.context.getImageData(0, 0, this.width, this.height);
    return this.kept;
  }

  // Puts back a picture that pixels() gave; the atlas takes its size.
  setPixels(image) {
    if (image === this.kept) return;
    this.resize(image.width, image.height);
    this.context.putImageData(image, 0, 0);
    this.charts = []; // whose rooms these are is for the next unwrap to say
    this.touch();
    this.kept = image;
  }

  // The picture has changed: the view shows it, and whoever keeps it on disk writes it.
  touch(byUser = false) {
    this.kept = null;
    this.texture.needsUpdate = true;
    this.dispatchEvent(new CustomEvent('change', { detail: { byUser } }));
  }

  // Carries out what an unwrap asks for (see unwrap()). `mesh` is the mesh it
  // was of. Nothing is rubbed out that faces have left: that is for the
  // user to sweep, when they will (see sweep()).
  apply(result, mesh) {
    const { context } = this;
    let painted = result.width !== this.width || result.height !== this.height;
    this.resize(result.width, result.height);
    // Every picture that moves is taken up before any is put down: they may overlap.
    const lifted = result.moved.map(({ from, w, h }) => context.getImageData(from.x, from.y, w, h));
    // (A room is a chart's rectangle with its rim.)
    const withRim = ({ x, y, w, h }) => ({ x: x - PADDING, y: y - PADDING, w: w + 2 * PADDING, h: h + 2 * PADDING });
    for (const fresh of result.fresh) {
      const { x, y, w, h } = withRim(fresh);
      context.clearRect(x, y, w, h);
    }
    result.moved.forEach(({ to, w, h }, k) => {
      const room = withRim({ ...to, w, h });
      context.clearRect(room.x, room.y, room.w, room.h);
      context.putImageData(lifted[k], to.x, to.y);
    });
    painted ||= result.moved.length > 0 || result.fresh.length > 0;
    this.charts = result.charts.map((chart) => {
      const polygons = chart.faces.map((i) => mesh.faces[i].uv);
      // The pixels the chart's faces show: what is the painter's in its room.
      const pixels = new Set();
      for (const polygon of polygons) for (const key of facePixels(polygon)) pixels.add(key);
      return { rect: chart.rect, polygons, pixels, faces: chart.faces, pinned: chart.pinned, shaped: Boolean(chart.shaped) };
    });
    if (this.template) {
      // New rooms, and those a chart has moved to: it moved because it grew,
      // and what it grew by is as bare as a new one.
      const within = (rect) => [...result.fresh, ...result.moved.map(({ to }) => to)].some((f) => f.x === rect.x && f.y === rect.y);
      for (const chart of this.charts) if (within(chart.rect)) this.paintTemplate(chart);
    }
    if (painted) this.touch();
    // Where the faces are has changed, painted or not: the guide is another picture now.
    if (result.changed || painted) this.dispatchEvent(new Event('layout'));
  }

  // Rubs out every pixel that no face shows (see facePixels()): what was
  // painted for faces that are gone, have moved or have shrunk, and anything
  // else off the charts - the UV editor's "Clean" (see Editor.cleanAtlas()).
  // Returns whether anything was rubbed out. (The picture is not touch()ed:
  // that is the caller's to do.)
  sweep() {
    const { width, height } = this;
    const used = new Uint8Array(width * height);
    for (const chart of this.charts) {
      for (const key of chart.pixels) {
        const [x, y] = key.split(',').map(Number);
        if (x >= 0 && y >= 0 && x < width && y < height) used[y * width + x] = 1;
      }
    }
    const image = this.context.getImageData(0, 0, width, height);
    let swept = false;
    for (let at = 0; at < used.length; at++) {
      if (used[at] || image.data[at * 4 + 3] === 0) continue;
      image.data.fill(0, at * 4, at * 4 + 4);
      swept = true;
    }
    if (swept) this.context.putImageData(image, 0, 0);
    return swept;
  }

  // Carries charts' pictures along with them, as their faces are put
  // elsewhere by hand: every pixel of each move's `pixels` (a Set of "x,y")
  // goes to the pixel that `place` takes its middle to. A pixel in `keep` (a
  // Set of "x,y": the pictures of charts that stay) is not painted over - a
  // chart put onto another's picture takes that picture, the way two faces
  // come to share one. What is left behind stays, until it is swept.
  carry(moves, keep) {
    const { width, height } = this;
    const image = this.context.getImageData(0, 0, width, height);
    const from = image.data.slice(); // every picture is taken up before any is put down: they may overlap
    for (const { pixels, place } of moves) {
      for (const key of pixels) {
        const [x, y] = key.split(',').map(Number);
        const [tx, ty] = place([x + 0.5, y + 0.5]).map(Math.floor);
        if (tx < 0 || ty < 0 || tx >= width || ty >= height || keep.has(`${tx},${ty}`)) continue;
        image.data.set(from.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), (ty * width + tx) * 4);
      }
    }
    this.context.putImageData(image, 0, 0);
    this.touch();
  }

  // Fills a chart's room with its colour and outlines its faces - only where
  // nothing is painted yet.
  paintTemplate(chart) {
    const { rect, polygons } = chart;
    const image = this.context.getImageData(rect.x, rect.y, rect.w, rect.h);
    const fill = tint(rect);
    const put = (x, y, color) => {
      const px = x - rect.x;
      const py = y - rect.y;
      if (px < 0 || py < 0 || px >= rect.w || py >= rect.h) return;
      const at = (py * rect.w + px) * 4;
      image.data[at] = Math.round(color.r * 255);
      image.data[at + 1] = Math.round(color.g * 255);
      image.data[at + 2] = Math.round(color.b * 255);
      image.data[at + 3] = 255;
    };
    const empty = (x, y) => {
      const px = x - rect.x;
      const py = y - rect.y;
      return px >= 0 && py >= 0 && px < rect.w && py < rect.h && image.data[(py * rect.w + px) * 4 + 3] === 0;
    };
    const srgb = (color) => ({ r: color.r, g: color.g, b: color.b });
    const body = srgb(fill.clone().convertLinearToSRGB());
    const edge = { r: body.r * OUTLINE, g: body.g * OUTLINE, b: body.b * OUTLINE };
    // All fills first, then all outlines: a face's outline is not painted over by its neighbour's fill.
    const faces = polygons.map((polygon) => facePixels(polygon));
    const blank = new Set();
    for (const pixels of faces) {
      for (const key of pixels) {
        const [x, y] = key.split(',').map(Number);
        if (empty(x, y)) blank.add(key);
      }
    }
    for (const key of blank) {
      const [x, y] = key.split(',').map(Number);
      put(x, y, body);
    }
    for (const pixels of faces) {
      for (const [x, y] of outlineOf(pixels)) if (blank.has(`${x},${y}`)) put(x, y, edge);
    }
    this.context.putImageData(image, rect.x, rect.y);
  }

  // Paints the template over every chart again - where nothing is painted.
  paintTemplates() {
    for (const chart of this.charts) this.paintTemplate(chart);
    this.touch();
  }

  // Repeats every chart's edge pixels outwards into its rim: a pixel next to
  // the chart that no face shows takes the colour of the chart's pixel it
  // touches - by a side if it can, by a corner otherwise. Returns whether the
  // picture changed; `tell` says whether to announce it (see touch()).
  // Nothing here calls it: it is there for an export that is asked for rims.
  extrude(tell = true) {
    if (this.charts.length === 0) return false;
    const { width, height } = this;
    const image = this.context.getImageData(0, 0, width, height);
    const { data } = image;
    let changed = false;
    const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const CORNERS = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
    // What any face shows is the painter's: where charts lie over each other
    // or side by side, no rim is put on another chart's pixels.
    const shown = new Set();
    for (const { pixels } of this.charts) for (const key of pixels) shown.add(key);
    // A chart that keeps its room to itself has its rim there. A pinned one
    // lies where the user put it - on other charts, or on a picture that a
    // chart has left - and has none: round it the picture it looks at goes on
    // by itself, and that picture is not ours to paint on.
    for (const { pixels, pinned } of this.charts) {
      if (pinned) continue;
      const rim = new Map(); // a rim pixel -> the chart pixel it copies
      for (const steps of [SIDES, CORNERS]) {
        for (const key of pixels) {
          const [x, y] = key.split(',').map(Number);
          for (const [dx, dy] of steps) {
            const px = x + dx;
            const py = y + dy;
            const beside = `${px},${py}`;
            if (px < 0 || py < 0 || px >= width || py >= height || shown.has(beside) || rim.has(beside)) continue;
            rim.set(beside, [x, y]);
          }
        }
      }
      for (const [beside, [x, y]] of rim) {
        const [px, py] = beside.split(',').map(Number);
        const from = (y * width + x) * 4;
        const to = (py * width + px) * 4;
        for (let channel = 0; channel < 4; channel++) {
          if (data[to + channel] === data[from + channel]) continue;
          data[to + channel] = data[from + channel];
          changed = true;
        }
      }
    }
    if (!changed) return false;
    this.context.putImageData(image, 0, 0);
    if (tell) this.touch();
    else this.kept = null;
    return true;
  }

  // The guide: a canvas of the atlas' size, see-through but for the outlines of the faces.
  guide() {
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    const context = canvas.getContext('2d');
    const image = context.createImageData(this.width, this.height);
    for (const { polygons } of this.charts) {
      for (const polygon of polygons) {
        for (const [x, y] of outlineOf(facePixels(polygon))) {
          if (x < 0 || y < 0 || x >= this.width || y >= this.height) continue;
          const at = (y * this.width + x) * 4;
          image.data.set([255, 0, 255, 255], at);
        }
      }
    }
    context.putImageData(image, 0, 0);
    return canvas;
  }

  // The colour of a pixel, as [r, g, b, a] (0..255).
  colorAt(x, y) {
    return [...this.context.getImageData(x, y, 1, 1).data];
  }

  // Gives a pixel a colour ([r, g, b, a], 0..255) - the brush's work, see
  // Editor.paintTo(). Returns whether the picture changed.
  paintPixel(x, y, color) {
    if (!(x >= 0 && y >= 0 && x < this.width && y < this.height)) return false;
    const pixel = this.context.getImageData(x, y, 1, 1);
    if (color.every((value, channel) => value === pixel.data[channel])) return false;
    pixel.data.set(color);
    this.context.putImageData(pixel, x, y);
    this.touch();
    return true;
  }

  // Gives a list of pixels ([x, y] each) a colour, as one change. Returns
  // whether the picture changed.
  paintPixels(pixels, color) {
    const inside = pixels.filter(([x, y]) => x >= 0 && y >= 0 && x < this.width && y < this.height);
    if (inside.length === 0) return false;
    const left = Math.min(...inside.map(([x]) => x));
    const top = Math.min(...inside.map(([, y]) => y));
    const width = Math.max(...inside.map(([x]) => x)) - left + 1;
    const height = Math.max(...inside.map(([, y]) => y)) - top + 1;
    const image = this.context.getImageData(left, top, width, height);
    let changed = false;
    for (const [x, y] of inside) {
      const at = ((y - top) * width + (x - left)) * 4;
      if (color.every((value, channel) => value === image.data[at + channel])) continue;
      image.data.set(color, at);
      changed = true;
    }
    if (!changed) return false;
    this.context.putImageData(image, left, top);
    this.touch();
    return true;
  }

  // The picture as it is this moment, to be put back with putBack() - what a
  // shape being drawn out is tried on, again and again. (Unlike pixels() and
  // setPixels(), which are the document's: these leave the charts alone.)
  taken() {
    return this.context.getImageData(0, 0, this.width, this.height);
  }

  // A rectangle of the picture ({ x, y, w, h }, in pixels), as an ImageData of its own.
  region({ x, y, w, h }) {
    return this.context.getImageData(x, y, w, h);
  }

  // Rubs a rectangle of the picture out. Returns whether anything was there.
  clearRegion(rect) {
    const had = this.region(rect).data.some((value, i) => i % 4 === 3 && value !== 0);
    if (!had) return false;
    this.context.clearRect(rect.x, rect.y, rect.w, rect.h);
    this.touch();
    return true;
  }

  // Puts a piece of picture down with its top left at (x, y): its pixels
  // over those under them, except the ones it has none at (see-through), which
  // let what is under them show - as a piece of pixel art is laid on another.
  stamp(image, x, y) {
    const under = this.context.getImageData(x, y, image.width, image.height);
    for (let i = 0; i < image.data.length; i += 4) {
      if (image.data[i + 3] !== 0) under.data.set(image.data.subarray(i, i + 4), i);
    }
    this.context.putImageData(under, x, y);
    this.touch();
  }

  putBack(image) {
    this.context.putImageData(image, 0, 0);
    this.touch();
  }

  // The pixels a flood from (x, y) reaches: those of exactly its colour that
  // hang together with it by their sides. `mask` - a Set of "x,y" - keeps the
  // flood to those pixels; without one it has the whole picture.
  floodPixels(x, y, mask = null) {
    const { width, height } = this;
    if (!(x >= 0 && y >= 0 && x < width && y < height)) return [];
    const { data } = this.context.getImageData(0, 0, width, height);
    const first = (y * width + x) * 4;
    const same = (at) => data[at] === data[first] && data[at + 1] === data[first + 1] && data[at + 2] === data[first + 2] && data[at + 3] === data[first + 3];
    const seen = new Uint8Array(width * height);
    const found = [];
    const open = [[x, y]];
    seen[y * width + x] = 1;
    while (open.length) {
      const [px, py] = open.pop();
      found.push([px, py]);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = px + dx;
        const ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height || seen[ny * width + nx]) continue;
        seen[ny * width + nx] = 1;
        if (same((ny * width + nx) * 4) && (!mask || mask.has(`${nx},${ny}`))) open.push([nx, ny]);
      }
    }
    return found;
  }

  // The picture with what the faces show of it carried outwards (texture
  // extrusion, or edge padding), on a canvas of its own: the pixels just
  // outside the faces' pieces take the colour of the nearest pixel inside,
  // `depth` pixels deep - less where two pieces are nearer than that, each
  // then getting its half of what lies between. A program that smooths the
  // texture, or shows it from afar at a smaller size, mixes in the pixels
  // next to a face's own; this makes those pixels the face's colour.
  // `polygons` are the faces' places on the atlas, each a list of [x, y].
  extruded(polygons, depth) {
    const { width, height } = this;
    const image = this.context.getImageData(0, 0, width, height);
    const { data } = image;
    let taken = new Uint8Array(width * height); // the pixels that have their colour
    for (const polygon of polygons) {
      for (const key of facePixels(polygon)) {
        const [x, y] = key.split(',').map(Number);
        if (x >= 0 && y >= 0 && x < width && y < height) taken[y * width + x] = 1;
      }
    }
    // A pixel's colour comes from beside it rather than from a corner: straight neighbours first.
    const around = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (let step = 0; step < depth; step++) {
      const from = data.slice(); // a ring grows from the one before, not from itself
      const next = taken.slice();
      let grown = false;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (taken[y * width + x]) continue;
          const [dx, dy] = around.find(([ax, ay]) => {
            const nx = x + ax;
            const ny = y + ay;
            return nx >= 0 && ny >= 0 && nx < width && ny < height && taken[ny * width + nx];
          }) ?? [];
          if (dx === undefined) continue;
          const source = ((y + dy) * width + x + dx) * 4;
          data.set(from.subarray(source, source + 4), (y * width + x) * 4);
          next[y * width + x] = 1;
          grown = true;
        }
      }
      if (!grown) break;
      taken = next;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').putImageData(image, 0, 0);
    return canvas;
  }

  // The picture (or another canvas) as the bytes of a PNG file.
  async png(canvas = this.canvas) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  }

  // Takes the picture from the bytes of an image file. One of another size
  // than the atlas is put at its top left, and what does not fit is lost: the
  // unwrap, not the picture, says how big the atlas is. Returns false if the
  // bytes are not a picture.
  async load(bytes, byUser = false) {
    let picture;
    try {
      picture = await createImageBitmap(new Blob([bytes]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    } catch {
      return false;
    }
    this.context.clearRect(0, 0, this.width, this.height);
    this.context.drawImage(picture, 0, 0);
    picture.close();
    this.touch(byUser);
    return true;
  }
}
