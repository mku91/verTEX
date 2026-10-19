import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { FITS, shapeMatrix, cloneCollider } from './collision-fit.js';
import { rotationOf } from './frames.js';
import { scrubbable } from './scrub.js';
import { latinName, freeName } from './names.js';
import { themeGizmo } from './theme.js';

// The collision mode: the objects' collision shapes (see collision-fit.js)
// shown over the model, picked, added - by hand or fitted by themselves -
// and moved, turned and sized, with the gizmo or in the panel's fields.
//
// Shapes are drawn as outlines over everything, in the colour of the body
// they make (see Editor.setBody()), the picked one brighter and filled. A
// press on a shape picks it, and its object; elsewhere the editor picks
// objects as it always does, but moves nothing. The tools the gizmo is
// shown with are those of the toolbar: move, rotate, scale (select = move).
//
// Every edit is one undo step; a drag of the gizmo or of a field's handle is one too.

export const BODY_COLORS = { static: 0x4ea8ff, kinematic: 0xffa94d, dynamic: 0x69db7c, trigger: 0xcc8cff };
const PICKED_COLOR = 0xffe066;
export const SHAPE_ICONS = {
  box: 'fa-regular fa-square', sphere: 'fa-regular fa-circle', capsule: 'fa-solid fa-capsules',
  cylinder: 'fa-solid fa-database', convex: 'fa-solid fa-gem', trimesh: 'fa-solid fa-border-all',
};

// A shape's name, as the scene tree has names - in Latin letters, the way
// Godot gets it as its node's (see gltf.js): its own, or one by its kind.
const SHAPE_NAMES = { box: 'Box', sphere: 'Sphere', capsule: 'Capsule', cylinder: 'Cylinder', convex: 'Convex', trimesh: 'Trimesh' };
export function shapeLabel(shapes, k) {
  return shapes[k].name ?? SHAPE_NAMES[shapes[k].type];
}

// `name`, or its first numbered variant no other shape of the list has
// (the way objects are numbered, see names.js: "Box", "Box_0", ...).
export function freeShapeName(shapes, name, except = -1) {
  return freeName(name, new Set(shapes.map((shape, k) => (k === except ? null : shapeLabel(shapes, k)))));
}

// The same, named: a new shape gets a name of its own by its kind.
const named = (shapes, shape) => ({ ...shape, name: freeShapeName(shapes, SHAPE_NAMES[shape.type]) });
const GIZMO_MODES = { select: 'translate', move: 'translate', rotate: 'rotate', scale: 'scale' };
const ROUND_SEGMENTS = 32;
const MIN_SIZE = 0.001;
const DEGREE = Math.PI / 180;
const round = (value) => +value.toFixed(5);

// The outline of a shape, in its own frame: line segments as pairs of points.
function outlineOf(shape, faces) {
  const lines = [];
  const circle = (radius, at, plane) => {
    // A circle round the axis `plane` names (its normal), `at` along it.
    for (let i = 0; i < ROUND_SEGMENTS; i++) {
      const point = (k) => {
        const t = (k / ROUND_SEGMENTS) * Math.PI * 2;
        const [u, v] = [Math.cos(t) * radius, Math.sin(t) * radius];
        return plane === 'y' ? [u, at, v] : plane === 'x' ? [at, u, v] : [u, v, at];
      };
      lines.push(point(i), point(i + 1));
    }
  };
  const arc = (radius, at, plane, from, to) => {
    // Half a circle in the plane through the y axis (`plane` its normal), above or below `at`.
    for (let i = 0; i < ROUND_SEGMENTS / 2; i++) {
      const point = (k) => {
        const t = from + ((to - from) * k) / (ROUND_SEGMENTS / 2);
        const [u, v] = [Math.cos(t) * radius, Math.sin(t) * radius + at];
        return plane === 'z' ? [u, v, 0] : [0, v, u];
      };
      lines.push(point(i), point(i + 1));
    }
  };
  switch (shape.type) {
    case 'box': {
      const [x, y, z] = shape.size.map((value) => value / 2);
      const corner = (i) => [i & 4 ? x : -x, i & 2 ? y : -y, i & 1 ? z : -z];
      for (const [a, b] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]) {
        lines.push(corner(a), corner(b));
      }
      break;
    }
    case 'sphere':
      for (const plane of ['x', 'y', 'z']) circle(shape.radius, 0, plane);
      break;
    case 'cylinder': {
      const h = shape.height / 2;
      circle(shape.radius, h, 'y');
      circle(shape.radius, -h, 'y');
      for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) lines.push([x * shape.radius, -h, z * shape.radius], [x * shape.radius, h, z * shape.radius]);
      break;
    }
    case 'capsule': {
      const h = Math.max(0, shape.height / 2 - shape.radius); // where the round ends start
      circle(shape.radius, h, 'y');
      circle(shape.radius, -h, 'y');
      for (const plane of ['z', 'x']) {
        arc(shape.radius, h, plane, 0, Math.PI);
        arc(shape.radius, -h, plane, Math.PI, Math.PI * 2);
      }
      for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) lines.push([x * shape.radius, -h, z * shape.radius], [x * shape.radius, h, z * shape.radius]);
      break;
    }
    case 'convex': {
      const geometry = new ConvexGeometry(shape.points.map((p) => new THREE.Vector3(...p)));
      const edges = new THREE.EdgesGeometry(geometry, 1);
      const at = edges.getAttribute('position');
      for (let i = 0; i < at.count; i++) lines.push([at.getX(i), at.getY(i), at.getZ(i)]);
      geometry.dispose();
      edges.dispose();
      break;
    }
    case 'trimesh':
      for (const loop of faces) loop.forEach((point, k) => lines.push(point, loop[(k + 1) % loop.length]));
      break;
  }
  return lines;
}

