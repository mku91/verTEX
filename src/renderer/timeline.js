import { theme, onThemeChange } from './theme.js';
import { scrubbable } from './scrub.js';
import { latinOnly, latinName, freeName } from './names.js';
import { MAX_FPS, PROPERTIES } from './animation.js';

// The animation mode's panel, at the bottom of the window (see animation.js
// for what a clip is): the clips - made, named, timed, taken away - and the
// timeline of the one worked on, with its keys and the frame looked at.
//
//   the bar      the clip and its settings, play and the frames, Autokey
//   the names    every entry of the scene, as in the scene tree, with a row
//                under it for each of its tracks: position, rotation, scale
//   the lanes    the frames left to right, a row for each name; the clip's
//                length lit; its keys; the frame looked at, a line
//
// Every frame is a line of the lanes, frame 0 the very left edge; its keys
// and the line of the frame looked at stand on it, its number to its right.
//
// A press on the frames' ruler or on a lane takes the line there, and a drag
// takes it along - from frame to frame, or between them with Ctrl held; the wheel makes the frames wider or narrower, about the
// pointer; the middle button moves them. What is changed in a clip is one
// undo step (see Editor.setAnimations()). The frame looked at and the clip
// worked on are the mode's, not the document's.

const ROW = 24; // px a row (as .tl-name)
const RULER = 26; // px of the frames' ruler
const MIN_FRAME_WIDTH = 2;
const MAX_FRAME_WIDTH = 60;
const NAMES_WIDTH_KEY = 'vertex.timelineNames';
const NAMES_WIDTH = 220; // px, at first
const NAMES_MIN = 120;
const PROPERTY_NAMES = { position: 'Позиция', rotation: 'Поворот', scale: 'Масштаб' };
const NEW_CLIP = { fps: 12, length: 24, loop: true };

export class Timeline extends EventTarget {
  constructor(section, editor) {
    super();
    this.section = section;
    this.editor = editor;
    this.open = false;
    this.clip = null; // the name of the clip worked on
    this.frame = 0; // the frame looked at (a fraction while playing)
    this.playing = false;
    this.autokey = false;
    this.frameWidth = 14; // px a frame
    this.scroll = 0; // the frame at the left edge of the lanes (a fraction; never below 0)
    this.folded = new Set(); // entries whose tracks are not shown
    this.rows = []; // what each row of the lanes is: { index, property? }

    const $ = (selector) => section.querySelector(selector);
    this.select = $('.clip-select');
    this.fields = { name: $('[name="clip-name"]'), fps: $('[name="clip-fps"]'), length: $('[name="clip-length"]'), loop: $('.tl-loop') };
    this.frameLabel = $('.tl-frame');
    this.names = $('.tl-names');
    this.ruler = $('.tl-ruler');
    this.lanes = $('.tl-lanes');
    this.scroller = $('.tl-scroll');
    this.empty = $('.tl-empty');
    this.body = $('.tl-body');

    this.bindBar();
    this.bindLanes();
    this.bindResize();
    new ResizeObserver(() => this.draw()).observe(this.lanes.parentElement);
    editor.addEventListener('change', () => this.update());
    onThemeChange(() => this.draw());
  }

  toggle(open = !this.open) {
    this.open = open;
    this.section.hidden = !open;
    if (!open) this.play(false);
    if (open) this.update();
    return open;
  }

  // --- the clips ---------------------------------------------------------------

  get clips() {
    return this.editor.animations;
  }

  current() {
    return this.clips.find((clip) => clip.name === this.clip) ?? null;
  }

  // The clips with this one changed (by its name), as one undo step.
  change(name, changes, record = true) {
    this.editor.setAnimations(this.clips.map((clip) => (clip.name === name ? { ...clip, ...changes } : clip)), record);
  }

  addClip(from = null) {
    const names = new Set(this.clips.map((clip) => clip.name));
    const clip = from
      ? { ...structuredClone(from), name: freeName(from.name, names) }
      : { name: freeName('idle', names), ...NEW_CLIP, tracks: [] };
    this.clip = clip.name;
    this.frame = 0;
    this.editor.setAnimations([...this.clips, clip]);
  }

  deleteClip() {
    const clip = this.current();
    if (!clip) return;
    const at = this.clips.indexOf(clip);
    const rest = this.clips.filter((other) => other !== clip);
    this.clip = rest[Math.min(at, rest.length - 1)]?.name ?? null;
    this.editor.setAnimations(rest);
  }

