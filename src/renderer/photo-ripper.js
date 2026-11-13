// The Texture Ripper: a picture taken off a photo, straightened, and put
// straight onto the faces picked.
//
// A photo is opened (a file, the clipboard, or dropped on the window), four
// corners are put on it around something flat seen in perspective - a wall,
// a door, a box's side - and what is within them is made square again: a
// projective map (a homography) takes the square onto the photo's four
// corners, and each pixel of the faces picked takes its colour from where
// its middle - and the places around it, as many as the photo has pixels to
// it - goes on the photo. "Pixels as they are" takes the one photo pixel
// under the middle instead, the colours kept as they are.
//
// Where it goes is the faces picked (see Editor.ripTargets()): a single
// four-cornered face takes the photo's corners onto its own, more faces
// the box around their pixels. Upright as the camera sees the model;
// ↻ and ⇋ turn and mirror it from there.

import { t } from './i18n.js';
import { imageOf } from './uv-editor.js';

const HANDLE = 6; // half a corner's square, screen pixels
const REACH = 11; // how near a press takes a corner
const LOUPE = 120; // the loupe's size, screen pixels
const LOUPE_ZOOM = 8;
const PREVIEW_MAX = 160; // the preview's larger side at most, its pixels
const MOST_SAMPLES = 16; // a target pixel's samples at most, a side

// The projective map of the unit square onto a quad: (0,0), (1,0), (1,1),
// (0,1) go to its four corners - a 3x3 matrix, row by row (Heckbert's).
export function squareToQuad([[x0, y0], [x1, y1], [x2, y2], [x3, y3]]) {
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  if (Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12) {
    return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1]; // a parallelogram: affine
  }
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / det;
  const h = (dx1 * sy - sx * dy1) / det;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

// A 3x3 matrix's inverse (row by row); null if it has none.
export function invert3([a, b, c, d, e, f, g, h, i]) {
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  return [A / det, (c * h - b * i) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, (c * d - a * f) / det, C / det, (b * g - a * h) / det, (a * e - b * d) / det];
}

function mapPoint(m, x, y) {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

function area([[x0, y0], [x1, y1], [x2, y2], [x3, y3]]) {
  return Math.abs((x0 * y1 - x1 * y0) + (x1 * y2 - x2 * y1) + (x2 * y3 - x3 * y2) + (x3 * y0 - x0 * y3)) / 2;
}

// Whether a quad's corners make a shape the map can be made for: no three in
// a line, its sides not crossing (convex, either way round).
export function fairQuad(quad) {
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = quad[k];
    const [bx, by] = quad[(k + 1) % 4];
    const [cx, cy] = quad[(k + 2) % 4];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cross) < 1e-9) return false;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
}