// The solid of a shape, in its own frame: what the pointer picks it by, and its fill.
function solidOf(shape, triangles) {
  switch (shape.type) {
    case 'box': return new THREE.BoxGeometry(...shape.size.map((value) => Math.max(value, MIN_SIZE)));
    case 'sphere': return new THREE.SphereGeometry(shape.radius, 24, 12);
    case 'cylinder': return new THREE.CylinderGeometry(shape.radius, shape.radius, shape.height, ROUND_SEGMENTS);
    case 'capsule': return new THREE.CapsuleGeometry(shape.radius, Math.max(0, shape.height - 2 * shape.radius), 8, ROUND_SEGMENTS);
    case 'convex': return new ConvexGeometry(shape.points.map((p) => new THREE.Vector3(...p)));
    default: {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(triangles.flat(2), 3));
      return geometry;
    }
  }
}

export class CollisionMode {
  constructor(panel, button, viewport, editor) {
    this.panel = panel;
    this.button = button;
    this.viewport = viewport;
    this.editor = editor;
    this.picked = null; // { id, index }: the picked shape, by its object's id and its place in the list
    this.group = new THREE.Group();
    this.group.visible = false;
    viewport.scene.add(this.group);
    this.solids = []; // [{ mesh, id, index }] - what a press is tested against
    this.raycaster = new THREE.Raycaster();
    this.onRefresh = null; // called after every refresh: the scene tree shows the shapes too

    // The picked shape's gizmo: it drives a stand-in, the shape follows it.
    this.proxy = new THREE.Object3D();
    viewport.scene.add(this.proxy);
    this.gizmo = new TransformControls(viewport.camera, viewport.renderer.domElement);
    this.gizmo.setSize(0.8);
    themeGizmo(this.gizmo);
    this.gizmo.setSpace('local');
    viewport.scene.add(this.gizmo.getHelper());
    this.gizmo.addEventListener('change', () => viewport.requestRender());
    this.gizmo.addEventListener('dragging-changed', (event) => {
      viewport.orbit.enabled = !event.value;
      editor.modeDragging = event.value;
    });
    this.gizmo.addEventListener('mouseDown', () => {
      this.dragBefore = editor.snapshot();
      this.dragStart = this.pickedShape() && cloneCollider(this.pickedShape());
      this.dragProxy = this.proxy.matrix.clone();
    });
    this.gizmo.addEventListener('objectChange', () => this.applyGizmo());
    this.gizmo.addEventListener('mouseUp', () => {
      if (!this.dragBefore) return;
      const before = this.dragBefore;
      this.dragBefore = null;
      if (JSON.stringify(this.dragStart) !== JSON.stringify(this.pickedShape())) editor.commitColliders(before);
      else this.refresh();
    });

    editor.workspacePress.collisions = (event) => this.press(event);
    editor.addEventListener('change', () => this.refresh());
    button.addEventListener('click', () => editor.setCollisions(!editor.collisions));
    button.addEventListener('mousedown', (event) => event.preventDefault()); // keep the keyboard focus
    this.buildPanel();
    this.refresh();
  }

