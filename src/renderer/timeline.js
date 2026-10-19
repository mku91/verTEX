import { theme, onThemeChange } from './theme.js';
import { scrubbable } from './scrub.js';
import { latinOnly, latinName, freeName } from './names.js';
import {
  MAX_FPS, PROPERTIES, frameOf, keyId, moveKeys, removeKeys, setInterpolation, setKey, copyKeys, pasteKeys,
  EASE_FAMILIES, EASE_DIRECTIONS, easing, easeParts, bezierOf, setEase, stillKeys, sameValue,
} from './animation.js';

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
// takes it along - from frame to frame, or between them with Ctrl held; the
// wheel moves the frames back and forth, and with Ctrl makes them wider or
// narrower about the pointer; the middle button moves them. What is changed in a clip is one
// undo step (see Editor.setAnimations()). The frame looked at and the clip
// worked on are the mode's, not the document's.
//
// The keys (see animation.js): diamonds in the colour of what they key, with
// a line to the next saying how they go on to it - straight, dashed (a
// step), tildes (smooth); on an entry's own row, an outline for any of its
// keys on a frame.
//   click        picks a key (on an entry's row, all its keys there);
//                Shift adds or takes away
//   drag         takes the picked keys along, frame by frame
//   Shift+drag   from an empty place: a box round the keys to pick
//   right click  their interpolation, or taking them away
//   double click a key's own settings beside it: its frame, its value, its
//                interpolation
//   a track's +  a key of it on the frame, as the entry is shown (see animate.js)
//   Delete, Ctrl+C, Ctrl+V   (see app.js) take them away, copy them, put
//                the copy down from the frame looked at