// The colours of pixels ([x, y] each) of a place whose four corners are
// `quad` (top-left, top-right, bottom-right, bottom-left), taken from the
// photo (ImageData) within its four corners `corners`, in the same order.
// A pixel outside the quad (a chart's rim) takes the nearest of its edge.
// `nearest`: the photo's pixel under each middle; else an average over
// as many samples as the photo has pixels to the place's one (`most` a
// side at most). Four bytes (RGBA) a pixel.
export function ripColors(photo, corners, quad, pixels, { nearest = false, most = MOST_SAMPLES } = {}) {
  const colors = new Uint8ClampedArray(pixels.length * 4);
  const toPhoto = squareToQuad(corners);
  const fromPlace = invert3(squareToQuad(quad));
  if (!fromPlace) return colors;
  const { width, height, data } = photo;
  const n = nearest ? 1 : Math.max(1, Math.min(most, Math.ceil(Math.sqrt(area(corners) / Math.max(area(quad), 1e-9)))));
  const clamp01 = (value) => Math.min(1, Math.max(0, value));
  const sum = [0, 0, 0, 0];
  const add = (px, py, weight) => {
    const at = (py * width + px) * 4;
    const alpha = data[at + 3] * weight;
    sum[0] += data[at] * alpha;
    sum[1] += data[at + 1] * alpha;
    sum[2] += data[at + 2] * alpha;
    sum[3] += alpha;
  };
  pixels.forEach(([x, y], k) => {
    const out = k * 4;
    if (nearest) {
      const [u, v] = mapPoint(fromPlace, x + 0.5, y + 0.5);
      const [px, py] = mapPoint(toPhoto, clamp01(u), clamp01(v));
      const at = (Math.min(height - 1, Math.max(0, Math.floor(py))) * width + Math.min(width - 1, Math.max(0, Math.floor(px)))) * 4;
      colors.set(data.subarray(at, at + 4), out);
      return;
    }
    sum.fill(0);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const [u, v] = mapPoint(fromPlace, x + (i + 0.5) / n, y + (j + 0.5) / n);
        const [px, py] = mapPoint(toPhoto, clamp01(u), clamp01(v));
        // bilinear, between the four pixel middles around
        const fx = Math.min(width - 1, Math.max(0, px - 0.5));
        const fy = Math.min(height - 1, Math.max(0, py - 0.5));
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
        const ax = fx - x0, ay = fy - y0;
        add(x0, y0, (1 - ax) * (1 - ay));
        add(x1, y0, ax * (1 - ay));
        add(x0, y1, (1 - ax) * ay);
        add(x1, y1, ax * ay);
      }
    }
    if (sum[3] > 0) {
      colors[out] = Math.round(sum[0] / sum[3]);
      colors[out + 1] = Math.round(sum[1] / sum[3]);
      colors[out + 2] = Math.round(sum[2] / sum[3]);
    }
    colors[out + 3] = Math.round(sum[3] / (n * n));
  });
  return colors;
}

// The quad's corners turned a quarter clockwise (`turn` times) and, with
// `flip`, mirrored left to right - as the picture on it would be.
function oriented(quad, turn, flip) {
  let q = flip ? [quad[1], quad[0], quad[3], quad[2]] : [...quad];
  for (let k = 0; k < turn % 4; k++) q = [q[3], q[0], q[1], q[2]];
  return q;
}

export class PhotoRipper {
  // `editor`: where the picture goes (Editor.ripTargets(), applyRip());
  // `say(text)`: tells the user something (a toast).
  constructor(editor, { say = () => {} } = {}) {
    this.editor = editor;
    this.say = say;
    this.photo = null; // ImageData
    this.photoCanvas = null; // the photo, to be drawn
    this.corners = null; // on the photo, its pixels: top-left, top-right, bottom-right, bottom-left
    this.view = { scale: 1, x: 0, y: 0 }; // screen = photo * scale + (x, y)
    this.turn = 0;
    this.flip = false;
    this.drag = null;
    this.active = 0; // the corner the arrow keys move
    this.build();
  }

