import { SpriteRenderer, SPRITE_DEFAULTS, sheetJSON } from './sprite-render.js';
import { scrubbable } from './scrub.js';

// The sprite render: a screen of its own over the editor, where the model is
// made into a sprite sheet (see sprite-render.js). On the left, one over the
// other:
//   - the player: the frames shown one after another, large, as a game would
//     show the model turning (a flipbook) - played, paused, stepped, at a
//     number of frames a second;
//   - the sheet itself, pixel for pixel, with the frame being played outlined;
//     a click on a frame shows it in the player.
// Both are drawn anew as soon as a setting changes; the settings are on the
// right, kept between runs. "Save PNG" writes the sheet (and, if asked, a
// JSON of its frames beside it).
//
// While it is open the keyboard is its own: Esc closes it, and the editor's
// shortcuts are off - the model is not to be changed from under it.
//
//   wheel             zoom the sheet (whole steps: pixels stay square)
//   RMB / MMB drag    move it
//   Space             play / pause the player

const SETTINGS_KEY = 'vertex.spriteRender';
// The settings' fields: limits, and whether a whole number.
const FIELDS = {
  directions: { min: 1, max: 64, whole: true },
  start: { min: -360, max: 360, whole: true },
  elevation: { min: 0, max: 90, whole: false },
  scale: { min: 1, max: 16, whole: true },
  width: { min: 1, max: 2048, whole: true },
  height: { min: 1, max: 2048, whole: true },
  count: { min: 1, max: 64, whole: true },
  padding: { min: 0, max: 256, whole: true },
  lightAzimuth: { min: 0, max: 360, whole: true },
  lightElevation: { min: 0, max: 90, whole: true },
  lightStrength: { min: 0.1, max: 10, whole: false },
  steps: { min: 2, max: 8, whole: true },
};
const DIAL = 104; // px across, the light's dials
const MODEL = 22; // px, the model in their middle - the same square in both
const SUN_COLOR = '#f1fa8c';
const MIN_ZOOM = 1;
const MAX_ZOOM = 32;
const FPS = { min: 1, max: 60, initial: 8 }; // the player's frames a second

