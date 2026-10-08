import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { EditableMesh, MeshView, edgeKey } from './mesh.js';
import { SnapGrid } from './snap-grid.js';
import { History } from './history.js';
import { theme, onThemeChange } from './theme.js';

// Tool id -> gizmo mode (null = no gizmo).
export const TOOLS = {
  select: null,
  move: 'translate',
  rotate: 'rotate',
  scale: 'scale',
};

// Axis lock mode for LMB vertex dragging -> world axis (null = free, screen plane).
export const AXIS_LOCKS = {
  free: null,
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

// Selection modes: which kind of element the pointer picks, selects and drags.
export const MODES = ['object', 'face', 'edge', 'vertex'];

// Selection modes each modal operation works in; the first one is its default.
export const OPERATION_MODES = { cut: ['face'], extrude: ['face', 'edge'], pencil: ['vertex'], polygon: ['face'] };

const MIN_AXIS_SINE = 0.1; // below this angle to the view ray a locked axis is undraggable
const PICK_RADIUS = 12; // px, vertices
const EDGE_PICK_RADIUS = 8; // px
const CLICK_TOLERANCE = 4; // px of pointer travel that still counts as a click

// The drawn cut line: how fast it glides to the cut's position (1/s, higher is
// snappier), and its dash pattern in screen pixels.
const CUT_GLIDE = 16;
const CUT_DASH = 9;
const CUT_GAP = 9;
const CUT_FLOW = 40; // px per second

// Editor state: mesh, selection, selection mode, active tool. Dispatches 'change' on any update.
export class Editor extends EventTarget {
  constructor(viewport) {
    super();
    this.viewport = viewport;
    this.mode = 'vertex';
    // Selected elements of the current mode, by key: vertex index, edge key
    // ("a_b"), face index or island index.
    this.picked = new Set();
    // Vertices of the picked elements: what every transform acts on.
    this.selection = new Set();
    // The object being edited, as the vertices of its islands. A selection
    // sets it; deselecting keeps it, so the three views go on showing it.
    this.target = new Set();
    this.hovered = null; // key of the element under the cursor, the one LMB would grab
    this.drag = null;
    this.box = null; // Shift+drag selection box in the main view, in client pixels
    this.shading = 'solid'; // how the object is drawn, see MeshView.setShading()
    // Modal operation, 'cut', 'extrude' or 'pencil': a state with its own look
    // and its own meaning of LMB, on top of whatever tool is active.
    this.operation = null;
    // The cut being placed: the face and the plane (axis = value) through it.
    this.cut = null;
    // The extrusion being pulled out: its new vertices and how far they went.
    this.extrude = null;
    // The polygon tool's state: its work plane and the outline drawn so far.
    this.polygon = null;
    this.axisLock = 'free';
    this.tool = 'select';
    this.raycaster = new THREE.Raycaster();
    this.snapGrid = new SnapGrid(viewport);
    this.history = new History();

    this.mesh = new EditableMesh();
    this.mesh.addCube();
    this.view = new MeshView(this.mesh);
    viewport.scene.add(this.view.group);
    this.updateTopology();
    this.target = new Set(this.mesh.vertices.keys());

    // How the drag code sees the main viewport; the orthographic views supply their own.
    const { camera } = viewport;
    this.mainViewer = {
      planeAxes: null, // the screen plane is not a grid plane
      planeNormal: () => camera.getWorldDirection(new THREE.Vector3()),
      viewDirection: (point) => point.clone().sub(camera.position).normalize(),
      ray: (clientX, clientY) => this.pointerRay(clientX, clientY),
    };

    this.setupGizmo();
    this.setupPointer();
    this.applyTheme();
    onThemeChange(() => this.applyTheme());
  }

  // 'solid' | 'wireframe' | 'orientation', see MeshView.setShading().
  setShading(mode) {
    this.shading = mode;
    this.view.setShading(mode);
    this.refreshHighlight(); // vertex colours, and a render
    this.emitChange();
  }

  applyTheme() {
    this.view.applyTheme();
    this.gizmo.setColors(theme.axisX, theme.axisY, theme.axisZ, theme.hoveredFocus);
    this.refreshHighlight(); // vertex colours, and a render
  }

  // --- gizmo -------------------------------------------------------------

  setupGizmo() {
    const { scene, camera, renderer, orbit } = this.viewport;

    // The gizmo drives this pivot; vertices follow the pivot's delta transform.
    this.pivot = new THREE.Object3D();
    scene.add(this.pivot);

    this.gizmo = new TransformControls(camera, renderer.domElement);
    this.gizmo.setSize(0.8);
    scene.add(this.gizmo.getHelper());
    // The move gizmo draws its own endless line along the dragged axis, right
    // over the snap dots. TransformControls has no option for it, so the
    // lines are found by name in its internals and given an invisible material.
    for (const helper of this.gizmo._gizmo.helper.translate.children) {
      if (['X', 'Y', 'Z'].includes(helper.name)) {
        helper.material = new THREE.LineBasicMaterial({ visible: false });
      }
    }

    this.gizmo.addEventListener('change', () => this.viewport.requestRender());
    this.gizmo.addEventListener('dragging-changed', (event) => {
      orbit.enabled = !event.value;
    });
    this.gizmo.addEventListener('mouseDown', () => {
      this.gizmoUsed = true;
      this.gizmoBefore = this.snapshot();
      this.pivotStart = this.pivot.position.clone();
      this.pivot.updateMatrix();
      this.dragStartInverse = this.pivot.matrix.clone().invert();
      this.dragStartPositions = new Map(
        [...this.selection].map((i) => [i, this.mesh.vertices[i].clone()]),
      );
      if (this.gizmo.mode === 'translate') this.beginGizmoSnap();
      if (this.gizmo.mode === 'scale') {
        this.scaleHalf = this.selectionBox().getSize(new THREE.Vector3()).multiplyScalar(0.5);
      }
    });
    this.gizmo.addEventListener('objectChange', () => {
      if (this.gizmo.mode === 'translate') this.snapPivot();
      if (this.gizmo.mode === 'scale') this.snapScale();
      // Always transform the snapshot, never the current positions, to avoid drift.
      this.pivot.updateMatrix();
      const delta = this.pivot.matrix.clone().multiply(this.dragStartInverse);
      for (const [i, start] of this.dragStartPositions) {
        this.mesh.vertices[i].copy(start).applyMatrix4(delta);
      }
      this.view.updatePositions();
      this.emitChange();
    });
    this.gizmo.addEventListener('mouseUp', () => {
      this.snapGrid.end();
      this.commit(this.gizmoBefore);
      this.placeGizmo();
    });
  }

  // Sets up the snap grid for the move gizmo handle being dragged ('X', 'XY',
  // 'XYZ', ...). The lattice starts at the pivot, so its travel snaps to whole steps.
  beginGizmoSnap() {
    const handle = this.gizmo.axis.toLowerCase();
    const start = this.pivotStart;
    if (handle.length < 3) {
      this.snapGrid.begin(start, handle, null, start);
      return;
    }
    // The center handle slides the pivot in the plane that faces the camera.
    const normal = this.viewport.camera.position.clone().sub(start).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, start);
    this.snapGrid.begin(start, 'free', plane, start);
  }

  // Snaps the move gizmo's pivot to the grid along the axes of the dragged
  // handle and keeps the other axes exactly in place.
  snapPivot() {
    const handle = this.gizmo.axis.toLowerCase();
    for (const axis of ['x', 'y', 'z']) {
      if (!handle.includes(axis)) this.pivot.position[axis] = this.pivotStart[axis];
    }
    this.snapGrid.snap(this.pivot.position);
    this.snapGrid.focus(this.pivot.position);
  }

  // Snaps the scale gizmo so that the selection's size, not the factor, moves
  // in grid steps: along each axis of the dragged handle the far side of the
  // selection lands on a grid line, and so does the near side, as the pivot is
  // the middle of the selection's bounds.
  snapScale() {
    const step = this.snapGrid.activeStep;
    const center = this.pivot.position;
    const { scale } = this.pivot;
    const snapped = (axis) => {
      const half = this.scaleHalf[axis];
      if (half < 1e-9) return 1; // flat along this axis: nothing to scale
      let target = Math.round((center[axis] + half * scale[axis]) / step) * step - center[axis];
      if (target < 1e-9) {
        // Never collapse or flip: stop at the nearest grid line beyond the center.
        const next = Math.ceil(center[axis] / step) * step - center[axis];
        target = next < 1e-9 ? step : next;
      }
      return target / half;
    };

    const handle = (this.gizmo.axis ?? '').toLowerCase();
    if (handle.length === 3) {
      // Uniform: one factor for all, snapped by the longest side.
      const axis = ['x', 'y', 'z'].reduce((best, candidate) =>
        this.scaleHalf[candidate] > this.scaleHalf[best] ? candidate : best);
      scale.setScalar(snapped(axis));
      return;
    }
    for (const axis of ['x', 'y', 'z']) scale[axis] = handle.includes(axis) ? snapped(axis) : 1;
  }

  // Whether the pointer is on a handle of the visible gizmo.
  overGizmo() {
    return Boolean(this.gizmo.object) && this.gizmo.axis !== null;
  }

  placeGizmo() {
    const mode = TOOLS[this.tool];
    if (!mode || this.selection.size === 0 || this.operation) {
      this.gizmo.detach();
    } else {
      // Scaling pivots on the middle of the bounds, which keeps both sides on the grid.
      this.pivot.position.copy(
        this.tool === 'scale'
          ? this.selectionBox().getCenter(new THREE.Vector3())
          : this.selectionCenter(),
      );
      this.pivot.quaternion.identity();
      this.pivot.scale.set(1, 1, 1);
      this.gizmo.setMode(mode);
      this.gizmo.attach(this.pivot);
    }
    this.viewport.requestRender();
  }

  // --- picking -----------------------------------------------------------

  setupPointer() {
    const dom = this.viewport.renderer.domElement;
    let down = null; // LMB press on empty space; a click there clears the selection

    this.boxElement = document.createElement('div');
    this.boxElement.className = 'selection-box';
    this.boxElement.hidden = true;
    this.viewport.container.append(this.boxElement);

    // Capture phase: runs before the gizmo's own pointerdown handler.
    dom.addEventListener(
      'pointerdown',
      (event) => {
        this.gizmoUsed = false;
        down = null;
        if (event.button !== 0) return;
        // The pencil works through ordinary vertex drags, see sproutVertex().
        if (this.operation && this.operation !== 'pencil') {
          event.stopImmediatePropagation();
          if (this.operation === 'cut') this.pressCut(event.clientX, event.clientY);
          else if (this.operation === 'extrude') this.pressExtrude(event.clientX, event.clientY);
          else this.pressPolygon(event.clientX, event.clientY);
          return;
        }
        // A gizmo handle under the cursor takes the press; otherwise the element does.
        if (this.overGizmo()) return;
        const key = this.pickElement(event.clientX, event.clientY);
        if (event.shiftKey) {
          // Shift: a drag draws a selection box, even when it starts on an element.
          event.stopImmediatePropagation();
          dom.setPointerCapture(event.pointerId);
          const { clientX: x, clientY: y } = event;
          this.box = { x0: x, y0: y, x1: x, y1: y, key, active: false };
          return;
        }
        if (key === null) {
          down = { x: event.clientX, y: event.clientY };
          return;
        }
        // Keep the press away from the gizmo and the camera.
        event.stopImmediatePropagation();
        dom.setPointerCapture(event.pointerId);
        this.setHovered(key);
        this.drag = {
          key,
          x: event.clientX,
          y: event.clientY,
          additive: event.shiftKey,
          start: null, // set once the pointer leaves the click dead zone
          viewer: this.mainViewer,
        };
      },
      { capture: true },
    );
    dom.addEventListener('pointermove', (event) => {
      this.setFineSnap(event.ctrlKey); // in case the key event was missed
      if (this.cut) {
        this.moveCut(event.clientX, event.clientY);
        return;
      }
      if (this.extrude) {
        this.moveExtrude(event.clientX, event.clientY);
        return;
      }
      if (this.polygon) {
        this.movePolygon(event.clientX, event.clientY);
        return;
      }
      if (this.box) {
        // A missed release applies the box as it is.
        if (event.buttons & 1) this.stretchBox(event.clientX, event.clientY);
        else this.finishBox();
        return;
      }
      // The release was missed (it can happen outside the window): finish the drag.
      if (this.drag && !(event.buttons & 1)) this.endDrag();
      if (this.drag) this.dragTo(event.clientX, event.clientY);
      else if (event.buttons === 0) {
        // The gizmo's own hover handler has already run for this event.
        this.setHovered(this.overGizmo() ? null : this.pickElement(event.clientX, event.clientY));
      }
    });
    dom.addEventListener('pointerleave', () => {
      if (!this.drag) this.setHovered(null);
    });
    dom.addEventListener('pointerup', (event) => {
      if (event.button !== 0) return;
      if (this.box) {
        this.finishBox();
        return;
      }
      if (this.drag) {
        this.endDrag();
        return;
      }
      if (!down || this.gizmoUsed) return;
      const travel = Math.hypot(event.clientX - down.x, event.clientY - down.y);
      down = null;
      if (travel <= CLICK_TOLERANCE) this.clearSelection();
    });
    dom.addEventListener('pointercancel', () => {
      this.cancelBox();
      this.cancelDrag();
    });
  }

  // --- modal operations --------------------------------------------------

  // Enters 'cut' or 'extrude', or leaves the current operation (null). While
  // one is on, the view shows only what it needs (see MeshView.setFocus), faces
  // are what the pointer picks, and LMB drives the operation instead of dragging.
  setOperation(name) {
    if (name === this.operation) return;
    this.cancelDrag();
    this.cancelBox();
    const wasIdle = this.operation === null;
    this.cancelCut();
    this.cancelExtrude();
    this.endPolygon();

    if (name) {
      if (wasIdle) this.modeBeforeOperation = this.mode;
      const modes = OPERATION_MODES[name];
      // Elements already selected in a suitable mode are taken right away.
      const keys = modes.includes(this.mode) ? [...this.picked] : [];
      this.operation = name;
      if (!modes.includes(this.mode)) {
        const modeToReturnTo = this.modeBeforeOperation;
        this.setMode(modes[0]);
        this.modeBeforeOperation = modeToReturnTo;
      }
      if (name === 'cut' && keys.length === 1) this.beginCut(keys[0]);
      if (name === 'extrude' && keys.length > 0) this.beginExtrude(keys);
      if (name === 'polygon') this.polygon = { axis: null, offset: 0, points: [], cursor: null, problem: null };
    } else {
      this.operation = null;
      if (this.mode !== this.modeBeforeOperation) this.setMode(this.modeBeforeOperation);
    }
    this.view.setFocus(name !== null);
    this.viewport.setFocus(name !== null);
    this.refreshHighlight();
    this.placeGizmo();
    this.emitChange();
  }

  // Esc during an operation: drops what is being placed, or leaves the
  // operation if there is nothing. Returns false when no operation is on.
  escapeOperation() {
    if (!this.operation) return false;
    const cancelled =
      this.cancelDrag() || this.cancelCut() || this.cancelExtrude() || this.clearPolygonOutline();
    if (!cancelled) this.setOperation(null);
    return true;
  }

  // --- polygon -----------------------------------------------------------
  //
  // The polygon tool draws a flat polygon point by point on a work plane: the
  // plane `axis` = `offset`, perpendicular to a world axis. Points snap to the
  // grid in that plane. Closing the outline makes it a face, an object of its own.

  // Picks the work plane by the axis it is perpendicular to ('free' = none
  // yet). Starts the outline over.
  setPolygonPlane(axis) {
    const polygon = this.polygon;
    if (!polygon || !(axis in AXIS_LOCKS)) return;
    polygon.axis = axis === 'free' ? null : axis;
    polygon.points = [];
    polygon.cursor = null;
    polygon.problem = null;
    this.showPolygonGrid();
    this.updatePolygonSketch();
  }

  // Moves the work plane along its axis by whole grid steps; only before the
  // first point is placed.
  shiftPolygonPlane(steps) {
    const polygon = this.polygon;
    if (!polygon?.axis || polygon.points.length) return;
    const step = this.snapGrid.activeStep;
    polygon.offset = Math.round(polygon.offset / step + steps) * step;
    polygon.cursor = null;
    this.showPolygonGrid();
    this.updatePolygonSketch();
  }

  // Shows the snap points of the work plane, around the cursor (or, before the
  // pointer has been there, around the point of the plane nearest to what the
  // camera looks at).
  showPolygonGrid() {
    const polygon = this.polygon;
    if (!polygon.axis) {
      this.snapGrid.end();
      return;
    }
    const start = polygon.cursor?.clone() ?? this.viewport.orbit.target.clone();
    start[polygon.axis] = polygon.offset;
    const inPlane = ['x', 'y', 'z'].filter((axis) => axis !== polygon.axis).join('');
    this.snapGrid.begin(start, inPlane, null);
    if (!polygon.cursor) this.snapGrid.snap(start);
    this.snapGrid.focus(start);
  }

  // The grid point of the work plane under the pointer.
  movePolygon(clientX, clientY) {
    const polygon = this.polygon;
    if (!polygon.axis) return;
    const plane = new THREE.Plane(AXIS_LOCKS[polygon.axis], -polygon.offset);
    const hit = this.pointerRay(clientX, clientY).intersectPlane(plane, new THREE.Vector3());
    if (!hit) return;
    this.snapGrid.snap(hit);
    hit[polygon.axis] = polygon.offset;
    polygon.cursor = hit;
    this.snapGrid.focus(hit);
    this.updatePolygonSketch();
  }

  // LMB in the polygon tool: adds the point under the pointer to the outline;
  // on the first point it closes the outline instead.
  pressPolygon(clientX, clientY) {
    const polygon = this.polygon;
    this.movePolygon(clientX, clientY);
    const { cursor, points } = polygon;
    if (!cursor) return;
    polygon.problem = null;
    if (this.polygonClosesAt(cursor)) {
      this.closePolygon();
      return;
    }
    if (points.some((point) => point.distanceTo(cursor) < 1e-6)) return; // already in the outline
    points.push(cursor.clone());
    this.updatePolygonSketch();
  }

  polygonClosesAt(point) {
    const { points } = this.polygon;
    return points.length >= 3 && points[0].distanceTo(point) < 1e-6;
  }

  // Takes back the last point of the outline.
  undoPolygonPoint() {
    if (!this.polygon?.points.length) return;
    this.polygon.points.pop();
    this.polygon.problem = null;
    this.updatePolygonSketch();
  }

  // Drops the outline but stays in the tool. Returns false if there was nothing to drop.
  clearPolygonOutline() {
    if (!this.polygon?.points.length) return false;
    this.polygon.points = [];
    this.polygon.problem = null;
    this.updatePolygonSketch();
    return true;
  }

  // Turns the outline into a face. The result is selected in face mode, ready
  // to be extruded, and the tool is left.
  closePolygon() {
    const polygon = this.polygon;
    if (!polygon || polygon.points.length < 3) return;
    polygon.problem = this.polygonProblem();
    if (polygon.problem) {
      this.updatePolygonSketch();
      return;
    }
    const before = this.snapshot();
    const center = polygon.points.reduce((sum, point) => sum.add(point), new THREE.Vector3());
    center.divideScalar(polygon.points.length);
    const facing = center.sub(this.viewport.camera.position).normalize();
    const vertices = this.mesh.addPolygon(polygon.points, facing);
    this.history.push(before);

    this.endPolygon();
    this.selection = new Set(vertices);
    this.rebuildView(); // face mode: selects the new face
    this.modeBeforeOperation = 'face'; // stay in face mode after the tool
    this.setOperation(null);
  }

  // Why the outline can't become a face, or null if it can.
  polygonProblem() {
    const { points, axis } = this.polygon;
    const [u, v] = ['x', 'y', 'z'].filter((candidate) => candidate !== axis);
    const flat = points.map((point) => ({ x: point[u], y: point[v] }));
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    // For p on the line through a and b: whether it is between them.
    const within = (a, b, p) =>
      Math.min(a.x, b.x) - 1e-9 <= p.x && p.x <= Math.max(a.x, b.x) + 1e-9 &&
      Math.min(a.y, b.y) - 1e-9 <= p.y && p.y <= Math.max(a.y, b.y) + 1e-9;

    // Two sides that are not neighbours must not cross or touch.
    const count = flat.length;
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        if (j === i + 1 || (i === 0 && j === count - 1)) continue;
        const [a, b, c, d] = [flat[i], flat[(i + 1) % count], flat[j], flat[(j + 1) % count]];
        const d1 = cross(a, b, c);
        const d2 = cross(a, b, d);
        const d3 = cross(c, d, a);
        const d4 = cross(c, d, b);
        const crossing = d1 * d2 < 0 && d3 * d4 < 0;
        // An end of one side lying on the other side.
        const touching =
          (Math.abs(d1) < 1e-12 && within(a, b, c)) ||
          (Math.abs(d2) < 1e-12 && within(a, b, d)) ||
          (Math.abs(d3) < 1e-12 && within(c, d, a)) ||
          (Math.abs(d4) < 1e-12 && within(c, d, b));
        if (crossing || touching) return 'контур пересекает сам себя';
      }
    }
    // Checked after the crossings: a figure of eight has no net area either.
    let doubleArea = 0;
    flat.forEach((a, i) => {
      const b = flat[(i + 1) % count];
      doubleArea += a.x * b.y - b.x * a.y;
    });
    if (Math.abs(doubleArea) < 1e-9) return 'точки лежат на одной прямой';
    return null;
  }

  // Leaves the polygon tool's state behind.
  endPolygon() {
    if (!this.polygon) return;
    this.polygon = null;
    this.snapGrid.end();
    this.view.setSketch(null);
  }

  updatePolygonSketch() {
    const { points, cursor } = this.polygon;
    this.view.setSketch({ points, cursor, closing: Boolean(cursor) && this.polygonClosesAt(cursor) });
    this.emitChange();
  }

  // --- extrude -----------------------------------------------------------

  // LMB in extrude mode: the first press grabs a face or an edge (whichever
  // the selection mode is) and starts pulling it out, the next one fixes the
  // extrusion where it is.
  pressExtrude(clientX, clientY) {
    if (this.extrude) {
      this.applyExtrude();
      return;
    }
    const key = this.pickElement(clientX, clientY);
    if (key === null) {
      this.clearSelection();
      return;
    }
    this.beginExtrude([key]);
    if (this.extrude) this.moveExtrude(clientX, clientY);
  }

  // Extrudes the given elements of the current mode (faces as one region, or
  // edges as one strip), by zero distance for now.
  beginExtrude(keys) {
    const before = this.snapshot();
    const edges = this.mode === 'edge' ? keys.map((key) => this.elementVertices(key)) : null;
    const direction = edges ? this.edgesDirection(edges) : this.facesDirection(keys);
    const cap = edges ? this.mesh.extrudeEdges(edges) : this.mesh.extrudeFaces(keys);

    this.selection = new Set(cap);
    this.rebuildView(); // selects the new faces or edges
    const base = new Map(cap.map((i) => [i, this.mesh.vertices[i].clone()]));
    const anchor = new THREE.Vector3();
    for (const position of base.values()) anchor.add(position);
    anchor.divideScalar(base.size);
    // `direction` is the automatic one; `axis` ('x' | 'y' | 'z') overrides it.
    this.extrude = { before, base, direction, axis: 'free', anchor, distance: 0, pointer: null };
    this.emitChange();
  }

  // Faces go out along their (average) normal.
  facesDirection(faces) {
    const direction = new THREE.Vector3();
    for (const face of faces) direction.add(this.mesh.faceNormal(face));
    return this.unitOrUp(direction);
  }

  // An edge on the border of a surface continues its only face outwards, in
  // the face's plane; an edge between two faces goes out half-way between them.
  edgesDirection(edges) {
    const { vertices } = this.mesh;
    const perEdge = new Map(); // edge key -> the faces' contributions
    for (const { face, from, to } of this.mesh.edgeUses(edges)) {
      const normal = this.mesh.faceNormal(face);
      const along = vertices[to].clone().sub(vertices[from]).normalize();
      const key = edgeKey(from, to);
      if (!perEdge.has(key)) perEdge.set(key, []);
      // The face lies to the left of its own edge direction; `outward` points away from it.
      perEdge.get(key).push({ normal, outward: along.cross(normal) });
    }
    const direction = new THREE.Vector3();
    for (const uses of perEdge.values()) {
      if (uses.length === 1) direction.add(uses[0].outward);
      else direction.add(this.unitOrUp(uses.reduce((sum, use) => sum.add(use.normal), new THREE.Vector3())));
    }
    return this.unitOrUp(direction);
  }

  // Normalizes a direction; one that cancels out to nothing becomes "up".
  unitOrUp(vector) {
    return vector.length() < 1e-6 ? new THREE.Vector3(0, 1, 0) : vector.normalize();
  }

  // Sets the extrusion depth from the pointer: the point of the line through
  // the middle of the extruded elements, along the chosen axis or else the
  // automatic direction, that is nearest to the cursor, in grid steps.
  moveExtrude(clientX, clientY) {
    const { anchor, base } = this.extrude;
    this.extrude.pointer = [clientX, clientY];
    const normal = AXIS_LOCKS[this.extrude.axis] ?? this.extrude.direction;
    // Plane through that line that faces the camera as much as possible.
    const view = anchor.clone().sub(this.viewport.camera.position).normalize();
    const planeNormal = view.addScaledVector(normal, -view.dot(normal));
    if (planeNormal.length() < MIN_AXIS_SINE) return; // looking straight along the line
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal.normalize(), anchor);
    const hit = this.pointerRay(clientX, clientY).intersectPlane(plane, new THREE.Vector3());
    if (!hit) return;

    const step = this.snapGrid.activeStep;
    const distance = Math.round(hit.sub(anchor).dot(normal) / step) * step;
    this.extrude.distance = distance;
    for (const [i, position] of base) {
      this.mesh.vertices[i].copy(position).addScaledVector(normal, distance);
    }
    this.view.updatePositions();
    this.emitChange();
  }

  // Picks the direction of the extrusion in progress: a world axis, or 'free'
  // for the automatic one. The choice does not outlive the extrusion.
  setExtrudeAxis(axis) {
    if (!this.extrude || !(axis in AXIS_LOCKS)) return;
    this.extrude.axis = axis;
    if (this.extrude.pointer) this.moveExtrude(...this.extrude.pointer);
    this.emitChange();
  }

  applyExtrude() {
    // An extrusion of no depth would leave doubled vertices behind.
    if (Math.abs(this.extrude.distance) < 1e-9) {
      this.cancelExtrude();
      return;
    }
    this.history.push(this.extrude.before);
    this.extrude = null;
    this.setOperation(null); // one extrusion per activation
  }

  // Undoes the extrusion in progress. Returns false if there was none.
  cancelExtrude() {
    if (!this.extrude) return false;
    const { before } = this.extrude;
    this.extrude = null;
    this.restore(before);
    return true;
  }

  // --- cut ---------------------------------------------------------------

  // LMB in cut mode: the first press picks the face to cut, the next one cuts.
  pressCut(clientX, clientY) {
    if (this.cut) {
      this.applyCut();
      return;
    }
    const face = this.pickFace(clientX, clientY);
    if (face === null) {
      this.clearSelection();
      return;
    }
    this.select(face, false);
    this.beginCut(face);
    this.moveCut(clientX, clientY);
  }

  // Starts cutting the object the face belongs to, with the line at the face's middle.
  beginCut(face) {
    const island = this.topology.islands[this.topology.islandOfFace[face]];
    // `value` is where the cut will be made; `shown` is where its line is drawn
    // right now, on its way there. `segments` is that line, `time` runs its dashes.
    this.cut = { face, faces: island.faces, axis: null, value: null, shown: null, segments: [], time: 0 };
    const center = new THREE.Vector3();
    for (const i of this.mesh.faces[face]) center.add(this.mesh.vertices[i]);
    this.placeCut(center.divideScalar(this.mesh.faces[face].length));
  }

  // Moves the cut line under the pointer.
  moveCut(clientX, clientY) {
    const points = this.mesh.faces[this.cut.face].map((i) => this.mesh.vertices[i]);
    // Newell's method: the face's normal even if it is not perfectly flat.
    const normal = new THREE.Vector3();
    points.forEach((a, i) => {
      const b = points[(i + 1) % points.length];
      normal.x += (a.y - b.y) * (a.z + b.z);
      normal.y += (a.z - b.z) * (a.x + b.x);
      normal.z += (a.x - b.x) * (a.y + b.y);
    });
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal.normalize(), points[0]);
    const hit = this.pointerRay(clientX, clientY).intersectPlane(plane, new THREE.Vector3());
    if (hit) this.placeCut(hit);
  }

  // Puts the cutting plane through `point` (a point in the face's plane),
  // snapped to the grid. The plane is perpendicular to the locked axis, or,
  // with no axis locked, to the face's edge nearest to the point, so that the
  // cut runs across that edge.
  placeCut(point) {
    const cut = this.cut;
    cut.point = point.clone(); // to re-place the line when the axis or the step changes
    const points = this.mesh.faces[cut.face].map((i) => this.mesh.vertices[i]);

    let axis = this.axisLock;
    if (axis === 'free') {
      let nearest = Infinity;
      const edge = new THREE.Line3();
      const closest = new THREE.Vector3();
      points.forEach((a, i) => {
        edge.set(a, points[(i + 1) % points.length]);
        const distance = edge.closestPointToPoint(point, true, closest).distanceTo(point);
        if (distance >= nearest) return;
        nearest = distance;
        const along = edge.delta(new THREE.Vector3());
        axis = ['x', 'y', 'z'].reduce((best, candidate) =>
          Math.abs(along[candidate]) > Math.abs(along[best]) ? candidate : best);
      });
    }

    // Grid positions strictly inside the face's extent along the axis.
    const step = this.snapGrid.activeStep;
    const coordinates = points.map((p) => p[axis]);
    const first = Math.ceil((Math.min(...coordinates) + 1e-6) / step);
    const last = Math.floor((Math.max(...coordinates) - 1e-6) / step);
    const axisChanged = axis !== cut.axis;
    cut.axis = axis;
    // No grid line crosses the face along this axis: there is nothing to cut.
    cut.value = first > last ? null : THREE.MathUtils.clamp(Math.round(point[axis] / step), first, last) * step;
    // The drawn line glides to a new position along the same axis, and jumps otherwise.
    if (axisChanged || cut.shown === null || cut.value === null) cut.shown = cut.value;
    this.animateCut();
    this.emitChange();
  }

  // Runs for as long as a cut is being placed: every frame moves the drawn line
  // towards the cut's position and lets its dashes flow. Dispatches 'cutframe'
  // for the other views that draw the line.
  animateCut() {
    if (this.cutFrame) return;
    let last = performance.now();
    const tick = (now) => {
      this.cutFrame = null;
      const cut = this.cut;
      if (!cut) return;
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      cut.time += dt;

      if (cut.value !== null) {
        // lerp(current, target, t), with t taken from the frame time so that
        // the glide lasts the same at any frame rate.
        cut.shown = THREE.MathUtils.lerp(cut.shown, cut.value, 1 - Math.exp(-CUT_GLIDE * dt));
        if (Math.abs(cut.shown - cut.value) < 1e-4) cut.shown = cut.value;
      }
      cut.segments = cut.value === null ? [] : this.mesh.planeSegments(cut.faces, cut.axis, cut.shown);

      const pixel = this.viewport.worldPerPixel(); // the dashes keep their size on screen
      this.view.setCutPreview(cut.segments, {
        dash: CUT_DASH * pixel,
        gap: CUT_GAP * pixel,
        phase: cut.time * CUT_FLOW * pixel,
      });
      this.viewport.render();
      this.dispatchEvent(new Event('cutframe'));
      this.cutFrame = requestAnimationFrame(tick);
    };
    tick(last);
  }

  applyCut() {
    const { faces, axis, value } = this.cut;
    if (value === null) return;
    const before = this.snapshot();
    const result = this.mesh.planeCut(faces, axis, value);
    if (!result.changed) return;
    this.history.push(before);
    this.selection = new Set(result.vertices);
    this.rebuildView(); // also ends the cut
    this.setOperation(null); // one cut per activation
  }

  // Drops the cut line. Returns false if there was none.
  cancelCut() {
    if (!this.cut) return false;
    this.cut = null;
    this.view.setCutPreview([]);
    this.emitChange();
    return true;
  }

  // --- box selection -----------------------------------------------------

  stretchBox(clientX, clientY) {
    const box = this.box;
    box.x1 = clientX;
    box.y1 = clientY;
    box.active ||= Math.hypot(clientX - box.x0, clientY - box.y0) > CLICK_TOLERANCE;
    this.showBox();
  }

  showBox() {
    const box = this.box;
    this.boxElement.hidden = !box?.active;
    if (!box?.active) return;
    const origin = this.viewport.container.getBoundingClientRect();
    const { style } = this.boxElement;
    style.left = `${Math.min(box.x0, box.x1) - origin.left}px`;
    style.top = `${Math.min(box.y0, box.y1) - origin.top}px`;
    style.width = `${Math.abs(box.x1 - box.x0)}px`;
    style.height = `${Math.abs(box.y1 - box.y0)}px`;
  }

  // Ends a Shift press. A drag replaces the selection with the visible vertices
  // inside the box; a plain click toggles the element under the pointer, or
  // deselects everything on empty space.
  finishBox() {
    const box = this.box;
    this.box = null;
    this.showBox();
    if (box.active) {
      const screen = this.screenProjector(0, 0);
      const origin = this.viewport.renderer.domElement.getBoundingClientRect();
      const left = Math.min(box.x0, box.x1) - origin.left;
      const right = Math.max(box.x0, box.x1) - origin.left;
      const top = Math.min(box.y0, box.y1) - origin.top;
      const bottom = Math.max(box.y0, box.y1) - origin.top;
      const inside = [];
      this.mesh.vertices.forEach((vertex, i) => {
        const p = screen.project(vertex);
        if (!p || p.x < left || p.x > right || p.y < top || p.y > bottom) return;
        if (!this.isOccluded(vertex)) inside.push(i);
      });
      this.selectVertices(inside);
    } else if (box.key === null) {
      this.clearSelection();
    } else {
      this.select(box.key, true);
    }
  }

  // Drops a selection box in progress. Returns false if there was none.
  cancelBox() {
    if (!this.box) return false;
    this.box = null;
    this.showBox();
    return true;
  }

  // --- dragging ----------------------------------------------------------

  // Starts a press on a single vertex from another view (see OrthoViews).
  // Follow with dragTo() on pointer moves and endDrag() on release.
  pressVertex(vertex, clientX, clientY, additive, viewer) {
    this.drag = {
      vertex,
      // Outside vertex mode a vertex is not a selectable element.
      key: this.mode === 'vertex' ? vertex : null,
      x: clientX,
      y: clientY,
      additive,
      start: null,
      viewer,
    };
  }

  dragTo(clientX, clientY) {
    const drag = this.drag;
    if (!drag.start) {
      if (Math.hypot(clientX - drag.x, clientY - drag.y) <= CLICK_TOLERANCE) return;
      this.beginDrag();
    }
    drag.lastX = clientX;
    drag.lastY = clientY;
    const point =
      drag.plane && drag.viewer.ray(clientX, clientY).intersectPlane(drag.plane, new THREE.Vector3());
    const vertex = this.mesh.vertices[drag.index];
    // Always offset the snapshot, never the current position, to avoid drift.
    vertex.copy(drag.start);
    if (point) {
      const delta = point.sub(drag.grab);
      if (drag.axis) delta.projectOnVector(drag.axis);
      this.snapGrid.snap(vertex.add(delta));
    }
    // The rest of the dragged group follows the grabbed vertex rigidly.
    const offset = vertex.clone().sub(drag.start);
    for (const [i, start] of drag.others) this.mesh.vertices[i].copy(start).add(offset);
    this.snapGrid.focus(vertex);
    this.view.updatePositions();
    this.emitChange();
  }

  beginDrag() {
    const drag = this.drag;
    drag.before = this.snapshot();
    if (this.operation === 'pencil') this.sproutVertex(drag);
    // The grabbed element's vertex nearest to the cursor leads the drag: the
    // constraint and the grid snap apply to it, the rest follows rigidly.
    drag.index = drag.vertex ?? this.nearestVertex(this.elementVertices(drag.key), drag.x, drag.y);
    const vertex = this.mesh.vertices[drag.index];
    drag.start = vertex.clone();
    this.constrainDrag();

    // Grabbing a selected element drags the whole selection; grabbing an unselected
    // one drags it alone, or joins it to the selection when Shift is held.
    if (drag.key !== null && !this.picked.has(drag.key)) {
      if (!drag.additive) this.picked.clear();
      this.picked.add(drag.key);
      this.syncSelection();
    }
    // A lone vertex pressed outside vertex mode moves by itself unless it
    // belongs to the selection; the selection is left as it is.
    const group = this.selection.has(drag.index) ? this.selection : [];
    drag.others = new Map();
    for (const i of group) {
      if (i !== drag.index) drag.others.set(i, this.mesh.vertices[i].clone());
    }
    this.refreshHighlight();
    this.gizmo.detach();
    this.viewport.renderer.domElement.style.cursor = 'grabbing';
  }

  // Picks the plane the cursor is projected onto, according to the view the
  // drag happens in and the current axis lock.
  constrainDrag() {
    const drag = this.drag;
    const { viewer } = drag;
    drag.axis = AXIS_LOCKS[this.axisLock];

    // Free: the vertex slides in the plane through it that is parallel to the
    // view. In an axis-aligned view that is a grid plane ('xz', ...).
    const lock = drag.axis ? this.axisLock : viewer.planeAxes ?? 'free';
    const normal = viewer.planeNormal();
    if (drag.axis) {
      // Locked: the plane through the axis that faces the viewer as much as possible.
      const view = viewer.viewDirection(drag.start);
      normal.copy(view).addScaledVector(drag.axis, -view.dot(drag.axis));
      // The axis points almost straight at the viewer: the cursor can't express
      // movement along it, so the vertex stays put instead of flying away.
      if (normal.length() < MIN_AXIS_SINE) {
        drag.plane = null;
        this.snapGrid.begin(drag.start, lock, null);
        return;
      }
      normal.normalize();
    }
    drag.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, drag.start);
    drag.grab =
      viewer.ray(drag.x, drag.y).intersectPlane(drag.plane, new THREE.Vector3()) ??
      drag.start.clone();
    this.snapGrid.begin(drag.start, lock, drag.plane);
  }

  endDrag() {
    const drag = this.drag;
    const { key, additive, start, before } = drag;
    this.drag = null;
    this.snapGrid.end();
    // The drag may have run in another view, with nothing hovered in this one.
    this.viewport.renderer.domElement.style.cursor = this.hovered === null ? '' : 'grab';
    if (!start) {
      // Never left the dead zone: a plain click.
      if (key !== null) this.select(key, additive);
      return;
    }
    if (drag.parent !== undefined) this.finishPencil(drag);
    this.commit(before); // the whole drag is one undo step
    this.placeGizmo();
    this.emitChange();
  }

  // --- pencil ------------------------------------------------------------

  // Pencil: a drag that starts on a vertex does not move it but pulls a new
  // vertex out of it, joined to it by an edge. Called as the drag begins.
  sproutVertex(drag) {
    drag.parent = drag.vertex ?? drag.key;
    const child = this.mesh.sprout(drag.parent);
    this.selection = new Set([child]);
    this.rebuildView(); // drops the drag in progress...
    this.drag = drag; // ...which goes on with the new vertex
    drag.vertex = child;
    drag.key = child;
  }

  // The pencil's new vertex was released. On top of another vertex it is not
  // kept: the edge goes to that vertex instead, and a loop it closes becomes a
  // face. Back on its parent, nothing is left of it.
  finishPencil(drag) {
    const child = drag.index;
    const target = this.pencilTarget(child, drag.viewer);
    if (target === null) return;
    this.mesh.removeVertices(new Set([child])); // the newest vertex: nothing is renumbered
    if (target !== drag.parent) {
      this.mesh.connect(drag.parent, target);
      const facing = drag.viewer.viewDirection(this.mesh.vertices[target]);
      this.mesh.closeLoop(drag.parent, target, facing);
    }
    this.selection = new Set([target]);
    this.rebuildView();
  }

  // The vertex the given one was dropped onto, or null. In an axis-aligned view
  // "onto" means the same spot in the view, whatever the depth (the nearest in
  // depth wins); in the perspective view it means the same point in space.
  pencilTarget(vertex, viewer) {
    const position = this.mesh.vertices[vertex];
    const flat = viewer.planeAxes ? [...viewer.planeAxes] : ['x', 'y', 'z'];
    let best = null;
    let bestDistance = Infinity;
    this.mesh.vertices.forEach((other, i) => {
      if (i === vertex || flat.some((axis) => Math.abs(other[axis] - position[axis]) > 1e-6)) return;
      const distance = other.distanceTo(position);
      if (distance >= bestDistance) return;
      best = i;
      bestDistance = distance;
    });
    return best;
  }

  // Aborts the drag in progress and restores the vertices. Returns false if there was none.
  cancelDrag() {
    if (!this.drag) return false;
    const { index, start, others, parent, before } = this.drag;
    this.drag = null;
    this.snapGrid.end();
    this.viewport.renderer.domElement.style.cursor = '';
    if (start && parent !== undefined) {
      this.restore(before); // the pencil's new vertex goes away with its edge
    } else if (start) {
      this.mesh.vertices[index].copy(start);
      for (const [i, position] of others) this.mesh.vertices[i].copy(position);
      this.view.updatePositions();
      this.placeGizmo();
      this.emitChange();
    }
    return true;
  }

  // Ray from the camera through a pointer position.
  pointerRay(clientX, clientY) {
    const { camera, renderer } = this.viewport;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, camera);
    this.raycaster.far = Infinity;
    return this.raycaster.ray;
  }

  setHovered(key) {
    if (key === this.hovered) return;
    this.hovered = key;
    this.viewport.renderer.domElement.style.cursor = key === null ? '' : 'grab';
    this.refreshHighlight();
  }

  // --- elements ----------------------------------------------------------

  // Vertex indices that make up an element of the current mode.
  elementVertices(key) {
    switch (this.mode) {
      case 'edge': return key.split('_').map(Number);
      case 'face': return this.mesh.faces[key];
      case 'object': return this.topology.islands[key].vertices;
      default: return [key];
    }
  }

  // Keys of every element of the current mode.
  allElements() {
    switch (this.mode) {
      case 'edge': return this.topology.edges.map(([a, b]) => edgeKey(a, b));
      case 'face': return this.mesh.faces.map((_, i) => i);
      case 'object': return this.topology.islands.map((_, i) => i);
      default: return this.mesh.vertices.map((_, i) => i);
    }
  }

  // Derived connectivity; recomputed whenever the topology changes.
  updateTopology() {
    const islands = this.mesh.islands();
    const islandOfFace = [];
    const islandOfVertex = [];
    islands.forEach((island, i) => {
      for (const face of island.faces) islandOfFace[face] = i;
      for (const vertex of island.vertices) islandOfVertex[vertex] = i;
    });
    this.topology = { edges: this.mesh.edges(), islands, islandOfFace, islandOfVertex };
  }

  // Makes `selection` the vertices of the picked elements.
  syncSelection() {
    this.selection = new Set([...this.picked].flatMap((key) => this.elementVertices(key)));
    this.updateTarget();
  }

  // Retargets to the islands that hold the selection. Without a selection the
  // current target is kept, only re-expanded to whole islands.
  updateTarget() {
    const { islands, islandOfVertex } = this.topology;
    const seeds = this.selection.size ? this.selection : this.target;
    const ids = new Set(
      [...seeds].filter((vertex) => vertex < this.mesh.vertices.length).map((vertex) => islandOfVertex[vertex]),
    );
    this.target = new Set([...ids].flatMap((id) => islands[id].vertices));
  }

  // Re-expresses the vertex selection in the current mode: an element is
  // picked when all of its vertices are selected.
  adoptSelection() {
    const vertices = this.selection;
    this.picked = new Set(
      this.allElements().filter((key) => this.elementVertices(key).every((i) => vertices.has(i))),
    );
    this.syncSelection();
  }

  // Pushes selection and hover to the view.
  refreshHighlight() {
    const { mode, hovered } = this;
    const faces = (keys) => {
      if (mode === 'face') return keys;
      if (mode === 'object') return keys.flatMap((key) => this.topology.islands[key].faces);
      return [];
    };
    const edges = (keys) => (mode === 'edge' ? keys.map((key) => this.elementVertices(key)) : []);
    const selected = [...this.picked];
    const hover = hovered === null ? [] : [hovered];

    // Vertex points would only get in the way of aiming at edges and faces.
    this.view.points.visible = mode === 'vertex' || this.operation !== null;
    this.view.updateColors(this.selection, mode === 'vertex' && hovered !== null ? hovered : -1);
    this.view.setHighlight({
      selectedFaces: faces(selected),
      hoveredFaces: faces(hover),
      selectedEdges: edges(selected),
      hoveredEdges: edges(hover),
    });
    this.viewport.requestRender();
  }

  // --- selection ---------------------------------------------------------

  select(key, additive) {
    if (additive) {
      if (key === null) return;
      if (this.picked.has(key)) this.picked.delete(key);
      else this.picked.add(key);
    } else {
      this.picked.clear();
      if (key !== null) this.picked.add(key);
    }
    this.syncSelection();
    this.selectionChanged();
  }

  // --- picking -----------------------------------------------------------

  // Key of the current mode's element under the pointer, or null.
  pickElement(clientX, clientY) {
    switch (this.mode) {
      case 'edge': return this.pickEdge(clientX, clientY);
      case 'face': return this.pickFace(clientX, clientY);
      case 'object': {
        const face = this.pickFace(clientX, clientY);
        return face === null ? null : this.topology.islandOfFace[face];
      }
      default: return this.pickVertex(clientX, clientY);
    }
  }

  // Maps world points to canvas pixels for one pointer position.
  screenProjector(clientX, clientY) {
    const { camera, renderer } = this.viewport;
    const rect = renderer.domElement.getBoundingClientRect();
    const projected = new THREE.Vector3();
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
      // Null when the point is behind the camera or beyond the far plane.
      project(point) {
        projected.copy(point).project(camera);
        if (projected.z < -1 || projected.z > 1) return null;
        return {
          x: (projected.x * 0.5 + 0.5) * rect.width,
          y: (-projected.y * 0.5 + 0.5) * rect.height,
        };
      },
    };
  }

  // Nearest visible vertex within PICK_RADIUS pixels of the pointer.
  pickVertex(clientX, clientY) {
    const screen = this.screenProjector(clientX, clientY);
    let best = null;
    let bestDistance = PICK_RADIUS;
    this.mesh.vertices.forEach((vertex, i) => {
      const p = screen.project(vertex);
      if (!p) return;
      const distance = Math.hypot(p.x - screen.x, p.y - screen.y);
      if (distance > bestDistance || this.isOccluded(vertex)) return;
      best = i;
      bestDistance = distance;
    });
    return best;
  }

  // Nearest visible edge within EDGE_PICK_RADIUS pixels of the pointer.
  pickEdge(clientX, clientY) {
    const screen = this.screenProjector(clientX, clientY);
    let best = null;
    let bestDistance = EDGE_PICK_RADIUS;
    for (const [a, b] of this.topology.edges) {
      const start = this.mesh.vertices[a];
      const end = this.mesh.vertices[b];
      const p = screen.project(start);
      const q = screen.project(end);
      if (!p || !q) continue;
      // Closest point of the on-screen segment to the pointer.
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const lengthSq = dx * dx + dy * dy;
      const t = lengthSq
        ? THREE.MathUtils.clamp(((screen.x - p.x) * dx + (screen.y - p.y) * dy) / lengthSq, 0, 1)
        : 0;
      const distance = Math.hypot(p.x + t * dx - screen.x, p.y + t * dy - screen.y);
      if (distance > bestDistance || this.isOccluded(start.clone().lerp(end, t))) continue;
      best = edgeKey(a, b);
      bestDistance = distance;
    }
    return best;
  }

  // The face the pointer ray hits first.
  pickFace(clientX, clientY) {
    this.pointerRay(clientX, clientY);
    const [hit] = this.raycaster.intersectObject(this.view.solid, false);
    return hit ? this.view.triangleFaces[hit.faceIndex] : null;
  }

  // Of the given vertices, the one closest to the pointer on screen.
  nearestVertex(indices, clientX, clientY) {
    const screen = this.screenProjector(clientX, clientY);
    let best = indices[0];
    let bestDistance = Infinity;
    for (const i of indices) {
      const p = screen.project(this.mesh.vertices[i]);
      const distance = p ? Math.hypot(p.x - screen.x, p.y - screen.y) : Infinity;
      if (distance < bestDistance) {
        best = i;
        bestDistance = distance;
      }
    }
    return best;
  }

  // Whether the surface hides a point (a vertex or a point on an edge) from the camera.
  isOccluded(vertex) {
    // A wireframe (the shading mode, or the look of a modal operation) hides nothing.
    if (this.shading === 'wireframe' || this.operation) return false;
    const origin = this.viewport.camera.position;
    const direction = vertex.clone().sub(origin);
    const distance = direction.length();
    this.raycaster.set(origin, direction.normalize());
    // Stop just short of the point so the faces it lies on don't count.
    this.raycaster.far = distance * (1 - 1e-3);
    return this.raycaster.intersectObject(this.view.solid, false).length > 0;
  }

  // --- commands ----------------------------------------------------------

  setTool(tool) {
    if (!(tool in TOOLS)) return;
    this.tool = tool;
    this.placeGizmo();
    this.emitChange();
  }

  setMode(mode) {
    if (!MODES.includes(mode) || mode === this.mode) return;
    this.cancelDrag();
    // A mode the current operation can't work in leaves the operation for it.
    if (this.operation && !OPERATION_MODES[this.operation].includes(mode)) {
      this.modeBeforeOperation = mode;
      this.setOperation(null);
      return;
    }
    this.cancelExtrude();
    // A mode picked inside an operation is the one to stay in after it.
    if (this.operation) this.modeBeforeOperation = mode;
    this.mode = mode;
    this.hovered = null;
    this.viewport.renderer.domElement.style.cursor = '';
    // A new mode starts with nothing selected; the edit target is kept.
    this.picked.clear();
    this.syncSelection();
    this.selectionChanged();
  }

  setAxisLock(mode) {
    // During an extrusion the keys pick its direction instead, like its popup.
    if (this.extrude) {
      this.setExtrudeAxis(mode);
      return;
    }
    // And in the polygon tool, its work plane.
    if (this.polygon) {
      this.setPolygonPlane(mode);
      return;
    }
    if (!(mode in AXIS_LOCKS) || mode === this.axisLock) return;
    this.axisLock = mode;
    if (this.cut) this.placeCut(this.cut.point); // the lock is the cut's axis
    // Switching mid-drag re-applies the whole drag under the new constraint.
    if (this.drag?.start) {
      this.constrainDrag();
      this.dragTo(this.drag.lastX, this.drag.lastY);
    }
    this.emitChange();
  }

  // Fine snapping (a tenth of the grid step) while the precision modifier is held.
  setFineSnap(on) {
    if (on === this.snapGrid.fine) return;
    this.snapGrid.fine = on;
    if (this.cut) this.placeCut(this.cut.point);
    if (this.polygon?.axis) this.showPolygonGrid();
    if (this.drag?.start) {
      this.constrainDrag();
      this.dragTo(this.drag.lastX, this.drag.lastY);
    }
    // Takes effect on the next pointer move of a gizmo drag.
    if (this.gizmo.dragging && this.gizmo.mode === 'translate') this.beginGizmoSnap();
  }

  // Makes the given vertices the selection. Outside vertex mode this selects
  // the elements whose vertices are all among them.
  selectVertices(vertices) {
    this.selection = new Set(vertices);
    this.adoptSelection();
    this.selectionChanged();
  }

  // Selects a whole object, by its index in the objects list; from any mode
  // this goes to object mode. `additive` toggles it in the selection.
  selectObject(index, additive) {
    if (this.busy()) return;
    if (this.operation) this.setOperation(null);
    if (this.mode !== 'object') this.setMode('object');
    this.select(index, additive);
  }

  // Renames an object; a name already taken gets a numbered suffix.
  renameObject(index, name) {
    const object = this.mesh.objects[index];
    name = name.trim();
    if (!object || !name || name === object.name || this.busy()) return;
    this.history.push(this.snapshot());
    object.name = this.mesh.freeName(name, object);
    this.updateTopology(); // the names are copied there
    this.emitChange();
  }

  selectAll() {
    this.picked = new Set(this.allElements());
    this.syncSelection();
    this.selectionChanged();
  }

  clearSelection() {
    this.picked.clear();
    this.syncSelection();
    this.selectionChanged();
  }

  addCube() {
    if (this.busy()) return;
    const before = this.snapshot();
    this.selection = new Set(this.mesh.addCube());
    this.commit(before);
    this.rebuildView();
    this.setTool('move');
  }

  // Vertices and objects go with every face that uses them; faces and edges
  // take only the faces themselves and the vertices left unused.
  deleteSelection() {
    if (this.picked.size === 0 || this.busy()) return;
    this.history.push(this.snapshot());
    let remap;
    if (this.mode === 'face') {
      remap = this.mesh.removeFaces(this.picked);
    } else if (this.mode === 'edge') {
      const faces = new Set();
      this.mesh.faces.forEach((face, i) => {
        const hasPickedEdge = face.some((a, j) =>
          this.picked.has(edgeKey(a, face[(j + 1) % face.length])));
        if (hasPickedEdge) faces.add(i);
      });
      this.mesh.wires = this.mesh.wires.filter(([a, b]) => !this.picked.has(edgeKey(a, b)));
      remap = this.mesh.removeFaces(faces);
    } else {
      remap = this.mesh.removeVertices(this.selection);
    }
    // What is left of the edited object stays the target.
    this.target = new Set([...this.target].filter((i) => remap.has(i)).map((i) => remap.get(i)));
    this.selection.clear();
    this.rebuildView();
    this.placeGizmo();
    this.emitChange();
  }

  newScene() {
    if (this.busy()) return;
    const before = this.snapshot();
    this.mesh.vertices = [];
    this.mesh.faces = [];
    this.mesh.wires = [];
    this.mesh.objects = [];
    this.mesh.vertexObject = [];
    this.mesh.addCube();
    this.selection.clear();
    this.target = new Set(this.mesh.vertices.keys());
    this.commit(before);
    this.rebuildView();
    this.placeGizmo();
    this.emitChange();
  }

  frame() {
    const { vertices } = this.mesh;
    const points = this.selection.size ? [...this.selection].map((i) => vertices[i]) : vertices;
    this.viewport.frame(points);
  }

  // Moves the selection so that its center lands on `value` along `axis` ('x' | 'y' | 'z').
  setSelectionCenter(axis, value) {
    if (this.selection.size === 0 || !Number.isFinite(value) || this.busy()) return;
    const before = this.snapshot();
    const offset = value - this.selectionCenter()[axis];
    for (const i of this.selection) this.mesh.vertices[i][axis] += offset;
    this.commit(before);
    this.view.updatePositions();
    this.placeGizmo();
    this.emitChange();
  }

  // --- history -----------------------------------------------------------

  undo() {
    if (this.busy()) return;
    const state = this.history.undo(this.snapshot());
    if (state) this.restore(state);
  }

  redo() {
    if (this.busy()) return;
    const state = this.history.redo(this.snapshot());
    if (state) this.restore(state);
  }

  // A drag in progress owns the mesh; history must not change it underneath.
  busy() {
    return (
      Boolean(this.drag?.start) ||
      this.gizmo.dragging ||
      this.extrude !== null ||
      Boolean(this.polygon?.points.length)
    );
  }

  // Copy of the document: the mesh plus the selection that goes with it.
  snapshot() {
    return {
      vertices: this.mesh.vertices.map((vertex) => vertex.clone()),
      faces: this.mesh.faces.map((face) => [...face]),
      wires: this.mesh.wires.map((wire) => [...wire]),
      objects: this.mesh.objects.map((object) => ({ ...object })),
      vertexObject: [...this.mesh.vertexObject],
      nextObjectId: this.mesh.nextObjectId,
      selection: [...this.selection],
      target: [...this.target],
    };
  }

  restore(state) {
    this.mesh.vertices = state.vertices.map((vertex) => vertex.clone());
    this.mesh.faces = state.faces.map((face) => [...face]);
    this.mesh.wires = state.wires.map((wire) => [...wire]);
    // A state from before objects existed has none; the mesh then makes them up.
    this.mesh.objects = (state.objects ?? []).map((object) => ({ ...object }));
    this.mesh.vertexObject = [...(state.vertexObject ?? [])];
    this.mesh.nextObjectId = Math.max(this.mesh.nextObjectId, state.nextObjectId ?? 1);
    this.selection = new Set(state.selection);
    this.target = new Set(state.target);
    this.rebuildView();
    this.placeGizmo();
    this.emitChange();
  }

  // Records `before` as an undo step if the mesh actually changed since then.
  commit(before) {
    const { vertices, faces, wires } = this.mesh;
    const changed =
      vertices.length !== before.vertices.length ||
      faces.length !== before.faces.length ||
      wires.length !== before.wires.length ||
      vertices.some((vertex, i) => !vertex.equals(before.vertices[i]));
    if (changed) this.history.push(before);
  }

  // --- debugging ---------------------------------------------------------

  // The whole project as plain text, for bug reports: the mesh, what is
  // selected and the editor's state.
  toText() {
    const { vertices, faces, wires } = this.mesh;
    const number = (value) => String(+value.toFixed(5));
    const list = (values) => (values.length ? values.join(' ') : '—');
    const sorted = (values) => [...values].sort((a, b) => a - b);
    const { camera, orbit } = this.viewport;
    const point = (p) => [p.x, p.y, p.z].map(number).join(' ');

    return [
      'verTEX — проект как текст',
      `режим: ${this.mode} | инструмент: ${this.tool} | операция: ${this.operation ?? 'нет'} | фиксация оси: ${this.axisLock} | шаг сетки: ${this.snapGrid.step}`,
      `камера: позиция ${point(camera.position)} | цель ${point(orbit.target)}`,
      `история: отмен ${this.history.undoStack.length}, повторов ${this.history.redoStack.length}`,
      '',
      `вершины (${vertices.length}) — номер: x y z`,
      ...vertices.map((vertex, i) => `  ${i}: ${point(vertex)}`),
      '',
      `грани (${faces.length}) — номер: номера вершин по обходу`,
      ...faces.map((face, i) => `  ${i}: ${face.join(' ')}`),
      '',
      `висящие рёбра (${wires.length}) — номер: две вершины`,
      ...wires.map((wire, i) => `  ${i}: ${wire.join(' ')}`),
      '',
      `объекты (${this.topology.islands.length}) — номер «имя»: вершины | грани`,
      ...this.topology.islands.map(
        (island, i) => `  ${i} «${island.name}»: ${list(island.vertices)} | ${list(island.faces)}`,
      ),
      '',
      `выделение, элементы режима «${this.mode}»: ${list([...this.picked])}`,
      `выделение, вершины: ${list(sorted(this.selection))}`,
      `редактируемый объект (таргет), вершины: ${list(sorted(this.target))}`,
    ].join('\n');
  }

  // --- helpers -----------------------------------------------------------

  // Bounds of the selected vertices.
  selectionBox() {
    return new THREE.Box3().setFromPoints([...this.selection].map((i) => this.mesh.vertices[i]));
  }

  selectionCenter() {
    const center = new THREE.Vector3();
    for (const i of this.selection) center.add(this.mesh.vertices[i]);
    return center.divideScalar(this.selection.size || 1);
  }

  // Topology changed: element keys are no longer valid, so hover and drag are
  // dropped and the picked elements are rebuilt from the vertex selection.
  rebuildView() {
    this.drag = null;
    this.cut = null;
    this.view.setCutPreview([]);
    this.snapGrid.end();
    this.hovered = null;
    this.viewport.renderer.domElement.style.cursor = '';
    this.view.rebuild();
    this.updateTopology();
    this.adoptSelection();
    this.refreshHighlight();
  }

  selectionChanged() {
    this.refreshHighlight();
    this.placeGizmo();
    this.emitChange();
  }

  emitChange() {
    this.dispatchEvent(new Event('change'));
  }
}
