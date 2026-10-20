import { DEFAULT_PALETTE, PALETTE_FILES, readPalette } from './palette.js';
import { t } from './i18n.js';

// The brush's colour: a button that shows it, and a popup that opens beside
// the button to choose it in.
//
//   - a field of the colour's shades - paler to the left, darker downwards -
//     and under it a strip of hues; the hue is kept apart from the colour, so
//     that it is not lost on the way through grey, which has none;
//   - the colour as a hex number and as red, green and blue;
//   - a palette: colours to take with a click. The first is no colour at all:
//     the brush then rubs out. A palette is read from a file (see palette.js),
//     a colour is added to it with the plus and taken off it with the right
//     button. It is kept between launches, the same for every project.
//
// The colour itself is the editor's (Editor.paintColor, [r, g, b, a]): the
// popup shows it and sets it, whoever else changes it - the pipette does.

const PALETTE_KEY = 'vertex.palette';
const CLEAR = [0, 0, 0, 0]; // no colour: the brush rubs out

const hexOf = ([r, g, b]) => [r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('');

function hsvOf([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const spread = max - min;
  let h = 0;
  if (spread > 0) {
    if (max === r) h = ((g - b) / spread) % 6;
    else if (max === g) h = (b - r) / spread + 2;
    else h = (r - g) / spread + 4;
  }
  return { h: (h * 60 + 360) % 360, s: max === 0 ? 0 : spread / max, v: max / 255 };
}

function rgbOf({ h, s, v }) {
  const of = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [of(5), of(3), of(1)];
}

export class ColorPopup {
  // `button` shows the colour and opens `popup`; `alert(message, detail)` tells of a file that could not be read.
  constructor({ button, popup, editor, alert }) {
    this.button = button;
    this.popup = popup;
    this.editor = editor;
    this.alert = alert;
    this.hsv = hsvOf(editor.paintColor);
    this.palette = this.savedPalette();

    this.field = popup.querySelector('.color-field');
    this.hue = popup.querySelector('.color-hue');
    this.inputs = Object.fromEntries([...popup.querySelectorAll('input[name]')].map((input) => [input.name, input]));
    this.swatches = popup.querySelector('.color-swatches');
    this.file = popup.querySelector('input[type=file]');
    this.file.accept = PALETTE_FILES;

    button.addEventListener('mousedown', (event) => event.preventDefault()); // keep the keyboard focus
    button.addEventListener('click', () => this.toggle());
    this.slide(this.field, (x, y) => this.choose({ ...this.hsv, s: x, v: 1 - y }));
    this.slide(this.hue, (x) => this.choose({ ...this.hsv, h: x * 360 }));
    this.inputs.hex.addEventListener('change', () => {
      const found = /^#?([0-9a-f]{6})$/i.exec(this.inputs.hex.value.trim());
      if (found) this.take([0, 2, 4].map((at) => parseInt(found[1].slice(at, at + 2), 16)));
      else this.show();
    });
    for (const [n, name] of ['r', 'g', 'b'].entries()) {
      this.inputs[name].addEventListener('change', () => {
        const value = Math.round(Number(this.inputs[name].value));
        const color = this.editor.paintColor.slice(0, 3);
        if (value >= 0 && value <= 255) color[n] = value;
        this.take(color);
      });
    }
    for (const input of Object.values(this.inputs)) {
      input.addEventListener('focus', () => input.select());
      // Enter takes the number and gives the keyboard back to the editor.
      input.addEventListener('keydown', (event) => {
        if (event.code === 'Enter' || event.code === 'NumpadEnter') input.blur();
      });
    }
    popup.querySelector('[data-palette="add"]').addEventListener('click', () => this.addColor());
    popup.querySelector('[data-palette="import"]').addEventListener('click', () => this.file.click());
    popup.querySelector('[data-palette="reset"]').addEventListener('click', () => this.setPalette(DEFAULT_PALETTE));
    this.file.addEventListener('change', () => this.importFile());
    // Its buttons must not take the keyboard focus; its number fields may.
    popup.addEventListener('mousedown', (event) => {
      if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
    });
    // A press anywhere else closes it, and so does Esc.
    window.addEventListener('pointerdown', (event) => {
      if (!popup.hidden && !popup.contains(event.target) && !button.contains(event.target)) this.toggle(false);
    }, true);
    window.addEventListener('keydown', (event) => {
      if (event.code !== 'Escape' || popup.hidden) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.toggle(false);
    }, true);
    editor.addEventListener('change', () => this.show());
    this.drawSwatches();
    this.show();
  }

  toggle(open = this.popup.hidden) {
    this.popup.hidden = !open;
    this.button.classList.toggle('open', open);
    if (!open) return;
    // Beside the button, inside the window.
    const at = this.button.getBoundingClientRect();
    const { height } = this.popup.getBoundingClientRect();
    this.popup.style.left = `${at.right + 8}px`;
    this.popup.style.top = `${Math.max(4, Math.min(at.top, window.innerHeight - height - 4))}px`;
    this.show();
  }

  // Follows the pointer over a strip or a field while it is held down:
  // `move` is given where it is, from 0 to 1 across and down.
  slide(element, move) {
    const at = (event) => {
      const rect = element.getBoundingClientRect();
      const within = (value) => Math.max(0, Math.min(1, value));
      move(within((event.clientX - rect.left) / rect.width), within((event.clientY - rect.top) / rect.height));
    };
    element.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      element.setPointerCapture(event.pointerId);
      at(event);
    });
    element.addEventListener('pointermove', (event) => {
      if (element.hasPointerCapture(event.pointerId)) at(event);
    });
  }

  // A colour chosen by hue and shade: the hue stays as it was chosen.
  choose(hsv) {
    this.hsv = hsv;
    this.editor.setPaintColor([...rgbOf(hsv), 255]);
    this.show();
  }

  // A colour given outright, [r, g, b].
  take(color) {
    this.editor.setPaintColor([...color, 255]);
    this.show();
  }

  // Shows the editor's colour, wherever it came from.
  show() {
    const color = this.editor.paintColor;
    const clear = color[3] === 0;
    this.button.classList.toggle('clear', clear);
    this.button.style.setProperty('--color', `#${hexOf(color)}`);
    if (this.popup.hidden) return;
    // The hue and the shade are kept unless the colour is no longer theirs.
    if (rgbOf(this.hsv).some((value, n) => value !== color[n])) {
      const hsv = hsvOf(color);
      this.hsv = hsv.s === 0 || hsv.v === 0 ? { ...hsv, h: this.hsv.h, s: hsv.v === 0 ? this.hsv.s : hsv.s } : hsv;
    }
    const { h, s, v } = this.hsv;
    this.popup.style.setProperty('--hue', `hsl(${h}, 100%, 50%)`);
    this.popup.style.setProperty('--color', `#${hexOf(color)}`);
    this.field.firstElementChild.style.left = `${s * 100}%`;
    this.field.firstElementChild.style.top = `${(1 - v) * 100}%`;
    this.hue.firstElementChild.style.left = `${(h / 360) * 100}%`;
    for (const [name, value] of [['hex', hexOf(color)], ['r', color[0]], ['g', color[1]], ['b', color[2]]]) {
      if (document.activeElement !== this.inputs[name]) this.inputs[name].value = value;
    }
    for (const swatch of this.swatches.children) {
      const own = swatch.dataset.color === 'clear' ? clear : !clear && swatch.dataset.color === hexOf(color);
      swatch.classList.toggle('current', own);
    }
  }

  // --- the palette --------------------------------------------------------------

  savedPalette() {
    try {
      const saved = JSON.parse(localStorage.getItem(PALETTE_KEY));
      const sound = typeof saved.name === 'string' && Array.isArray(saved.colors) &&
        saved.colors.every((color) => Array.isArray(color) && color.length === 3 && color.every((value) => Number.isInteger(value) && value >= 0 && value <= 255));
      if (sound) return saved;
    } catch {
      // Nothing kept, or not a palette: the one to start with.
    }
    return { name: DEFAULT_PALETTE.name, colors: DEFAULT_PALETTE.colors.map((color) => [...color]) };
  }

  setPalette({ name, colors }) {
    this.palette = { name, colors: colors.map((color) => [...color]) };
    localStorage.setItem(PALETTE_KEY, JSON.stringify(this.palette));
    this.drawSwatches();
    this.show();
  }

  // The brush's colour joins the palette, if it is not in it.
  addColor() {
    const color = this.editor.paintColor;
    if (color[3] === 0 || this.palette.colors.some((own) => hexOf(own) === hexOf(color))) return;
    this.setPalette({ name: this.palette.name, colors: [...this.palette.colors, color.slice(0, 3)] });
  }

  async importFile() {
    const [file] = this.file.files;
    this.file.value = ''; // the same file may be chosen again
    if (!file) return;
    try {
      this.setPalette(await readPalette(file.name, new Uint8Array(await file.arrayBuffer())));
    } catch (error) {
      await this.alert(t('color-popup.read-failed'), `${file.name}\n\n${error.message}`);
    }
  }

  drawSwatches() {
    const swatch = (color, title) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'color-swatch';
      button.title = title;
      button.dataset.color = color ? hexOf(color) : 'clear';
      if (color) button.style.background = `#${hexOf(color)}`;
      button.addEventListener('click', () => {
        if (color) this.take(color);
        else {
          this.editor.setPaintColor(CLEAR);
          this.show();
        }
      });
      return button;
    };
    const colors = this.palette.colors.map((color, n) => {
      const button = swatch(color, t('color-popup.swatch', { hex: hexOf(color) }));
      button.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this.setPalette({ name: this.palette.name, colors: this.palette.colors.filter((_, k) => k !== n) });
      });
      return button;
    });
    this.swatches.replaceChildren(swatch(null, t('color-popup.no-color')), ...colors);
    this.popup.querySelector('.color-palette-name').textContent = `${this.palette.name} · ${this.palette.colors.length}`;
  }
}