export class RenderMode {
  constructor(element, editor, { pick, write, name, alert }) {
    this.element = element;
    this.editor = editor;
    this.files = { pick, write, name, alert };
    this.renderer = new SpriteRenderer(editor);
    this.form = element.querySelector('.render-settings');
    this.canvas = element.querySelector('.render-sheet canvas');
    this.preview = element.querySelector('.render-sheet');
    this.player = {
      canvas: element.querySelector('.render-player canvas'),
      pane: element.querySelector('.render-player'),
      frame: 0, // the frame shown
      playing: true,
      since: 0, // when it was shown, ms
    };
    this.sheet = null;
    this.zoom = 0; // 0: not yet fitted
    this.offset = { x: 0, y: 0 };
    this.settings = { ...SPRITE_DEFAULTS, json: false, fps: FPS.initial };
    try {
      const kept = JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {};
      // Kept from before there was a layout: columns, 0 for one row.
      if (kept.layout === undefined && kept.columns > 0) Object.assign(kept, { layout: 'columns', count: kept.columns });
      delete kept.columns;
      if (kept.light === 'sun') kept.light = 'custom'; // the sun was a custom light from its one direction
      Object.assign(this.settings, kept);
    } catch {
      // Not settings: the defaults.
    }

    for (const [name, field] of Object.entries(FIELDS)) {
      const input = this.form.elements[name];
      input.spellcheck = false;
      input.addEventListener('change', () => this.take(name, input.value));
      scrubbable(input, { read: () => this.settings[name], write: (value) => this.take(name, value), whole: field.whole, min: field.min, max: field.max });
    }
    this.form.elements.json.addEventListener('change', (event) => {
      this.settings.json = event.target.checked;
      this.keep();
    });
    this.form.elements.dither.addEventListener('change', (event) => {
      this.settings.dither = event.target.checked;
      this.changed();
    });
    this.form.elements.ditherFaces.addEventListener('change', (event) => {
      this.settings.ditherFaces = event.target.checked;
      this.changed();
    });
    this.form.elements.pot.addEventListener('change', (event) => {
      this.settings.pot = event.target.checked;
      this.changed();
    });
    this.bindDials();
    for (const button of element.querySelectorAll('[data-blend]')) {
      button.addEventListener('click', () => {
        this.settings.blend = button.dataset.blend;
        this.changed();
      });
    }
    for (const button of element.querySelectorAll('[data-layout]')) {
      button.addEventListener('click', () => {
        this.settings.layout = button.dataset.layout;
        this.zoom = 0;
        this.changed();
      });
    }
    for (const button of element.querySelectorAll('[data-light]')) {
      button.addEventListener('click', () => {
        this.settings.light = button.dataset.light;
        this.changed();
      });
    }
    element.querySelector('[data-render="fit"]').addEventListener('click', () => this.fit());
    // The player's bar.
    element.querySelector('[data-player="play"]').addEventListener('click', () => this.play(!this.player.playing));
    element.querySelector('[data-player="previous"]').addEventListener('click', () => this.step(-1));
    element.querySelector('[data-player="next"]').addEventListener('click', () => this.step(1));
    const fps = this.form.ownerDocument.querySelector('#render-mode [name="fps"]');
    fps.addEventListener('change', () => {
      const value = Math.round(parseFloat(fps.value.replace(',', '.')));
      if (Number.isFinite(value)) this.settings.fps = Math.min(FPS.max, Math.max(FPS.min, value));
      fps.value = this.settings.fps;
      this.keep();
    });
    scrubbable(fps, {
      read: () => this.settings.fps,
      write: (value) => {
        this.settings.fps = value;
        fps.value = value;
        this.keep();
      },
      whole: true,
      min: FPS.min,
      max: FPS.max,
    });
    this.fps = fps;
    element.querySelector('[data-render="save"]').addEventListener('click', () => this.save());
    element.querySelector('[data-render="close"]').addEventListener('click', () => this.close());
    for (const button of element.querySelectorAll('button')) button.addEventListener('mousedown', (event) => event.preventDefault());
    this.form.addEventListener('submit', (event) => event.preventDefault());

    // The keyboard is the screen's while it is open.
    for (const type of ['keydown', 'keyup']) {
      window.addEventListener(type, (event) => {
        if (element.hidden) return;
        if (type === 'keydown' && event.code === 'Escape') this.close();
        if (type === 'keydown' && event.code === 'Space' && !(event.target instanceof HTMLInputElement)) {
          event.preventDefault();
          this.play(!this.player.playing);
        }
        if (type === 'keydown' && (event.code === 'Enter' || event.code === 'NumpadEnter') && event.target instanceof HTMLInputElement) event.target.blur();
        if (element.contains(event.target) && event.target instanceof HTMLInputElement) return; // typing in a field
        event.stopImmediatePropagation();
      }, true);
    }
    this.bindPreview();
    new ResizeObserver(() => this.draw()).observe(this.preview);
    new ResizeObserver(() => this.drawPlayer()).observe(this.player.pane);
  }

  get open() {
    return !this.element.hidden;
  }

  show() {
    if (this.editor.busy()) return;
    this.element.hidden = false;
    this.zoom = 0;
    this.player.frame = 0;
    this.changed();
    this.tick();
  }

  close() {
    this.element.hidden = true;
    this.sheet = null;
    cancelAnimationFrame(this.ticking);
    document.activeElement?.blur();
  }

  // A setting from a field, kept within its limits; a field left with no
  // number gets the one it had.
  take(name, text) {
    const field = FIELDS[name];
    let value = parseFloat(String(text).replace(',', '.'));
    if (Number.isFinite(value)) {
      value = Math.min(field.max, Math.max(field.min, field.whole ? Math.round(value) : +value.toFixed(2)));
      this.settings[name] = value;
    }
    this.changed();
  }