  // --- what is shown --------------------------------------------------------

  // The objects whose shapes can be seen and edited: shown, not groups.
  objectIndex(id) {
    return this.editor.mesh.objects.findIndex((object) => object.id === id);
  }

  pickedShape() {
    if (!this.picked) return null;
    const object = this.editor.mesh.objects[this.objectIndex(this.picked.id)];
    return object?.colliders?.[this.picked.index] ?? null;
  }

  // What the panel works on: a picked shape's object - a shape is picked on
  // its own, with its object not selected - or else the objects in hand.
  scope() {
    return this.pickedShape() ? [this.objectIndex(this.picked.id)] : this.editor.objectsInHand();
  }

  // The object a shape is added to: the one the panel works on.
  target() {
    const scope = this.scope();
    return scope.length === 1 ? scope[0] : null;
  }

  refresh() {
    const { editor } = this;
    const on = editor.collisions;
    this.button.classList.toggle('active', on);
    this.panel.hidden = !on;
    this.group.visible = on && !editor.preview && !editor.simulating;
    // A shape is picked instead of objects: picking objects lets it go.
    const hand = editor.objectsInHand();
    const handKey = hand.join();
    if (handKey !== this.handKey) {
      if (hand.length) this.picked = null;
      this.handKey = handKey;
    }
    if (!on || !this.pickedShape()) this.picked = null;
    this.rebuild();
    this.placeGizmo();
    this.showPanel();
    this.onRefresh?.();
    this.viewport.requestRender();
  }

  // Picks a shape - of the object at `index`, the k-th - by itself: what
  // was selected is let go of.
  pickShape(index, k) {
    const object = this.editor.mesh.objects[index];
    if (!object?.colliders?.[k]) return;
    this.picked = { id: object.id, index: k };
    if (this.editor.objectsInHand().length) this.editor.clearSelection();
    else this.refresh();
  }

