import { scrubbable } from './scrub.js';
import { MARKER_COLORS, markerColor } from './marker-colors.js';

const OBJECT_ICON = '<i class="fa-solid fa-cube"></i>';
const GROUP_ICON = '<i class="fa-solid fa-folder"></i>';
const EYE_ICON = '<i class="fa-solid fa-eye"></i>';
const EYE_OFF_ICON = '<i class="fa-solid fa-eye-slash"></i>';
const INDENT = 14; // px per nesting level
const DRAG_THRESHOLD = 5; // px of pointer travel before a press on a row becomes a drag
// Ctrl combinations that still work in the fields of the modal form.
const CLIPBOARD_KEYS = new Set(['KeyA', 'KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyY']);

// Parameters asked for before a primitive is made: field id, label, default
// and limits. A kind without fields is made at once.
const PRIMITIVES = {
  cube: {
    title: 'Куб',
    fields: [{ id: 'size', label: 'Размер', value: 1, min: 0.01, max: 100 }],
  },
  cone: {
    title: 'Конус',
    fields: [
      { id: 'sides', label: 'Вершин в основании', value: 8, min: 3, max: 64, whole: true },
      { id: 'size', label: 'Размер', value: 1, min: 0.01, max: 100 },
    ],
  },
  cylinder: {
    title: 'Цилиндр',
    fields: [
      { id: 'sides', label: 'Вершин в основании', value: 8, min: 3, max: 64, whole: true },
      { id: 'size', label: 'Диаметр', value: 1, min: 0.01, max: 100 },
      { id: 'height', label: 'Высота', value: 1, min: 0.01, max: 100 },
    ],
  },
  sphere: {
    title: 'Сфера',
    fields: [
      { id: 'segments', label: 'Детализация', value: 8, min: 3, max: 48, whole: true },
      { id: 'size', label: 'Размер', value: 1, min: 0.01, max: 100 },
    ],
  },
};

// The scene tree: objects and groups by name, a group's contents indented under it.
//   click          - select the object, or everything in the group; Shift+click adds or removes it
//   double click   - rename
//   drag onto a group - put it in; onto an object - next to it; onto empty space - top level
//   the arrow      - fold or unfold a group
//   the eye        - hide or show the object, or the group with all it holds
//   right click    - a menu: fly the camera to it, hide or show, delete
// Above the list, "+" opens the menu of things to add.
export class Outliner {
  constructor(section, editor) {
    this.editor = editor;
    this.list = section.querySelector('#outliner');
    this.menu = section.querySelector('#add-menu');
    this.form = section.querySelector('#add-form');
    this.addButton = section.querySelector('#add-object');
    this.shown = ''; // what the list was last built from
    this.renaming = false;
    this.folded = new Set(); // ids of objects whose children are hidden
    this.press = null; // a press on a row that may become a drag
    this.suppressClick = false;

    this.bindList();
    this.bindContextMenu();
    this.bindAdding(section);
    editor.addEventListener('change', () => this.update());
    this.update();
  }

  // --- the list ----------------------------------------------------------

  update() {
    if (this.renaming) return; // don't pull the text field from under the user
    const { islands, islandOfVertex } = this.editor.topology;
    const { selection, picked } = this.editor;
    // Whole objects are selected only in object mode; elsewhere the object is just being worked on.
    const whole = this.editor.mode === 'object';
    const selected = new Set([...selection].map((vertex) => islandOfVertex[vertex]));
    // A group is selected only when picked itself, not when what it holds is.
    islands.forEach((island, index) => {
      if (island.kind === 'group' && whole && picked.has(index)) selected.add(index);
    });
    const signature = JSON.stringify([
      islands.map((island) => [island.name, island.kind, island.parentIndex, island.hiddenOwn, island.hidden]),
      [...selected],
      whole,
      [...this.folded],
      this.editor.mesh.objects.map((object) => object.color ?? null), // the icons' colours
    ]);
    if (signature === this.shown) return;
    this.shown = signature;

    const rows = [];
    // `within`: a group above this row is selected, and the row with it.
    const addRow = (index, depth, within = false) => {
      const island = islands[index];
      const folded = this.folded.has(island.id);
      const row = document.createElement('div');
      row.className = 'outliner-row';
      row.dataset.object = index;
      row.style.paddingLeft = `${6 + depth * INDENT}px`;
      const picked = whole && selected.has(index);
      if (within) row.classList.add('implied'); // selected through its group: marked faintly
      else if (selected.has(index)) row.classList.add(whole ? 'selected' : 'active');

      const arrow = document.createElement('span');
      arrow.className = 'outliner-arrow';
      if (island.children.length) {
        arrow.innerHTML = `<i class="fa-solid fa-caret-${folded ? 'right' : 'down'}"></i>`;
        arrow.dataset.fold = island.id;
      }
      const name = document.createElement('span');
      name.className = 'outliner-name';
      name.textContent = island.name;
      row.append(arrow);
      const group = island.kind === 'group';
      row.classList.toggle('group', group);
      row.insertAdjacentHTML('beforeend', group ? GROUP_ICON : OBJECT_ICON);
      // Its marker colour, if it has one.
      const marker = markerColor(this.editor.mesh.objects[index].color);
      if (marker) row.lastElementChild.style.color = marker;
      row.append(name);
      row.title = group
        ? `Группа: внутри ${island.children.length}`
        : `${island.vertices.length} вершин, ${island.faces.length} граней`;
      // Hidden, by its own eye or by a group's above it.
      row.classList.toggle('hidden', island.hidden);
      const eye = document.createElement('span');
      eye.className = 'outliner-eye';
      eye.dataset.eye = '';
      eye.title = island.hiddenOwn ? 'Показать' : 'Скрыть';
      eye.innerHTML = island.hiddenOwn ? EYE_OFF_ICON : EYE_ICON;
      row.append(eye);
      rows.push(row);
      const carries = within || (picked && island.kind === 'group');
      if (!folded) for (const child of island.children) addRow(child, depth + 1, carries);
    };
    islands.forEach((island, index) => {
      if (island.parentIndex === null) addRow(index, 0);
    });
    this.list.replaceChildren(...rows);
  }