  rename(name) {
    const clip = this.current();
    name = name.trim();
    if (!clip || !name || latinName(name) !== name || name === clip.name) return this.showBar();
    const unique = freeName(name, new Set(this.clips.filter((other) => other !== clip).map((other) => other.name)));
    this.clip = unique;
    this.change(clip.name, { name: unique });
  }

  // --- the frame looked at ---------------------------------------------------------

  setFrame(frame) {
    const clip = this.current();
    const last = clip ? clip.length : 0;
    frame = Math.max(0, Math.min(last, frame));
    if (frame === this.frame) return;
    this.frame = frame;
    this.showFrame();
    this.dispatchEvent(new Event('frame'));
  }

  // Playing: the frames go by at the clip's rate; round again if it loops,
  // else it stops at the end.
  play(on = !this.playing) {
    const clip = this.current();
    if (on && !clip) return false;
    if (on === this.playing) return true;
    this.playing = on;
    if (on) {
      if (this.frame >= clip.length && !clip.loop) this.frame = 0;
      let last = performance.now();
      const tick = (time) => {
        if (!this.playing) return;
        const clipNow = this.current();
        if (!clipNow) return this.play(false);
        let frame = this.frame + ((time - last) / 1000) * clipNow.fps;
        last = time;
        if (frame >= clipNow.length) {
          if (clipNow.loop) frame %= clipNow.length;
          else {
            this.setFrame(clipNow.length);
            return this.play(false);
          }
        }
        this.frame = frame;
        this.showFrame();
        this.dispatchEvent(new Event('frame'));
        this.request = requestAnimationFrame(tick);
      };
      this.request = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(this.request);
      this.setFrame(Math.round(this.frame));
    }
    this.showBar();
    return true;
  }

  // --- the bar ------------------------------------------------------------------