  rebuild() {
    for (const child of [...this.group.children]) {
      child.geometry.dispose();
      child.material.dispose();
      this.group.remove(child);
    }
    this.solids = [];
    if (!this.editor.collisions) return;
    const { mesh } = this.editor;
    const byId = new Map(mesh.objects.map((object) => [object.id, object]));
    const hidden = (object) => Boolean(object) && (Boolean(object.hidden) || hidden(byId.get(object.parent)));
    mesh.objects.forEach((object, index) => {
      if (object.kind === 'group' || !object.colliders?.length || hidden(object)) return;
      const frame = this.editor.objectFrame(index);
      const world = new THREE.Matrix4().compose(frame.origin, frame.quaternion, new THREE.Vector3(1, 1, 1));
      const color = BODY_COLORS[object.body ?? 'static'];
      // A trimesh shape is the object's own faces: in its frame, and in triangles.
      let faces = null;
      let triangles = null;
      const ownFaces = () => {
        if (faces) return;
        const local = (vertex) => new THREE.Vector3().copy(mesh.vertices[vertex]).sub(frame.origin).applyQuaternion(frame.quaternion.clone().invert()).toArray();
        const own = mesh.faces.map((face, i) => [face, i]).filter(([face]) => mesh.vertexObject[face[0]] === object.id);
        faces = own.map(([face]) => face.map(local));
        triangles = own.flatMap(([, i]) => mesh.triangulate(i).map((triangle) => triangle.map(local)));
      };
      object.colliders.forEach((shape, k) => {
        if (shape.type === 'trimesh') ownFaces();
        if (shape.type === 'convex' && shape.points.length < 4) return;
        const picked = this.picked?.id === object.id && this.picked.index === k;
        const matrix = world.clone().multiply(shapeMatrix(shape));
        const lines = new THREE.LineSegments(
          new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(outlineOf(shape, faces).flat(), 3)),
          new THREE.LineBasicMaterial({ color: picked ? PICKED_COLOR : color, depthTest: false, transparent: true, opacity: picked ? 1 : 0.85 }),
        );
        lines.renderOrder = 9;
        const solid = new THREE.Mesh(
          solidOf(shape, triangles),
          new THREE.MeshBasicMaterial({ color: picked ? PICKED_COLOR : color, transparent: true, opacity: picked ? 0.14 : 0.05, depthTest: false, depthWrite: false, side: THREE.DoubleSide }),
        );
        solid.renderOrder = 9;
        for (const part of [lines, solid]) {
          part.matrixAutoUpdate = false;
          part.matrix.copy(matrix);
          this.group.add(part);
        }
        this.solids.push({ mesh: solid, id: object.id, index: k });
      });
    });
    this.group.updateMatrixWorld(true);
  }

  // --- the gizmo ------------------------------------------------------------

  placeGizmo() {
    const shape = this.pickedShape();
    const mode = GIZMO_MODES[this.editor.tool];
    if (!shape || !mode || shape.type === 'trimesh' || this.editor.preview || this.editor.simulating) {
      this.gizmo.detach();
      return;
    }
    if (this.gizmo.dragging) return;
    const index = this.objectIndex(this.picked.id);
    const frame = this.editor.objectFrame(index);
    const world = new THREE.Matrix4().compose(frame.origin, frame.quaternion, new THREE.Vector3(1, 1, 1));
    // A hull has no place of its own: the gizmo stands in the middle of its bounds.
    const own = shape.type === 'convex'
      ? new THREE.Matrix4().makeTranslation(new THREE.Box3().setFromArray(shape.points.flat()).getCenter(new THREE.Vector3()))
      : shapeMatrix(shape);
    world.multiply(own).decompose(this.proxy.position, this.proxy.quaternion, this.proxy.scale);
    this.proxy.scale.set(1, 1, 1);
    this.proxy.updateMatrix();
    this.gizmo.setMode(mode);
    const snap = this.editor.snapGrid.enabled;
    this.gizmo.setTranslationSnap(snap ? this.editor.snapGrid.step : null);
    this.gizmo.setRotationSnap(snap ? 15 * DEGREE : null);
    this.gizmo.setScaleSnap(null);
    if (this.gizmo.object !== this.proxy) this.gizmo.attach(this.proxy);
  }

  // The stand-in was moved: the shape is where it is now, in its object's frame.
  applyGizmo() {
    const start = this.dragStart;
    if (!start) return;
    const index = this.objectIndex(this.picked.id);
    const frame = this.editor.objectFrame(index);
    const world = new THREE.Matrix4().compose(frame.origin, frame.quaternion, new THREE.Vector3(1, 1, 1));
    this.proxy.updateMatrix();
    const local = world.clone().invert().multiply(this.proxy.matrix);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    local.decompose(position, quaternion, scale);
    const shape = cloneCollider(start);
    // Of the two that are one size together, the one moved the most.
    const either = (a, b) => (Math.abs(a - 1) > Math.abs(b - 1) ? a : b);
    if (shape.type === 'convex') {
      // Every corner as the stand-in took it, from where it stood at the start.
      const delta = local.clone().multiply(world.clone().invert().multiply(this.dragProxy).invert());
      shape.points = start.points.map((p) => new THREE.Vector3(...p).applyMatrix4(delta).toArray().map(round));
    } else {
      shape.center = position.toArray().map(round);
      if (shape.rotation) shape.rotation = (rotationOf(quaternion) ?? [0, 0, 0]).map(round);
      if (shape.type === 'box') shape.size = start.size.map((value, i) => round(Math.max(MIN_SIZE, Math.abs(value * scale.getComponent(i)))));
      if (shape.type === 'sphere') shape.radius = round(Math.max(MIN_SIZE, start.radius * Math.abs(either(either(scale.x, scale.y), scale.z))));
      if (shape.type === 'capsule' || shape.type === 'cylinder') {
        shape.radius = round(Math.max(MIN_SIZE, start.radius * Math.abs(either(scale.x, scale.z))));
        shape.height = round(Math.max(MIN_SIZE, start.height * Math.abs(scale.y)));
        if (shape.type === 'capsule') shape.height = Math.max(shape.height, round(2 * shape.radius));
      }
    }
    this.replace(shape, false);
  }

  // The picked shape, changed; recorded as an undo step or only shown.
  replace(shape, record = true) {
    const index = this.objectIndex(this.picked.id);
    const list = [...this.editor.mesh.objects[index].colliders];
    list[this.picked.index] = shape;
    this.editor.setColliders(index, list, record);
  }

  // --- the pointer ----------------------------------------------------------

  // A press in the main view (see the editor's pointerdown).
  press(event) {
    if (this.gizmo.object && this.gizmo.axis !== null) return 'gizmo';
    const ray = this.editor.mainViewer.ray(event.clientX, event.clientY);
    this.raycaster.set(ray.origin, ray.direction);
    const hits = this.raycaster.intersectObjects(this.solids.map((solid) => solid.mesh), false);
    if (!hits.length) {
      // Past the shapes: the press picks an object, or nothing - the shape goes either way.
      this.picked = null;
      return false;
    }
    // Of shapes one inside another, the smaller is the one aimed at: the
    // outer one is still to be had by its rim.
    const solid = this.solids.find((candidate) => candidate.mesh === hits[0].object);
    this.pickShape(this.objectIndex(solid.id), solid.index);
    return true;
  }

  // --- the panel ------------------------------------------------------------

  buildPanel() {
    const { panel, editor } = this;
    const $ = (selector) => panel.querySelector(selector);
    this.hint = $('.collision-hint');
    this.body = $('.collision-body');
    this.list = $('.collider-list');
    this.fields = $('.collider-fields');
    this.bodyButtons = [...panel.querySelectorAll('[data-body]')];
    for (const button of panel.querySelectorAll('button')) button.addEventListener('mousedown', (event) => event.preventDefault());
    for (const button of this.bodyButtons) {
      button.addEventListener('click', () => editor.setBody(this.scope(), button.dataset.body));
    }
    for (const button of panel.querySelectorAll('[data-add]')) {
      button.addEventListener('click', () => this.add(button.dataset.add));
    }
    $('.collider-auto').addEventListener('click', () => this.auto());
    $('.collider-refit').addEventListener('click', () => this.refit());
    $('.collider-delete').addEventListener('click', () => this.remove());

    // The fields of the picked shape: each a number of it, dragged by its
    // handle as every number field (one undo step a drag), or typed in.
    this.inputs = [...this.fields.querySelectorAll('input')];
    for (const input of this.inputs) {
      const read = () => parseFloat(input.value.replace(',', '.'));
      const write = (value, record) => {
        const shape = this.pickedShape();
        if (!shape || !Number.isFinite(value)) return;
        const changed = cloneCollider(shape);
        const [key, at] = input.dataset.field.split('.');
        if (at === undefined) changed[key] = key === 'radius' || key === 'height' ? Math.max(MIN_SIZE, value) : value;
        else changed[key][+at] = key === 'size' ? Math.max(0, value) : value;
        if (changed.type === 'capsule') changed.height = Math.max(changed.height, 2 * changed.radius);
        this.replace(changed, record);
      };
      input.addEventListener('change', () => {
        const value = read();
        if (Number.isFinite(value)) write(value, true);
        else this.showPanel();
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === 'Escape') input.blur();
        event.stopPropagation(); // the keys are the field's, not the shortcuts'
      });
      let before = null;
      scrubbable(input, {
        read,
        write: (value) => {
          input.value = value;
          write(value, false);
        },
        begin: () => { before = editor.snapshot(); },
        end: () => editor.commitColliders(before),
        min: input.dataset.field === 'radius' || input.dataset.field === 'height' ? MIN_SIZE : -Infinity,
      });
    }
  }

  showPanel() {
    if (this.panel.hidden) return;
    const { editor } = this;
    const hand = this.scope();
    const target = this.target();
    this.hint.hidden = hand.length > 0;
    this.body.hidden = hand.length === 0;
    if (hand.length === 0) return;
    const objects = hand.map((index) => editor.mesh.objects[index]);
    const bodies = new Set(objects.map((object) => object.body ?? 'static'));
    for (const button of this.bodyButtons) button.classList.toggle('active', bodies.size === 1 && bodies.has(button.dataset.body));
    // Adding by hand is to one object; fitting, to every object in hand.
    for (const button of this.panel.querySelectorAll('[data-add]')) button.disabled = target === null;
    this.panel.querySelector('.collider-auto').title = hand.length > 1
      ? `Подобрать фигуру каждому из ${hand.length} объектов: простую, если она плотно облегает объект, иначе выпуклую оболочку. Прежние фигуры заменяются`
      : 'Подобрать фигуру по объекту: простую (коробку, сферу, капсулу, цилиндр), если она плотно облегает его, иначе выпуклую оболочку. Прежние фигуры заменяются';

    // The list: the target's shapes; with several objects, how many they have.
    this.list.replaceChildren();
    if (target === null) {
      const count = objects.reduce((sum, object) => sum + (object.colliders?.length ?? 0), 0);
      const line = document.createElement('p');
      line.className = 'collider-empty';
      line.textContent = `${hand.length} объект(ов), фигур: ${count}`;
      this.list.append(line);
    } else {
      const object = editor.mesh.objects[target];
      const shapes = object.colliders ?? [];
      if (shapes.length === 0) {
        const line = document.createElement('p');
        line.className = 'collider-empty';
        line.textContent = 'Нет фигур';
        this.list.append(line);
      }
      shapes.forEach((shape, k) => {
        const row = document.createElement('button');
        row.className = 'collider-row';
        row.classList.toggle('active', this.picked?.id === object.id && this.picked.index === k);
        row.textContent = shapeLabel(shapes, k);
        row.addEventListener('mousedown', (event) => event.preventDefault());
        row.addEventListener('click', () => this.pickShape(target, k));
        this.list.append(row);
      });
    }

    // The picked shape's numbers.
    const shape = this.pickedShape();
    this.fields.hidden = !shape;
    this.panel.querySelector('.collider-tools').hidden = !shape;
    if (!shape) return;
    for (const group of this.fields.querySelectorAll('[data-for]')) {
      group.hidden = !group.dataset.for.split(' ').includes(shape.type);
    }
    for (const input of this.inputs) {
      if (document.activeElement === input) continue;
      const [key, at] = input.dataset.field.split('.');
      const value = at === undefined ? shape[key] : shape[key]?.[+at];
      input.value = value === undefined ? '' : +(+value).toFixed(4);
    }
  }

  // --- the commands ---------------------------------------------------------

  // A shape of this kind on the target object, fitted to it; picked.
  add(type) {
    const index = this.target();
    if (index === null) return;
    const points = this.editor.objectPoints(index);
    const shape = points.length ? FITS[type](points) : null;
    if (!shape) return; // nothing to fit, or a hull of flat points
    const object = this.editor.mesh.objects[index];
    const list = [...(object.colliders ?? [])];
    list.push(named(list, shape));
    this.editor.setColliders(index, list);
    this.pickShape(index, list.length - 1);
  }

  // Every object in hand gets the one shape that fits it best (see fitAuto()),
  // in place of those it had. One undo step for them all.
  auto() {
    const { editor } = this;
    const hand = this.scope();
    if (!hand.length || editor.busy()) return;
    const before = editor.snapshot();
    let changed = false;
    for (const index of hand) {
      const points = editor.objectPoints(index);
      if (!points.length) continue;
      editor.setColliders(index, [named([], FITS.auto(points))], false);
      changed = true;
    }
    if (!changed) return;
    editor.commitColliders(before);
    if (hand.length === 1) this.pickShape(hand[0], 0);
  }

  // The picked shape fitted again, as it was made: to the object as it is now.
  refit() {
    const shape = this.pickedShape();
    if (!shape) return;
    const points = this.editor.objectPoints(this.objectIndex(this.picked.id));
    const fitted = points.length ? FITS[shape.type](points) : null;
    if (fitted) this.replace({ ...fitted, ...(shape.name ? { name: shape.name } : {}) });
  }

  // A new name for the k-th shape of the object at `index` (Latin letters
  // only, see latinName()); unique among its object's. One undo step.
  renameShape(index, k, name) {
    const shapes = this.editor.mesh.objects[index]?.colliders;
    name = name.trim();
    if (!shapes?.[k] || !name || latinName(name) !== name || name === shapeLabel(shapes, k)) return;
    const list = [...shapes];
    list[k] = { ...shapes[k], name: freeShapeName(shapes, name, k) };
    this.editor.setColliders(index, list);
  }

  remove() {
    const shape = this.pickedShape();
    if (!shape) return;
    const index = this.objectIndex(this.picked.id);
    const list = this.editor.mesh.objects[index].colliders.filter((_, k) => k !== this.picked.index);
    // The shape before it is picked next; with none left, the object itself.
    this.picked = list.length ? { id: this.picked.id, index: Math.max(0, this.picked.index - 1) } : null;
    this.editor.setColliders(index, list);
    if (!list.length) this.editor.select(index, false);
  }

  // A shape taken away by its place (the scene tree's menu). One undo step.
  removeShape(index, k) {
    this.pickShape(index, k);
    this.remove();
  }

  // Delete with a shape picked: the shape goes, not the object. Returns
  // whether the key was taken.
  deleteKey() {
    if (!this.editor.collisions || this.editor.simulating || !this.pickedShape()) return false;
    this.remove();
    return true;
  }
}
