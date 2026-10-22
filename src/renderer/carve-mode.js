import * as THREE from 'three';
import { newCarve, restack, buildCarve, sectionOf, levelAt, STACKS, ACROSS, ALONG } from './carve.js';
import { scrubbable } from './scrub.js';
import { theme, onThemeChange, axisColor } from './theme.js';
import { t } from './i18n.js';

// Carving (the editor's operation 'carve'): a shape cut out of a box by three
// stacks of slices, see carve.js. The box is the object picked when it
// begins, if it is one - a cube, its sides along the axes - or a cube made
// for it. While it goes on the box is out of sight, and in its place is the
// shape as the slices make it now, built again at every change; around it,
// the box's frame. Dispatches 'toggle' as it begins and ends.
//
// The slices are drawn in the three views (see ortho-views.js, which hands
// them over while carving goes on): seen from above the levels by height,
// from the front those by depth, from the side those by width - one level of
// each at a time, its neighbours faintly behind it. A level holds one shape.
//   click        - a point of a new shape, on the fine grid (Ctrl: the coarse
//                  one - both are drawn); a click on its first point, or Enter,
//                  closes it - in place of the level's shape. Backspace takes
//                  the last point back, Esc the shape.
//   drag a point - moves a corner of the shape
//   click inside - picks the shape; Delete takes it away (the level whole again)
//   Alt+wheel, PgUp / PgDn, the arrows in a view's title - another slice
// The mirror (the popup's ↔ and ↕, either or both): a half - or a quarter -
// is drawn, and closed it is made whole by its reflection across the box's
// middle; a point dragged takes its reflections along.
// Changes are undone by Ctrl+Z here, one by one; they are the editor's undo
// step only when the shape is applied (see the end).
//
// `popup` (a form by `button`, shown while it goes on) holds the stacks'
// level counts (its fields y, z and x) and what is done to the level last
// worked on (data-slice).

const COUNT_MAX = 64;
const DEFAULT_COUNT = 4;
const PICK_RADIUS = 7; // px: a shape's point under the pointer
const AXIS_NAMES = ['x', 'y', 'z'];
const MIN_FINE_SPACING = 6; // px; a finer grid is not drawn
// The stack each view draws, by the plane it shows.
const STACK_OF_VIEW = { xz: 'y', xy: 'z', yz: 'x' };