  keep() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
  }

  // A setting changed: the fields show them all, and the sheet is made anew.
  changed() {
    this.keep();
    for (const name of Object.keys(FIELDS)) {
      const input = this.form.elements[name];
      if (document.activeElement !== input) input.value = this.settings[name];
    }
    this.form.elements.json.checked = this.settings.json;
    this.form.elements.pot.checked = this.settings.pot;
    this.form.elements.dither.checked = this.settings.dither;
    this.form.elements.ditherFaces.checked = this.settings.ditherFaces;
    const faces = this.element.querySelector('.render-dither-faces');
    faces.classList.toggle('open', this.settings.dither);
    faces.firstElementChild.inert = !this.settings.dither;
    // The grid: one row, or so many columns, or so many rows - the field says which.
    for (const button of this.element.querySelectorAll('[data-layout]')) button.classList.toggle('active', button.dataset.layout === this.settings.layout);
    const count = this.element.querySelector('.render-count');
    count.classList.toggle('open', this.settings.layout !== 'row');
    count.querySelector('div').inert = this.settings.layout === 'row';
    count.querySelector('span').textContent = this.settings.layout === 'rows' ? 'Строк, не больше' : 'Столбцов, не больше';
    // The custom light's own settings, only with it.
    const custom = this.element.querySelector('.render-custom');
    custom.classList.toggle('open', this.settings.light === 'custom');
    custom.firstElementChild.inert = this.settings.light !== 'custom';
    this.drawDials();
    // The blend: only with a light; the number of steps only with steps.
    const lit = this.settings.light !== 'none';
    const blend = this.element.querySelector('.render-blend');
    blend.classList.toggle('open', lit);
    blend.firstElementChild.inert = !lit;
    for (const button of this.element.querySelectorAll('[data-blend]')) button.classList.toggle('active', button.dataset.blend === this.settings.blend);
    const steps = this.element.querySelector('.render-steps');
    steps.classList.toggle('open', this.settings.blend === 'steps');
    steps.firstElementChild.inert = this.settings.blend !== 'steps';
    if (document.activeElement !== this.fps) this.fps.value = this.settings.fps;
    for (const button of this.element.querySelectorAll('[data-light]')) button.classList.toggle('active', button.dataset.light === this.settings.light);
    if (!this.open) return;
    this.sheet = this.renderer.sheet(this.settings);
    const size = this.element.querySelector('.render-size');
    size.textContent = this.sheet
      ? `${this.sheet.frames.length} кадр${plural(this.sheet.frames.length)} по ${this.settings.width} × ${this.settings.height} · ` +
        `${this.sheet.columns} × ${this.sheet.rows} · лист ${this.sheet.canvas.width} × ${this.sheet.canvas.height} px`
      : '';
    this.element.querySelector('.render-empty').hidden = Boolean(this.sheet);
    if (this.sheet) this.player.frame %= this.sheet.frames.length;
    this.draw();
    this.drawPlayer();
  }

  // --- the custom light's dials ---------------------------------------------------
  //
  // Two circles, the model in the middle of each and the light a sun on the
  // rim, which is dragged round it: seen from the side - the model on the
  // ground; up to straight above, the light's height - and seen from above -
  // the model from above, the first frame's camera below it (a mark); round
  // the circle, the side the light is on.

  bindDials() {
    for (const canvas of this.element.querySelectorAll('[data-dial]')) {
      const dial = canvas.dataset.dial;
      let dragging = false;
      const set = (event) => {
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left - rect.width / 2;
        const y = event.clientY - rect.top - rect.height / 2;
        if (dial === 'elevation') {
          // Above the horizon only: the side it is dragged to does not matter (that is the azimuth's).
          this.settings.lightElevation = Math.round(Math.min(90, Math.max(0, degrees(Math.atan2(-y, Math.abs(x))))));
        } else if (x * x + y * y > 4) {
          // Screen right is the first frame's right, screen down its camera's side.
          this.settings.lightAzimuth = (Math.round(degrees(Math.atan2(x, y))) + 360) % 360;
        }
        this.changed();
      };
      canvas.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        dragging = true;
        canvas.setPointerCapture(event.pointerId);
        set(event);
      });
      canvas.addEventListener('pointermove', (event) => {
        if (dragging) set(event);
      });
      const stop = () => {
        dragging = false;
      };
      canvas.addEventListener('pointerup', stop);
      canvas.addEventListener('pointercancel', stop);
    }
  }

  drawDials() {
    const style = getComputedStyle(this.element);
    const line = style.getPropertyValue('--text-dim').trim() || '#888';
    const fill = style.getPropertyValue('--bg').trim() || '#222';
    const ratio = window.devicePixelRatio || 1;
    for (const canvas of this.element.querySelectorAll('[data-dial]')) {
      canvas.width = canvas.height = Math.round(DIAL * ratio);
      canvas.style.width = canvas.style.height = `${DIAL}px`;
      const context = canvas.getContext('2d');
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const c = DIAL / 2;
      const r = DIAL / 2 - 12; // the rim the sun is on
      context.clearRect(0, 0, DIAL, DIAL);
      context.lineWidth = 1.5;
      context.strokeStyle = line;
      context.fillStyle = fill;
      context.beginPath();
      context.arc(c, c, r, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      let sun;
      if (canvas.dataset.dial === 'elevation') {
        // The model on the ground, from the side: in the middle, the ground under it.
        context.strokeRect(c - MODEL / 2, c - MODEL / 2, MODEL, MODEL);
        context.beginPath();
        context.moveTo(c - r * 0.75, c + MODEL / 2);
        context.lineTo(c + r * 0.75, c + MODEL / 2);
        context.lineWidth = 2.5;
        context.stroke();
        const up = (this.settings.lightElevation * Math.PI) / 180;
        sun = { x: c + Math.cos(up) * r, y: c - Math.sin(up) * r };
      } else {
        // The model from above, and its first frame's camera below it.
        context.strokeRect(c - MODEL / 2, c - MODEL / 2, MODEL, MODEL);
        context.fillStyle = line;
        context.beginPath();
        context.moveTo(c, c + r - 9);
        context.lineTo(c - 5, c + r - 1);
        context.lineTo(c + 5, c + r - 1);
        context.closePath();
        context.fill();
        const around = (this.settings.lightAzimuth * Math.PI) / 180;
        sun = { x: c + Math.sin(around) * r, y: c + Math.cos(around) * r };
      }
      // The sun: a disc and its rays.
      context.strokeStyle = SUN_COLOR;
      context.fillStyle = SUN_COLOR;
      context.lineWidth = 1.5;
      context.beginPath();
      context.arc(sun.x, sun.y, 5, 0, Math.PI * 2);
      context.fill();
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        context.beginPath();
        context.moveTo(sun.x + Math.cos(a) * 7.5, sun.y + Math.sin(a) * 7.5);
        context.lineTo(sun.x + Math.cos(a) * 10.5, sun.y + Math.sin(a) * 10.5);
        context.stroke();
      }
    }
  }

  // --- the player ---------------------------------------------------------------

  // Plays or pauses.
  play(on) {
    this.player.playing = on;
    this.player.since = performance.now();
    this.element.querySelector('[data-player="play"] i').className = `fa-solid ${on ? 'fa-pause' : 'fa-play'}`;
  }

  // A frame on (1) or back (-1), paused.
  step(by) {
    if (!this.sheet) return;
    this.play(false);
    this.showFrame((this.player.frame + by + this.sheet.frames.length) % this.sheet.frames.length);
  }

  // Shows frame k in the player, and outlines it on the sheet.
  showFrame(k) {
    this.player.frame = k;
    this.player.since = performance.now();
    this.drawPlayer();
    this.draw();
  }

  // Every screen frame while the render is open: the next frame of the sheet
  // when its time has come.
  tick() {
    cancelAnimationFrame(this.ticking);
    const loop = (now) => {
      if (!this.open) return;
      const { player, sheet } = this;
      if (player.playing && sheet && now - player.since >= 1000 / this.settings.fps) {
        player.since = now;
        this.showFrame((player.frame + 1) % sheet.frames.length);
      }
      this.ticking = requestAnimationFrame(loop);
    };
    this.ticking = requestAnimationFrame(loop);
  }

  // The frame shown, as large as fits in whole steps, in the middle of the
  // player, over chequers; and its number and turn under it.
  drawPlayer() {
    const { canvas, pane } = this.player;
    const { sheet } = this;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!this.open || width === 0 || height === 0) return;
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const label = pane.querySelector('.player-frame');
    if (!sheet) {
      label.textContent = '';
      return;
    }
    const frame = sheet.frames[this.player.frame];
    const zoom = Math.max(1, Math.floor(Math.min((width - 24) / frame.w, (height - 24) / frame.h)));
    const w = frame.w * zoom;
    const h = frame.h * zoom;
    const x = Math.round((width - w) / 2);
    const y = Math.round((height - h) / 2);
    this.chequers(context, x, y, w, h, Math.max(8, zoom * 2));
    context.imageSmoothingEnabled = false;
    context.drawImage(sheet.canvas, frame.x, frame.y, frame.w, frame.h, x, y, w, h);
    label.textContent = `кадр ${this.player.frame + 1} из ${sheet.frames.length} · ${Math.round(frame.angle)}°`;
  }

  // Chequers in a rectangle: what is clear in a picture laid over them shows as such.
  chequers(context, x0, y0, w, h, tile) {
    const style = getComputedStyle(this.element);
    const light = style.getPropertyValue('--bg-raised');
    const dark = style.getPropertyValue('--bg');
    context.save();
    context.beginPath();
    context.rect(x0, y0, w, h);
    context.clip();
    for (let y = 0; y * tile < h; y++) {
      for (let x = 0; x * tile < w; x++) {
        context.fillStyle = (x + y) % 2 ? light : dark;
        context.fillRect(x0 + x * tile, y0 + y * tile, tile, tile);
      }
    }
    context.restore();
  }

  // The frame made to fit the model, in every direction.
  fit() {
    const size = this.renderer.fit(this.settings);
    if (!size) return;
    this.settings.width = Math.min(FIELDS.width.max, size.width);
    this.settings.height = Math.min(FIELDS.height.max, size.height);
    this.zoom = 0;
    this.changed();
  }

  // Draws the sheet on the preview, pixel for pixel at the zoom, over
  // chequers that show what is clear; the frames' bounds lightly outlined.
  draw() {
    const { canvas, preview, sheet } = this;
    const width = preview.clientWidth;
    const height = preview.clientHeight;
    if (!this.open || width === 0) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    if (!sheet) return;
    const { canvas: image } = sheet;
    if (this.zoom === 0) {
      // As large as fits, in whole steps, in the middle.
      this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor(Math.min((width - 40) / image.width, (height - 40) / image.height)) || 1));
      this.offset = { x: Math.round((width - image.width * this.zoom) / 2), y: Math.round((height - image.height * this.zoom) / 2) };
    }
    const { zoom, offset } = this;
    const w = image.width * zoom;
    const h = image.height * zoom;
    // The chequers, under the sheet only.
    this.chequers(context, offset.x, offset.y, w, h, Math.max(4, zoom * 2));
    context.imageSmoothingEnabled = false;
    context.drawImage(image, offset.x, offset.y, w, h);
    context.lineWidth = 1;
    sheet.frames.forEach((frame, k) => {
      if (k === this.player.frame) return;
      context.strokeStyle = 'rgba(255, 255, 255, 0.18)';
      context.strokeRect(offset.x + frame.x * zoom - 0.5, offset.y + frame.y * zoom - 0.5, frame.w * zoom + 1, frame.h * zoom + 1);
    });
    // The frame being played: in the accent colour, over its neighbours' lines.
    const played = sheet.frames[this.player.frame];
    if (played) {
      context.lineWidth = 2;
      context.strokeStyle = getComputedStyle(this.element).getPropertyValue('--accent');
      context.strokeRect(offset.x + played.x * zoom - 1, offset.y + played.y * zoom - 1, played.w * zoom + 2, played.h * zoom + 2);
    }
    // The sheet's size, over its top right corner - as the UV editor shows
    // the atlas' - kept in view however the sheet is moved about or zoomed.
    context.font = '12px "Segoe UI", system-ui, sans-serif';
    context.textAlign = 'right';
    context.textBaseline = 'alphabetic';
    const label = `${image.width} × ${image.height}`;
    const right = Math.max(context.measureText(label).width + 6, Math.min(offset.x + w, width - 6));
    context.fillStyle = getComputedStyle(this.element).getPropertyValue('--text-dim');
    context.fillText(label, right, Math.min(Math.max(offset.y - 6, 16), height - 6));
  }

  // The frame of the sheet at a point of its canvas (client coordinates), or -1.
  frameAt(clientX, clientY) {
    if (!this.sheet) return -1;
    const rect = this.canvas.getBoundingClientRect();
    const x = (clientX - rect.left - this.offset.x) / this.zoom;
    const y = (clientY - rect.top - this.offset.y) / this.zoom;
    return this.sheet.frames.findIndex((frame) => x >= frame.x && y >= frame.y && x < frame.x + frame.w && y < frame.y + frame.h);
  }

  // The wheel zooms at the pointer, RMB or MMB moves the sheet.
  bindPreview() {
    const { canvas } = this;
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      if (!this.sheet) return;
      const rect = canvas.getBoundingClientRect();
      const at = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const before = { x: (at.x - this.offset.x) / this.zoom, y: (at.y - this.offset.y) / this.zoom };
      this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom + (event.deltaY < 0 ? 1 : -1)));
      this.offset = { x: Math.round(at.x - before.x * this.zoom), y: Math.round(at.y - before.y * this.zoom) };
      this.draw();
    }, { passive: false });
    let drag = null;
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button === 0) {
        // A click on a frame: it is shown in the player, paused there.
        const k = this.frameAt(event.clientX, event.clientY);
        if (k >= 0) {
          this.play(false);
          this.showFrame(k);
        }
        return;
      }
      canvas.setPointerCapture(event.pointerId);
      drag = { x: event.clientX, y: event.clientY, offset: { ...this.offset } };
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!drag) return;
      this.offset = { x: drag.offset.x + event.clientX - drag.x, y: drag.offset.y + event.clientY - drag.y };
      this.draw();
    });
    const stop = () => {
      drag = null;
    };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
  }

  // Asks where the sheet goes and writes it there - and the frames' JSON
  // beside it, under the same name, if asked.
  async save() {
    const { sheet, files } = this;
    if (!sheet || !files.pick) return;
    const target = await files.pick(`${files.name()}_sprites`, [{ name: 'Изображение PNG', extension: 'png' }]);
    if (!target) return;
    const bytes = await new Promise((resolve) => {
      sheet.canvas.toBlob(async (blob) => resolve(blob ? new Uint8Array(await blob.arrayBuffer()) : null), 'image/png');
    });
    if (!bytes) return;
    const beside = {};
    if (this.settings.json) {
      const image = target.path.split(/[\\/]/).pop();
      beside[image.replace(/\.png$/i, '.json')] = new TextEncoder().encode(sheetJSON(target.name, image, sheet, this.settings));
    }
    const result = await files.write(target.path, bytes, beside);
    if (result?.error) await files.alert('Не удалось сохранить спрайты', result.error);
  }
}

// Radians in degrees.
function degrees(radians) {
  return (radians * 180) / Math.PI;
}

// The ending of "кадр" after a number: 1 кадр, 2 кадра, 5 кадров.
function plural(count) {
  const n = count % 100;
  if (n >= 11 && n <= 14) return 'ов';
  if (n % 10 === 1) return '';
  return n % 10 >= 2 && n % 10 <= 4 ? 'а' : 'ов';
}
