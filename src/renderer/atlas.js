import * as THREE from 'three';
import { START_SIZE, PADDING } from './unwrap.js';

// The texture atlas: the one picture a project's model is painted with.
//
// It is pixel art: shown with its pixels as they are (no smoothing, no
// smaller copies for the distance), and see-through pixels are holes. The
// picture itself is painted outside this program; here it is kept, moved
// about when the unwrap moves a chart, and marked up so that the painter can
// see what is where:
//   - the template: room given to a new chart is filled with a colour of its
//     own, every face in it outlined;
//   - the guide: a picture of the same size with nothing but the faces'
//     outlines, to lay over the atlas in the painting program.
//
// And it is kept safe from bleeding: every chart has a rim (see PADDING in
// unwrap.js) in which its edge pixels are repeated outwards. That is done
// here, after every change, and is not for painting: what is painted in a
// rim is painted over.

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

// A colour for a chart, told by where it is: the same chart keeps its colour.
function tint(rect) {
  const hue = ((rect.x * 47 + rect.y * 89 + rect.w * 13) % 360) / 360;
  return new THREE.Color().setHSL(hue, 0.42, 0.64, THREE.SRGBColorSpace);
}

export class Atlas extends EventTarget {
  constructor() {
    super();
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
  // was of. `sweep` off leaves the rooms that charts have left as they are: a
  // chart moved by hand has left its picture behind on purpose.
  apply(result, mesh, { sweep = true } = {}) {
    const { context } = this;
    let painted = result.width !== this.width || result.height !== this.height;
    this.resize(result.width, result.height);
    // Every picture that moves is taken up before any is put down: they may overlap.
    const lifted = result.moved.map(({ from, w, h }) => context.getImageData(from.x, from.y, w, h));
    // Room that charts had and none has now is swept: what was painted there
    // is of faces that are gone or have moved away. (Outside the charts'
    // rooms nothing is touched: that is the painter's own.)
    // (A room is a chart's rectangle with its rim.)
    const withRim = ({ x, y, w, h }) => ({ x: x - PADDING, y: y - PADDING, w: w + 2 * PADDING, h: h + 2 * PADDING });
    const rooms = result.charts.map((chart) => withRim(chart.rect));
    for (const chart of sweep ? this.charts : []) {
      const rect = withRim(chart.rect);
      if (rooms.some((room) => room.x === rect.x && room.y === rect.y && room.w === rect.w && room.h === rect.h)) continue;
      const image = context.getImageData(rect.x, rect.y, rect.w, rect.h);
      let swept = false;
      for (let y = 0; y < rect.h; y++) {
        for (let x = 0; x < rect.w; x++) {
          const px = rect.x + x;
          const py = rect.y + y;
          if (rooms.some((room) => px >= room.x && px < room.x + room.w && py >= room.y && py < room.y + room.h)) continue;
          if (image.data[(y * rect.w + x) * 4 + 3] !== 0) swept = true;
          image.data.fill(0, (y * rect.w + x) * 4, (y * rect.w + x) * 4 + 4);
        }
      }
      if (swept) {
        context.putImageData(image, rect.x, rect.y);
        painted = true;
      }
    }
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
      return { rect: chart.rect, polygons, pixels, faces: chart.faces, pinned: chart.pinned };
    });
    if (this.template) {
      // New rooms, and those a chart has moved to: it moved because it grew,
      // and what it grew by is as bare as a new one.
      const within = (rect) => [...result.fresh, ...result.moved.map(({ to }) => to)].some((f) => f.x === rect.x && f.y === rect.y);
      for (const chart of this.charts) if (within(chart.rect)) this.paintTemplate(chart);
    }
    if (this.extrude(false)) painted = true;
    if (painted) this.touch();
    // Where the faces are has changed, painted or not: the guide is another picture now.
    if (result.changed || painted) this.dispatchEvent(new Event('layout'));
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
    this.extrude(false);
    this.touch();
  }

  // Repeats every chart's edge pixels outwards into its rim: a pixel next to
  // the chart that no face shows takes the colour of the chart's pixel it
  // touches - by a side if it can, by a corner otherwise. Returns whether the
  // picture changed; `tell` says whether to announce it (see touch()).
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
    // The painter's picture is taken as it is; its rims are ours to fill, and
    // if that changed anything the file is to be written again.
    const rimmed = this.extrude(false);
    this.touch(byUser && !rimmed);
    return true;
  }
}