export class CarveMode extends EventTarget {
  constructor(popup, button, viewport, editor) {
    super();
    this.popup = popup;
    this.button = button;
    this.viewport = viewport;
    this.editor = editor;
    this.views = null; // the three views (ortho-views.js), set once they are made
    this.on = false;
    this.carve = null; // see carve.js
    this.frame = null; // the box's object: its id
    this.shape = null; // the shape last built: { vertices, faces }, or null for nothing
    this.building = 0; // the number of the last build asked for: an older one coming back late is let go
    this.reset();

    // What is shown in the box's place: the shape as a wireframe (its
    // surface only a shade, to be seen through), the frame, and the slices
    // drawn on, as plates where they are (see showPlates()).
    this.group = new THREE.Group();
    this.group.visible = false;
    this.surface = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshLambertMaterial({ flatShading: true, side: THREE.DoubleSide, transparent: true, opacity: 0.12, depthWrite: false }),
    );
    this.edges = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial());
    this.box = new THREE.Box3Helper(new THREE.Box3());
    this.plates = new THREE.Group();
    // Where the shape's edges lie on the frame's (a slice left whole), the
    // two lines are one: the frame drawn first, writing no depth, the edges
    // over it - not either one by turns as the view turns.
    this.box.material.depthWrite = false;
    this.box.renderOrder = 0;
    this.edges.renderOrder = 3;
    this.group.add(this.plates, this.surface, this.edges, this.box);
    viewport.scene.add(this.group);
    const colour = () => {
      this.surface.material.color.set(theme.surface);
      this.edges.material.color.set(theme.wire);
      this.box.material.color.set(theme.textDim);
      this.showPlates();
      viewport.requestRender();
    };
    onThemeChange(colour);
    colour();

    this.counts = {};
    popup.addEventListener('submit', (event) => event.preventDefault());
    for (const name of STACKS) {
      const input = popup.elements[name];
      this.counts[name] = input;
      scrubbable(input, {
        read: () => this.carve?.stacks[name].count ?? DEFAULT_COUNT,
        write: (value) => this.setCount(name, value),
        whole: true,
        min: 1,
        max: COUNT_MAX,
      });
      input.addEventListener('change', () => this.setCount(name, parseInt(input.value, 10)));
    }
    for (const button of popup.querySelectorAll('[data-carve-mirror]')) {
      button.addEventListener('click', () => {
        const axis = button.dataset.carveMirror;
        this.mirror[axis] = !this.mirror[axis];
        button.classList.toggle('active', this.mirror[axis]);
        this.redraw();
      });
    }
    popup.querySelector('[data-carve="apply"]').addEventListener('click', () => this.apply());
    popup.querySelector('[data-carve="cancel"]').addEventListener('click', () => this.cancel());
    for (const action of popup.querySelectorAll('[data-slice]')) {
      action.addEventListener('click', () => this.sliceAction(action.dataset.slice));
    }
    popup.addEventListener('mousedown', (event) => {
      if (event.target.closest('button')) event.preventDefault(); // (the keyboard stays where it was)
    });

    this.entering = false; // (making the box changes the editor too: not a beginning again)
    this.made = null; // with a cube made to carve: the length of the undo history after its making
    this.mirror = { u: false, v: false }; // across the box's middle: left to right (u), top to bottom (v)
    this.applying = false;
    editor.addEventListener('change', () => {
      if (this.entering || (editor.operation === 'carve') === this.on) return;
      if (this.on) this.leave();
      else this.enter();
    });
  }

  // What is worked on, back to nothing.
  reset() {
    this.layer = { y: 0, z: 0, x: 0 }; // the slice shown, in each stack
    this.active = 'y'; // the stack last worked in (the popup's slice actions are for it)
    this.drawing = null; // a shape being drawn: { stack, points: [[u, v]], cursor }
    this.picked = null; // a shape picked: { stack, index } on its stack's slice shown
    this.drag = null; // a point being moved: { stack, shape, point, moved }
    this.hover = null; // a point under the pointer: { stack, shape, point }
    this.coarse = false; // Ctrl held: the points go on the coarse grid
    this.past = []; // the stacks as they were, for undo
    this.future = []; // and as they were undone, for redo
  }

  // --- in and out -----------------------------------------------------------------

  enter() {
    const { editor } = this;
    this.entering = true;
    const box = this.pickedBox() ?? this.newBox();
    this.entering = false;
    if (!box) {
      editor.setOperation(null); // (nothing to carve: the editor was busy)
      return;
    }
    this.on = true;
    this.frame = box.id;
    this.carve = newCarve(box, this.gridCounts(box));
    this.reset();
    this.box.box.set(new THREE.Vector3(...box.min), new THREE.Vector3(...box.max));
    // Out of sight: the box - the shape is shown in its place - and every
    // other object, not to be in the way (their nodes stay: a node hidden
    // would hide the box in it too).
    editor.setVeiled(editor.mesh.objects.filter((object) => object.kind !== 'node').map((object) => object.id));
    this.group.visible = true;
    this.showCounts();
    this.showPopup();
    this.addLayerControls();
    this.rebuild();
    this.dispatchEvent(new Event('toggle'));
    this.views?.frame();
  }

  leave() {
    this.on = false;
    this.group.visible = false;
    this.popup.hidden = true;
    this.removeLayerControls();
    this.editor.setVeiled(null);
    // A cube made for carving, not applied: gone again - its making undone,
    // and not to be redone. (Only while it is still the last step taken.)
    const { history } = this.editor;
    if (this.made !== null && !this.applying && history.undoStack.length === this.made) {
      this.editor.undo();
      history.redoStack.length = 0;
    }
    this.made = null;
    this.applying = false;
    this.carve = null;
    this.frame = null;
    this.shape = null;
    this.reset();
    this.viewport.requestRender();
    this.dispatchEvent(new Event('toggle'));
    this.views?.frame();
  }

  // Under the button, or over it where there is no room below; within the window.
  showPopup() {
    const { popup } = this;
    popup.hidden = false;
    const at = this.button.getBoundingClientRect();
    const { width, height } = popup.getBoundingClientRect();
    const below = at.bottom + 6 + height <= window.innerHeight;
    popup.style.top = `${below ? at.bottom + 6 : at.top - 6 - height}px`;
    popup.style.left = `${Math.max(6, Math.min(at.left, window.innerWidth - width - 6))}px`;
  }

  // How many levels a stack of the box has at first: as many as put them on
  // the coarse grid's lines, the box's sides included (a unit cube on a 0.25
  // grid: five, a quarter apart) - between two and COUNT_MAX.
  gridCounts(box) {
    const step = this.editor.snapGrid.step;
    const counts = {};
    for (const name of STACKS) {
      const w = ALONG[name];
      const cells = Math.round((box.max[w] - box.min[w]) / step);
      counts[name] = Math.max(2, Math.min(COUNT_MAX, cells + 1));
    }
    return counts;
  }

  // The object picked, if it is a box with its sides along the axes: { id,
  // min, max }; null if it is not (or there is none, or more than one).
  pickedBox() {
    const hand = this.editor.objectsInHand();
    return hand.length === 1 ? this.boxOf(hand[0]) : null;
  }

  // The object `index`, if it is a box with its sides along the axes: { id,
  // min, max }; null if it is not.
  boxOf(index) {
    const { editor } = this;
    const island = editor.topology.islands[index];
    if (!island) return null;
    if (island.vertices.length !== 8 || island.faces.length !== 6) return null;
    const points = island.vertices.map((i) => editor.mesh.vertices[i]);
    const min = [0, 1, 2].map((k) => Math.min(...points.map((p) => p.getComponent(k))));
    const max = [0, 1, 2].map((k) => Math.max(...points.map((p) => p.getComponent(k))));
    const corner = (p) => [0, 1, 2].every((k) => Math.abs(p.getComponent(k) - min[k]) < 1e-6 || Math.abs(p.getComponent(k) - max[k]) < 1e-6);
    if (!points.every(corner) || new Set(points.map((p) => p.toArray().join())).size !== 8) return null;
    if ([0, 1, 2].some((k) => max[k] - min[k] < 1e-6)) return null;
    return { id: editor.mesh.objects[index].id, min, max };
  }

  // A cube made to carve, where a new object would go (see Editor.addPrimitive()).
  // It is taken away again if carving is left without applying (see leave()).
  newBox() {
    const { editor } = this;
    const count = editor.mesh.objects.length;
    editor.addPrimitive('cube', { size: 1 });
    if (editor.mesh.objects.length === count) return null;
    this.made = editor.history.undoStack.length; // (the undo step that made it: still the last one when it is taken away)
    return this.boxOf(count);
  }

  // --- the stacks -------------------------------------------------------------------

  setCount(name, value) {
    if (!this.carve || !(value >= 1)) return;
    const count = Math.min(COUNT_MAX, Math.round(value));
    if (count !== this.carve.stacks[name].count) {
      this.remember();
      this.carve.stacks[name] = restack(this.carve.stacks[name], count);
      this.layer[name] = Math.min(this.layer[name], count - 1);
      this.changed();
    }
    this.showCounts();
  }

  showCounts() {
    for (const name of STACKS) this.counts[name].value = this.carve?.stacks[name].count ?? DEFAULT_COUNT;
  }

  // The slice shown in a stack: its shapes, or null (whole) or [] (empty).
  sliceOf(stack) {
    return this.carve.stacks[stack].slices[this.layer[stack]];
  }

  setSlice(stack, slice) {
    this.carve.stacks[stack].slices[this.layer[stack]] = slice;
  }

  // Another slice shown in a stack: `step` on from this one.
  stepLayer(stack, step) {
    if (!this.on) return;
    const count = this.carve.stacks[stack].count;
    const layer = Math.max(0, Math.min(count - 1, this.layer[stack] + step));
    if (layer === this.layer[stack]) return;
    if (this.drawing?.stack === stack) this.drawing = null;
    this.layer[stack] = layer;
    this.picked = null;
    this.active = stack;
    this.redraw();
  }

  // The shape picked in a stack - or, with none, its level shown as it is -
  // copied onto the level `step` on, in place of what is there; that level
  // is then shown, the copy picked: pressed again, it goes on through the
  // levels.
  duplicate(stack, step) {
    if (!this.on) return;
    const { slices, count } = this.carve.stacks[stack];
    const from = this.layer[stack];
    const to = from + step;
    if (to < 0 || to >= count) return;
    const picked = this.picked?.stack === stack ? slices[from]?.[this.picked.index] : null;
    this.remember();
    if (picked) {
      slices[to] = [structuredClone(picked)];
      this.picked = { stack, index: 0 };
    } else {
      slices[to] = structuredClone(slices[from]);
      this.picked = null;
    }
    if (this.drawing?.stack === stack) this.drawing = null;
    this.layer[stack] = to;
    this.active = stack;
    this.changed();
  }

  // The shape put in the box's place, and carving done: the box object takes
  // it (see Editor.reshapeObject() - one undo step). Nothing if nothing of
  // the box is left.
  async apply() {
    if (!this.on) return false;
    this.drawing = null;
    const number = ++this.building;
    const shape = await buildCarve(this.carve); // (as the slices are now, not as last shown)
    if (number !== this.building || !this.on || !shape) return false;
    const { frame } = this;
    this.applying = true; // (the cube stays, made for it or not: it takes the shape)
    this.editor.setOperation(null); // (the objects shown again first: the shape is the box's, not out of sight)
    return this.editor.reshapeObject(frame, shape);
  }

  // Carving left, the slices thrown away; the box as it was.
  cancel() {
    if (this.on) this.editor.setOperation(null);
  }

  // The popup's actions on the slice shown in the stack last worked in.
  sliceAction(action) {
    if (!this.on) return;
    const stack = this.active;
    const { slices } = this.carve.stacks[stack];
    const index = this.layer[stack];
    this.remember();
    if (action === 'whole') slices[index] = null;
    else if (action === 'empty') slices[index] = [];
    else if (action === 'next' && index + 1 < slices.length) slices[index + 1] = structuredClone(slices[index]);
    else if (action === 'previous' && index > 0) slices[index - 1] = structuredClone(slices[index]);
    else if (action === 'all') slices.forEach((_, i) => { slices[i] = structuredClone(slices[index]); });
    else {
      this.past.pop();
      return;
    }
    this.picked = null;
    this.changed();
  }

  // --- undo ----------------------------------------------------------------------------

  // The stacks as they are, kept before a change.
  remember() {
    this.past.push(structuredClone(this.carve.stacks));
    this.future = [];
  }

  undo() {
    if (!this.on) return false;
    if (this.drawing) {
      this.drawing = null;
      this.redraw();
      return true;
    }
    if (!this.past.length) return true;
    this.future.push(structuredClone(this.carve.stacks));
    this.carve.stacks = this.past.pop();
    this.afterHistory();
    return true;
  }

  redo() {
    if (!this.on) return false;
    if (!this.future.length) return true;
    this.past.push(structuredClone(this.carve.stacks));
    this.carve.stacks = this.future.pop();
    this.afterHistory();
    return true;
  }

  afterHistory() {
    for (const name of STACKS) this.layer[name] = Math.min(this.layer[name], this.carve.stacks[name].count - 1);
    this.picked = null;
    this.showCounts();
    this.changed();
  }

  // --- keys ----------------------------------------------------------------------------

  // Enter: the shape being drawn closed. Whether there was one.
  close() {
    if (!this.drawing) return false;
    this.finishDrawing();
    return true;
  }

  // Backspace: its last point back. Whether there was one.
  undoPoint() {
    if (!this.drawing) return false;
    this.drawing.points.pop();
    if (!this.drawing.points.length) this.drawing = null;
    this.redraw();
    return true;
  }

  // Esc: the shape being drawn let go, or the shape picked. Whether there was one.
  escape() {
    if (this.drawing) {
      this.drawing = null;
    } else if (this.picked) {
      this.picked = null;
    } else {
      return false;
    }
    this.redraw();
    return true;
  }

  // The right button in a view: the shape being drawn there let go. Whether there was one.
  cancelDrawing(view) {
    if (!this.on || this.drawing?.stack !== STACK_OF_VIEW[view.axes]) return false;
    this.drawing = null;
    this.redraw();
    return true;
  }

  // Delete: the shape picked taken away. Whether there was one.
  deletePicked() {
    if (!this.picked) return false;
    const { stack, index } = this.picked;
    const slice = this.sliceOf(stack);
    if (!slice?.[index]) return false;
    this.remember();
    this.setSlice(stack, null); // (its one shape gone: the level whole, as a new one)
    this.picked = null;
    this.changed();
    return true;
  }

  // PgUp / PgDn: another slice in the stack last worked in.
  stepActive(step) {
    if (!this.on) return false;
    this.stepLayer(this.active, step);
    return true;
  }

  // --- the views: the pointer ------------------------------------------------------------

  // The grid's steps: the coarse one (the snapping's, see snap-grid.js) and
  // the fine one, a part of it.
  steps() {
    const grid = this.editor.snapGrid;
    return { coarse: grid.step, fine: grid.step / grid.fineDivisor };
  }

  // A view pixel as a point of the stack's plane, [u, v]: on the fine grid
  // (Ctrl: the coarse one; none with snapping off), inside the box.
  pointAt(view, x, y, snap = true) {
    const stack = STACK_OF_VIEW[view.axes];
    const world = this.views.unproject(view, x, y);
    const { coarse, fine } = this.steps();
    const step = this.editor.snapGrid.enabled ? (this.coarse ? coarse : fine) : 0;
    return ACROSS[stack].map((axis) => {
      let value = world[AXIS_NAMES[axis]];
      if (snap && step) value = Math.round(value / step) * step;
      const { min, max } = this.carve.box;
      return +Math.min(max[axis], Math.max(min[axis], value)).toFixed(6);
    });
  }

  // A point of a stack's plane as a view pixel.
  pixelOf(view, [u, v]) {
    const stack = STACK_OF_VIEW[view.axes];
    const world = view.center.clone();
    const [a, b] = ACROSS[stack];
    world[AXIS_NAMES[a]] = u;
    world[AXIS_NAMES[b]] = v;
    return this.views.project(view, world);
  }

  // The shapes' point under a view pixel, on the slice shown: { shape, point } or null.
  pointUnder(view, x, y) {
    const stack = STACK_OF_VIEW[view.axes];
    const slice = this.sliceOf(stack);
    if (!slice) return null;
    let best = null;
    slice.forEach((shape, s) => shape.points.forEach((point, p) => {
      const at = this.pixelOf(view, point);
      const distance = Math.hypot(at.x - x, at.y - y);
      if (distance <= PICK_RADIUS && (!best || distance < best.distance)) best = { shape: s, point: p, distance };
    }));
    return best && { stack, shape: best.shape, point: best.point };
  }

  // The shape a view pixel is inside, on the slice shown (the last drawn, of several): its index or null.
  shapeUnder(view, x, y) {
    const stack = STACK_OF_VIEW[view.axes];
    const slice = this.sliceOf(stack);
    if (!slice) return null;
    const [u, v] = this.pointAt(view, x, y, false);
    for (let s = slice.length - 1; s >= 0; s--) if (inside(slice[s].points, u, v)) return s;
    return null;
  }

  press(view, event) {
    const stack = STACK_OF_VIEW[view.axes];
    const { x, y } = this.views.localPoint(view, event.clientX, event.clientY);
    this.coarse = event.ctrlKey;
    this.active = stack;
    if (this.drawing && this.drawing.stack !== stack) this.drawing = null;
    if (this.drawing) {
      const first = this.pixelOf(view, this.drawing.points[0]);
      const enough = this.mirror.u || this.mirror.v ? 2 : 3; // (a half of two points is a whole of four)
      if (this.drawing.points.length >= enough && Math.hypot(first.x - x, first.y - y) <= PICK_RADIUS) this.finishDrawing();
      else this.addPoint(this.pointAt(view, x, y));
      this.redraw();
      return;
    }
    const under = this.pointUnder(view, x, y);
    if (under) {
      this.remember();
      this.drag = { ...under, moved: false, twins: this.twinsOf(under) };
      this.picked = { stack, index: under.shape };
      this.redraw();
      return;
    }
    const shape = this.shapeUnder(view, x, y);
    if (shape !== null) {
      this.picked = { stack, index: shape };
      this.redraw();
      return;
    }
    this.picked = null;
    this.drawing = { stack, points: [this.pointAt(view, x, y)], cursor: null };
    this.redraw();
  }

  move(view, event) {
    const { x, y } = this.views.localPoint(view, event.clientX, event.clientY);
    this.coarse = event.ctrlKey;
    if (this.drag) {
      if (!(event.buttons & 1)) {
        this.release();
        return;
      }
      const shape = this.carve.stacks[this.drag.stack].slices[this.layer[this.drag.stack]][this.drag.shape];
      const point = this.pointAt(view, x, y);
      // A point on a mirror's line stays on it.
      const [mu, mv] = this.middleOf(this.drag.stack);
      if (this.drag.twins.onU) point[0] = mu;
      if (this.drag.twins.onV) point[1] = mv;
      const was = shape.points[this.drag.point];
      if (was[0] !== point[0] || was[1] !== point[1]) {
        shape.points[this.drag.point] = point;
        for (const { index, u, v } of this.drag.twins.list) {
          shape.points[index] = [u ? 2 * mu - point[0] : point[0], v ? 2 * mv - point[1] : point[1]].map((value) => +value.toFixed(6));
        }
        this.drag.moved = true;
        this.changed();
      }
      return;
    }
    if (this.drawing?.stack === STACK_OF_VIEW[view.axes]) {
      this.drawing.cursor = this.pointAt(view, x, y);
    }
    const hover = this.drawing ? null : this.pointUnder(view, x, y);
    view.canvas.style.cursor = hover ? 'grab' : 'crosshair';
    this.hover = hover;
    this.redraw();
  }

  release() {
    if (!this.drag) return;
    if (!this.drag.moved) this.past.pop(); // (a click on a point: nothing changed)
    this.drag = null;
    this.redraw();
  }

  addPoint(point) {
    const { points } = this.drawing;
    const last = points[points.length - 1];
    if (last && last[0] === point[0] && last[1] === point[1]) return;
    points.push(point);
  }

  // The mirror's lines in a stack's plane: the box's middle, as [u, v].
  middleOf(stack) {
    const [a, b] = ACROSS[stack];
    const { min, max } = this.carve.box;
    return [(min[a] + max[a]) / 2, (min[b] + max[b]) / 2];
  }

  // A half (or with both mirrors a quarter) made whole: its points, then
  // their reflection across the middle in turn backwards - those on the
  // mirror's line once.
  mirrored(stack, points) {
    const [mu, mv] = this.middleOf(stack);
    const same = (p, q) => Math.abs(p[0] - q[0]) < 1e-9 && Math.abs(p[1] - q[1]) < 1e-9;
    const join = (half, reflect) => {
      const out = [...half];
      for (const p of [...half].reverse().map(reflect)) if (!out.some((q) => same(p, q))) out.push(p);
      return out;
    };
    const acrossU = ([u, v]) => [+(2 * mu - u).toFixed(6), v];
    const acrossV = ([u, v]) => [u, +(2 * mv - v).toFixed(6)];
    // The halves meet where the drawing ends: with both mirrors, the one
    // whose line it ends on first (a quarter drawn from one line to the other).
    const last = points[points.length - 1];
    const vFirst = this.mirror.u && this.mirror.v && Math.abs(last[1] - mv) < 1e-9 && Math.abs(last[0] - mu) >= 1e-9;
    let whole = points;
    for (const axis of vFirst ? ['v', 'u'] : ['u', 'v']) {
      if (this.mirror[axis]) whole = join(whole, axis === 'u' ? acrossU : acrossV);
    }
    return whole;
  }

  // A point's reflections in its shape, to be dragged along (the mirrors on
  // as the drag begins): { list: [{ index, u, v }], onU, onV } - and whether
  // the point is on a mirror's line, to stay there.
  twinsOf({ stack, shape, point }) {
    const points = this.carve.stacks[stack].slices[this.layer[stack]][shape].points;
    const [mu, mv] = this.middleOf(stack);
    const [pu, pv] = points[point];
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    const onU = this.mirror.u && near(pu, mu);
    const onV = this.mirror.v && near(pv, mv);
    const list = [];
    for (const [u, v] of [[true, false], [false, true], [true, true]]) {
      if ((u && !this.mirror.u) || (v && !this.mirror.v) || (u && onU) || (v && onV)) continue;
      const want = [u ? 2 * mu - pu : pu, v ? 2 * mv - pv : pv];
      const index = points.findIndex((q, k) => k !== point && near(q[0], want[0]) && near(q[1], want[1]));
      if (index >= 0 && !list.some((twin) => twin.index === index)) list.push({ index, u, v });
    }
    return { list, onU, onV };
  }

  // The shape drawn put on its level, in place of the one there (made whole by the mirror, if it is on).
  finishDrawing() {
    const { stack } = this.drawing;
    const points = this.mirrored(stack, this.drawing.points);
    this.drawing = null;
    if (points.length < 3 || Math.abs(area(points)) < 1e-9) {
      this.redraw();
      return;
    }
    this.remember();
    this.setSlice(stack, [{ points }]);
    this.picked = null;
    this.changed();
  }

  // --- showing -----------------------------------------------------------------------------

  // The slices changed: the shape built again, the views drawn.
  changed() {
    this.rebuild();
    this.redraw();
  }

  redraw() {
    this.updateLayerControls();
    this.showPlates();
    this.views?.draw();
  }

  // The levels drawn on, in the main view: each a plate where it is - its
  // shape filled faintly in its stack's axis' colour, outlined; the level
  // shown in each stack brighter. (Whole and empty levels are not shown:
  // nothing is drawn on them.)
  showPlates() {
    for (const child of [...this.plates.children]) {
      child.geometry.dispose();
      child.material.dispose();
      this.plates.remove(child);
    }
    if (!this.on || !this.carve) return;
    const { box } = this.carve;
    for (const stack of STACKS) {
      const { count, slices } = this.carve.stacks[stack];
      const [a, b] = ACROSS[stack];
      const w = ALONG[stack];
      const colour = axisColor(stack);
      slices.forEach((slice, i) => {
        if (!slice?.length) return;
        const shown = i === this.layer[stack];
        const level = levelAt(box, stack, count, i);
        const world = ([u, v]) => {
          const p = new THREE.Vector3();
          p.setComponent(a, u);
          p.setComponent(b, v);
          p.setComponent(w, level);
          return p;
        };
        for (const shape of slice) {
          if (shape.points.length < 3) continue;
          const points = shape.points.map(world);
          const positions = [];
          for (const [p, q, r] of triangles(points)) positions.push(...p.toArray(), ...q.toArray(), ...r.toArray());
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
          const fill = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
            color: colour, transparent: true, opacity: shown ? 0.35 : 0.15, side: THREE.DoubleSide, depthWrite: false,
          }));
          fill.renderOrder = 1;
          this.plates.add(fill);
          const outline = new THREE.LineLoop(
            new THREE.BufferGeometry().setFromPoints(points),
            new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: shown ? 1 : 0.55 }),
          );
          outline.renderOrder = 2;
          this.plates.add(outline);
        }
      });
    }
    this.viewport.requestRender();
  }

  // The shape built again from the slices as they are, and shown.
  async rebuild() {
    const number = ++this.building;
    const shape = await buildCarve(this.carve);
    if (number !== this.building || !this.on) return;
    this.shape = shape;
    this.show();
  }

  show() {
    this.popup.querySelector('[data-carve="apply"]').disabled = !this.shape;
    const positions = [];
    const lines = [];
    for (const face of this.shape?.faces ?? []) {
      const points = face.map((i) => new THREE.Vector3(...this.shape.vertices[i]));
      for (const [a, b, c] of triangles(points)) positions.push(...a.toArray(), ...b.toArray(), ...c.toArray());
      points.forEach((p, k) => lines.push(...p.toArray(), ...points[(k + 1) % points.length].toArray()));
    }
    const set = (mesh, values) => {
      mesh.geometry.dispose();
      mesh.geometry = new THREE.BufferGeometry();
      mesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute(values, 3));
    };
    set(this.surface, positions);
    this.surface.geometry.computeVertexNormals();
    set(this.edges, lines);
    this.viewport.requestRender();
  }

  // The stack a view draws.
  stackOf(view) {
    return STACK_OF_VIEW[view.axes];
  }

  // The box, in a view: for its fit (see OrthoViews.fit()).
  bounds() {
    return this.box.box;
  }

  // A view's picture while carving: the box, the other stacks' slices as
  // lines across it, the neighbouring slices faintly, the slice shown with
  // its shapes, and the shape being drawn.
  drawView(view) {
    const { context } = view;
    const stack = STACK_OF_VIEW[view.axes];
    const { box } = this.carve;
    const corners = sectionOf(box, stack).map((point) => this.pixelOf(view, point));
    const path = (points, closed = true) => {
      context.beginPath();
      points.forEach((p, i) => (i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y)));
      if (closed) context.closePath();
    };
    const shapesPath = (slice) => {
      context.beginPath();
      for (const shape of slice) {
        shape.points.forEach((point, i) => {
          const p = this.pixelOf(view, point);
          if (i) context.lineTo(p.x, p.y);
          else context.moveTo(p.x, p.y);
        });
        context.closePath();
      }
    };
    context.save();
    this.drawGrids(view);

    // What is drawn in the other stacks, as it is seen from here: each of
    // their levels a line where it is, as long as its shape goes along the
    // axis the two views share, in its stack's axis' colour. (Whole levels
    // are not drawn on yet: they are left out.)
    for (const other of STACKS) {
      if (other === stack) continue;
      const k = ACROSS[stack].indexOf(ALONG[other]); // this view's axis the other stack is cut along
      const shared = ACROSS[stack][1 - k];
      const j = ACROSS[other].indexOf(shared); // the same axis in the other stack's plane
      const { count, slices } = this.carve.stacks[other];
      context.strokeStyle = axisColor(other);
      context.lineWidth = 3;
      context.globalAlpha = 0.6;
      slices.forEach((slice, i) => {
        if (!slice) return;
        const level = levelAt(box, other, count, i);
        for (const shape of slice) {
          if (shape.points.length < 3) continue;
          const along = shape.points.map((point) => point[j]);
          const corner = (a, b) => (k === 0 ? [b, a] : [a, b]); // (shared, level) as this view's (u, v)
          path([corner(Math.min(...along), level), corner(Math.max(...along), level)].map((point) => this.pixelOf(view, point)), false);
          context.stroke();
        }
      });
      context.lineWidth = 1;
    }

    // The neighbouring slices: their outlines, dashed.
    context.globalAlpha = 0.35;
    context.strokeStyle = theme.textDim;
    for (const [step, dash] of [[-1, [4, 4]], [1, [1, 3]]]) {
      const neighbour = this.carve.stacks[stack].slices[this.layer[stack] + step];
      if (!neighbour?.length) continue;
      context.setLineDash(dash);
      shapesPath(neighbour);
      context.stroke();
    }
    context.setLineDash([]);

    // The level shown: what of it is there, filled, and its outline.
    const slice = this.sliceOf(stack);
    const accent = theme.accent;
    context.globalAlpha = 0.22;
    context.fillStyle = accent;
    if (slice === null) {
      path(corners);
      context.fill();
    } else if (slice.length) {
      shapesPath(slice);
      context.fill('nonzero');
    }
    // The box.
    context.globalAlpha = 0.8;
    context.strokeStyle = theme.textDim;
    context.setLineDash(slice?.length === 0 ? [6, 4] : []);
    path(corners);
    context.stroke();
    context.setLineDash([]);
    // The shapes' outlines and points; the picked one brighter.
    for (const [s, shape] of (slice ?? []).entries()) {
      const picked = this.picked?.stack === stack && this.picked.index === s;
      context.globalAlpha = 1;
      context.lineWidth = picked ? 2 : 1.25;
      context.strokeStyle = accent;
      path(shape.points.map((point) => this.pixelOf(view, point)));
      context.stroke();
      shape.points.forEach((point, p) => {
        const at = this.pixelOf(view, point);
        const hovered = this.hover?.stack === stack && this.hover.shape === s && this.hover.point === p;
        context.fillStyle = hovered || this.drag?.point === p && this.drag.shape === s ? theme.hovered : accent;
        context.fillRect(at.x - 3, at.y - 3, 6, 6);
      });
    }

    // The mirror's lines: dashed, in the accent, across the box.
    if (this.mirror.u || this.mirror.v) {
      const [mu, mv] = this.middleOf(stack);
      const [a, b] = sectionOf(box, stack).filter((_, c) => c === 0 || c === 2);
      context.globalAlpha = 0.7;
      context.strokeStyle = theme.accent;
      context.lineWidth = 1;
      context.setLineDash([6, 4]);
      if (this.mirror.u) {
        path([[mu, a[1]], [mu, b[1]]].map((point) => this.pixelOf(view, point)), false);
        context.stroke();
      }
      if (this.mirror.v) {
        path([[a[0], mv], [b[0], mv]].map((point) => this.pixelOf(view, point)), false);
        context.stroke();
      }
      context.setLineDash([]);
    }

    // The shape being drawn - and with the mirror, its whole as it would close, dashed.
    if (this.drawing?.stack === stack && (this.mirror.u || this.mirror.v)) {
      const half = this.drawing.cursor ? [...this.drawing.points, this.drawing.cursor] : this.drawing.points;
      if (half.length >= 2) {
        context.globalAlpha = 0.5;
        context.strokeStyle = theme.cut;
        context.lineWidth = 1;
        context.setLineDash([4, 3]);
        path(this.mirrored(stack, half).map((point) => this.pixelOf(view, point)));
        context.stroke();
        context.setLineDash([]);
      }
    }
    if (this.drawing?.stack === stack) {
      const points = this.drawing.points.map((point) => this.pixelOf(view, point));
      const cursor = this.drawing.cursor && this.pixelOf(view, this.drawing.cursor);
      context.globalAlpha = 1;
      context.lineWidth = 1.5;
      context.strokeStyle = theme.cut;
      path(cursor ? [...points, cursor] : points, false);
      context.stroke();
      if (cursor && points.length >= 2) {
        context.globalAlpha = 0.35;
        context.setLineDash([3, 3]);
        path([cursor, points[0]], false);
        context.stroke();
        context.setLineDash([]);
      }
      context.globalAlpha = 1;
      context.fillStyle = context.strokeStyle;
      points.forEach((p, i) => {
        context.beginPath();
        context.arc(p.x, p.y, i === 0 ? 5 : 3, 0, Math.PI * 2);
        if (i === 0) context.stroke();
        else context.fill();
      });
    }
    context.restore();
  }

  // The grids the points go on, over the whole view: the fine one faintly,
  // the coarse one over it (in place of the views' own, see
  // OrthoViews.drawView()), and the lines where an axis is zero.
  drawGrids(view) {
    const { context, width, height } = view;
    const { coarse, fine } = this.steps();
    const lines = (step) => {
      context.beginPath();
      for (const axis of [view.right, view.up]) {
        const [min, max] = this.views.visibleRange(view, axis);
        for (let i = Math.ceil(min / step); i <= Math.floor(max / step); i++) line(axis, i * step);
      }
      context.stroke();
    };
    const point = new THREE.Vector3();
    const line = (axis, value) => {
      point.copy(view.center);
      point[axis] = value;
      const p = this.views.project(view, point);
      if (axis === view.right) {
        context.moveTo(Math.round(p.x) + 0.5, 0);
        context.lineTo(Math.round(p.x) + 0.5, height);
      } else {
        context.moveTo(0, Math.round(p.y) + 0.5);
        context.lineTo(width, Math.round(p.y) + 0.5);
      }
    };
    context.lineWidth = 1;
    context.strokeStyle = theme.text;
    if (fine * view.scale >= MIN_FINE_SPACING) {
      context.globalAlpha = 0.05;
      lines(fine);
    }
    if (coarse * view.scale >= MIN_FINE_SPACING) {
      context.globalAlpha = 0.11;
      lines(coarse);
    }
    context.globalAlpha = 0.45;
    for (const [axis, along] of [[view.right, view.up], [view.up, view.right]]) {
      context.strokeStyle = axisColor(along);
      context.beginPath();
      line(axis, 0);
      context.stroke();
    }
    context.globalAlpha = 1;
  }

  // --- the slice in each view's title ---------------------------------------------------------

  addLayerControls() {
    if (!this.views) return;
    for (const view of this.views.views) {
      const stack = STACK_OF_VIEW[view.axes];
      const header = view.frame.querySelector('.ortho-header');
      const control = document.createElement('span');
      control.className = 'carve-layer';
      control.title = t('carve.layer.title');
      const button = (icon, title, act) => {
        const element = document.createElement('button');
        element.innerHTML = `<i class="fa-solid ${icon}"></i>`;
        if (title) element.title = title;
        element.addEventListener('mousedown', (event) => event.preventDefault());
        element.addEventListener('click', act);
        return element;
      };
      const label = document.createElement('b');
      control.append(
        button('fa-chevron-left', '', () => this.stepLayer(stack, -1)),
        label,
        button('fa-chevron-right', '', () => this.stepLayer(stack, 1)),
        button('fa-angles-left', t('carve.duplicate.previous'), () => this.duplicate(stack, -1)),
        button('fa-angles-right', t('carve.duplicate.next'), () => this.duplicate(stack, 1)),
      );
      header.append(control);
    }
    this.updateLayerControls();
  }

  removeLayerControls() {
    for (const control of document.querySelectorAll('.carve-layer')) control.remove();
  }

  updateLayerControls() {
    if (!this.views || !this.on) return;
    for (const view of this.views.views) {
      const stack = STACK_OF_VIEW[view.axes];
      const label = view.frame.querySelector('.carve-layer b');
      if (label) label.textContent = t('carve.layer', { index: this.layer[stack] + 1, count: this.carve.stacks[stack].count });
      view.frame.querySelector('.carve-layer')?.classList.toggle('active', stack === this.active);
    }
  }
}