  bindBar() {
    const { section, fields } = this;
    for (const button of section.querySelectorAll('button')) button.addEventListener('mousedown', (event) => event.preventDefault());
    const commands = {
      add: () => this.addClip(),
      duplicate: () => this.current() && this.addClip(this.current()),
      delete: () => this.deleteClip(),
      first: () => this.setFrame(0),
      prev: () => this.setFrame(Math.ceil(this.frame) - 1),
      play: () => this.play(),
      next: () => this.setFrame(Math.floor(this.frame) + 1),
      last: () => this.setFrame(this.current()?.length ?? 0),
      autokey: () => {
        this.autokey = !this.autokey;
        this.showBar();
        this.dispatchEvent(new Event('autokey'));
      },
    };
    for (const button of section.querySelectorAll('[data-tl]')) {
      button.addEventListener('click', () => commands[button.dataset.tl]());
    }
    this.select.addEventListener('change', () => {
      this.play(false);
      this.clip = this.select.value;
      this.frame = 0;
      this.update();
      this.dispatchEvent(new Event('frame'));
    });

    latinOnly(fields.name);
    fields.name.addEventListener('change', () => this.rename(fields.name.value));
    for (const input of [fields.name, fields.fps, fields.length]) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === 'Escape') input.blur();
        event.stopPropagation(); // the keys are the field's, not the shortcuts'
      });
    }
    // The numbers: typed, or dragged by their handles (one undo step a drag).
    const number = (input, key, min, max) => {
      const read = () => parseInt(input.value, 10);
      const write = (value, record) => {
        const clip = this.current();
        if (!clip || !Number.isFinite(value)) return this.showBar();
        value = Math.max(min, Math.min(max, Math.round(value)));
        if (value !== clip[key]) this.change(clip.name, { [key]: value }, record);
        if (key === 'length' && this.frame > value) this.setFrame(value);
      };
      input.addEventListener('change', () => write(read(), true));
      let before = null;
      scrubbable(input, {
        read,
        write: (value) => {
          input.value = value;
          write(value, false);
        },
        begin: () => { before = this.editor.snapshot(); },
        end: () => {
          const was = JSON.stringify(before.animations);
          if (was !== JSON.stringify(this.clips)) this.editor.history.push(before);
          this.editor.emitChange();
        },
        whole: true,
        min,
        max,
      });
    };
    number(fields.fps, 'fps', 1, MAX_FPS);
    number(fields.length, 'length', 1, 100000);
    // The loop: a button that stays pressed while the clip loops.
    fields.loop.addEventListener('click', () => {
      const clip = this.current();
      if (clip) this.change(clip.name, { loop: !clip.loop });
    });
  }

  showBar() {
    const clip = this.current();
    const { select, fields } = this;
    select.replaceChildren(...this.clips.map((other) => new Option(other.name, other.name, false, other.name === this.clip)));
    select.disabled = this.clips.length === 0;
    for (const button of this.section.querySelectorAll('[data-tl]')) {
      if (button.dataset.tl !== 'add') button.disabled = !clip;
    }
    for (const input of [fields.name, fields.fps, fields.length, fields.loop]) input.disabled = !clip;
    if (document.activeElement !== fields.name) fields.name.value = clip?.name ?? '';
    if (document.activeElement !== fields.fps) fields.fps.value = clip?.fps ?? '';
    if (document.activeElement !== fields.length) fields.length.value = clip?.length ?? '';
    fields.loop.classList.toggle('active', Boolean(clip?.loop));
    const play = this.section.querySelector('[data-tl="play"]');
    play.firstElementChild.className = `fa-solid ${this.playing ? 'fa-pause' : 'fa-play'}`;
    play.title = this.playing ? 'Пауза (Enter)' : 'Воспроизвести (Enter)';
    this.section.querySelector('[data-tl="autokey"]').classList.toggle('active', this.autokey);
    this.showFrame();
  }

  showFrame() {
    const clip = this.current();
    // (between frames - with Ctrl, see bindLanes() - to a tenth; while playing, the frame it is in)
    const shown = this.playing || Number.isInteger(this.frame) ? Math.floor(this.frame) : this.frame.toFixed(1);
    this.frameLabel.textContent = clip ? `${shown} / ${clip.length}` : '';
    this.draw();
  }

  // --- the names ------------------------------------------------------------------

  // Everything as it stands: the clip worked on (the first, if that one is
  // gone), the bar, the names and the lanes.
  update() {
    if (!this.open) return;
    if (!this.current()) {
      this.clip = this.clips[0]?.name ?? null;
      this.frame = 0;
    }
    const clip = this.current();
    this.empty.hidden = Boolean(clip);
    this.body.hidden = !clip;
    this.showBar();
    this.showNames();
  }

  // The entries in the scene tree's order, with their tracks' rows under them.
  showNames() {
    const { islands } = this.editor.topology;
    const hand = new Set(this.editor.objectsInHand());
    const picked = this.editor.mode === 'object' ? this.editor.picked : new Set();
    const clip = this.current();
    const animated = new Set(clip?.tracks.map((track) => track.object) ?? []);
    const signature = JSON.stringify([islands.map((island) => [island.id, island.name, island.kind, island.parentIndex, island.hidden]), [...hand], [...picked], [...this.folded], [...animated]]);
    if (signature !== this.shownNames) {
      this.shownNames = signature;
      const rows = [];
      const lines = [];
      const add = (index, depth) => {
        const island = islands[index];
        const folded = this.folded.has(island.id);
        const line = document.createElement('div');
        line.className = 'tl-name';
        line.style.paddingLeft = `${4 + depth * 12}px`;
        line.classList.toggle('picked', picked.has(index) || hand.has(index));
        line.classList.toggle('hidden', island.hidden);
        line.classList.toggle('animated', animated.has(island.id));
        line.innerHTML = `<span class="tl-fold"><i class="fa-solid fa-caret-${folded ? 'right' : 'down'}"></i></span><i class="fa-solid ${island.kind === 'group' ? 'fa-folder' : 'fa-cube'}"></i>`;
        const name = document.createElement('span');
        name.textContent = island.name;
        line.append(name);
        line.dataset.index = index;
        lines.push(line);
        rows.push({ index });
        if (folded) return;
        for (const property of PROPERTIES) {
          const sub = document.createElement('div');
          sub.className = 'tl-name tl-track';
          sub.style.paddingLeft = `${26 + depth * 12}px`;
          sub.textContent = PROPERTY_NAMES[property];
          lines.push(sub);
          rows.push({ index, property });
        }
        for (const child of island.children) add(child, depth + 1);
      };
      islands.forEach((island, index) => {
        if (island.parentIndex === null) add(index, 0);
      });
      this.names.replaceChildren(...lines);
      this.rows = rows;
    }
    this.draw();
  }

  // --- the lanes ------------------------------------------------------------------

  // The frame at a point of the lanes (client x; rounded, the nearest line), and back.
  frameAt(clientX) {
    return (clientX - this.lanes.getBoundingClientRect().left) / this.frameWidth + this.scroll;
  }

  xOf(frame) {
    return (frame - this.scroll) * this.frameWidth;
  }

  bindLanes() {
    // A press on the ruler or a lane: the frame looked at goes there, and with the drag.
    for (const canvas of [this.ruler, this.lanes]) {
      canvas.addEventListener('pointerdown', (event) => {
        if (event.button === 1) {
          // The middle button: the frames move with the pointer.
          event.preventDefault();
          canvas.setPointerCapture(event.pointerId);
          const start = { x: event.clientX, scroll: this.scroll };
          const move = (moved) => {
            this.scroll = Math.max(0, start.scroll - (moved.clientX - start.x) / this.frameWidth); // (nothing before frame 0)
            this.draw();
          };
          const up = () => {
            canvas.removeEventListener('pointermove', move);
            canvas.removeEventListener('pointerup', up);
          };
          canvas.addEventListener('pointermove', move);
          canvas.addEventListener('pointerup', up);
          return;
        }
        if (event.button !== 0 || !this.current()) return;
        canvas.setPointerCapture(event.pointerId);
        this.play(false);
        // On the frames' lines; with Ctrl held, anywhere between them.
        const go = (at) => {
          const frame = this.frameAt(at.clientX);
          this.setFrame(at.ctrlKey ? Math.round(frame * 100) / 100 : Math.round(frame));
        };
        go(event);
        const up = () => {
          canvas.removeEventListener('pointermove', go);
          canvas.removeEventListener('pointerup', up);
        };
        canvas.addEventListener('pointermove', go);
        canvas.addEventListener('pointerup', up);
      });
      canvas.addEventListener('wheel', (event) => {
        event.preventDefault();
        const at = this.frameAt(event.clientX);
        this.frameWidth = Math.max(MIN_FRAME_WIDTH, Math.min(MAX_FRAME_WIDTH, this.frameWidth * (event.deltaY < 0 ? 1.2 : 1 / 1.2)));
        this.scroll = Math.max(0, at - (event.clientX - this.lanes.getBoundingClientRect().left) / this.frameWidth);
        this.draw();
      }, { passive: false });
    }
    this.scroller.addEventListener('scroll', () => this.draw());
    // A name: its fold, or the entry picked.
    this.names.addEventListener('mousedown', (event) => event.preventDefault());
    this.names.addEventListener('click', (event) => {
      const line = event.target.closest('[data-index]');
      if (!line) return;
      const index = Number(line.dataset.index);
      if (event.target.closest('.tl-fold')) {
        const { id } = this.editor.topology.islands[index];
        if (!this.folded.delete(id)) this.folded.add(id);
        this.showNames();
        return;
      }
      this.editor.selectObject(index, event.shiftKey);
    });
  }

  // The names' column is as wide as it is dragged (remembered between launches).
  setNamesWidth(width) {
    const most = Math.max(NAMES_MIN, this.section.clientWidth * 0.6 || 600);
    width = Math.round(Math.max(NAMES_MIN, Math.min(most, width)));
    this.section.style.setProperty('--tl-names', `${width}px`);
    try { localStorage.setItem(NAMES_WIDTH_KEY, width); } catch { /* not kept: fine */ }
  }

  bindResize() {
    const handle = this.section.querySelector('.tl-resize');
    let saved = NAMES_WIDTH;
    try { saved = parseFloat(localStorage.getItem(NAMES_WIDTH_KEY)) || NAMES_WIDTH; } catch { /* the default */ }
    this.section.style.setProperty('--tl-names', `${Math.max(NAMES_MIN, saved)}px`);
    const follow = (event) => this.setNamesWidth(event.clientX - this.body.getBoundingClientRect().left);
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('dragging');
      handle.addEventListener('pointermove', follow);
    });
    const stop = () => {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', follow);
    };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
    handle.addEventListener('dblclick', () => this.setNamesWidth(NAMES_WIDTH));
  }

  draw() {
    if (!this.open || this.body.hidden) return;
    const clip = this.current();
    const css = getComputedStyle(document.documentElement);
    const color = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const colors = {
      bg: color('--bg', theme.bg), raised: color('--bg-raised', theme.bgRaised), border: color('--border', theme.border),
      text: color('--text', theme.text), dim: color('--text-dim', theme.textDim), accent: color('--accent', theme.accent),
    };
    const ratio = window.devicePixelRatio || 1;
    const width = this.lanes.parentElement.clientWidth;
    const prepare = (canvas, height) => {
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      const context = canvas.getContext('2d');
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      return context;
    };
    // Which frames get a line, and which a number: no closer than a few pixels.
    const step = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((each) => each * this.frameWidth >= 40) ?? 1000;
    const first = Math.floor(this.scroll);
    const lastShown = Math.ceil(this.scroll + width / this.frameWidth);
    const length = clip?.length ?? 0;

    // The ruler: numbers every `step` frames, and the frame looked at.
    const ruler = prepare(this.ruler, RULER);
    ruler.fillStyle = colors.raised;
    ruler.fillRect(0, 0, width, RULER);
    ruler.font = '11px "Segoe UI", sans-serif';
    ruler.textBaseline = 'top';
    // A mark on every frame's line (a short one when there is room), and the
    // number to the right of its line - where the frame's line does not cover it.
    const fineMarks = this.frameWidth >= 6;
    for (let frame = Math.max(0, first); frame <= lastShown; frame += 1) {
      const major = frame % step === 0;
      if (!major && !fineMarks) continue;
      const x = Math.round(this.xOf(frame));
      ruler.fillStyle = frame <= length ? colors.dim : colors.border;
      ruler.fillRect(x, major ? RULER - 7 : RULER - 3, 1, major ? 7 : 3);
      if (major) ruler.fillText(String(frame), x + 4, 5);
    }

    // The lanes: a row for each name, the clip's frames lit, a line every frame (when there is room).
    const height = Math.max(this.rows.length * ROW, this.scroller.clientHeight);
    const lanes = prepare(this.lanes, height);
    lanes.fillStyle = colors.bg;
    lanes.fillRect(0, 0, width, height);
    lanes.fillStyle = colors.raised;
    lanes.fillRect(this.xOf(0), 0, length * this.frameWidth, height);
    this.rows.forEach((row, k) => {
      if (row.property) return;
      lanes.fillStyle = colors.border;
      lanes.fillRect(0, k * ROW, width, 1);
    });
    const fine = this.frameWidth >= 6 ? 1 : step;
    for (let frame = Math.max(0, first - (first % fine)); frame <= Math.min(lastShown, length); frame += fine) {
      lanes.fillStyle = frame % step === 0 ? colors.border : `${colors.border}88`;
      lanes.fillRect(Math.round(this.xOf(frame)), 0, 1, height);
    }
    // The keys of the clip, on their tracks' rows, and a dot on the entry's row for every frame with any.
    if (clip) {
      const ids = this.editor.topology.islands.map((island) => island.id);
      const size = Math.min(6, Math.max(3, this.frameWidth / 3));
      const diamond = (x, y, filled) => {
        lanes.beginPath();
        lanes.moveTo(x, y - size);
        lanes.lineTo(x + size, y);
        lanes.lineTo(x, y + size);
        lanes.lineTo(x - size, y);
        lanes.closePath();
        if (filled) lanes.fill();
        else lanes.stroke();
      };
      lanes.fillStyle = colors.text;
      lanes.strokeStyle = colors.dim;
      this.rows.forEach((row, k) => {
        const id = ids[row.index];
        const tracks = clip.tracks.filter((track) => track.object === id && (!row.property || track.property === row.property));
        const frames = new Set(tracks.flatMap((track) => track.keys.map((key) => key.frame)));
        // (on its line, always: a key on frame 0, at the very edge, shows its right half)
        for (const frame of frames) diamond(this.xOf(frame), k * ROW + ROW / 2, Boolean(row.property));
      });
    }
    // The frame looked at: on its line, over it.
    const x = Math.round(this.xOf(this.frame));
    for (const context of [ruler, lanes]) {
      context.fillStyle = colors.accent;
      context.fillRect(Math.max(0, x - 0.5), 0, 2, context === ruler ? RULER : height);
    }
  }
}