  build() {
    const panel = document.createElement('div');
    panel.id = 'ripper';
    panel.hidden = true;
    panel.tabIndex = -1;
    panel.innerHTML = `
      <div class="ripper-title"><i class="kp-grip" title="${t('ripper.grip.title')}"></i><span>${t('ripper.title')}</span><small class="ripper-target"></small><button type="button" class="ripper-close" title="${t('ripper.close.title')}"><i class="fa-solid fa-xmark"></i></button></div>
      <div class="ripper-bar">
        <button type="button" data-rip="open" title="${t('ripper.open.title')}"><i class="fa-solid fa-folder-open"></i></button>
        <button type="button" data-rip="paste" title="${t('ripper.paste.title')}"><i class="fa-solid fa-paste"></i></button>
        <i class="ripper-divider"></i>
        <button type="button" data-rip="reset" title="${t('ripper.reset.title')}"><i class="fa-solid fa-rotate-left"></i></button>
        <button type="button" data-rip="turn" title="${t('ripper.turn.title')}"><i class="fa-solid fa-rotate-right"></i></button>
        <button type="button" data-rip="flip" title="${t('ripper.flip.title')}"><i class="fa-solid fa-left-right"></i></button>
        <i class="ripper-divider"></i>
        <label class="ripper-check" title="${t('ripper.nearest.title')}"><input type="checkbox" name="nearest"><span>${t('ripper.nearest')}</span></label>
      </div>
      <div class="ripper-body">
        <canvas class="ripper-photo"></canvas>
        <div class="ripper-empty">${t('ripper.empty')}</div>
      </div>
      <div class="ripper-foot">
        <canvas class="ripper-preview" title="${t('ripper.preview.title')}"></canvas>
        <div class="ripper-info"></div>
        <button type="button" class="primary" data-rip="apply" title="${t('ripper.apply.title')}">${t('ripper.apply')}</button>
      </div>`;
    document.body.append(panel);
    this.panel = panel;
    this.canvas = panel.querySelector('.ripper-photo');
    this.preview = panel.querySelector('.ripper-preview');
    this.nearest = panel.querySelector('[name="nearest"]');
    try {
      this.nearest.checked = localStorage.getItem('vertex.ripNearest') === '1';
    } catch { /* not kept: fine */ }

    panel.querySelector('.ripper-close').addEventListener('click', () => this.close());
    panel.querySelector('.ripper-bar').addEventListener('click', (event) => {
      const what = event.target.closest('[data-rip]')?.dataset.rip;
      if (what === 'open') this.openFile();
      else if (what === 'paste') this.paste();
      else if (what === 'reset') this.resetCorners();
      else if (what === 'turn') this.turn = (this.turn + 1) % 4;
      else if (what === 'flip') this.flip = !this.flip;
      if (what === 'turn' || what === 'flip') this.refresh();
    });
    panel.querySelector('[data-rip="apply"]').addEventListener('click', () => this.apply());
    this.nearest.addEventListener('change', () => {
      try { localStorage.setItem('vertex.ripNearest', this.nearest.checked ? '1' : '0'); } catch { /* not kept: fine */ }
      this.refresh();
    });
    panel.addEventListener('keydown', (event) => this.onKey(event));
    panel.addEventListener('pointerdown', () => {
      if (!panel.contains(document.activeElement) || document.activeElement === document.body) panel.focus({ preventScroll: true });
    });
    // A picture dropped on the window.
    panel.addEventListener('dragover', (event) => {
      event.preventDefault();
      panel.classList.add('dropping');
    });
    panel.addEventListener('dragleave', () => panel.classList.remove('dropping'));
    panel.addEventListener('drop', async (event) => {
      event.preventDefault();
      panel.classList.remove('dropping');
      const file = [...(event.dataTransfer?.files ?? [])].find((item) => item.type.startsWith('image/'));
      if (file) await this.load(file);
    });

    this.bindGrip();
    this.bindCanvas();
    new ResizeObserver(() => this.layout()).observe(panel.querySelector('.ripper-body'));
    this.editor.addEventListener('change', () => {
      if (!this.panel.hidden) this.refresh();
    });
  }

  get open() {
    return !this.panel.hidden;
  }

  show() {
    if (this.open) {
      this.panel.focus({ preventScroll: true });
      return;
    }
    this.panel.hidden = false;
    if (!this.placed) {
      // At the right of the model's view the first time - the model in the
      // middle stays in sight; dragged by its title (see bindGrip()).
      const { width, height } = this.panel.getBoundingClientRect();
      const view = this.editor.viewport.renderer.domElement.getBoundingClientRect();
      this.panel.style.left = `${Math.max(6, Math.min(window.innerWidth - width - 6, view.right - width - 12))}px`;
      this.panel.style.top = `${Math.max(6, Math.min(window.innerHeight - height - 6, view.top + 160))}px`; // (under the view's gizmo)
      this.placed = true;
    }
    this.layout();
    this.refresh();
    this.panel.focus({ preventScroll: true });
  }

  close() {
    this.panel.hidden = true;
    this.drag = null;
  }

  toggle() {
    if (this.open) this.close();
    else this.show();
  }

  // --- the photo

  async openFile() {
    const bytes = await window.vertex?.atlas.pickPicture?.();
    if (bytes) await this.load(new Blob([bytes]));
  }

