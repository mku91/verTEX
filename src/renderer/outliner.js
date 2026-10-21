import { scrubbable } from './scrub.js';
import { MARKER_COLORS, markerColor } from './marker-colors.js';
import { BODY_COLORS, SHAPE_ICONS, shapeLabel } from './collisions.js';
import { latinOnly } from './names.js';
import { boundByNode, selectBound } from './skin.js';
import { confirmIt } from './ask-dialog.js';
import { t } from './i18n.js';

// Objects joined - asked first when they are on different atlases: the
// joined one is on the first one's, and the others' faces are laid out on
// it anew, what was painted for them left behind.
async function joinAsked(editor, joined) {
  const { objects } = editor.mesh;
  const atlases = new Set(joined.map((index) => objects[index]?.atlas).filter(Boolean));
  if (atlases.size > 1) {
    const first = editor.atlasById(joined.map((index) => objects[index]?.atlas).find(Boolean));
    const sure = await confirmIt(
      t('outliner.join.title'),
      t('outliner.join.text', { atlas: first?.name }),
      t('outliner.join.ok'),
    );
    if (!sure) return;
  }
  editor.joinObjects(joined);
}

const OBJECT_ICON = '<i class="fa-solid fa-cube"></i>';
const NODE_ICON = '<i class="fa-solid fa-circle-nodes"></i>'; // a node (the kind 'node')
const EYE_ICON = '<i class="fa-solid fa-eye"></i>';
const EYE_OFF_ICON = '<i class="fa-solid fa-eye-slash"></i>';
const INDENT = 14; // px per nesting level
const DRAG_THRESHOLD = 5; // px of pointer travel before a press on a row becomes a drag
// Ctrl combinations that still work in the fields of the modal form.
const CLIPBOARD_KEYS = new Set(['KeyA', 'KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyY']);

// Where a new object may be put up against the selection: automatically (a
// selected face's side, or the one towards the camera), or on a side chosen.
const SIDES = [
  { id: 'auto', label: t('outliner.side.auto.label'), title: t('outliner.side.auto.title') },
  { id: 'x+', label: 'X+', axis: 'x', sign: 1 },
  { id: 'x-', label: 'X−', axis: 'x', sign: -1 },
  { id: 'y+', label: 'Y+', axis: 'y', sign: 1 },
  { id: 'y-', label: 'Y−', axis: 'y', sign: -1 },
  { id: 'z+', label: 'Z+', axis: 'z', sign: 1 },
  { id: 'z-', label: 'Z−', axis: 'z', sign: -1 },
];

// Parameters asked for before a primitive is made: field id, label, default
// and limits. A kind without fields is made at once.
const PRIMITIVES = {
  cube: {
    title: t('outliner.primitive.cube'),
    fields: [{ id: 'size', label: t('outliner.field.size'), value: 1, min: 0.01, max: 100 }],
  },
  cone: {
    title: t('outliner.primitive.cone'),
    fields: [
      { id: 'sides', label: t('outliner.field.sides'), value: 8, min: 3, max: 64, whole: true },
      { id: 'size', label: t('outliner.field.size'), value: 1, min: 0.01, max: 100 },
    ],
  },
  cylinder: {
    title: t('outliner.primitive.cylinder'),
    fields: [
      { id: 'sides', label: t('outliner.field.sides'), value: 8, min: 3, max: 64, whole: true },
      { id: 'size', label: t('outliner.field.diameter'), value: 1, min: 0.01, max: 100 },
      { id: 'height', label: t('outliner.field.height'), value: 1, min: 0.01, max: 100 },
    ],
  },
  sphere: {
    title: t('outliner.primitive.sphere'),
    fields: [
      { id: 'segments', label: t('outliner.field.segments'), value: 8, min: 3, max: 48, whole: true },
      { id: 'size', label: t('outliner.field.size'), value: 1, min: 0.01, max: 100 },
    ],
  },
  capsule: {
    title: t('outliner.primitive.capsule'),
    fields: [
      { id: 'segments', label: t('outliner.field.segments'), value: 8, min: 3, max: 48, whole: true },
      { id: 'size', label: t('outliner.field.diameter'), value: 1, min: 0.01, max: 100 },
      { id: 'height', label: t('outliner.field.height'), value: 2, min: 0.01, max: 100 },
    ],
  },
};