// Twice a polygon's signed area ([u, v] points).
function area(points) {
  let sum = 0;
  points.forEach(([x0, y0], i) => {
    const [x1, y1] = points[(i + 1) % points.length];
    sum += x0 * y1 - x1 * y0;
  });
  return sum;
}

// Whether (u, v) is inside a polygon (even-odd).
function inside(points, u, v) {
  let within = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > v !== yj > v && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) within = !within;
  }
  return within;
}

// A flat polygon's triangles, wound as it is: ear clipping in its own plane.
function triangles(points) {
  if (points.length === 3) return [points];
  const normal = new THREE.Vector3();
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    normal.x += (a.y - b.y) * (a.z + b.z);
    normal.y += (a.z - b.z) * (a.x + b.x);
    normal.z += (a.x - b.x) * (a.y + b.y);
  }
  normal.normalize();
  const u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(normal.x) > 0.9) u.set(0, 1, 0);
  u.cross(normal).normalize();
  const v = new THREE.Vector3().crossVectors(normal, u);
  // (In the (u, v) plane the polygon goes round counter-clockwise; each triangle is made to as well.)
  const contour = points.map((p) => new THREE.Vector2(p.dot(u), p.dot(v)));
  return THREE.ShapeUtils.triangulateShape(contour, []).map(([a, b, c]) => {
    const area2 = (contour[b].x - contour[a].x) * (contour[c].y - contour[a].y) - (contour[c].x - contour[a].x) * (contour[b].y - contour[a].y);
    return area2 >= 0 ? [points[a], points[b], points[c]] : [points[a], points[c], points[b]];
  });
}
