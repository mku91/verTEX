import { SpriteRenderer, SPRITE_DEFAULTS, sheetJSON, clipsTres, clipsJSON, clipImageName } from './sprite-render.js';
import { scrubbable } from './scrub.js';
import { PINGPONG } from './animation.js';

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
// With animation clips in the model, "Анимация" may have them drawn instead
// of the model at rest (see render() in sprite-render.js): a PNG for
// every clip's direction, a strip of its frames, at the sprite's own rate.
// The one clip picked is what is shown - its directions' strips one under
// another, the player going round the frames of the direction picked in
// them - and "Export" writes them all: the PNGs, Godot's SpriteFrames (a
// .tres naming them) and a JSON of their frames.
//
// The sheets are made in the background (see SpriteRenderer.render()), the
// screen going on meanwhile: a setting changed starts them anew - what was
// being made for the one before is dropped - and till they are there the
// ones before stay, under a spinner that tells how far it has got. Export
// makes its own, a spinner on its button.
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
  spriteFps: { min: 1, max: 60, whole: true },
};
// A clip's preview (see strips()): every direction's strip - a PNG of its
// own - in a frame of this colour, its size on a tab over its top right
// corner; so many screen px from one strip to the next, whatever the zoom.
const STRIP_COLOR = '#bd93f9';
const PLAYED_COLOR = '#ff79c6'; // the frame being played, outlined on the sheet
const STRIP_TAB = 18; // px, the tab's height
const STRIP_BORDER = 2; // px
const STRIP_SPACE = 36; // px from a strip's bottom to the next one's top (its tab and frame in it)
const DIAL = 104; // px across, the light's dials
const MODEL = 22; // px, the model in their middle - the same square in both
const SUN_COLOR = '#f1fa8c';
const MIN_ZOOM = 1;
const MAX_ZOOM = 32;
const FPS = { min: 1, max: 60, initial: 8 }; // the player's frames a second
// The settings' panel: as wide as its left edge is dragged to, remembered.
const PANEL_WIDTH_KEY = 'vertex.renderPanelWidth';
const PANEL_WIDTH = { initial: 300, min: 260 }; // px
const PREVIEW_MIN_WIDTH = 360; // px left to the preview

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
    this.settings = { ...SPRITE_DEFAULTS, json: false, fps: FPS.initial, source: 'rest', spriteFps: 12, clip: null };
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
    // The model at rest, or its clips; the clip shown.
    for (const button of element.querySelectorAll('[data-source]')) {
      button.addEventListener('click', () => {
        this.settings.source = button.dataset.source;
        this.zoom = 0;
        this.player.frame = 0;
        this.changed();
      });
    }
    this.form.elements.clip.addEventListener('change', (event) => {
      this.settings.clip = event.target.value;
      this.zoom = 0;
      this.player.frame = 0;
      this.changed();
    });
    element.querySelector('[data-render="fit"]').addEventListener('click', () => this.fit());
    // The player's bar.
    element.querySelector('[data-player="play"]').addEventListener('click', () => this.play(!this.player.playing));
    element.querySelector('[data-player="previous"]').addEventListener('click', () => this.step(-1));
    element.querySelector('[data-player="next"]').addEventListener('click', () => this.step(1));
    const fps = this.form.ownerDocument.querySelector('#render-mode [name="fps"]');
    // (With the clips it is the sprite's own rate, as "FPS спрайта" is.)
    const setFps = (value) => {
      if (this.clipsOn) {
        this.take('spriteFps', value);
        return;
      }
      this.settings.fps = value;
      fps.value = value;
      this.keep();
    };
    fps.addEventListener('change', () => {
      const value = Math.round(parseFloat(fps.value.replace(',', '.')));
      if (Number.isFinite(value)) setFps(Math.min(FPS.max, Math.max(FPS.min, value)));
      fps.value = this.playerFps;
    });
    scrubbable(fps, {
      read: () => this.playerFps,
      write: setFps,
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
    this.bindPanelWidth();
  }

  get open() {
    return !this.element.hidden;
  }

  // The settings' panel, as wide as its edge is dragged to (as the editor's
  // side panel, see app.js): a double click puts it back; a narrow window
  // squeezes it, and gives it back what was set as it widens.
  bindPanelWidth() {
    const splitter = this.element.querySelector('.render-splitter');
    const body = this.element.querySelector('.render-body');
    let wanted = PANEL_WIDTH.initial;
    try { wanted = parseFloat(localStorage.getItem(PANEL_WIDTH_KEY)) || PANEL_WIDTH.initial; } catch { /* the default */ }
    const apply = () => {
      const room = body.clientWidth - splitter.offsetWidth - PREVIEW_MIN_WIDTH;
      const width = Math.round(Math.min(Math.max(wanted, PANEL_WIDTH.min), Math.max(room, PANEL_WIDTH.min)));
      this.element.style.setProperty('--render-panel', `${width}px`);
      return width;
    };
    const set = (width) => {
      wanted = width;
      wanted = apply();
      try { localStorage.setItem(PANEL_WIDTH_KEY, wanted); } catch { /* not kept: fine */ }
    };
    // The pointer holds the middle of the strip; the panel starts at its right edge.
    const follow = (event) => set(body.getBoundingClientRect().right - event.clientX - splitter.offsetWidth / 2);
    splitter.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      splitter.setPointerCapture(event.pointerId);
      splitter.classList.add('dragging');
      splitter.addEventListener('pointermove', follow);
    });
    const stop = () => {
      splitter.classList.remove('dragging');
      splitter.removeEventListener('pointermove', follow);
    };
    splitter.addEventListener('pointerup', stop);
    splitter.addEventListener('pointercancel', stop);
    splitter.addEventListener('dblclick', () => set(PANEL_WIDTH.initial));
    new ResizeObserver(apply).observe(body);
    apply();
  }

  // The clips drawn instead of the model at rest: asked for, and there are some.
  get clipsOn() {
    return this.settings.source === 'clips' && this.editor.animations.length > 0;
  }

  // The clip shown (see the top).
  shownClip() {
    const clips = this.editor.animations;
    return clips.find((clip) => clip.name === this.settings.clip) ?? clips[0] ?? null;
  }

  // The player's frames a second: the sprite's, with the clips.
  get playerFps() {
    return this.clipsOn ? this.settings.spriteFps : this.settings.fps;
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
    this.renderJob = (this.renderJob ?? 0) + 1; // (what was being made: dropped)
    cancelAnimationFrame(this.renderStart);
    this.showBusy(null);
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
    if (document.activeElement !== this.fps) this.fps.value = this.playerFps;
    // The animation: only with clips; the clip and the sprite's rate only with them on.
    const clips = this.editor.animations;
    this.element.querySelector('.render-animation').hidden = clips.length === 0;
    for (const button of this.element.querySelectorAll('[data-source]')) button.classList.toggle('active', button.dataset.source === (this.clipsOn ? 'clips' : 'rest'));
    const clipBlock = this.element.querySelector('.render-clips');
    clipBlock.classList.toggle('open', this.clipsOn);
    clipBlock.firstElementChild.inert = !this.clipsOn;
    const select = this.form.elements.clip;
    select.replaceChildren(...clips.map((clip) => new Option(clip.name, clip.name)));
    select.value = this.shownClip()?.name ?? '';
    this.form.elements.json.closest('label').hidden = this.clipsOn; // (with the clips the JSON is always written)
    for (const button of this.element.querySelectorAll('[data-light]')) button.classList.toggle('active', button.dataset.light === this.settings.light);
    if (!this.open) return;
    this.rerender();
  }

  // The sheets made anew, in the background (see the top): started on the
  // next screen frame - settings changed in the meantime go into the same
  // start - and shown as soon as they are there, if they are still wanted.
  rerender() {
    const job = (this.renderJob = (this.renderJob ?? 0) + 1);
    const refit = this.zoom === 0; // (fitted to what is coming, not to what is shown meanwhile)
    this.showBusy(0);
    cancelAnimationFrame(this.renderStart);
    this.renderStart = requestAnimationFrame(async () => {
      const settings = structuredClone(this.settings);
      const clips = this.editor.animations;
      const clip = this.clipsOn ? this.shownClip() : null;
      const wanted = () => job === this.renderJob && this.open;
      let made;
      try {
        made = await this.renderer.render(settings, clip ? { clips, drawn: [clip] } : {}, {
          cancelled: () => !wanted(),
          progress: (part) => wanted() && this.showBusy(part),
        });
      } catch (error) {
        if (wanted()) this.showBusy(null);
        throw error;
      }
      if (made === null || !wanted()) return;
      this.showBusy(null);
      if (refit) this.zoom = 0;
      const size = this.element.querySelector('.render-size');
      const empty = made.empty === true;
      if (clip) {
        const shown = empty ? null : made[0];
        this.sheet = shown ? this.strips(shown) : null;
        const strip = shown?.directions[0];
        size.textContent = shown
          ? `${clip.name}: ${shown.directions.length} × ${shown.frames} кадр${plural(shown.frames)} по ${settings.width} × ${settings.height} · ` +
            `${shown.directions.length} PNG по ${strip.width} × ${strip.height} px`
          : '';
        this.element.querySelector('.render-clip-info').textContent = shown
          ? `${shown.frames} кадр${plural(shown.frames)} на направление · ${(clip.length / clip.fps).toFixed(2)} с${clip.loop === PINGPONG ? ' · пинг-понг' : clip.loop ? ' · цикл' : ''}`
          : '';
      } else {
        this.sheet = empty ? null : made;
        size.textContent = this.sheet
          ? `${this.sheet.frames.length} кадр${plural(this.sheet.frames.length)} по ${settings.width} × ${settings.height} · ` +
            `${this.sheet.columns} × ${this.sheet.rows} · лист ${this.sheet.width} × ${this.sheet.height} px`
          : '';
      }
      this.element.querySelector('.render-empty').hidden = Boolean(this.sheet);
      if (this.sheet) this.player.frame = Math.min(this.player.frame, this.sheet.frames.length - 1);
      this.draw();
      this.drawPlayer();
    });
  }

  // The spinner over the preview: how far the sheets have got (0 to 1), or
  // hidden (null). (It shows only if they take a moment, see the stylesheet.)
  showBusy(part) {
    const busy = this.element.querySelector('.render-busy');
    busy.hidden = part === null;
    if (part !== null) busy.querySelector('span').textContent = `${Math.round(part * 100)}%`;
  }

  // A clip's sheets (see clipSheets()) as one picture to show: its
  // directions' strips one under another (`strips`: where each is in it),
  // and their frames - each with its direction's number (`direction`) - in
  // order. On the screen the strips are apart (see place()).
  strips(clip) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(...clip.directions.map((direction) => direction.canvas.width));
    canvas.height = clip.directions.reduce((sum, direction) => sum + direction.canvas.height, 0);
    const context = canvas.getContext('2d');
    const frames = [];
    const strips = [];
    let y = 0;
    clip.directions.forEach((direction, d) => {
      context.drawImage(direction.canvas, 0, y);
      for (const frame of direction.frames) frames.push({ ...frame, y: frame.y + y, direction: d });
      strips.push({ y, w: direction.canvas.width, h: direction.canvas.height });
      y += direction.canvas.height;
    });
    return { canvas, frames, clip, strips };
  }

  // Where a point of the sheet (in its pixels) of direction `d`'s strip is
  // on the preview: the zoom, and STRIP_SPACE between a clip's strips.
  place(x, y, d = 0) {
    return { x: this.offset.x + x * this.zoom, y: this.offset.y + y * this.zoom + d * STRIP_SPACE };
  }

  // The frames the player goes round: with the clips, those of the
  // direction of the frame shown; else all.
  round() {
    const { sheet } = this;
    if (!sheet) return [];
    const all = sheet.frames.map((_, k) => k);
    if (!sheet.clip) return all;
    const direction = sheet.frames[this.player.frame]?.direction ?? 0;
    return all.filter((k) => sheet.frames[k].direction === direction);
  }

  // The frame `by` frames on from the one shown, round the player's frames.
  frameOn(by) {
    const round = this.round();
    const at = Math.max(0, round.indexOf(this.player.frame));
    // A clip going there and back (see LOOPS): to its last frame and back
    // to its first, the player's way kept (`back`) - a frame is passed twice.
    if (this.sheet?.clip?.loop === PINGPONG && round.length > 1) {
      const span = 2 * (round.length - 1);
      const phase = ((((this.player.back ? span - at : at) + by) % span) + span) % span;
      this.player.back = phase >= round.length;
      return round[phase < round.length ? phase : span - phase];
    }
    return round[(at + by + round.length) % round.length];
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
    this.showFrame(this.frameOn(by));
  }

  // Shows frame k in the player, and outlines it on the sheet.
  showFrame(k) {
    this.player.frame = k;
    this.player.since = performance.now();
    this.drawPlayer();
    this.requestDraw();
  }

  // Every screen frame while the render is open: the next frame of the sheet
  // when its time has come.
  tick() {
    cancelAnimationFrame(this.ticking);
    const loop = (now) => {
      if (!this.open) return;
      const { player, sheet } = this;
      if (player.playing && sheet && now - player.since >= 1000 / this.playerFps) {
        player.since = now;
        this.showFrame(this.frameOn(1));
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
    if (sheet.clip) {
      const round = this.round();
      label.textContent = `${sheet.clip.name} · ${Math.round(frame.angle)}° · кадр ${round.indexOf(this.player.frame) + 1} из ${round.length}`;
    } else {
      label.textContent = `кадр ${this.player.frame + 1} из ${sheet.frames.length} · ${Math.round(frame.angle)}°`;
    }
  }

  // Chequers in a rectangle: what is clear in a picture laid over them shows as such.
  // (One fill of a pattern of four tiles, laid from the rectangle's corner -
  // made once for every size and colours - and only where it can be seen:
  // `bounds`, { width, height } of the canvas, if not all of it.)
  chequers(context, x0, y0, w, h, tile, bounds = null) {
    const left = Math.max(x0, 0);
    const top = Math.max(y0, 0);
    const right = bounds ? Math.min(x0 + w, bounds.width) : x0 + w;
    const bottom = bounds ? Math.min(y0 + h, bounds.height) : y0 + h;
    if (right <= left || bottom <= top) return;
    const style = getComputedStyle(this.element);
    const light = style.getPropertyValue('--bg-raised');
    const dark = style.getPropertyValue('--bg');
    const key = `${tile} ${light} ${dark}`;
    this.patterns ??= new Map();
    if (!this.patterns.has(key)) {
      const cells = document.createElement('canvas');
      cells.width = cells.height = tile * 2;
      const draw = cells.getContext('2d');
      draw.fillStyle = dark;
      draw.fillRect(0, 0, tile * 2, tile * 2);
      draw.fillStyle = light;
      draw.fillRect(tile, 0, tile, tile);
      draw.fillRect(0, tile, tile, tile);
      this.patterns.set(key, cells);
    }
    const pattern = context.createPattern(this.patterns.get(key), 'repeat');
    pattern.setTransform(new DOMMatrix().translate(x0, y0));
    context.fillStyle = pattern;
    context.fillRect(left, top, right - left, bottom - top);
  }

  // The frame made to fit the model, in every direction.
  // (With the clips: in every pose of all of them.)
  async fit() {
    const button = this.element.querySelector('[data-render="fit"]');
    button.disabled = true;
    let size;
    try {
      size = this.clipsOn ? await this.renderer.fitClips(this.settings, this.editor.animations) : this.renderer.fit(this.settings);
    } finally {
      button.disabled = false;
    }
    if (!size) return;
    this.settings.width = Math.min(FIELDS.width.max, size.width);
    this.settings.height = Math.min(FIELDS.height.max, size.height);
    this.zoom = 0;
    this.changed();
  }

  // Draws the sheet on the preview, pixel for pixel at the zoom, over
  // chequers that show what is clear; the frames' bounds lightly outlined.
  //
  // Only what can be seen is drawn - the strips, the frames' outlines and the
  // tabs in the canvas - and the canvas is sized anew only when it changes:
  // moved about or zoomed, a large sheet goes as smoothly as a small one.
  draw() {
    cancelAnimationFrame(this.drawing);
    this.drawing = 0;
    const { canvas, preview, sheet } = this;
    const width = preview.clientWidth;
    const height = preview.clientHeight;
    if (!this.open || width === 0) return;
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    if (!sheet) return;
    const { canvas: image } = sheet;
    // (a clip's strips: apart on the screen, each a tab over it)
    const strips = sheet.strips ?? [{ y: 0, w: image.width, h: image.height }];
    const spaces = (strips.length - 1) * STRIP_SPACE;
    const top = sheet.strips ? STRIP_TAB + STRIP_BORDER : 0;
    if (this.zoom === 0) {
      // As large as fits, in whole steps, in the middle.
      this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor(Math.min((width - 40) / image.width, (height - 40 - spaces - top) / image.height)) || 1));
      this.offset = { x: Math.round((width - image.width * this.zoom) / 2), y: Math.round((height - image.height * this.zoom - spaces - top) / 2) + top };
    }
    const { zoom, offset } = this;
    const w = image.width * zoom;
    const h = image.height * zoom;
    const style = getComputedStyle(this.element);
    // Whether a rectangle of the canvas (with `margin` round it) can be seen.
    const seen = (x, y, rw, rh, margin = 0) => x + rw + margin > 0 && y + rh + margin > 0 && x - margin < width && y - margin < height;
    const shown = strips.map((strip, d) => ({ strip, d, at: this.place(0, strip.y, d) }))
      .filter(({ strip, at }) => seen(at.x, at.y, strip.w * zoom, strip.h * zoom, STRIP_TAB + STRIP_BORDER));
    // The chequers, under the sheet only; the sheet over them, strip by strip.
    context.imageSmoothingEnabled = false;
    for (const { strip, at } of shown) {
      this.chequers(context, at.x, at.y, strip.w * zoom, strip.h * zoom, Math.max(4, zoom * 2), { width, height });
      context.drawImage(image, 0, strip.y, strip.w, strip.h, at.x, at.y, strip.w * zoom, strip.h * zoom);
    }
    // The frames' outlines, in one go.
    context.lineWidth = 1;
    context.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    context.beginPath();
    sheet.frames.forEach((frame, k) => {
      if (k === this.player.frame) return;
      const at = this.place(frame.x, frame.y, frame.direction);
      if (seen(at.x, at.y, frame.w * zoom, frame.h * zoom, 1)) context.rect(at.x - 0.5, at.y - 0.5, frame.w * zoom + 1, frame.h * zoom + 1);
    });
    context.stroke();
    // A clip's strips: each in its frame, its size on the tab.
    if (sheet.strips) {
      context.font = '12px "Segoe UI", system-ui, sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      const tabText = style.getPropertyValue('--bg');
      for (const { strip, at } of shown) {
        const outer = { x: at.x - STRIP_BORDER, y: at.y - STRIP_BORDER, w: strip.w * zoom + 2 * STRIP_BORDER, h: strip.h * zoom + 2 * STRIP_BORDER };
        context.strokeStyle = STRIP_COLOR;
        context.lineWidth = STRIP_BORDER;
        context.strokeRect(outer.x + STRIP_BORDER / 2, outer.y + STRIP_BORDER / 2, outer.w - STRIP_BORDER, outer.h - STRIP_BORDER);
        const label = `${strip.w} × ${strip.h}`;
        const tab = Math.ceil(context.measureText(label).width) + 14;
        context.fillStyle = STRIP_COLOR;
        context.fillRect(outer.x + outer.w - tab, outer.y - STRIP_TAB, tab, STRIP_TAB);
        context.fillStyle = tabText;
        context.fillText(label, outer.x + outer.w - tab / 2, outer.y - STRIP_TAB / 2 + 0.5);
      }
    }
    // The frame being played: in its own colour, over its neighbours' lines.
    const played = sheet.frames[this.player.frame];
    if (played) {
      const at = this.place(played.x, played.y, played.direction);
      context.lineWidth = 2;
      context.strokeStyle = PLAYED_COLOR;
      context.strokeRect(at.x - 1, at.y - 1, played.w * zoom + 2, played.h * zoom + 2);
    }
    if (sheet.strips) return; // (their sizes are on their tabs)
    // The sheet's size, over its top right corner - as the UV editor shows
    // the atlas' - kept in view however the sheet is moved about or zoomed.
    context.font = '12px "Segoe UI", system-ui, sans-serif';
    context.textAlign = 'right';
    context.textBaseline = 'alphabetic';
    const label = `${image.width} × ${image.height}`;
    const right = Math.max(context.measureText(label).width + 6, Math.min(offset.x + w, width - 6));
    context.fillStyle = style.getPropertyValue('--text-dim');
    context.fillText(label, right, Math.min(Math.max(offset.y - 6, 16), height - 6));
  }

  // draw() on the next screen frame, however many times it is asked for
  // before then: what moves the sheet about or zooms it asks so.
  requestDraw() {
    if (!this.drawing) this.drawing = requestAnimationFrame(() => this.draw());
  }

  // The frame of the sheet at a point of its canvas (client coordinates), or -1.
  frameAt(clientX, clientY) {
    if (!this.sheet) return -1;
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return this.sheet.frames.findIndex((frame) => {
      const at = this.place(frame.x, frame.y, frame.direction);
      return x >= at.x && y >= at.y && x < at.x + frame.w * this.zoom && y < at.y + frame.h * this.zoom;
    });
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
      this.requestDraw();
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
      this.requestDraw();
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
    if (!sheet || !files.pick || this.exporting) return;
    if (this.clipsOn) return this.saveClips();
    const target = await files.pick(`${files.name()}_sprites`, [{ name: 'Изображение PNG', extension: 'png' }]);
    if (!target) return;
    const settings = structuredClone(this.settings);
    const made = await this.exported(() => this.renderer.render(settings, { png: true }, { cancelled: () => !this.open }));
    if (!made?.png) return;
    const beside = {};
    if (settings.json) {
      const image = target.path.split(/[\\/]/).pop();
      beside[image.replace(/\.png$/i, '.json')] = new TextEncoder().encode(sheetJSON(target.name, image, made, settings));
    }
    const result = await files.write(target.path, made.png, beside);
    if (result?.error) await files.alert('Не удалось сохранить спрайты', result.error);
  }

  // Runs `make` (the sheets for export) with a spinner on the Export button.
  async exported(make) {
    const button = this.element.querySelector('[data-render="save"]');
    const text = button.innerHTML;
    this.exporting = true;
    button.disabled = true;
    button.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Экспорт…';
    try {
      return await make();
    } finally {
      this.exporting = false;
      button.disabled = false;
      button.innerHTML = text;
    }
  }

  // The clips: asks where Godot's SpriteFrames (.tres) goes, and writes it
  // there - and beside it every clip's direction's PNG, named after it
  // (<name>_<clip>_<angle>.png), and the JSON of their frames (<name>.json).
  async saveClips() {
    const { files } = this;
    const target = await files.pick(`${files.name()}_sprites`, [{ name: 'Godot SpriteFrames', extension: 'tres' }]);
    if (!target) return;
    const settings = structuredClone(this.settings);
    const sheets = await this.exported(() => this.renderer.render(settings, { clips: this.editor.animations, png: true }, { cancelled: () => !this.open }));
    if (!Array.isArray(sheets)) return;
    const encoder = new TextEncoder();
    const beside = {};
    for (const clip of sheets) {
      for (const direction of clip.directions) beside[clipImageName(target.name, clip, direction)] = direction.png;
    }
    beside[`${target.name}.json`] = encoder.encode(clipsJSON(target.name, sheets, settings));
    const result = await files.write(target.path, encoder.encode(clipsTres(target.name, sheets)), beside);
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