  async paste() {
    let blob = null;
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((kind) => kind.startsWith('image/'));
        if (type) {
          blob = await item.getType(type);
          break;
        }
      }
    } catch {
      // (the clipboard could not be read)
    }
    if (blob) await this.load(blob);
    else this.say(t('ripper.no-picture'));
  }

  async load(blob) {
    const image = await imageOf(blob);
    if (!image) {
      this.say(t('ripper.not-picture'));
      return;
    }
    this.setPhoto(image);
  }

  setPhoto(image) {
    this.photo = image;
    this.photoCanvas = document.createElement('canvas');
    this.photoCanvas.width = image.width;
    this.photoCanvas.height = image.height;
    this.photoCanvas.getContext('2d').putImageData(image, 0, 0);
    this.panel.classList.add('has-photo');
    this.resetCorners();
    this.fit();
    this.show();
  }

  resetCorners() {
    if (!this.photo) return;
    const { width: w, height: h } = this.photo;
    const mx = w * 0.2, my = h * 0.2;
    this.corners = [[mx, my], [w - mx, my], [w - mx, h - my], [mx, h - my]];
    this.active = 0;
    this.refresh();
  }

  // The whole photo in sight.
  fit() {
    if (!this.photo) return;
    const { clientWidth: cw, clientHeight: ch } = this.canvas;
    const scale = Math.min((cw - 24) / this.photo.width, (ch - 24) / this.photo.height);
    this.view.scale = scale > 0 ? scale : 1;
    this.view.x = (cw - this.photo.width * this.view.scale) / 2;
    this.view.y = (ch - this.photo.height * this.view.scale) / 2;
    this.draw();
  }

  // --- where it goes, and the picture there

  // The editor's targets, each with its quad turned and mirrored as asked.
  targets() {
    return this.editor.ripTargets().map((target) => ({ ...target, quad: oriented(target.quad, this.turn, this.flip) }));
  }

  // Whether faces are picked whose objects are on no atlas, and there is
  // one to put them on (see Editor.applyRip()).
  addable() {
    return this.editor.atlas !== this.editor.noAtlas && this.editor.ripOffAtlas().length > 0;
  }

  ready() {
    return Boolean(this.photo && this.corners && fairQuad(this.corners));
  }

  apply() {
    if (!this.ready()) {
      this.say(t(this.photo ? 'ripper.bad-corners' : 'ripper.no-photo'));
      return false;
    }
    if (!this.targets().length && !this.addable()) {
      this.say(t(this.editor.mode === 'face' && this.editor.picked.size && this.editor.atlas === this.editor.noAtlas ? 'ripper.no-atlas' : 'ripper.no-faces'));
      return false;
    }
    const nearest = this.nearest.checked;
    return this.editor.applyRip((targets) => targets.map((target) => {
      const quad = oriented(target.quad, this.turn, this.flip);
      return { atlas: target.atlas, pixels: target.pixels, colors: ripColors(this.photo, this.corners, quad, target.pixels, { nearest }) };
    }));
  }

  // The size of the picture the preview shows: the target's (its quad's
  // sides, on average), else the corners' on the photo - at most PREVIEW_MAX.
  previewSize(target) {
    const quad = target?.quad ?? this.corners;
    const side = (a, b) => Math.hypot(quad[b][0] - quad[a][0], quad[b][1] - quad[a][1]);
    let w = (side(0, 1) + side(3, 2)) / 2;
    let h = (side(0, 3) + side(1, 2)) / 2;
    const down = Math.max(w, h) > PREVIEW_MAX ? PREVIEW_MAX / Math.max(w, h) : 1;
    w = Math.max(1, Math.round(w * down));
    h = Math.max(1, Math.round(h * down));
    return { w, h };
  }

  refresh() {
    if (!this.open) return;
    const targets = this.targets(); // (turned and mirrored as asked: the preview takes its sides)
    const info = this.panel.querySelector('.ripper-info');
    const label = this.panel.querySelector('.ripper-target');
    if (targets.length) {
      const faces = targets.reduce((sum, target) => sum + target.faces.length, 0);
      const { w, h } = targets[0].size;
      label.textContent = '';
      info.textContent = faces === 1 ? t('ripper.target.face', { w, h }) : t('ripper.target.faces', { count: faces, w, h });
    } else {
      label.textContent = '';
      info.textContent = '';
    }
    // Faces of objects on no atlas: they are put on it as the picture is.
    if (this.addable()) info.textContent = `${info.textContent ? `${info.textContent}. ` : ''}${t('ripper.target.add', { name: this.editor.atlas.name || this.editor.atlas.id })}`;
    else if (!targets.length) info.textContent = t(this.editor.mode === 'face' && this.editor.picked.size && this.editor.atlas === this.editor.noAtlas ? 'ripper.no-atlas' : 'ripper.target.none');
    this.panel.querySelector('[data-rip="apply"]').disabled = (!targets.length && !this.addable()) || !this.ready();
    this.draw();
    cancelAnimationFrame(this.previewFrame);
    this.previewFrame = requestAnimationFrame(() => this.drawPreview(targets[0]));
  }

  drawPreview(target) {
    const { preview } = this;
    preview.hidden = !this.ready();
    if (preview.hidden) return;
    const { w, h } = this.previewSize(target ? { quad: target.quad } : null);
    const pixels = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels.push([x, y]);
    // (Upright, as the picture is meant: the turn and the mirror are the target's.)
    const colors = ripColors(this.photo, this.corners, [[0, 0], [w, 0], [w, h], [0, h]], pixels, { nearest: this.nearest.checked, most: 4 });
    preview.width = w;
    preview.height = h;
    preview.getContext('2d').putImageData(new ImageData(colors, w, h), 0, 0);
    // Shown as large as the box lets it be, its pixels sharp.
    const box = 96;
    const scale = Math.max(1, Math.floor(box / Math.max(w, h))) || 1;
    const fitted = Math.min(scale, box / Math.max(w, h));
    preview.style.width = `${Math.max(1, Math.round(w * fitted))}px`;
    preview.style.height = `${Math.max(1, Math.round(h * fitted))}px`;
  }

  // --- the photo's view

  layout() {
    const { canvas } = this;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    this.draw();
  }

  toScreen([x, y]) {
    return [x * this.view.scale + this.view.x, y * this.view.scale + this.view.y];
  }

  toPhoto(sx, sy) {
    return [(sx - this.view.x) / this.view.scale, (sy - this.view.y) / this.view.scale];
  }

  draw() {
    const { canvas } = this;
    const context = canvas.getContext('2d');
    const ratio = canvas.width / Math.max(1, canvas.clientWidth);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!this.photo) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const style = getComputedStyle(this.panel);
    const accent = style.getPropertyValue('--accent').trim() || '#4aa3ff';
    const { scale, x, y } = this.view;
    context.imageSmoothingEnabled = scale < 2;
    context.drawImage(this.photoCanvas, x, y, this.photo.width * scale, this.photo.height * scale);
    if (!this.corners) return;
    const quad = this.corners.map((point) => this.toScreen(point));
    // What is outside the corners dimmed.
    context.beginPath();
    context.rect(0, 0, canvas.clientWidth, canvas.clientHeight);
    context.moveTo(...quad[0]);
    for (const point of quad.slice(1)) context.lineTo(...point);
    context.closePath();
    context.fillStyle = 'rgb(0 0 0 / 0.5)';
    context.fill('evenodd');
    // A grid within, in perspective: lines that should lie along the photo's.
    if (fairQuad(this.corners)) {
      const map = squareToQuad(this.corners);
      context.beginPath();
      for (let k = 1; k < 4; k++) {
        const f = k / 4;
        context.moveTo(...this.toScreen(mapPoint(map, f, 0)));
        context.lineTo(...this.toScreen(mapPoint(map, f, 1)));
        context.moveTo(...this.toScreen(mapPoint(map, 0, f)));
        context.lineTo(...this.toScreen(mapPoint(map, 1, f)));
      }
      context.strokeStyle = 'rgb(255 255 255 / 0.35)';
      context.lineWidth = 1;
      context.stroke();
    }
    context.beginPath();
    context.moveTo(...quad[0]);
    for (const point of quad.slice(1)) context.lineTo(...point);
    context.closePath();
    context.strokeStyle = fairQuad(this.corners) ? accent : '#ff5050';
    context.lineWidth = 1.5;
    context.stroke();
    // The top side, thicker: what is up on the face.
    context.beginPath();
    context.moveTo(...quad[0]);
    context.lineTo(...quad[1]);
    context.lineWidth = 3.5;
    context.stroke();
    quad.forEach(([qx, qy], k) => {
      context.fillStyle = k === this.active ? accent : '#ffffff';
      context.strokeStyle = '#000000';
      context.lineWidth = 1;
      context.fillRect(qx - HANDLE, qy - HANDLE, HANDLE * 2, HANDLE * 2);
      context.strokeRect(qx - HANDLE + 0.5, qy - HANDLE + 0.5, HANDLE * 2 - 1, HANDLE * 2 - 1);
    });
    if (this.drag?.corner !== undefined) this.drawLoupe(context, this.corners[this.drag.corner], quad[this.drag.corner]);
  }

  // The photo around a corner being dragged, large, in a corner of the view
  // away from it.
  drawLoupe(context, [px, py], [sx, sy]) {
    const { clientWidth: cw } = this.canvas;
    const left = sx < cw / 2 ? cw - LOUPE - 8 : 8;
    const top = 8;
    const half = LOUPE / 2 / LOUPE_ZOOM;
    context.save();
    context.beginPath();
    context.rect(left, top, LOUPE, LOUPE);
    context.clip();
    context.fillStyle = '#000';
    context.fillRect(left, top, LOUPE, LOUPE);
    context.imageSmoothingEnabled = false;
    context.drawImage(this.photoCanvas, px - half, py - half, half * 2, half * 2, left, top, LOUPE, LOUPE);
    context.strokeStyle = 'rgb(255 255 255 / 0.9)';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(left + LOUPE / 2 + 0.5, top);
    context.lineTo(left + LOUPE / 2 + 0.5, top + LOUPE);
    context.moveTo(left, top + LOUPE / 2 + 0.5);
    context.lineTo(left + LOUPE, top + LOUPE / 2 + 0.5);
    context.stroke();
    context.restore();
    context.strokeStyle = '#000';
    context.strokeRect(left + 0.5, top + 0.5, LOUPE - 1, LOUPE - 1);
  }

  bindCanvas() {
    const { canvas } = this;
    const local = (event) => {
      const rect = canvas.getBoundingClientRect();
      return [event.clientX - rect.left, event.clientY - rect.top];
    };
    const inside = ([sx, sy]) => {
      // (the point within the quad on the screen, by its sides' sides)
      const quad = this.corners.map((point) => this.toScreen(point));
      let sign = 0;
      for (let k = 0; k < 4; k++) {
        const [ax, ay] = quad[k];
        const [bx, by] = quad[(k + 1) % 4];
        const cross = (bx - ax) * (sy - ay) - (by - ay) * (sx - ax);
        if (sign && Math.sign(cross) !== sign) return false;
        sign = Math.sign(cross) || sign;
      }
      return true;
    };
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    canvas.addEventListener('pointerdown', (event) => {
      if (!this.photo) {
        if (event.button === 0) this.openFile();
        return;
      }
      const at = local(event);
      canvas.setPointerCapture(event.pointerId);
      if (event.button === 0 && this.corners) {
        let corner = -1;
        let best = REACH;
        this.corners.forEach((point, k) => {
          const [qx, qy] = this.toScreen(point);
          const distance = Math.hypot(qx - at[0], qy - at[1]);
          if (distance <= best) {
            best = distance;
            corner = k;
          }
        });
        if (corner >= 0) {
          this.active = corner;
          const [qx, qy] = this.toScreen(this.corners[corner]);
          this.drag = { corner, dx: qx - at[0], dy: qy - at[1] };
        } else if (inside(at)) {
          this.drag = { move: true, from: this.toPhoto(...at), start: this.corners.map((point) => [...point]) };
        } else this.drag = { pan: true, from: at, view: { ...this.view } };
      } else this.drag = { pan: true, from: at, view: { ...this.view } };
      canvas.classList.toggle('panning', Boolean(this.drag.pan));
      this.draw();
      event.preventDefault();
    });
    canvas.addEventListener('pointermove', (event) => {
      const { drag } = this;
      if (!drag) {
        if (this.photo && this.corners) {
          const at = local(event);
          const near = this.corners.some((point) => {
            const [qx, qy] = this.toScreen(point);
            return Math.hypot(qx - at[0], qy - at[1]) <= REACH;
          });
          canvas.style.cursor = near ? 'crosshair' : inside(at) ? 'move' : '';
        }
        return;
      }
      const at = local(event);
      if (drag.pan) {
        this.view.x = drag.view.x + at[0] - drag.from[0];
        this.view.y = drag.view.y + at[1] - drag.from[1];
      } else if (drag.move) {
        const [px, py] = this.toPhoto(...at);
        const dx = px - drag.from[0], dy = py - drag.from[1];
        this.corners = drag.start.map(([x, y]) => [x + dx, y + dy]);
      } else {
        this.corners[drag.corner] = this.toPhoto(at[0] + drag.dx, at[1] + drag.dy);
      }
      if (drag.pan) this.draw();
      else this.refresh();
    });
    const drop = () => {
      if (!this.drag) return;
      this.drag = null;
      canvas.classList.remove('panning');
      this.refresh();
    };
    canvas.addEventListener('pointerup', drop);
    canvas.addEventListener('pointercancel', drop);
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      if (!this.photo) return;
      const [sx, sy] = local(event);
      const [px, py] = this.toPhoto(sx, sy);
      const factor = Math.exp(-event.deltaY * 0.0015);
      this.view.scale = Math.min(64, Math.max(0.02, this.view.scale * factor));
      this.view.x = sx - px * this.view.scale;
      this.view.y = sy - py * this.view.scale;
      this.draw();
    }, { passive: false });
    canvas.addEventListener('dblclick', () => this.fit());
  }

  // Dragged by its grip, kept within the window (as the popup of "Искажение").
  bindGrip() {
    const { panel } = this;
    const title = panel.querySelector('.ripper-title');
    let grab = null;
    title.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) return;
      const at = panel.getBoundingClientRect();
      grab = { dx: event.clientX - at.left, dy: event.clientY - at.top };
      title.setPointerCapture(event.pointerId);
      panel.classList.add('dragging');
      event.preventDefault();
    });
    title.addEventListener('pointermove', (event) => {
      if (!grab) return;
      const { width } = panel.getBoundingClientRect();
      panel.style.left = `${Math.min(Math.max(0, event.clientX - grab.dx), window.innerWidth - Math.min(width, 80))}px`;
      panel.style.top = `${Math.min(Math.max(0, event.clientY - grab.dy), window.innerHeight - 40)}px`;
    });
    const drop = () => {
      grab = null;
      panel.classList.remove('dragging');
    };
    title.addEventListener('pointerup', drop);
    title.addEventListener('pointercancel', drop);
  }

  // Keys with the window in focus are its own, not the editor's shortcuts:
  // Ctrl+V a photo, Enter puts it on, Esc closes, the arrows move the corner
  // last taken by a photo pixel (Shift: ten), Tab goes to the next corner.
  onKey(event) {
    const key = event.key;
    // (Undo and redo go on as anywhere: the picture put on taken back from here)
    if ((event.ctrlKey || event.metaKey) && /^[zy]$/i.test(key)) return;
    event.stopPropagation();
    if (key === 'Escape') {
      event.preventDefault();
      this.close();
    } else if (key === 'Enter' && event.target.tagName !== 'BUTTON') {
      event.preventDefault();
      this.apply();
    } else if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'v') {
      event.preventDefault();
      this.paste();
    } else if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'o') {
      event.preventDefault();
      this.openFile();
    } else if (key === 'Tab' && this.corners && event.target === this.panel) {
      event.preventDefault();
      this.active = (this.active + (event.shiftKey ? 3 : 1)) % 4;
      this.draw();
    } else if (key.startsWith('Arrow') && this.corners && event.target.tagName !== 'INPUT') {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      const [dx, dy] = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[key];
      const [x, y] = this.corners[this.active];
      this.corners[this.active] = [x + dx, y + dy];
      this.refresh();
    }
  }
}