const ROW = 24; // px a row (as .tl-name)
const BEFORE = 1; // frames of room before frame 0, hatched
const RULER = 26; // px of the frames' ruler
const SECONDS = 21; // px of the seconds' ruler, under the lanes (and its border)
const MIN_FRAME_WIDTH = 2;
const GLIDE = 60; // ms: how quickly the frames close in on where the wheel sends them (see glideTo())
const REVEAL_GLIDE = 90; // ms: how quickly the rows close in on an entry picked out of sight (see revealPicked())
const REVEAL_MARGIN = 8; // px left over the entry's rows, or under them
const WHEEL_PX = 0.6; // px the frames go by for a pixel of the wheel's travel (a notch: ~60 px)
const MAX_FRAME_WIDTH = 60;
const NAMES_WIDTH_KEY = 'vertex.timelineNames';
const GROUPS_ONLY_KEY = 'vertex.timelineGroupsOnly';
const NAMES_WIDTH = 220; // px, at first
const NAMES_MIN = 120;
const PROPERTY_NAMES = { position: 'Позиция', rotation: 'Поворот', scale: 'Масштаб' };
const NEW_CLIP = { fps: 12, length: 24, loop: true };
const INTERPOLATION_NAMES = { linear: 'Линейная', step: 'Шаг', smooth: 'Плавная' };
const KEY_COLORS = { position: 'keyPosition', rotation: 'keyRotation', scale: 'keyScale' }; // theme's, see theme.js
const PREVIEW_COLOR = '#8be9fd'; // the frame looked at, while a key's curve is previewed
const STILL_COLOR = '#ff5555'; // a key that repeats the one before it
const COPIED_WAVE = 1200; // ms, a wave out of a copied key (see copyKeys())
const COPIED_REACH = 1.4; // how far it goes, in the key's sizes
// A key just set pops in: from twice its size down to its own, overshooting
// a little (Back.Out), in so many ms (see popKeys()).
const BORN_SCALE = 2;
const BORN_TIME = 380;

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
    this.frameWidth = 14 * 1.2 ** 4; // px a frame: at first four turns of the wheel in from 14 (about 29)
    this.scroll = 0; // the frame at the left edge of the lanes, after the one before 0 (a fraction; never below 0)
    this.folded = new Set(); // entries whose tracks are not shown
    this.rows = []; // what each row of the lanes is: { index, property? }
    this.selected = new Set(); // the keys picked, by their ids (see animation.js)
    this.box = null; // the box keys are being picked by: { x0, y0, x1, y1 } in the lanes
    this.copied = null; // keys copied, see copyKeys()
    this.copiedFrom = null; // where they were copied from: { clip (its name), ids } - marked by a wave (see draw())
    this.born = new Map(); // key id -> when it was set, while it pops in (see popKeys())
    // Only the groups: their rows alone, and only they keyed and posed (see
    // setGroupsOnly()). Kept between runs.
    let groupsOnly = false;
    try { groupsOnly = localStorage.getItem(GROUPS_ONLY_KEY) === '1'; } catch { /* off */ }
    this.groupsOnly = groupsOnly;
    editor.animationGroupsOnly = groupsOnly;

    const $ = (selector) => section.querySelector(selector);
    this.select = $('.clip-select');
    this.fields = { name: $('[name="clip-name"]'), fps: $('[name="clip-fps"]'), length: $('[name="clip-length"]'), loop: $('.tl-loop') };
    this.frameLabel = $('.tl-frame');
    this.names = $('.tl-names');
    this.ruler = $('.tl-ruler');
    this.secondsRuler = $('.tl-seconds');
    this.lanes = $('.tl-lanes');
    this.scroller = $('.tl-scroll');
    this.empty = $('.tl-empty');
    this.body = $('.tl-body');

    this.bindBar();
    this.bindLanes();
    this.bindKeys();
    this.bindPopup();
    this.bindResize();
    // Drawn anew whenever there is more or less room: across (the lanes' box)
    // and down (the scrolled part - the lanes reach its bottom, whatever few rows there are).
    const resized = new ResizeObserver(() => this.draw());
    resized.observe(this.lanes.parentElement);
    resized.observe(this.scroller);
    editor.addEventListener('change', () => this.update());
    onThemeChange(() => this.draw());
  }

  // Only the groups, or everything: the timeline's rows, what is keyed (see
  // AnimationMode.writeKeys()) and what a press in the main view picks (see
  // Editor.pickOwner()). The objects' own keys stay in the clip, played.
  setGroupsOnly(on) {
    this.groupsOnly = on;
    this.editor.animationGroupsOnly = on;
    this.section.querySelector('.tl-groups-only').classList.toggle('active', on);
    try { localStorage.setItem(GROUPS_ONLY_KEY, on ? '1' : '0'); } catch { /* not kept: fine */ }
    this.showNames();
    this.dispatchEvent(new Event('groupsonly'));
  }

  // The bar's last button, "Вернуть позу" (see AnimationMode.restorePose()):
  // off while there is nothing to bring back - a warning sign on it while the
  // pose has changes not keyed - and on once another frame has let them go.
  // `state`: 'pending', the frame they were on (a number), or null.
  showUnkeyed(state) {
    const restore = this.section.querySelector('.tl-restore');
    const lost = typeof state === 'number';
    restore.disabled = !lost;
    restore.classList.toggle('pending', state === 'pending');
    restore.classList.toggle('lost', lost);
    restore.querySelector('i').className = `fa-solid ${state === 'pending' ? 'fa-triangle-exclamation' : 'fa-rotate-left'}`;
    restore.title = lost
      ? `Вернуть позу, изменённую на кадре ${state} и сброшенную без ключа`
      : state === 'pending'
        ? 'Не в ключах: поза изменена, но ключ не поставлен — при смене кадра она сбросится туда, где показан призрак (K — поставить ключ). После сброса здесь можно будет её вернуть'
        : 'Вернуть позу: если поза, изменённая без ключа, сбросится при смене кадра, её можно будет вернуть здесь';
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
    if (on) this.stopPreview();
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
      keyall: () => this.dispatchEvent(new Event('keyall')), // (see AnimationMode.keyAll())
      groupsonly: () => this.setGroupsOnly(!this.groupsOnly),
      duplicate: () => this.current() && this.addClip(this.current()),
      delete: () => this.deleteClip(),
      first: () => this.setFrame(0),
      prev: () => this.setFrame(Math.ceil(this.frame) - 1),
      play: () => this.play(),
      next: () => this.setFrame(Math.floor(this.frame) + 1),
      last: () => this.setFrame(this.current()?.length ?? 0),
      key: () => this.dispatchEvent(new Event('insertkey')), // (the mode's, see animate.js)
      autokey: () => {
        this.autokey = !this.autokey;
        this.showBar();
        this.dispatchEvent(new Event('autokey'));
      },
    };
    section.querySelector('.tl-restore').addEventListener('click', () => {
      this.play(false);
      this.dispatchEvent(new Event('restore'));
    });
    for (const button of section.querySelectorAll('[data-tl]')) {
      button.addEventListener('click', () => commands[button.dataset.tl]());
    }
    section.querySelector('.tl-groups-only').classList.toggle('active', this.groupsOnly);
    this.select.addEventListener('change', () => {
      this.play(false);
      this.selected.clear();
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
      if (button.dataset.tl !== 'add' && button.dataset.tl !== 'key' && button.dataset.tl !== 'autokey') button.disabled = !clip;
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

  // Keys just set (by their ids) - new, or put over ones that were there -
  // pop in (see draw()): what keys sets them, and pasting. A key moved, or
  // its value changed in its popup, does not.
  popKeys(ids) {
    const now = performance.now();
    for (const id of ids) this.born.set(id, now);
    this.draw();
  }

  // The entries in the scene tree's order, with their tracks' rows under them.
  showNames() {
    const { islands } = this.editor.topology;
    const hand = new Set(this.editor.objectsInHand());
    const picked = this.editor.mode === 'object' ? this.editor.picked : new Set();
    const clip = this.current();
    const animated = new Set(clip?.tracks.map((track) => track.object) ?? []);
    const signature = JSON.stringify([islands.map((island) => [island.id, island.name, island.kind, island.parentIndex, island.hidden]), [...hand], [...picked], [...this.folded], [...animated],
      this.editor.mesh.objects.map((object) => object.rotationMode ?? null), this.groupsOnly]);
    if (signature !== this.shownNames) {
      this.shownNames = signature;
      const rows = [];
      const lines = [];
      const add = (index, depth) => {
        const island = islands[index];
        // (only the groups: an object's row left out, what it holds in its place)
        if (this.groupsOnly && island.kind !== 'group') {
          for (const child of island.children) add(child, depth);
          return;
        }
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
          const plus = document.createElement('button');
          plus.className = `tl-add ${property}`;
          plus.textContent = '+';
          plus.title = `Ключ: ${PROPERTY_NAMES[property].toLowerCase()} на этом кадре`;
          plus.dataset.add = `${index}:${property}`;
          // The turn's row: how the entry is turned - a symbol to switch it by.
          if (property === 'rotation' && islands[index].kind !== undefined) {
            const quaternion = this.editor.mesh.objects[index]?.rotationMode === 'quaternion';
            const mode = document.createElement('button');
            mode.className = 'tl-mode';
            mode.textContent = quaternion ? 'ℍ' : '∠';
            mode.dataset.mode = index;
            mode.title = quaternion
              ? 'Поворот кватернионами (W, X, Y, Z): кратчайший путь, без «шарнирного замка», но не больше пол-оборота между ключами. Нажмите — перейти на углы'
              : 'Поворот углами (X, Y, Z): можно больше 360° между ключами, но при повороте по нескольким осям путь бывает кривым. Нажмите — перейти на кватернионы';
            sub.append(mode);
          }
          sub.append(plus);
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
    // Another entry picked: brought into sight, if it is out of it.
    const pickedNow = JSON.stringify([...picked, ...hand]);
    if (pickedNow !== this.pickedShown) {
      this.pickedShown = pickedNow;
      if (picked.size || hand.size) this.revealPicked();
    }
    this.draw();
  }

  // The rows glide to the entry picked (the topmost, if more) - its name and
  // its tracks - when it is out of sight, just far enough to have it in at
  // the nearer edge: rows = lerp(rows, to, t), t = 1 - e^(-dt/REVEAL_GLIDE),
  // the same on any screen (as glideTo()). The wheel or the scroll bar taken
  // on the way stops it.
  revealPicked() {
    const line = this.names.querySelector('.tl-name.picked');
    if (!line) return;
    const scroller = this.scroller;
    const top = line.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const index = Number(line.dataset.index);
    const height = Math.max(1, this.rows.filter((row) => row.index === index).length) * ROW;
    const view = scroller.clientHeight;
    let to = scroller.scrollTop;
    if (top < scroller.scrollTop) to = top - REVEAL_MARGIN;
    else if (top + height > scroller.scrollTop + view) to = Math.min(top - REVEAL_MARGIN, top + height - view + REVEAL_MARGIN);
    to = Math.max(0, Math.min(scroller.scrollHeight - view, to));
    if (Math.abs(to - scroller.scrollTop) < 1) return;
    cancelAnimationFrame(this.reveal?.request);
    const reveal = { to, at: scroller.scrollTop, last: performance.now() };
    this.reveal = reveal;
    const tick = (time) => {
      if (this.reveal !== reveal) return;
      const t = 1 - Math.exp(-(time - reveal.last) / REVEAL_GLIDE);
      reveal.last = time;
      reveal.at += (reveal.to - reveal.at) * t;
      if (Math.abs(reveal.to - reveal.at) < 0.5) {
        reveal.at = reveal.to;
        this.reveal = null;
      } else {
        reveal.request = requestAnimationFrame(tick);
      }
      scroller.scrollTop = reveal.at;
    };
    reveal.request = requestAnimationFrame(tick);
  }

  // --- the lanes ------------------------------------------------------------------

  // The frames glide to where the wheel sends them: every frame they cover
  // the same share of what is left - x = lerp(x, to, t) - with t worked out
  // from the time since the last frame (1 - e^(-dt/GLIDE)), so that it is the
  // same on any screen; a turn of the wheel on the way moves where they go.
  glideTo(scroll) {
    const to = Math.max(0, scroll);
    if (this.glide) {
      this.glide.to = to;
      return;
    }
    const glide = { to, last: performance.now() };
    this.glide = glide;
    const tick = (time) => {
      if (this.glide !== glide) return;
      const t = 1 - Math.exp(-(time - glide.last) / GLIDE);
      glide.last = time;
      this.scroll += (glide.to - this.scroll) * t;
      if (Math.abs(glide.to - this.scroll) < 0.002) {
        this.scroll = glide.to;
        this.glide = null;
      } else {
        glide.request = requestAnimationFrame(tick);
      }
      this.draw();
    };
    glide.request = requestAnimationFrame(tick);
  }

  stopGlide() {
    if (!this.glide) return;
    cancelAnimationFrame(this.glide.request);
    this.glide = null;
  }

  // The frame at a point of the lanes (client x; rounded, the nearest line), and back.
  // (Before frame 0 there is room for one frame more - hatched: nothing goes there.)
  frameAt(clientX) {
    return (clientX - this.lanes.getBoundingClientRect().left) / this.frameWidth + this.scroll - BEFORE;
  }

  xOf(frame) {
    return (frame - this.scroll + BEFORE) * this.frameWidth;
  }

  bindLanes() {
    // A press on the ruler or a lane: the frame looked at goes there, and with the drag.
    for (const canvas of [this.ruler, this.lanes, this.secondsRuler]) {
      canvas.addEventListener('pointerdown', (event) => {
        if (event.button === 1) {
          // The middle button: the frames move with the pointer.
          event.preventDefault();
          canvas.setPointerCapture(event.pointerId);
          this.stopGlide();
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
        // On the lanes, a key under the pointer, or Shift for a box, is the keys' (see bindKeys()).
        if (canvas === this.lanes && this.pressKeys(event)) return;
        if (canvas === this.lanes && this.selected.size) {
          this.selected.clear();
          this.draw();
        }
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
      // The wheel: the frames go by, back and forth; with Ctrl, wider or
      // narrower about the pointer. (With Shift it is the rows', up and down.)
      canvas.addEventListener('wheel', (event) => {
        if (event.shiftKey) return;
        event.preventDefault();
        if (!event.ctrlKey) {
          const travel = (event.deltaY || event.deltaX) * (event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? 400 : 1);
          this.glideTo((this.glide?.to ?? this.scroll) + (travel * WHEEL_PX) / this.frameWidth);
          return;
        }
        this.stopGlide();
        const at = this.frameAt(event.clientX);
        this.frameWidth = Math.max(MIN_FRAME_WIDTH, Math.min(MAX_FRAME_WIDTH, this.frameWidth * (event.deltaY < 0 ? 1.2 : 1 / 1.2)));
        this.scroll = Math.max(0, at + BEFORE - (event.clientX - this.lanes.getBoundingClientRect().left) / this.frameWidth);
        this.draw();
      }, { passive: false });
    }
    this.scroller.addEventListener('scroll', () => this.draw());
    // (the rows taken by hand: no gliding to a picked entry meanwhile)
    const stopReveal = () => {
      cancelAnimationFrame(this.reveal?.request);
      this.reveal = null;
    };
    this.scroller.addEventListener('wheel', stopReveal, { passive: true, capture: true });
    this.scroller.addEventListener('pointerdown', stopReveal, { capture: true });
    // A name: its fold, or the entry picked.
    this.names.addEventListener('mousedown', (event) => event.preventDefault());
    this.names.addEventListener('click', (event) => {
      // The turn's symbol: angles or quaternions (see Editor.setRotationMode()).
      const mode = event.target.closest('[data-mode]');
      if (mode) {
        const index = Number(mode.dataset.mode);
        this.editor.setRotationMode(index, this.editor.mesh.objects[index]?.rotationMode === 'quaternion' ? 'euler' : 'quaternion');
        return;
      }
      // A track's +: the mode keys it (see animate.js).
      const plus = event.target.closest('[data-add]');
      if (plus) {
        const [index, property] = plus.dataset.add.split(':');
        this.dispatchEvent(new CustomEvent('addkey', { detail: { index: Number(index), property } }));
        return;
      }
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

  // --- the keys -------------------------------------------------------------------

  keySize() {
    return Math.min(6, Math.max(3, this.frameWidth / 3));
  }

  // The keys a row shows, frame by frame: [{ frame, keys: [{ id, interpolation }] }].
  keysOfRow(row) {
    const clip = this.current();
    const island = this.editor.topology.islands[row.index];
    if (!clip || !island) return [];
    const frames = new Map();
    for (const track of clip.tracks) {
      if (track.object !== island.id || (row.property && track.property !== row.property)) continue;
      for (const key of track.keys) {
        if (!frames.has(key.frame)) frames.set(key.frame, []);
        frames.get(key.frame).push({ id: keyId(track.object, track.property, key.frame), interpolation: key.interpolation });
      }
    }
    return [...frames].map(([frame, keys]) => ({ frame, keys }));
  }

  // The keys under a point of the lanes (client coordinates): their ids, or null.
  keysAt(clientX, clientY) {
    const rect = this.lanes.getBoundingClientRect();
    const row = this.rows[Math.floor((clientY - rect.top) / ROW)];
    if (!row) return null;
    const x = clientX - rect.left;
    const reach = this.keySize() + 2;
    let best = null;
    for (const entry of this.keysOfRow(row)) {
      const off = Math.abs(this.xOf(entry.frame) - x);
      if (off <= reach && (!best || off < best.off)) best = { off, ids: entry.keys.map((key) => key.id) };
    }
    return best ? best.ids : null;
  }

  // The clip worked on, changed: recorded as one undo step, or only shown.
  changeClip(changed, record = true) {
    this.editor.setAnimations(this.clips.map((clip) => (clip.name === changed.name ? changed : clip)), record);
  }

  // A press on the lanes, as the keys take it: a key under the pointer is
  // picked (Shift: added or taken away) and the picked ones dragged along;
  // Shift on an empty place draws a box. Returns whether it was theirs.
  pressKeys(event) {
    const clip = this.current();
    const ids = this.keysAt(event.clientX, event.clientY);
    const lanes = this.lanes;
    if (!ids && !event.shiftKey) return false;
    lanes.setPointerCapture(event.pointerId);
    this.play(false);
    let move;
    let up;
    if (!ids) {
      // A box from here: the keys in it are picked (added to those picked).
      const rect = lanes.getBoundingClientRect();
      const kept = new Set(this.selected);
      this.box = { x0: event.clientX - rect.left, y0: event.clientY - rect.top, x1: event.clientX - rect.left, y1: event.clientY - rect.top };
      move = (moved) => {
        this.box.x1 = moved.clientX - rect.left;
        this.box.y1 = moved.clientY - rect.top;
        const [left, right] = [Math.min(this.box.x0, this.box.x1), Math.max(this.box.x0, this.box.x1)];
        const [top, bottom] = [Math.min(this.box.y0, this.box.y1), Math.max(this.box.y0, this.box.y1)];
        this.selected = new Set(kept);
        this.rows.forEach((row, k) => {
          const y = k * ROW + ROW / 2;
          if (y < top || y > bottom) return;
          for (const entry of this.keysOfRow(row)) {
            const x = this.xOf(entry.frame);
            if (x >= left && x <= right) for (const key of entry.keys) this.selected.add(key.id);
          }
        });
        this.draw();
      };
      up = () => {
        this.box = null;
        this.draw();
      };
    } else {
      // A key: picked, then dragged with the others picked.
      if (event.shiftKey) {
        const all = ids.every((id) => this.selected.has(id));
        for (const id of ids) {
          if (all) this.selected.delete(id);
          else this.selected.add(id);
        }
      } else if (!ids.every((id) => this.selected.has(id))) {
        this.selected = new Set(ids);
      }
      this.draw();
      const base = clip;
      const before = this.editor.snapshot();
      const picked = new Set(this.selected);
      // The key taken lands on a frame's line; with Ctrl held, anywhere
      // (to a hundredth of a frame). The others go as far as it does.
      const grabbed = Number(ids[0].split(':')[2]);
      const from = this.frameAt(event.clientX);
      let by = 0;
      move = (moved) => {
        const travel = this.frameAt(moved.clientX) - from;
        const now = moved.ctrlKey ? frameOf(grabbed + travel) - grabbed : Math.max(0, Math.round(grabbed + travel)) - grabbed;
        if (now === by || !picked.size) return;
        by = now;
        this.changeClip(moveKeys(base, picked, by), false);
        this.selected = new Set([...picked].map((id) => {
          const [object, property, frame] = id.split(':');
          return keyId(Number(object), property, frameOf(Number(frame) + by));
        }));
        this.draw();
      };
      up = () => {
        if (by !== 0) {
          this.editor.history.push(before);
          this.editor.emitChange();
        }
      };
    }
    const end = () => {
      lanes.removeEventListener('pointermove', move);
      lanes.removeEventListener('pointerup', end);
      up();
    };
    lanes.addEventListener('pointermove', move);
    lanes.addEventListener('pointerup', end);
    return true;
  }

  // The picked keys taken away. Returns whether there were any.
  deleteKeys() {
    const clip = this.current();
    if (!clip || !this.selected.size) return false;
    this.changeClip(removeKeys(clip, this.selected));
    this.selected.clear();
    return true;
  }

  copyKeys() {
    const clip = this.current();
    if (!clip || !this.selected.size) return false;
    this.copied = copyKeys(clip, this.selected);
    this.copiedFrom = { clip: clip.name, ids: new Set(this.selected) };
    this.draw();
    return true;
  }

  // The copied keys put down from the frame looked at, and picked.
  pasteKeys() {
    const clip = this.current();
    if (!clip || !this.copied?.length) return false;
    const { clip: changed, ids } = pasteKeys(clip, this.copied, Math.round(this.frame));
    this.selected = ids;
    this.changeClip(changed);
    this.popKeys(ids);
    return true;
  }

  setInterpolation(interpolation) {
    const clip = this.current();
    if (clip && this.selected.size) this.changeClip(setInterpolation(clip, this.selected, interpolation));
  }

  // --- a key's own settings ---------------------------------------------------------

  // The key under a point of a track's row: { object, property, frame }, or null.
  keyAt(clientX, clientY) {
    const rect = this.lanes.getBoundingClientRect();
    const row = this.rows[Math.floor((clientY - rect.top) / ROW)];
    if (!row?.property) return null;
    const ids = this.keysAt(clientX, clientY);
    if (!ids) return null;
    const [object, property, frame] = ids[0].split(':');
    return { object: Number(object), property, frame: Number(frame) };
  }

  // The popup of a key's settings, beside it. Every change in it is one undo
  // step (a drag of a number's handle too); it follows the key if it moves.
  bindPopup() {
    const popup = document.createElement('div');
    popup.className = 'key-popup';
    popup.hidden = true;
    popup.innerHTML = `
      <div class="kp-head"><i class="kp-grip" title="Потяните, чтобы переставить окно"></i><span></span><button class="kp-step" data-step="-1" title="Предыдущий ключ этой дорожки"><i class="fa-solid fa-chevron-left"></i></button><button class="kp-step" data-step="1" title="Следующий ключ этой дорожки"><i class="fa-solid fa-chevron-right"></i></button><button class="kp-close" title="Закрыть (Esc)"><i class="fa-solid fa-xmark"></i></button></div>
      <label><span>Кадр</span><input data-kp="frame" inputmode="numeric" spellcheck="false"></label>
      <label hidden><span class="axis">W</span><input data-kp="3" inputmode="decimal" spellcheck="false"></label>
      <label><span class="axis x">X</span><input data-kp="0" inputmode="decimal" spellcheck="false"></label>
      <label><span class="axis y">Y</span><input data-kp="1" inputmode="decimal" spellcheck="false"></label>
      <label><span class="axis z">Z</span><input data-kp="2" inputmode="decimal" spellcheck="false"></label>
      <div class="kp-kinds">${Object.entries(INTERPOLATION_NAMES).map(([kind, label]) => `<button data-kind="${kind}">${label}</button>`).join('')}</div>
      <button class="kp-delete">Удалить ключ</button>
      <p class="kp-still" hidden></p>`;
    document.body.append(popup);
    this.popup = popup;
    this.popupKey = null;
    // A smooth key's curve: a popup of its own beside this one (to its right),
    // which comes and goes with it - and slides in only while the key is smooth.
    const curve = document.createElement('div');
    curve.className = 'key-popup curve-popup';
    curve.inert = true;
    curve.innerHTML = `
      <div class="kp-head"><span>Кривая перехода</span></div>
        <canvas class="kp-graph" title="Кривая перехода к следующему ключу: потяните за ручки, чтобы сделать свою"></canvas>
        <div class="kp-families">
          <button data-family="" title="Мягкий разгон и торможение (smoothstep)">Обычная</button>
          ${Object.entries(EASE_FAMILIES).map(([family, { label }]) => `<button data-family="${family}">${label}</button>`).join('')}
          <button data-family="custom" disabled title="Своя кривая: задаётся ручками на графике">Своя</button>
        </div>
        <div class="kp-dirs">${EASE_DIRECTIONS.map((direction) => `<button data-direction="${direction}" title="${{ In: 'Разгон: медленно в начале', Out: 'Торможение: медленно в конце', InOut: 'Разгон и торможение' }[direction]}">${direction}</button>`).join('')}</div>
        <button class="kp-preview" title="Предпросмотр: переход от этого ключа к следующему по кругу, с секундой паузы в начале и в конце"><i class="fa-solid fa-play"></i><span>Предпросмотр</span></button>
`;
    document.body.append(curve);
    this.curvePopup = curve;
    for (const button of curve.querySelectorAll('button')) button.addEventListener('mousedown', (event) => event.preventDefault());
    const close = () => this.closePopup();
    for (const button of popup.querySelectorAll('button')) button.addEventListener('mousedown', (event) => event.preventDefault());
    popup.querySelector('.kp-close').addEventListener('click', close);
    // The grip: the popup is dragged by it to where it is handy (the curve's goes along).
    const grip = popup.querySelector('.kp-grip');
    grip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      grip.setPointerCapture(event.pointerId);
      const rect = popup.getBoundingClientRect();
      const start = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      popup.classList.add('dragged');
      const move = (moved) => {
        this.popupMoved = { left: start.left + moved.clientX - start.x, top: start.top + moved.clientY - start.y };
        this.placePopup();
      };
      const up = () => {
        popup.classList.remove('dragged');
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    });
    // < and >: the popup goes over to the key before or after on the track -
    // picked, and the frame looked at goes to it.
    for (const button of popup.querySelectorAll('[data-step]')) {
      button.addEventListener('click', () => {
        const to = this.stepKey(Number(button.dataset.step));
        if (!to) return;
        this.stopPreview();
        this.popupKey = { ...this.popupKey, frame: to.frame };
        this.selected = new Set([keyId(this.popupKey.object, this.popupKey.property, to.frame)]);
        this.setFrame(to.frame);
        this.showPopup();
        this.draw();
      });
    }
    popup.querySelector('.kp-delete').addEventListener('click', () => {
      const clip = this.current();
      const key = this.popupKey;
      if (clip && key) this.changeClip(removeKeys(clip, new Set([keyId(key.object, key.property, key.frame)])));
      close();
    });
    for (const button of popup.querySelectorAll('[data-kind]')) {
      button.addEventListener('click', () => {
        const clip = this.current();
        const key = this.popupKey;
        if (clip && key) this.changeClip(setInterpolation(clip, new Set([keyId(key.object, key.property, key.frame)]), button.dataset.kind));
      });
    }
    // The numbers: the frame moves the key; X, Y, Z are its value.
    for (const input of popup.querySelectorAll('input')) {
      const field = input.dataset.kp;
      const read = () => parseFloat(input.value.replace(',', '.'));
      const write = (value, record) => {
        const clip = this.current();
        const key = this.popupKey;
        const track = clip?.tracks.find((other) => other.object === key?.object && other.property === key.property);
        const found = track?.keys.find((other) => other.frame === key.frame);
        if (!found || !Number.isFinite(value)) return this.showPopup();
        if (field === 'frame') {
          const frame = frameOf(value); // (between frames too, if typed so)
          if (frame === key.frame) return this.showPopup();
          const from = key.frame;
          key.frame = frame; // (first: the popup follows the key as the change is shown)
          this.selected = new Set([keyId(key.object, key.property, frame)]);
          this.changeClip(moveKeys(clip, new Set([keyId(key.object, key.property, from)]), frame - from), record);
        } else {
          const changed = [...found.value];
          changed[+field] = value;
          this.changeClip(setKey(clip, key.object, key.property, key.frame, changed), record);
        }
      };
      input.addEventListener('change', () => write(read(), true));
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === 'Escape') input.blur();
        event.stopPropagation();
      });
      let before = null;
      scrubbable(input, {
        read,
        write: (value) => {
          input.value = value;
          write(value, false);
        },
        begin: () => { before = this.editor.snapshot(); },
        end: () => {
          if (JSON.stringify(before.animations) !== JSON.stringify(this.clips)) this.editor.history.push(before);
          this.editor.emitChange();
        },
        whole: field === 'frame', // (dragged: frame by frame)
        min: field === 'frame' ? 0 : -Infinity,
      });
    }
    this.bindCurve();
    this.lanes.addEventListener('dblclick', (event) => {
      const key = this.keyAt(event.clientX, event.clientY);
      if (!key) return;
      this.selected = new Set([keyId(key.object, key.property, key.frame)]);
      this.popupKey = key;
      popup.hidden = false;
      this.showPopup();
      this.popupAnchor = { x: event.clientX, y: event.clientY };
      this.popupMoved = null; // (beside the key again)
      this.placePopup();
      this.draw();
    });
    window.addEventListener('pointerdown', (event) => {
      if (!popup.hidden && !popup.contains(event.target) && !curve.contains(event.target)) close();
    }, true);
    // As the curve slides open or shut the popup grows and shrinks: kept inside the window all the while.
    new ResizeObserver(() => this.placePopup()).observe(popup);
    window.addEventListener('keydown', (event) => {
      if (event.code === 'Escape' && !popup.hidden) {
        close();
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    this.editor.addEventListener('change', () => this.showPopup());
  }

  closePopup() {
    this.stopPreview();
    this.popup.hidden = true;
    this.curvePopup.classList.remove('shown');
    this.curvePopup.inert = true;
    this.popupKey = null;
  }

  // Beside the key: to its right (or left, if there is no room) and a
  // little up; moved up as far as it has to be to stay inside the window.
  // The curve's popup beside it, on the side away from the key.
  // Dragged by its grip (`popupMoved`), it stays where it was put - inside
  // the window - and the curve's popup goes along beside it.
  placePopup() {
    const popup = this.popup;
    const anchor = this.popupAnchor;
    if (!popup || popup.hidden || !anchor) return;
    const { width, height } = popup.getBoundingClientRect();
    const curve = this.curvePopup.getBoundingClientRect();
    const moved = this.popupMoved;
    const inside = (value, size, room) => Math.max(4, Math.min(value, room - size - 4));
    const right = moved
      ? moved.left + width + 8 + curve.width <= window.innerWidth
      : anchor.x + 16 + width + 8 + curve.width <= window.innerWidth;
    const left = moved ? inside(moved.left, width, window.innerWidth) : right ? anchor.x + 16 : Math.max(4, anchor.x - 16 - width);
    const top = moved ? inside(moved.top, height, window.innerHeight) : Math.max(4, Math.min(anchor.y - 40, window.innerHeight - height - 4));
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
    const curveLeft = right ? left + width + 8 : Math.max(4, left - 8 - curve.width);
    this.curvePopup.style.left = `${curveLeft}px`;
    this.curvePopup.style.top = `${Math.max(4, Math.min(top, window.innerHeight - curve.height - 4))}px`;
    this.curvePopup.classList.toggle('from-left', !right);
  }

  showPopup() {
    const popup = this.popup;
    const key = this.popupKey;
    if (!popup || popup.hidden || !key) return;
    const clip = this.current();
    const found = clip?.tracks.find((track) => track.object === key.object && track.property === key.property)?.keys.find((other) => other.frame === key.frame);
    if (!found) {
      this.closePopup();
      return;
    }
    const island = this.editor.topology.islands.find((entry) => entry.id === key.object);
    popup.querySelector('.kp-head span').textContent = `${PROPERTY_NAMES[key.property]} · ${island?.name ?? ''}`;
    popup.querySelector('.kp-grip').style.color = theme[KEY_COLORS[key.property]];
    // A quaternion's turn: W too, first.
    popup.querySelector('[data-kp="3"]').closest('label').hidden = found.value.length !== 4;
    for (const input of popup.querySelectorAll('input')) {
      if (document.activeElement === input) continue;
      const field = input.dataset.kp;
      const value = field === 'frame' ? key.frame : found.value[+field];
      input.value = value === undefined ? '' : field === 'frame' ? value : +value.toFixed(4);
    }
    for (const button of popup.querySelectorAll('[data-kind]')) button.classList.toggle('active', button.dataset.kind === found.interpolation);
    // The curve, for a smooth key: its popup slides in; its ease's family and direction lit.
    const curve = this.curvePopup;
    const smooth = found.interpolation === 'smooth';
    curve.classList.toggle('shown', smooth);
    curve.inert = !smooth;
    this.placePopup();
    const parts = easeParts(found.ease);
    const family = Array.isArray(found.ease) ? 'custom' : parts ? parts[0] : '';
    for (const button of curve.querySelectorAll('[data-family]')) button.classList.toggle('active', button.dataset.family === family);
    for (const button of curve.querySelectorAll('[data-direction]')) {
      button.disabled = !parts;
      button.classList.toggle('active', Boolean(parts) && button.dataset.direction === parts[1]);
    }
    // A key that repeats the one before it: why it is ringed.
    const next = this.nextKey();
    const track = clip.tracks.find((other) => other.object === key.object && other.property === key.property);
    const before = track.keys.filter((other) => other.frame < key.frame).pop();
    const stillNote = popup.querySelector('.kp-still');
    const still = Boolean(before) && sameValue(found.value, before.value);
    stillNote.hidden = !still;
    if (still) stillNote.textContent = `Дубликат предыдущего ключа (кадр ${before.frame}): с кадра ${before.frame} по ${found.frame} значение не меняется — это пауза`;
    for (const button of popup.querySelectorAll('[data-step]')) button.disabled = !this.stepKey(Number(button.dataset.step));
    // The preview: there is something to see only with a key after this one.
    const preview = curve.querySelector('.kp-preview');
    preview.disabled = !next;
    preview.title = next
      ? 'Предпросмотр: переход от этого ключа к следующему по кругу, с секундой паузы в начале и в конце'
      : 'Предпросмотр: у этой дорожки нет ключа после этого';
    if (!smooth || !next) this.stopPreview();
    preview.classList.toggle('active', Boolean(this.preview));
    preview.firstElementChild.className = `fa-solid ${this.preview ? 'fa-stop' : 'fa-play'}`;
    this.drawCurve(found.ease, theme[KEY_COLORS[key.property]]);
  }

  // --- a smooth key's curve -----------------------------------------------------------

  // Where on the graph a point of the curve is (x 0..1, y -0.5..1.5), and back.
  graphPlace(x, y) {
    const { width, height } = this.graphSize;
    const pad = 12;
    return { x: pad + x * (width - 2 * pad), y: height - pad - ((y + 0.5) / 2) * (height - 2 * pad) };
  }

  graphPoint(px, py) {
    const { width, height } = this.graphSize;
    const pad = 12;
    return { x: (px - pad) / (width - 2 * pad), y: ((height - pad - py) / (height - 2 * pad)) * 2 - 0.5 };
  }

  // The curve of an ease: the square from (0,0) to (1,1), the straight line
  // faintly, the curve in the key's colour; and the Bezier's two handles
  // (for a preset, those of its likeness), to be dragged into a curve of its own.
  // --- the preview of a key's curve ----------------------------------------------------
  //
  // From the popup's key to the next of its track, over and over: a second
  // on the first, the way between them at the clip's rate, a second on the
  // next. The frame looked at goes with it (the model is shown so), and a
  // dot runs along the curve; when it stops, the frame is the one it was.

  // The key before (-1) or after (1) the popup's on its track, or null.
  stepKey(by) {
    const key = this.popupKey;
    const track = key && this.current()?.tracks.find((other) => other.object === key.object && other.property === key.property);
    if (!track) return null;
    return by < 0 ? track.keys.filter((other) => other.frame < key.frame).pop() ?? null : track.keys.find((other) => other.frame > key.frame) ?? null;
  }

  // The key after the popup's on its track, or null.
  nextKey() {
    const key = this.popupKey;
    const track = key && this.current()?.tracks.find((other) => other.object === key.object && other.property === key.property);
    return track?.keys.find((other) => other.frame > key.frame) ?? null;
  }

  startPreview() {
    const clip = this.current();
    const key = this.popupKey;
    if (this.preview || !clip || !key || !this.nextKey()) return;
    this.play(false);
    this.preview = { frame: this.frame, start: performance.now() };
    const PAUSE = 1; // s, on either key
    const tick = (time) => {
      const preview = this.preview;
      const next = this.nextKey();
      const clipNow = this.current();
      if (!preview || !next || !clipNow || !this.popupKey) return this.stopPreview();
      const from = this.popupKey.frame;
      const way = (next.frame - from) / clipNow.fps;
      const t = ((time - preview.start) / 1000) % (PAUSE + way + PAUSE);
      const u = Math.min(1, Math.max(0, (t - PAUSE) / way));
      this.previewAt = u;
      this.frame = from + (next.frame - from) * u;
      this.showFrame();
      this.dispatchEvent(new Event('frame'));
      this.showPopup();
      preview.request = requestAnimationFrame(tick);
    };
    this.preview.request = requestAnimationFrame(tick);
    this.showPopup();
  }

  stopPreview() {
    const preview = this.preview;
    if (!preview) return;
    cancelAnimationFrame(preview.request);
    this.preview = null;
    this.previewAt = null;
    this.frame = -1; // (so that the frame it was is set anew, and shown)
    this.setFrame(preview.frame);
    this.showPopup();
  }

  drawCurve(ease, color) {
    const canvas = this.curvePopup.querySelector('.kp-graph');
    const width = canvas.clientWidth || 226;
    const height = 170;
    this.graphSize = { width, height };
    const ratio = window.devicePixelRatio || 1;
    canvas.style.height = `${height}px`;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const dim = css.getPropertyValue('--text-dim').trim() || theme.textDim;
    const border = css.getPropertyValue('--border').trim() || theme.border;
    context.fillStyle = css.getPropertyValue('--bg').trim() || theme.bg;
    context.fillRect(0, 0, width, height);
    const at = (x, y) => this.graphPlace(x, y);
    const a = at(0, 0);
    const b = at(1, 1);
    context.strokeStyle = border;
    context.lineWidth = 1;
    context.strokeRect(a.x + 0.5, b.y + 0.5, b.x - a.x, a.y - b.y);
    context.setLineDash([3, 4]);
    context.strokeStyle = dim;
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
    context.setLineDash([]);
    // The curve.
    const f = easing(ease);
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.beginPath();
    for (let i = 0; i <= 120; i++) {
      const p = at(i / 120, f(i / 120));
      if (i === 0) context.moveTo(p.x, p.y);
      else context.lineTo(p.x, p.y);
    }
    context.stroke();
    // Where the preview is on it.
    if (this.preview && this.previewAt !== null && this.previewAt !== undefined) {
      const p = at(this.previewAt, f(this.previewAt));
      context.beginPath();
      context.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
      context.fillStyle = css.getPropertyValue('--text').trim() || theme.text;
      context.fill();
    }
    // The handles.
    const [x1, y1, x2, y2] = bezierOf(ease);
    this.handles = [at(x1, y1), at(x2, y2)];
    context.strokeStyle = dim;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(this.handles[0].x, this.handles[0].y);
    context.moveTo(b.x, b.y);
    context.lineTo(this.handles[1].x, this.handles[1].y);
    context.stroke();
    for (const handle of this.handles) {
      context.beginPath();
      context.arc(handle.x, handle.y, 5, 0, Math.PI * 2);
      context.fillStyle = Array.isArray(ease) ? color : css.getPropertyValue('--bg-raised').trim() || theme.bgRaised;
      context.fill();
      context.strokeStyle = color;
      context.lineWidth = 1.5;
      context.stroke();
    }
  }

  // The popup's curve at work: a family, a direction, the handles dragged.
  bindCurve() {
    const popup = this.curvePopup;
    const ids = () => new Set([keyId(this.popupKey.object, this.popupKey.property, this.popupKey.frame)]);
    const found = () => this.current()?.tracks.find((track) => track.object === this.popupKey?.object && track.property === this.popupKey.property)?.keys.find((key) => key.frame === this.popupKey.frame);
    popup.querySelector('.kp-preview').addEventListener('click', () => (this.preview ? this.stopPreview() : this.startPreview()));
    const apply = (ease, record = true) => {
      const clip = this.current();
      if (clip && this.popupKey) this.changeClip(setEase(clip, ids(), ease), record);
    };
    for (const button of popup.querySelectorAll('[data-family]')) {
      button.addEventListener('click', () => {
        const family = button.dataset.family;
        if (family === 'custom') return;
        const direction = easeParts(found()?.ease)?.[1] ?? 'InOut';
        apply(family ? `${family}${direction}` : null);
      });
    }
    for (const button of popup.querySelectorAll('[data-direction]')) {
      button.addEventListener('click', () => {
        const parts = easeParts(found()?.ease);
        if (parts) apply(`${parts[0]}${button.dataset.direction}`);
      });
    }
    const canvas = popup.querySelector('.kp-graph');
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !this.handles) return;
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const k = this.handles.findIndex((handle) => Math.hypot(handle.x - px, handle.y - py) <= 10);
      if (k < 0) return;
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      const before = this.editor.snapshot();
      const bezier = bezierOf(found()?.ease);
      const move = (moved) => {
        const point = this.graphPoint(moved.clientX - rect.left, moved.clientY - rect.top);
        bezier[k * 2] = +Math.min(1, Math.max(0, point.x)).toFixed(3);
        bezier[k * 2 + 1] = +Math.min(1.5, Math.max(-0.5, point.y)).toFixed(3);
        apply([...bezier], false);
      };
      const up = () => {
        canvas.removeEventListener('pointermove', move);
        canvas.removeEventListener('pointerup', up);
        if (JSON.stringify(before.animations) !== JSON.stringify(this.clips)) {
          this.editor.history.push(before);
          this.editor.emitChange();
        }
      };
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
    });
  }

  // The right button on a key: it is picked (if it was not), and a menu of
  // what the picked keys go on to the next by, or taking them away.
  bindKeys() {
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.hidden = true;
    document.body.append(menu);
    const close = () => {
      menu.hidden = true;
    };
    this.lanes.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      close();
      const ids = this.keysAt(event.clientX, event.clientY);
      if (!ids) return;
      if (!ids.every((id) => this.selected.has(id))) this.selected = new Set(ids);
      this.draw();
      const clip = this.current();
      const kinds = new Set();
      for (const track of clip.tracks) {
        for (const key of track.keys) if (this.selected.has(keyId(track.object, track.property, key.frame))) kinds.add(key.interpolation);
      }
      const item = (label, run, current = false) => {
        const button = document.createElement('button');
        button.textContent = label;
        button.classList.toggle('current', current);
        button.addEventListener('mousedown', (pressed) => pressed.preventDefault());
        button.addEventListener('click', () => {
          close();
          run();
        });
        return button;
      };
      menu.replaceChildren(
        ...Object.entries(INTERPOLATION_NAMES).map(([kind, label]) =>
          item(`${kinds.size === 1 && kinds.has(kind) ? '● ' : ''}${label}`, () => this.setInterpolation(kind), kinds.size === 1 && kinds.has(kind))),
        item('Удалить', () => this.deleteKeys()),
      );
      menu.hidden = false;
      const { width, height } = menu.getBoundingClientRect();
      menu.style.left = `${Math.min(event.clientX, window.innerWidth - width - 4)}px`;
      menu.style.top = `${Math.min(event.clientY, window.innerHeight - height - 4)}px`;
    });
    window.addEventListener('pointerdown', (event) => {
      if (!menu.contains(event.target)) close();
    }, true);
    window.addEventListener('keydown', (event) => {
      if (event.code === 'Escape' && !menu.hidden) {
        close();
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
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

    // The ruler of seconds, under the lanes: a mark every so many seconds -
    // no closer than ~60 px - with the time to its right; the clip's time lit.
    const seconds = prepare(this.secondsRuler, SECONDS);
    seconds.fillStyle = colors.raised;
    seconds.fillRect(0, 0, width, SECONDS);
    if (clip) {
      const fps = clip.fps;
      const each = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60].find((s) => s * fps * this.frameWidth >= 60) ?? 120;
      seconds.font = '11px "Segoe UI", sans-serif';
      seconds.textBaseline = 'top';
      const firstTime = Math.max(0, Math.floor(this.scroll / fps / each) * each);
      const lastTime = (this.scroll + width / this.frameWidth) / fps;
      for (let t = firstTime; t <= lastTime + 1e-9; t += each) {
        const x = Math.round(this.xOf(t * fps));
        const inside = t * fps <= length + 1e-9;
        seconds.fillStyle = inside ? colors.dim : colors.border;
        seconds.fillRect(x, 0, 1, 6);
        const label = `${+t.toFixed(2)} с`;
        seconds.fillText(label, x + 4, 6);
      }
      // A short mark at every whole frame when there is room for it.
      if (this.frameWidth >= 6) {
        seconds.fillStyle = colors.border;
        for (let frame = Math.max(0, Math.floor(this.scroll)); frame <= Math.min(length, lastShown); frame += 1) {
          seconds.fillRect(Math.round(this.xOf(frame)), 0, 1, 3);
        }
      }
    }

    // The lanes: a row for each name, the clip's frames lit, a line every frame (when there is room).
    const height = Math.max(this.rows.length * ROW, this.scroller.clientHeight);
    const lanes = prepare(this.lanes, height);
    lanes.fillStyle = colors.bg;
    lanes.fillRect(0, 0, width, height);
    lanes.fillStyle = colors.raised;
    lanes.fillRect(this.xOf(0), 0, length * this.frameWidth, height);
    // Before frame 0: hatched, a place for nothing.
    const hatch = (context, h) => {
      const end = this.xOf(0);
      if (end <= 0) return;
      context.save();
      context.beginPath();
      context.rect(0, 0, end, h);
      context.clip();
      context.fillStyle = colors.bg;
      context.fillRect(0, 0, end, h);
      context.strokeStyle = colors.border;
      context.lineWidth = 1.5;
      context.beginPath();
      for (let x = -h; x < end + h; x += 6) {
        context.moveTo(x, h);
        context.lineTo(x + h, 0);
      }
      context.stroke();
      context.restore();
    };
    hatch(lanes, height);
    hatch(ruler, RULER);
    hatch(seconds, SECONDS);
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
    // The keys of the clip: shaped and coloured by what they key, on
    // their tracks' rows; on the entry's row, an outline for every frame with
    // any. Between two keys of a track, a line says how the first goes on to
    // the next: straight (linear), dashed (step), a row of tildes (smooth). Picked keys white, ringed in the accent;
    // those past the clip's end dimmer. (Always on their lines.)
    if (clip) {
      const size = this.keySize();
      // A key's shape is what it keys: a position a diamond, a turn a
      // circle, a scale a square (an entry's row: diamonds).
      const diamond = (x, y, property = 'position', grow = 1) => {
        const r = size * grow;
        lanes.beginPath();
        if (property === 'rotation') lanes.arc(x, y, r * 0.85, 0, Math.PI * 2);
        else if (property === 'scale') lanes.rect(x - r * 0.75, y - r * 0.75, r * 1.5, r * 1.5);
        else {
          lanes.moveTo(x, y - r);
          lanes.lineTo(x + r, y);
          lanes.lineTo(x, y + r);
          lanes.lineTo(x - r, y);
          lanes.closePath();
        }
      };
      const between = (x0, x1, y, interpolation, color) => {
        const from = x0 + size + 2;
        const to = x1 - size - 2;
        if (to <= from) return;
        lanes.save();
        lanes.strokeStyle = color;
        lanes.globalAlpha *= 0.75;
        lanes.lineWidth = 1.5;
        lanes.beginPath();
        if (interpolation === 'step') lanes.setLineDash([4, 4]);
        if (interpolation === 'smooth') {
          // A row of tildes, "~ ~ ~", spread evenly between the keys.
          const width = 8; // px a tilde
          const gap = 8;
          const height = 2.2;
          const count = Math.max(1, Math.floor((to - from + gap) / (width + gap)));
          const start = from + (to - from - (count * width + (count - 1) * gap)) / 2;
          for (let n = 0; n < count; n++) {
            const x0 = start + n * (width + gap);
            for (let i = 0; i <= width; i++) {
              const dy = -Math.sin((i / width) * Math.PI * 2) * height;
              if (i === 0) lanes.moveTo(x0 + i, y + dy);
              else lanes.lineTo(x0 + i, y + dy);
            }
          }
        } else {
          lanes.moveTo(from, y);
          lanes.lineTo(to, y);
        }
        lanes.stroke();
        lanes.restore();
      };
      lanes.lineWidth = 1.5;
      // The keys copied, in this clip - and how far their wave has got, 0 to 1.
      const copied = this.copiedFrom?.clip === clip.name ? this.copiedFrom.ids : null;
      const wave = (performance.now() % COPIED_WAVE) / COPIED_WAVE;
      let waving = false;
      let popping = false; // (a key popping in)
      this.rows.forEach((row, k) => {
        const y = k * ROW + ROW / 2;
        const entries = this.keysOfRow(row).sort((a, b) => a.frame - b.frame);
        if (row.property) {
          const color = theme[KEY_COLORS[row.property]];
          entries.forEach((entry, i) => {
            const next = entries[i + 1];
            lanes.globalAlpha = entry.frame > length ? 0.45 : 1;
            if (next) between(this.xOf(entry.frame), this.xOf(next.frame), y, entry.keys[0].interpolation, color);
          });
        }
        // (A key that repeats the one before it, see stillKeys().)
        const island = this.editor.topology.islands[row.index];
        const track = row.property ? clip.tracks.find((other) => other.object === island?.id && other.property === row.property) : null;
        const still = track ? stillKeys(track) : new Set();
        for (const { frame, keys } of entries) {
          const x = this.xOf(frame);
          const picked = keys.some((key) => this.selected.has(key.id));
          lanes.globalAlpha = frame > length ? 0.45 : 1;
          const repeats = Boolean(row.property) && still.has(frame);
          // (just appeared: popping in - from twice its size down, overshooting a little)
          const born = Math.max(0, ...keys.map((key) => this.born.get(key.id) ?? 0));
          const age = born ? (performance.now() - born) / BORN_TIME : 1;
          const pop = age < 1 ? BORN_SCALE + (1 - BORN_SCALE) * EASE_FAMILIES.back.Out(age) : 1;
          if (age < 1) popping = true;
          diamond(x, y, row.property ?? 'position', pop);
          if (row.property) {
            lanes.fillStyle = picked ? colors.text : theme[KEY_COLORS[row.property]]; // (picked: the accent's ring says so)
            lanes.fill();
            if (picked) {
              lanes.strokeStyle = colors.accent;
              lanes.lineWidth = 2;
              lanes.stroke();
              lanes.lineWidth = 1.5;
            }
            // (a key that repeats the one before it: a red heart of its own shape)
            if (repeats) {
              diamond(x, y, row.property, 0.5 * pop);
              lanes.fillStyle = STILL_COLOR;
              lanes.fill();
            }
            // (a key copied: a wave runs out of it, one at a time, and fades -
            // as long as it is where it was copied from)
            if (copied && keys.some((key) => copied.has(key.id))) {
              const out = 1 - (1 - wave) ** 2; // fast at first, then slower
              diamond(x, y, row.property, 1 + out * COPIED_REACH);
              lanes.save();
              lanes.globalAlpha *= (1 - wave) * 0.9;
              lanes.strokeStyle = theme[KEY_COLORS[row.property]];
              lanes.lineWidth = 1.5;
              lanes.stroke();
              lanes.restore();
              waving = true;
            }
          } else {
            lanes.strokeStyle = picked ? colors.accent : colors.dim;
            lanes.stroke();
          }
        }
      });
      lanes.globalAlpha = 1;
      // (the copied keys' waves go on: drawn again on the next screen frame)
      cancelAnimationFrame(this.waving);
      if (waving || popping) this.waving = requestAnimationFrame(() => this.draw());
      if (!popping) this.born.clear();
    }
    // The box keys are being picked by.
    if (this.box) {
      const { x0, y0, x1, y1 } = this.box;
      lanes.fillStyle = `${colors.accent}22`;
      lanes.strokeStyle = colors.accent;
      lanes.lineWidth = 1;
      lanes.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      lanes.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    }
    // The frame looked at: on its line, over it. (Another colour while a
    // key's curve is being previewed: the frame is the preview's, not set by hand.)
    const x = Math.round(this.xOf(this.frame));
    for (const [context, tall] of [[ruler, RULER], [lanes, height], [seconds, SECONDS]]) {
      context.fillStyle = this.preview ? PREVIEW_COLOR : colors.accent;
      context.fillRect(Math.max(0, x - 0.5), 0, 2, tall);
    }
  }
}
