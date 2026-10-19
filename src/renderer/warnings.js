const TOAST_TIME = 8000; // ms a new warning stays up before it goes to the status bar

// The Russian form of a noun for a count: [1, 2-4, 5+].
const plural = (count, [one, few, many]) => {
  const n = Math.abs(count) % 100;
  if (n >= 11 && n <= 14) return many;
  return n % 10 === 1 ? one : n % 10 >= 2 && n % 10 <= 4 ? few : many;
};

const point = (p) => `(${[p.x, p.y, p.z].map((n) => +n.toFixed(3)).join(', ')})`;

// Warnings about the model, for now one kind: vertices of an object standing
// in the same place, which are better merged into one.
//
// A new one comes up as a card in the corner - it does not take the input -
// with a bar running down; "keep" and "merge" answer it. Left alone it goes
// away, and what is unanswered waits behind the warnings button in the status
// bar, which opens the list of them. "Keep" silences a warning until the
// vertices in question change.
//
// Next to it is the errors button, for what is wrong rather than doubtful:
// faces that are not flat, which cannot be textured without stretch.
export class Warnings {
  constructor(editor, { toast, button, errorButton, list }) {
    this.editor = editor;
    this.toast = toast;
    this.button = button;
    this.errorButton = errorButton;
    this.list = list;
    this.errors = []; // { text }
    this.listed = 'warning'; // which kind the open list shows
    this.kept = new Set(); // signatures the user chose to keep
    this.seen = new Set(); // signatures already announced
    this.pending = []; // the warnings the card is about
    this.current = []; // all unanswered warnings

    toast.querySelector('[data-keep]').addEventListener('click', () => this.answer(this.pending, false));
    toast.querySelector('[data-merge]').addEventListener('click', () => this.answer(this.pending, true));
    // The bar is the timer: when it has run out the card goes.
    toast.querySelector('.toast-timer i').addEventListener('animationend', () => this.hideToast());
    for (const [kind, opener] of [['warning', button], ['error', errorButton]]) {
      opener.addEventListener('click', () => {
        // A second click on the same button closes the list.
        list.hidden = !list.hidden && this.listed === kind;
        this.listed = kind;
        if (!list.hidden) this.showList();
      });
    }
    window.addEventListener('pointerdown', (event) => {
      const inside = [list, button, errorButton].some((element) => element.contains(event.target));
      if (!inside) list.hidden = true;
    }, true);
    // None of it takes the keyboard from the editor.
    for (const element of [toast, button, errorButton, list]) {
      element.addEventListener('mousedown', (event) => event.preventDefault());
    }
    editor.addEventListener('change', () => this.update());
    this.update();
  }

  update() {
    const { editor } = this;
    // Not in the middle of a drag: things pass through each other on the way.
    if (editor.busy() || editor.drag) return;
    const found = editor.overlaps().map((overlap) => ({
      ...overlap,
      signature: `${overlap.object}:${point(overlap.point)}:${overlap.indices.length}`,
    }));
    const live = new Set(found.map((warning) => warning.signature));
    // What is gone may come back as news; a "keep" lasts while the overlap does.
    for (const set of [this.kept, this.seen]) {
      for (const signature of set) if (!live.has(signature)) set.delete(signature);
    }
    this.current = found.filter((warning) => !this.kept.has(warning.signature));
    // Things to know, not to answer (see Editor.notices()).
    this.notes = editor.notices?.() ?? [];
    // What is wrong rather than doubtful, see Editor.problems().
    this.errors = editor.problems();
    const fresh = this.current.filter((warning) => !this.seen.has(warning.signature));
    for (const warning of fresh) this.seen.add(warning.signature);
    this.pending = this.pending
      .map((old) => this.current.find((warning) => warning.signature === old.signature))
      .filter(Boolean);
    if (fresh.length) {
      this.pending = [...this.pending, ...fresh];
      this.showToast();
    } else if (this.toastShown() && this.pending.length === 0) {
      this.hideToast();
    }
    this.show();
  }

  // Keeps or merges the given warnings.
  answer(warnings, merge) {
    if (merge) {
      this.editor.mergeOverlaps(warnings.map((warning) => warning.indices));
    } else {
      for (const warning of warnings) this.kept.add(warning.signature);
    }
    this.pending = [];
    this.hideToast();
    this.update();
  }

  showToast() {
    const vertices = this.pending.reduce((sum, warning) => sum + warning.indices.length, 0);
    const places = this.pending.length;
    this.toast.querySelector('p').textContent =
      places === 1
        ? `${vertices} вершины стоят в одной точке. Рекомендуется соединить их в одну.`
        : `Вершины совпадают в ${places} местах (всего ${vertices}). Рекомендуется соединить их.`;
    this.toast.classList.add('shown'); // slides in, see the styles
    // The bar starts over.
    const bar = this.toast.querySelector('.toast-timer i');
    bar.style.animation = 'none';
    void bar.offsetWidth;
    bar.style.animation = `toast-timer ${TOAST_TIME}ms linear forwards`;
  }

  toastShown() {
    return this.toast.classList.contains('shown');
  }

  hideToast() {
    this.toast.classList.remove('shown'); // slides away
    this.pending = [];
    this.show();
  }

  // The two buttons in the status bar are always there; each is filled with
  // its colour only while it has something to show.
  show() {
    const set = (button, count, forms) => {
      button.classList.toggle('active', count > 0);
      button.querySelector('span').textContent = `${count} ${plural(count, forms)}`;
    };
    set(this.button, this.current.length + (this.notes?.length ?? 0), ['предупреждение', 'предупреждения', 'предупреждений']);
    set(this.errorButton, this.errors.length, ['ошибка', 'ошибки', 'ошибок']);
    if (!this.list.hidden) this.showList();
  }

  // The list of one kind: 'warning' or 'error'.
  showList() {
    const { list } = this;
    const make = (tag, text, className) => {
      const element = document.createElement(tag);
      if (text) element.textContent = text;
      if (className) element.className = className;
      return element;
    };
    const action = (label, run) => {
      const button = make('button', label);
      button.addEventListener('click', run);
      return button;
    };
    const errors = this.listed === 'error';
    list.classList.toggle('errors', errors);
    const head = make('div', null, 'warnings-head');
    head.append(make('span', errors ? 'Ошибки' : 'Предупреждения'));
    if (!errors && this.current.length > 1) head.append(action('Соединить все', () => this.answer(this.current, true)));
    const rows = errors
      ? this.errors.map((error) => {
          const row = make('div', null, 'warning-row');
          row.append(make('span', error.text));
          return row;
        })
      : [...this.current.map((warning) => {
          const row = make('div', null, 'warning-row');
          const count = warning.indices.length;
          const text = make('span', `${count} ${plural(count, ['вершина', 'вершины', 'вершин'])} в одной точке ${point(warning.point)} · ${warning.name}`);
          row.append(text, action('Оставить', () => this.answer([warning], false)), action('Соединить', () => this.answer([warning], true)));
          return row;
        }), ...(this.notes ?? []).map((note) => {
          const row = make('div', null, 'warning-row');
          row.append(make('span', note.text));
          return row;
        })];
    if (rows.length === 0) rows.push(make('div', errors ? 'Ошибок нет' : 'Предупреждений нет', 'warning-none'));
    list.replaceChildren(head, ...rows);
  }
}