// The scene tree: objects and nodes by name, a node's contents indented under it.
//   click          - select the object, or everything in the node; Shift+click adds or removes it
//   double click   - rename
//   drag onto a node - put it in; onto an object - next to it; onto empty space - top level
//   the arrow      - fold or unfold a node
//   the eye        - hide or show the object, or the node with all it holds
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
    // The collision mode (see collisions.js), set once it is made: in it an
    // object's collision shapes are rows under it, to pick them by.
    this.shapes = null;

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
    // A node is selected only when picked itself, not when what it holds is.
    islands.forEach((island, index) => {
      if (island.kind === 'node' && whole && picked.has(index)) selected.add(index);
    });
    // What the nodes bind (the skin, see skin.js): a row under a node for each object.
    const bound = boundByNode(this.editor.mesh);
    const focus = this.editor.mode === 'vertex' ? this.editor.skinFocus ?? null : null;
    const signature = JSON.stringify([
      islands.map((island) => [island.name, island.kind, island.parentIndex, island.hiddenOwn, island.hidden]),
      [...bound].map(([node, objects]) => [node, objects.map(({ object, vertices }) => [object, vertices.length])]), focus,
      [...selected],
      whole,
      [...this.folded],
      this.editor.mesh.objects.map((object) => object.color ?? null), // the icons' colours
      this.editor.mesh.objects.map((object) => object.locked ?? false), // the nodes' locks
      // In the collision mode, the shapes: their kinds, the bodies, the one picked.
      this.editor.collisions
        ? [this.editor.mesh.objects.map((object) => [object.body ?? null, (object.colliders ?? []).map((shape) => shape.type)]), this.shapes?.picked ?? null]
        : null,
    ]);
    if (signature === this.shown) return;
    this.shown = signature;

    const rows = [];
    // `within`: a node above this row is selected, and the row with it.
    const addRow = (index, depth, within = false) => {
      const island = islands[index];
      const folded = this.folded.has(island.id);
      const row = document.createElement('div');
      row.className = 'outliner-row';
      row.dataset.object = index;
      row.style.paddingLeft = `${6 + depth * INDENT}px`;
      const picked = whole && selected.has(index);
      if (within) row.classList.add('implied'); // selected through its node: marked faintly
      else if (selected.has(index)) row.classList.add(whole ? 'selected' : 'active');

      const object = this.editor.mesh.objects[index];
      const shapes = this.editor.collisions ? object.colliders ?? [] : [];
      const arrow = document.createElement('span');
      arrow.className = 'outliner-arrow';
      const binds = island.kind === 'node' ? bound.get(island.id) ?? [] : [];
      if (island.children.length || shapes.length || binds.length) {
        arrow.innerHTML = `<i class="fa-solid fa-caret-${folded ? 'right' : 'down'}"></i>`;
        arrow.dataset.fold = island.id;
      }
      const name = document.createElement('span');
      name.className = 'outliner-name';
      name.textContent = island.name;
      row.append(arrow);
      const node = island.kind === 'node';
      row.classList.toggle('node', node);
      row.insertAdjacentHTML('beforeend', node ? NODE_ICON : OBJECT_ICON);
      // Its marker colour, if it has one.
      const marker = markerColor(this.editor.mesh.objects[index].color);
      if (marker) row.lastElementChild.style.color = marker;
      row.append(name);
      row.title = node
        ? t('outliner.row.node.title', { count: island.children.length })
        : `${t('outliner.row.vertices', { count: island.vertices.length })}, ${t('outliner.row.faces', { count: island.faces.length })}`;
      // A node's lock: picked only whole in the main view while it is shut (see Editor.lockedOwner()).
      if (node) {
        // Open, shut (picked whole) or 'nearest' (picked as the nearest node).
        const locked = this.editor.mesh.objects[index].locked ?? false;
        const lock = document.createElement('span');
        lock.className = 'outliner-lock';
        lock.classList.toggle('shut', locked === true);
        lock.classList.toggle('nearest', locked === 'nearest');
        lock.dataset.lock = index;
        lock.title = locked === true
          ? t('outliner.lock.shut.title')
          : locked === 'nearest'
            ? t('outliner.lock.nearest.title')
            : t('outliner.lock.open.title');
        // (nearest: a child - a part picked as the node it is a child of)
        lock.innerHTML = `<i class="fa-solid ${locked === 'nearest' ? 'fa-child' : locked ? 'fa-lock' : 'fa-lock-open'}"></i>`;
        row.append(lock);
      }
      // A node's +: something new made in it (see bindAdding()).
      if (node) {
        const plus = document.createElement('span');
        plus.className = 'outliner-add';
        plus.dataset.addInto = island.id;
        plus.title = t('outliner.add-into.title');
        plus.innerHTML = '<i class="fa-solid fa-plus"></i>';
        row.append(plus);
      }
      // Hidden, by its own eye or by a node's above it.
      row.classList.toggle('hidden', island.hidden);
      const eye = document.createElement('span');
      eye.className = 'outliner-eye';
      eye.dataset.eye = '';
      eye.title = island.hiddenOwn ? t('outliner.show') : t('outliner.hide');
      eye.innerHTML = island.hiddenOwn ? EYE_OFF_ICON : EYE_ICON;
      row.append(eye);
      rows.push(row);
      const carries = within || (picked && island.kind === 'node');
      if (folded) return;
      // Its collision shapes first, in the body's colour; the picked one marked.
      shapes.forEach((shape, k) => {
        const line = document.createElement('div');
        line.className = 'outliner-row outliner-shape';
        line.dataset.shape = `${index}:${k}`;
        line.style.paddingLeft = `${6 + (depth + 1) * INDENT}px`;
        const chosen = this.shapes?.picked?.id === object.id && this.shapes.picked.index === k;
        if (chosen) line.classList.add('selected');
        line.innerHTML = `<span class="outliner-arrow"></span><i class="${SHAPE_ICONS[shape.type]}"></i>`;
        line.lastElementChild.style.color = `#${BODY_COLORS[object.body ?? 'static'].toString(16).padStart(6, '0')}`;
        const name = document.createElement('span');
        name.className = 'outliner-name';
        name.textContent = shapeLabel(object.colliders, k);
        line.append(name);
        line.title = t('outliner.shape.title');
        rows.push(line);
      });
      // What it binds (a node): an object a row, in the skin's green; a press picks those vertices.
      for (const { object: id, vertices } of binds) {
        const owner = this.editor.mesh.objects.find((entry) => entry.id === id);
        const line = document.createElement('div');
        line.className = 'outliner-row outliner-skin';
        line.dataset.skin = `${island.id}:${id}`;
        line.style.paddingLeft = `${6 + (depth + 1) * INDENT}px`;
        if (focus?.node === island.id && focus.object === id) line.classList.add('selected');
        line.innerHTML = '<span class="outliner-arrow"></span><i class="fa-solid fa-link"></i>';
        const name = document.createElement('span');
        name.className = 'outliner-name';
        name.textContent = `${owner?.name ?? '?'} · ${vertices.length}`;
        line.append(name);
        line.title = t('outliner.skin.title', { object: owner?.name ?? '?', node: island.name });
        rows.push(line);
      }
      for (const child of island.children) addRow(child, depth + 1, carries);
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
      // A node's lock.
      const lock = event.target.closest('[data-lock]');
      if (lock) {
        const index = Number(lock.dataset.lock);
        // round: open -> shut -> nearest -> open
        const now = editor.mesh.objects[index].locked ?? false;
        editor.setNodeLock(index, now === true ? 'nearest' : now === 'nearest' ? false : true);
        return;
      }
      // A node's +: the menu of things to add, beside it, for that node.
      const plus = event.target.closest('[data-add-into]');
      if (plus) {
        this.openAddMenu(Number(plus.dataset.addInto), plus);
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
      const shape = event.target.closest('[data-shape]');
      if (shape) {
        const [index, k] = shape.dataset.shape.split(':').map(Number);
        this.shapes?.pickShape(index, k);
        return;
      }
      // What a node binds: those vertices picked (see skin.js).
      const skin = event.target.closest('[data-skin]');
      if (skin) {
        const [node, object] = skin.dataset.skin.split(':').map(Number);
        selectBound(editor, node, object);
        return;
      }
      const row = rowAt(event.target);
      if (row && !this.renaming) editor.selectObject(Number(row.dataset.object), event.shiftKey);
    });
    list.addEventListener('dblclick', (event) => {
      const row = rowAt(event.target);
      if (row && !event.target.closest('[data-fold], [data-eye], [data-add-into], [data-lock]')) this.rename(row);
      const shape = event.target.closest('[data-shape]');
      if (shape) this.rename(shape);
    });
    // Rows must not take the keyboard focus away from the editor.
    list.addEventListener('mousedown', (event) => {
      if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
    });

    // Dragging a row onto a node puts it into that node.
    list.addEventListener('pointerdown', (event) => {
      this.suppressClick = false; // the last drag's click never came
      const row = rowAt(event.target);
      if (!row || event.button !== 0 || this.renaming || event.target.closest('[data-fold], [data-eye], [data-add-into], [data-lock]')) return;
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
      const shape = event.target.closest?.('[data-shape]');
      const row = shape ?? event.target.closest?.('[data-object]');
      if (!row || this.renaming) return;
      const index = Number(shape ? shape.dataset.shape.split(':')[0] : row.dataset.object);
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
      // A collision shape's row: picked by the press, and its own menu.
      if (shape) {
        const k = Number(shape.dataset.shape.split(':')[1]);
        this.shapes?.pickShape(index, k);
        menu.replaceChildren(
          item(t('outliner.menu.rename'), () => {
            const line = this.list.querySelector(`[data-shape="${index}:${k}"]`);
            if (line) this.rename(line);
          }),
          item(t('outliner.menu.delete'), () => this.shapes?.removeShape(index, k)),
        );
        // (the press picked it, and the list was built anew: the row is the new one's)
        this.list.querySelector(`[data-shape="${index}:${k}"]`)?.classList.add('context');
        menu.hidden = false;
        const { width, height } = menu.getBoundingClientRect();
        menu.style.left = `${Math.min(event.clientX, window.innerWidth - width - 4)}px`;
        menu.style.top = `${Math.min(event.clientY, window.innerHeight - height - 4)}px`;
        return;
      }
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
        swatch(t('outliner.menu.no-color'), null, null),
      );
      const colorItem = document.createElement('div');
      colorItem.className = 'submenu-item';
      const colorLabel = document.createElement('button');
      colorLabel.innerHTML = '<span></span><i class="fa-solid fa-chevron-right"></i>';
      colorLabel.firstElementChild.textContent = t('outliner.menu.marker-color');
      colorItem.append(colorLabel, colors);
      // Joining: the picked objects into this one, when it is one of them.
      const joined = [index, ...whole.filter((other) => other !== index)].filter(
        (other) => editor.topology.islands[other].kind !== 'node',
      );
      menu.replaceChildren(
        item(t('outliner.menu.center'), () => editor.focusObject(index), editor.contents([index]).vertices.size > 0),
        item(t('outliner.menu.drop'), () => editor.dropToFloor(whole), editor.contents(whole).vertices.size > 0),
        item(island.hiddenOwn ? t('outliner.show') : t('outliner.hide'), () => editor.setHidden(index, !island.hiddenOwn)),
        colorItem,
        item(t('outliner.menu.duplicate'), () => editor.duplicateObjects(whole)),
        item(t('outliner.menu.join'), () => joinAsked(editor, joined), island.kind !== 'node' && joined.length > 1),
        item(t('outliner.menu.reset-pivot'), () => editor.resetPivot(index), Boolean(editor.mesh.objects[index].pivot)),
        item(t('outliner.menu.delete'), () => editor.deleteObject(index)),
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

  // Where a dragged row would land: a node's index, null for the top level
  // (empty space of the list), undefined outside the list. Over an object's
  // row that is the node the object is in: the row lands next to it.
  dropTarget(event) {
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (element?.closest('[data-shape]')) return undefined; // a shape's row holds nothing
    const row = element?.closest('[data-object]');
    if (row && this.list.contains(row)) {
      const index = Number(row.dataset.object);
      const island = this.editor.topology.islands[index];
      return island.kind === 'node' ? index : island.parentIndex;
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
  // A row's name made a field to type a new one in: an object's, a node's
  // or a collision shape's. Latin letters only (see names.js).
  rename(row) {
    const shape = row.dataset.shape?.split(':').map(Number) ?? null;
    const index = shape ? shape[0] : Number(row.dataset.object);
    const label = row.querySelector('.outliner-name');
    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.value = label.textContent;
    latinOnly(input);
    label.replaceWith(input);
    this.renaming = true;
    input.focus();
    input.select();

    // Ends the renaming once, whichever way it is left.
    const finish = (keep) => {
      if (!this.renaming) return;
      this.renaming = false;
      this.shown = ''; // force a rebuild
      if (keep && shape) this.shapes?.renameShape(index, shape[1], input.value);
      else if (keep) this.editor.renameObject(index, input.value);
      this.update();
    };
    input.addEventListener('keydown', (event) => {
      if (event.code === 'Enter' || event.code === 'NumpadEnter') finish(true);
      if (event.code === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  // --- adding objects ----------------------------------------------------

  // The menu of things to add: under the header's +, or - `into` a node's
  // id - beside that node's + (`at`), for what is made to go in it.
  openAddMenu(into = null, at = null) {
    const { menu, addButton } = this;
    this.closeForm();
    const again = !menu.hidden && this.into === into;
    menu.hidden = again;
    this.into = again ? null : into;
    addButton.classList.toggle('active', !menu.hidden && into === null);
    if (menu.hidden) return;
    if (at) {
      const place = at.getBoundingClientRect();
      const section = menu.offsetParent.getBoundingClientRect();
      menu.style.top = `${place.bottom - section.top + 4}px`;
    } else {
      menu.style.top = '';
    }
  }

  bindAdding(section) {
    const { menu, form, addButton } = this;
    this.into = null; // the node what is made goes in (its id), or none
    const closeMenu = () => {
      menu.hidden = true;
      addButton.classList.remove('active');
    };
    addButton.addEventListener('click', () => this.openAddMenu(null));
    for (const item of menu.querySelectorAll('[data-primitive]')) {
      item.addEventListener('click', () => {
        closeMenu();
        const kind = item.dataset.primitive;
        if (PRIMITIVES[kind].fields.length) this.openForm(kind);
        else this.editor.addPrimitive(kind, {}, null, this.into);
      });
    }
    menu.querySelector('[data-node]').addEventListener('click', () => {
      closeMenu();
      this.editor.addNode(this.into);
    });
    // Buttons must not take the keyboard focus; the form's fields may.
    section.querySelector('.outliner-header').addEventListener('mousedown', (event) => event.preventDefault());
    menu.addEventListener('mousedown', (event) => event.preventDefault());
    // A press anywhere else closes the menu.
    window.addEventListener('pointerdown', (event) => {
      if (!menu.contains(event.target) && !addButton.contains(event.target) && !event.target.closest?.('[data-add-into]')) closeMenu();
    }, true);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const options = this.formOptions();
      const side = this.attachSide();
      const into = this.into;
      this.closeForm();
      this.editor.addPrimitive(form.dataset.kind, options, side, into);
    });
    // Put up against the selection, or not; and on which side. Off at every
    // launch (it is not always wanted); what was chosen stays while the program runs.
    this.attach = false;
    this.side = 'auto';
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
        if (event.code === 'Space') return; // Space + RMB pans the view: the camera is free (see below)
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
    // And so does the pointer - all but the camera's: over the main view RMB
    // turns it, MMB (and Space + RMB) moves it, and the wheel brings it
    // nearer, so that the preview can be looked at from every side. Every
    // other press - picking, editing, the gizmo, painting, the panels, the
    // UV editor - is stopped before anything else hears of it.
    const view = this.editor.viewport.renderer.domElement;
    const guard = (event) => {
      if (form.hidden || form.contains(event.target)) return;
      const camera = event.target === view &&
        (event.type === 'wheel' || event.type === 'contextmenu' ||
          (event.type === 'pointerdown' || event.type === 'mousedown' || event.type === 'pointerup' || event.type === 'mouseup') && event.button !== 0);
      if (camera) return;
      event.stopImmediatePropagation();
      event.preventDefault();
    };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'wheel', 'contextmenu']) {
      window.addEventListener(type, guard, { capture: true, passive: false });
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

  // The side the new object is to be put up against the selection on, as
  // primitiveAnchor() takes it; null if it is not to be.
  attachSide() {
    if (!this.attach || this.editor.selection.size === 0) return null;
    const side = SIDES.find((each) => each.id === this.side);
    return side.axis ? { axis: side.axis, sign: side.sign } : 'auto';
  }

  showPreview() {
    this.editor.previewPrimitive(this.form.dataset.kind, this.formOptions(), this.attachSide(), this.into);
  }

  // The form's part that says where the object goes: a box - up against the
  // selected object, or not - and, only while it is ticked, a row of the
  // sides it may go on, which slides open and shut with it.
  attachRow() {
    const selected = this.editor.selection.size > 0;
    const block = document.createElement('div');
    block.className = 'attach';
    const label = document.createElement('label');
    label.className = 'choice';
    label.title = selected ? t('outliner.attach.title') : t('outliner.attach.none.title');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.attach && selected;
    box.disabled = !selected;
    const caption = document.createElement('span');
    caption.textContent = t('outliner.attach.caption');
    label.append(box, caption);
    const sides = document.createElement('div');
    sides.className = 'sides';
    // (In a body that slides, as the folding panels' do: see the styles.)
    const slide = document.createElement('div');
    slide.className = 'sides-slide';
    const inner = document.createElement('div');
    inner.append(sides);
    slide.append(inner);
    const open = () => {
      block.classList.toggle('open', box.checked);
      inner.inert = !box.checked; // out of reach of the keyboard while shut
    };
    const show = () => {
      for (const button of sides.children) button.classList.toggle('active', button.dataset.side === this.side);
      open();
      this.showPreview();
    };
    for (const side of SIDES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.side = side.id;
      button.textContent = side.label;
      if (side.axis) button.classList.add(`axis-${side.axis}`);
      button.title = side.title ?? t('outliner.side.title', { side: side.label });
      button.addEventListener('mousedown', (event) => event.preventDefault()); // the keyboard stays where it is
      button.addEventListener('click', () => {
        this.side = side.id;
        show();
      });
      sides.append(button);
    }
    box.addEventListener('change', () => {
      this.attach = box.checked;
      show();
    });
    block.append(label, slide);
    for (const button of sides.children) button.classList.toggle('active', button.dataset.side === this.side);
    open();
    return block;
  }

  // Shows the parameters of a primitive; submitting the form makes the object.
  openForm(kind) {
    const { form } = this;
    const { title, fields } = PRIMITIVES[kind];
    form.dataset.kind = kind;
    // (made in a node: its name says so)
    const node = this.into === null ? null : this.editor.mesh.objects.find((object) => object.id === this.into);
    form.querySelector('h3').textContent = node ? t('outliner.form.into', { title, node: node.name }) : title;
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
        input.title = t('outliner.field.range.title', { min: field.min, max: field.max });
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
      this.attachRow(),
    );
    form.hidden = false;
    this.showPreview();
    const first = form.querySelector('input');
    first.focus();
    first.select();
  }

  closeForm() {
    if (this.form.hidden) return;
    this.form.hidden = true;
    this.into = null;
    this.editor.previewPrimitive(null);
    document.activeElement?.blur(); // give the keyboard back to the editor shortcuts
  }
}