  bindList() {
    const { list, editor } = this;
    const rowAt = (target) => target.closest?.('[data-object]') ?? null;

    list.addEventListener('click', (event) => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      const eye = event.target.closest('[data-eye]');
      if (eye) {
        const index = Number(rowAt(eye).dataset.object);
        editor.setHidden(index, !editor.topology.islands[index].hiddenOwn);
        return;
      }
      const fold = event.target.closest('[data-fold]');
      if (fold) {
        const id = Number(fold.dataset.fold);
        if (!this.folded.delete(id)) this.folded.add(id);
        this.update();
        return;
      }
      const row = rowAt(event.target);
      if (row && !this.renaming) editor.selectObject(Number(row.dataset.object), event.shiftKey);
    });
    list.addEventListener('dblclick', (event) => {
      const row = rowAt(event.target);
      if (row && !event.target.closest('[data-fold], [data-eye]')) this.rename(row);
    });
    // Rows must not take the keyboard focus away from the editor.
    list.addEventListener('mousedown', (event) => {
      if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
    });

    // Dragging a row onto a group puts it into that group.
    list.addEventListener('pointerdown', (event) => {
      this.suppressClick = false; // the last drag's click never came
      const row = rowAt(event.target);
      if (!row || event.button !== 0 || this.renaming || event.target.closest('[data-fold], [data-eye]')) return;
      this.press = { index: Number(row.dataset.object), x: event.clientX, y: event.clientY, dragging: false };
    });
    window.addEventListener('pointermove', (event) => {
      const press = this.press;
      if (!press) return;
      if (!press.dragging) {
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_THRESHOLD) return;
        press.dragging = true;
        list.classList.add('dragging');
      }
      this.markDropTarget(this.dropTarget(event));
    });
    window.addEventListener('pointerup', (event) => {
      const press = this.press;
      this.press = null;
      if (!press?.dragging) return;
      list.classList.remove('dragging');
      const target = this.dropTarget(event);
      this.markDropTarget(undefined);
      this.suppressClick = rowAt(event.target) !== null; // the click that follows the release
      if (target !== undefined) editor.setParent(press.index, target);
    });
  }

  // The menu of a row, opened with the right button. It acts on that row,
  // whatever is selected.
  bindContextMenu() {
    const { list, editor } = this;
    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.hidden = true;
    document.body.append(menu);
    this.contextMenu = menu;
    const close = () => {
      if (menu.hidden) return false;
      menu.hidden = true;
      list.querySelector('.context')?.classList.remove('context');
      return true;
    };

    list.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      close();
      const row = event.target.closest?.('[data-object]');
      if (!row || this.renaming) return;
      const index = Number(row.dataset.object);
      const island = editor.topology.islands[index];
      const item = (label, run, enabled = true) => {
        const button = document.createElement('button');
        button.textContent = label;
        button.disabled = !enabled;
        button.addEventListener('click', () => {
          close();
          run();
        });
        return button;
      };
      // A marker colour: for this row, or - if it is one of several picked - for all of them.
      const whole = editor.mode === 'object' && editor.picked.has(index) ? [...editor.picked] : [index];
      const current = editor.mesh.objects[index].color ?? null;
      const swatch = (label, color, id) => {
        const button = item(label, () => editor.setObjectColor(whole, id));
        const dot = document.createElement('i');
        dot.className = 'color-dot';
        if (color) dot.style.background = color;
        else dot.classList.add('none');
        button.prepend(dot);
        button.classList.toggle('current', id === current);
        return button;
      };
      const colors = document.createElement('div');
      colors.className = 'submenu';
      colors.append(
        ...MARKER_COLORS.map((marker) => swatch(marker.label, marker.color, marker.id)),
        swatch('Без цвета', null, null),
      );
      const colorItem = document.createElement('div');
      colorItem.className = 'submenu-item';
      const colorLabel = document.createElement('button');
      colorLabel.innerHTML = '<span>Цвет метки</span><i class="fa-solid fa-chevron-right"></i>';
      colorItem.append(colorLabel, colors);
      menu.replaceChildren(
        item('Центровать', () => editor.focusObject(index), editor.contents([index]).vertices.size > 0),
        item(island.hiddenOwn ? 'Показать' : 'Скрыть', () => editor.setHidden(index, !island.hiddenOwn)),
        colorItem,
        item('Сбросить опорную точку', () => editor.resetPivot(index), Boolean(editor.mesh.objects[index].pivot)),
        item('Удалить', () => editor.deleteObject(index)),
      );
      row.classList.add('context');
      menu.hidden = false;
      // At the pointer, but inside the window.
      const { width, height } = menu.getBoundingClientRect();
      menu.style.left = `${Math.min(event.clientX, window.innerWidth - width - 4)}px`;
      menu.style.top = `${Math.min(event.clientY, window.innerHeight - height - 4)}px`;
      // The submenu opens to the right, or to the left where there is no room; and up near the bottom.
      const placed = menu.getBoundingClientRect();
      colorItem.classList.toggle('left', placed.right + 170 > window.innerWidth);
      colorItem.classList.toggle('up', colorItem.getBoundingClientRect().top + (MARKER_COLORS.length + 1) * 28 + 12 > window.innerHeight);
    });
    // Its buttons must not take the keyboard focus.
    menu.addEventListener('mousedown', (event) => event.preventDefault());
    // A press anywhere else closes it, and so do Esc and leaving the window.
    window.addEventListener('pointerdown', (event) => {
      if (!menu.contains(event.target)) close();
    }, true);
    window.addEventListener('keydown', (event) => {
      if (event.code === 'Escape' && close()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    window.addEventListener('blur', close);
  }

  // Where a dragged row would land: a group's index, null for the top level
  // (empty space of the list), undefined outside the list. Over an object's
  // row that is the group the object is in: the row lands next to it.
  dropTarget(event) {
    const element = document.elementFromPoint(event.clientX, event.clientY);
    const row = element?.closest('[data-object]');
    if (row && this.list.contains(row)) {
      const index = Number(row.dataset.object);
      const island = this.editor.topology.islands[index];
      return island.kind === 'group' ? index : island.parentIndex;
    }
    return element && this.list.contains(element) ? null : undefined;
  }

  markDropTarget(target) {
    for (const row of this.list.children) {
      row.classList.toggle('drop-target', Number(row.dataset.object) === target);
    }
    this.list.classList.toggle('drop-root', target === null);
  }

  // Replaces a row's name with a text field; Enter or a click away keeps the
  // new name, Esc drops it.
  rename(row) {
    const index = Number(row.dataset.object);
    const label = row.querySelector('.outliner-name');
    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.value = label.textContent;
    label.replaceWith(input);
    this.renaming = true;
    input.focus();
    input.select();

    // Ends the renaming once, whichever way it is left.
    const finish = (keep) => {
      if (!this.renaming) return;
      this.renaming = false;
      this.shown = ''; // force a rebuild
      if (keep) this.editor.renameObject(index, input.value);
      this.update();
    };
    input.addEventListener('keydown', (event) => {
      if (event.code === 'Enter' || event.code === 'NumpadEnter') finish(true);
      if (event.code === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  // --- adding objects ----------------------------------------------------

  bindAdding(section) {
    const { menu, form, addButton } = this;
    const closeMenu = () => {
      menu.hidden = true;
      addButton.classList.remove('active');
    };
    addButton.addEventListener('click', () => {
      this.closeForm();
      menu.hidden = !menu.hidden;
      addButton.classList.toggle('active', !menu.hidden);
    });
    for (const item of menu.querySelectorAll('[data-primitive]')) {
      item.addEventListener('click', () => {
        closeMenu();
        const kind = item.dataset.primitive;
        if (PRIMITIVES[kind].fields.length) this.openForm(kind);
        else this.editor.addPrimitive(kind);
      });
    }
    menu.querySelector('[data-group]').addEventListener('click', () => {
      closeMenu();
      this.editor.addGroup();
    });
    // Buttons must not take the keyboard focus; the form's fields may.
    section.querySelector('.outliner-header').addEventListener('mousedown', (event) => event.preventDefault());
    menu.addEventListener('mousedown', (event) => event.preventDefault());
    // A press anywhere else closes the menu.
    window.addEventListener('pointerdown', (event) => {
      if (!menu.contains(event.target) && !addButton.contains(event.target)) closeMenu();
    }, true);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const options = this.formOptions();
      this.closeForm();
      this.editor.addPrimitive(form.dataset.kind, options);
    });
    // The wireframe in the scene follows the fields.
    form.addEventListener('input', () => this.showPreview());
    form.addEventListener('keydown', (event) => {
      if (event.code === 'Escape') this.closeForm();
      if (event.code === 'Enter' || event.code === 'NumpadEnter') {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    form.querySelector('[data-cancel]').addEventListener('click', () => this.closeForm());
    // The form is modal. While it is open the keyboard belongs to it: outside
    // its fields only Enter and Esc do anything (after a field has been dragged
    // nothing in the form has the focus), and the editor's shortcuts are off.
    for (const type of ['keydown', 'keyup']) {
      window.addEventListener(type, (event) => {
        if (form.hidden) return;
        // Inside the form a key goes on to the field, but no further.
        if (form.contains(event.target)) {
          if (type === 'keydown' && (event.ctrlKey || event.metaKey) && !CLIPBOARD_KEYS.has(event.code)) {
            event.preventDefault();
          }
          return;
        }
        event.stopImmediatePropagation();
        event.preventDefault();
        if (type !== 'keydown') return;
        if (event.code === 'Enter' || event.code === 'NumpadEnter') form.requestSubmit();
        else if (event.code === 'Escape') this.closeForm();
      }, true);
    }
    // Keys typed in a field stay in the form.
    form.addEventListener('keydown', (event) => event.stopPropagation());
    form.addEventListener('keyup', (event) => event.stopPropagation());
    // And so does the pointer: an invisible sheet over the rest of the window
    // takes presses, drags and the wheel. The scene stays visible through it,
    // for the preview's sake.
    this.blocker = document.createElement('div');
    this.blocker.className = 'modal-blocker';
    this.blocker.hidden = true;
    document.body.append(this.blocker);
    for (const type of ['pointerdown', 'mousedown', 'wheel', 'contextmenu']) {
      this.blocker.addEventListener(type, (event) => event.preventDefault(), { passive: false });
    }
  }

  // The form's values as options for the primitive, kept within each field's limits.
  formOptions() {
    const options = {};
    for (const field of PRIMITIVES[this.form.dataset.kind].fields) {
      let value = parseFloat(this.form.elements[field.id].value.replace(',', '.'));
      if (!Number.isFinite(value)) value = field.value;
      value = Math.min(Math.max(value, field.min), field.max);
      options[field.id] = field.whole ? Math.round(value) : value;
    }
    return options;
  }

  showPreview() {
    this.editor.previewPrimitive(this.form.dataset.kind, this.formOptions());
  }

  // Shows the parameters of a primitive; submitting the form makes the object.
  openForm(kind) {
    const { form } = this;
    const { title, fields } = PRIMITIVES[kind];
    form.dataset.kind = kind;
    form.querySelector('h3').textContent = title;
    form.querySelector('.fields').replaceChildren(
      ...fields.map((field) => {
        const label = document.createElement('label');
        const caption = document.createElement('span');
        caption.textContent = field.label;
        const input = document.createElement('input');
        input.type = 'text';
        input.name = field.id;
        input.inputMode = field.whole ? 'numeric' : 'decimal';
        input.spellcheck = false;
        input.value = field.value;
        input.title = `от ${field.min} до ${field.max} · чтобы менять, ведите вверх или вниз за точку справа`;
        // Dragging the field's handle up or down changes its value.
        const scrub = scrubbable(input, {
          read: () => parseFloat(input.value.replace(',', '.')),
          write: (value) => {
            input.value = value;
            this.showPreview();
          },
          whole: field.whole,
          min: field.min,
          max: field.max,
        });
        label.append(caption, scrub);
        return label;
      }),
    );
    form.hidden = false;
    this.blocker.hidden = false;
    this.showPreview();
    const first = form.querySelector('input');
    first.focus();
    first.select();
  }

  closeForm() {
    if (this.form.hidden) return;
    this.form.hidden = true;
    this.blocker.hidden = true;
    this.editor.previewPrimitive(null);
    document.activeElement?.blur(); // give the keyboard back to the editor shortcuts
  }
}
