const STORAGE_KEY = 'vertex.hotkeys';
const MODIFIER_CODES = /^(Control|Shift|Alt|Meta)(Left|Right)$/;

const KEY_NAMES = {
  Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'",
  BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`',
};

// A key press as a combination: 'KeyE', 'Ctrl+KeyE', 'Ctrl+Shift+Digit1', ...
// (physical keys, so it is the same on any keyboard layout). Null for a
// modifier pressed on its own.
export function comboOf(event) {
  if (MODIFIER_CODES.test(event.code) || !event.code) return null;
  return [
    event.ctrlKey || event.metaKey ? 'Ctrl+' : '',
    event.shiftKey ? 'Shift+' : '',
    event.altKey ? 'Alt+' : '',
    event.code,
  ].join('');
}

// A combination as the user reads it: 'Ctrl+E', '1', 'Delete'.
export function comboLabel(combo) {
  if (!combo) return '—';
  const parts = combo.split('+');
  const code = parts.pop();
  const key =
    KEY_NAMES[code] ??
    code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ');
  return [...parts, key].join('+');
}

// The editor's rebindable shortcuts.
//   bindings: [{ id, label, group, keys, run }] - `keys` is the default
//             combination; run() does the action and may return false to say
//             the press was not for it (the key then does what it normally does).
//   reserved: combinations that can't be given to anything (fixed keys).
// The user's own choices are kept between runs, apart from the defaults.
export class Hotkeys extends EventTarget {
  constructor(bindings, reserved = []) {
    super();
    this.bindings = bindings;
    this.reserved = new Set(reserved);
    this.custom = {};
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
      for (const { id } of bindings) {
        if (typeof saved[id] === 'string') this.custom[id] = saved[id];
      }
    } catch {
      // Unreadable settings: the defaults are used.
    }
  }

  // The combination a binding answers to now ('' = none).
  keysOf(id) {
    const binding = this.bindings.find((candidate) => candidate.id === id);
    return this.custom[id] ?? binding?.keys ?? '';
  }

  label(id) {
    return comboLabel(this.keysOf(id));
  }

  isCustom(id) {
    return id in this.custom;
  }

  // Runs the binding the key press is for. Returns true if there was one and it took the press.
  // With `only` (ids), the other bindings are not heard.
  handle(event, only = null) {
    const combo = comboOf(event);
    if (!combo) return false;
    const binding = this.bindings.find(({ id }) => this.keysOf(id) === combo);
    if (!binding || (only && !only.includes(binding.id)) || binding.run() === false) return false;
    event.preventDefault();
    return true;
  }

  // Gives a binding a combination. One that another binding answers to is
  // taken from it; that binding is returned (it has no key now), or null.
  // A reserved combination is refused: returns false.
  set(id, combo) {
    if (this.reserved.has(combo)) return false;
    const loser = this.bindings.find((other) => other.id !== id && this.keysOf(other.id) === combo) ?? null;
    if (loser) this.custom[loser.id] = '';
    this.custom[id] = combo;
    this.save();
    return loser;
  }

  // Back to the default; whoever holds that combination meanwhile loses it.
  reset(id) {
    const binding = this.bindings.find((candidate) => candidate.id === id);
    delete this.custom[id];
    for (const other of this.bindings) {
      if (other.id !== id && binding.keys && this.keysOf(other.id) === binding.keys) this.custom[other.id] = '';
    }
    this.save();
  }

  resetAll() {
    this.custom = {};
    this.save();
  }

  save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.custom));
    this.dispatchEvent(new Event('change'));
  }
}
