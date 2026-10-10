import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { EditableMesh, MeshView, edgeKey, cloneFace } from './mesh.js';
import { SnapGrid } from './snap-grid.js';
import { History } from './history.js';
import { Mirror } from './mirror.js';
import { quaternionOf, rotationOf, setRotation } from './frames.js';
import { Atlas } from './atlas.js';
import { unwrap, START_SIZE, PADDING } from './unwrap.js';
import { theme, onThemeChange } from './theme.js';

// Tool id -> gizmo mode (null = no gizmo).
export const TOOLS = {
  select: null,
  move: 'translate',
  rotate: 'rotate',
  scale: 'scale',
  pivot: 'translate', // moves the pivot point of the selected object, not the object
};

const PIVOT_MARKER_SIZE = 18; // px
const PIVOT_INNER_SIZE = 13; // px; the pivot points of what a selected group holds

// The pivot marker's picture: a ring with a dot and four ticks, white, to be tinted.
function pivotTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d');
  context.strokeStyle = context.fillStyle = '#fff';
  context.lineWidth = 6;
  context.beginPath();
  context.arc(32, 32, 17, 0, Math.PI * 2);
  context.stroke();
  context.beginPath();
  context.arc(32, 32, 6, 0, Math.PI * 2);
  context.fill();
  for (const [x, y, w, h] of [[29, 0, 6, 13], [29, 51, 6, 13], [0, 29, 13, 6], [51, 29, 13, 6]]) {
    context.fillRect(x, y, w, h);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

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
export const OPERATION_MODES = { cut: ['face'], extrude: ['face', 'edge'], pencil: ['vertex'], polygon: ['face'], place: ['object'] };

// The place tool: the sides of an object's bounds, along its own axes, that it can lie on.
export const PLACE_SIDES = {
  '-y': { axis: 'y', sign: -1 }, '+y': { axis: 'y', sign: 1 },
  '-x': { axis: 'x', sign: -1 }, '+x': { axis: 'x', sign: 1 },
  '-z': { axis: 'z', sign: -1 }, '+z': { axis: 'z', sign: 1 },
};
const BLINK_DARK = 0.05; // the darkest shade of that outline (linear: a dark grey on screen)
const BLINK_PERIOD = 900; // ms, white to black and back, of a picked face's outline with the UV editor open
const PLACE_RING = 13; // px, the radius of the ring that follows the pointer
const PLACE_NORMAL = 92; // px, the length of the normal that comes out of it

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

// Adds a primitive to a mesh as a new object and returns its vertices, or
// undefined for an unknown kind. Options: cone { sides, size }, cylinder
// { sides, size, height }, sphere { segments, size }.
function buildPrimitive(mesh, kind, options) {
  switch (kind) {
    case 'cube': return mesh.addCube(options.size);
    case 'cone': return mesh.addCone(options.sides, options.size);
    case 'cylinder': return mesh.addCylinder(options.sides, options.size, options.height);
    case 'sphere': return mesh.addSphere(options.segments, options.size);
    default: return undefined;
  }
}

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
    this.focus = false; // the focus look, see setFocus()
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
    // The move and rotate gizmos stand along the axes of the object they move
    // (see setLocalAxes()) rather than the world's.
    this.localAxes = false;
    // Texturing (see unwrap.js): the project's pixels per unit of length, and its atlas.
    this.ppu = 16;
    this.uvLook = false; // the UV editor is open, see setUVLook()
    this.atlas = new Atlas();
    this.atlas.addEventListener('change', () => this.viewport.requestRender());
    // The place tool: what is being placed (see beginPlace()), and the side it lies on.
    this.place = null;
    this.placeSide = '-y';
    this.cutDirection = 'vertical'; // or 'horizontal': which way the cut tool cuts
    this.axisHold = null; // the lock to go back to when a held axis key is let go, see holdAxis()
    this.tool = 'select';
    this.raycaster = new THREE.Raycaster();
    this.snapGrid = new SnapGrid(viewport);
    this.history = new History();

    this.mesh = new EditableMesh();
    this.mesh.addCube();
    this.mirror = new Mirror(this); // mirror modeling, see mirror.js
    this.view = new MeshView(this.mesh);
    this.view.atlas = this.atlas;
    viewport.scene.add(this.view.group);
    // The vertex dots are hidden by the surface through a depth map of it.
    viewport.depthPass = {
      scene: this.view.depthScene,
      prepare: (camera, target) => this.view.prepareDepth(camera, target),
    };
    this.updateTopology();
    this.layOut(); // the first object's faces take their places on the atlas
    this.view.updateUVs(); // (the view was built before they had any)
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
    this.pivotMarker.material.color.set(theme.pivot);
    this.refreshHighlight(); // vertex colours, and a render
  }

  // --- gizmo -------------------------------------------------------------

  setupGizmo() {
    const { scene, camera, renderer, orbit } = this.viewport;

    // The gizmo drives this pivot; vertices follow the pivot's delta transform.
    this.pivot = new THREE.Object3D();
    scene.add(this.pivot);

    // Marks the pivot point of the selected object; a fixed size on screen,
    // seen through everything.
    this.pivotMarker = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: pivotTexture(), sizeAttenuation: false, depthTest: false, transparent: true }),
    );
    this.pivotMarker.renderOrder = 8;
    this.pivotMarker.visible = false;
    scene.add(this.pivotMarker);
    // The pivot points of everything inside a selected group: the same mark,
    // smaller, as many of them as are needed at the moment.
    this.pivotRings = [];

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
      // Scaling takes along the vertices folded onto the selected ones (a
      // face scaled flat is picked by one of its edges or corners), so that
      // they unfold together.
      const moved = this.gizmo.mode === 'scale' ? this.withFoldedTwins([...this.selection]) : [...this.selection];
      this.dragStartPositions = new Map(moved.map((i) => [i, this.mesh.vertices[i].clone()]));
      this.dragStartPivots = this.pivotsInMotion();
      this.dragStartRotations = this.gizmo.mode === 'rotate' ? this.rotationsInMotion() : new Map();
      // Scaling along the axes of a turned object, see placeGizmo(): its turn, or null.
      // The scale is worked out in the coordinates of those axes: where the
      // vertices and the gizmo were, there (`scaleStarts`, `scaleOrigin`).
      this.scaleTurn =
        this.gizmo.mode === 'scale' && this.pivot.quaternion.angleTo(new THREE.Quaternion()) > 1e-9
          ? this.pivot.quaternion.clone()
          : null;
      // The turn the gizmo stands in as the drag starts, and - for a move
      // along turned axes - the same again, or null.
      this.pivotStartTurn = this.pivot.quaternion.clone();
      this.moveTurn =
        this.gizmo.mode === 'translate' && this.pivotStartTurn.angleTo(new THREE.Quaternion()) > 1e-9
          ? this.pivotStartTurn
          : null;
      this.scaleStarts = this.dragStartPositions;
      this.scaleOrigin = this.pivotStart;
      if (this.scaleTurn) {
        const back = this.scaleTurn.clone().invert();
        this.scaleStarts = new Map(moved.map((i) => [i, this.mesh.vertices[i].clone().applyQuaternion(back)]));
        this.scaleOrigin = this.pivotStart.clone().applyQuaternion(back);
      }
      // The pivot tool moves the point alone: the entry it belongs to.
      this.pivotEdited = this.tool === 'pivot' ? this.pivotEntry() : null;
      if (this.gizmo.mode === 'translate') this.beginGizmoSnap();
      if (this.gizmo.mode === 'scale') this.scaleBox = this.selectionBox(this.scaleTurn);
    });
    this.gizmo.addEventListener('objectChange', () => this.applyGizmo());
    // Alt held while scaling: one-sided, see scaleCenter(). Pressing or
    // letting go of it mid-drag takes effect at once. (And Alt must not send
    // the keyboard to the window's menu while the scale tool is in hand.)
    this.altHeld = false;
    for (const type of ['keydown', 'keyup']) {
      window.addEventListener(type, (event) => {
        if (event.key !== 'Alt') return;
        if (this.tool === 'scale') event.preventDefault();
        this.setAltHeld(type === 'keydown');
      });
    }
    window.addEventListener('blur', () => this.setAltHeld(false));
    renderer.domElement.addEventListener('pointermove', (event) => this.setAltHeld(event.altKey));
    this.gizmo.addEventListener('mouseUp', () => {
      this.snapGrid.end();
      this.commit(this.gizmoBefore);
      this.placeGizmo();
    });
  }

  setAltHeld(on) {
    if (on === this.altHeld) return;
    this.altHeld = on;
    if (this.gizmo.dragging && this.gizmo.mode === 'scale') this.applyGizmo();
  }

  // The point a scale drag holds still. Normally the gizmo's own place; with
  // Alt held, the side of the selection opposite to the handle being pulled,
  // along each axis of that handle - so only the pulled side moves.
  // (Like the rest of a scale drag, in the coordinates of the axes it goes along.)
  scaleCenter() {
    const center = this.scaleOrigin.clone();
    const handle = (this.gizmo.axis ?? '').toLowerCase();
    if (!this.altHeld || handle.length === 3) return center; // the middle handle scales all round
    const grabbed = this.gizmo.pointStart.clone(); // where the handle was taken, from the gizmo's place
    if (this.scaleTurn) grabbed.applyQuaternion(this.scaleTurn.clone().invert());
    for (const axis of handle) {
      center[axis] = grabbed[axis] >= 0 ? this.scaleBox.min[axis] : this.scaleBox.max[axis];
    }
    return center;
  }

  // Applies the gizmo's drag, as it stands, to what is being dragged.
  applyGizmo() {
    const scaling = this.gizmo.mode === 'scale';
    const own = scaling ? this.scaleTurn : null; // the turn of the axes the scale goes along, see placeGizmo()
    const center = scaling ? this.scaleCenter() : null; // in the coordinates of those axes
    if (this.gizmo.mode === 'translate') this.snapPivot();
    if (scaling) {
      // No turning inside out: a scale drag stops at zero.
      const { scale } = this.pivot;
      for (const axis of ['x', 'y', 'z']) scale[axis] = Math.max(0, scale[axis]);
      if (this.snapGrid.enabled) this.snapScale(center);
    }
    if (this.pivotEdited !== null) {
      this.mesh.objects[this.pivotEdited].pivot = this.pivot.position.toArray();
      this.emitChange();
      return;
    }
    // Always transform the snapshot, never the current positions, to avoid drift.
    this.pivot.updateMatrix();
    let delta = this.pivot.matrix.clone().multiply(this.dragStartInverse);
    if (scaling) {
      // About the centre of this drag, which need not be the gizmo's place;
      // for a turned object, out of the world into its axes and back.
      const { scale } = this.pivot;
      const turn = new THREE.Matrix4().makeRotationFromQuaternion(own ?? new THREE.Quaternion());
      delta = turn.clone()
        .multiply(new THREE.Matrix4().makeTranslation(center.x, center.y, center.z))
        .multiply(new THREE.Matrix4().makeScale(scale.x, scale.y, scale.z))
        .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z))
        .multiply(turn.clone().invert());
    }
    for (const [i, start] of this.dragStartPositions) {
      this.mesh.vertices[i].copy(start).applyMatrix4(delta);
    }
    for (const [object, start] of this.dragStartPivots) {
      object.pivot = start.clone().applyMatrix4(delta).toArray();
    }
    // Whole objects being turned: so are their frames, by what the gizmo has
    // turned since the drag began.
    const turned = this.pivot.quaternion.clone().multiply(this.pivotStartTurn.clone().invert());
    for (const [object, start] of this.dragStartRotations) {
      setRotation(object, rotationOf(turned.clone().multiply(start)));
    }
    if (scaling) this.scaleFlat(center);
    this.mirror.moves(this.dragStartPositions);
    this.view.updatePositions();
    this.emitChange();
  }

  // --- scaling through zero and back --------------------------------------------

  // Scaled flat along an axis, a selection keeps no size there to scale: the
  // scale handle then sets its size outright, and each vertex goes back to
  // the side of the centre it was folded from (see mesh.folds). Along the
  // axes of the handle that the drag has just flattened, that side is noted.
  scaleFlat(center) {
    const handle = (this.gizmo.axis ?? '').toLowerCase();
    const axes = handle.length === 3 ? ['x', 'y', 'z'] : [...handle];
    const { scale } = this.pivot;
    const size = this.scaleBox.getSize(new THREE.Vector3());
    const reference = Math.max(size.x, size.y, size.z, 0.5) / 2; // one handle's pull adds this much to each side
    const fits = this.foldsFit(this.scaleTurn);
    for (const axis of axes) {
      if (size[axis] > 1e-9) {
        // Flattened by this drag: every vertex remembers its side.
        if (Math.abs(scale[axis]) < 1e-9) {
          for (const [i, start] of this.scaleStarts) {
            if (fits(i)) this.noteFold(i, axis, Math.sign(start[axis] - center[axis]));
          }
        }
        continue;
      }
      let half = reference * Math.max(0, scale[axis] - 1);
      if (this.snapGrid.enabled) half = Math.round(half / this.snapGrid.activeStep) * this.snapGrid.activeStep;
      this.unfold([...this.dragStartPositions.keys()], axis, center[axis], half, this.scaleTurn);
    }
  }

  // The indices plus every vertex of the same object standing in the same
  // place as one of them that remembers a side to unfold to.
  withFoldedTwins(indices) {
    const { vertices, vertexObject, folds } = this.mesh;
    const chosen = new Set(indices);
    const placeOf = (i) => vertexObject[i] + ':' + vertices[i].toArray().map((n) => Math.round(n * 1e4)).join(';');
    const places = new Set(indices.map(placeOf));
    vertices.forEach((_, i) => {
      if (!chosen.has(i) && folds.has(i) && places.has(placeOf(i))) chosen.add(i);
    });
    return [...chosen];
  }

  noteFold(index, axis, sign) {
    const { folds } = this.mesh;
    if (!folds.has(index)) folds.set(index, {});
    folds.get(index)[axis] = sign === 0 ? folds.get(index)[axis] ?? 0 : sign;
  }

  // Puts the vertices `half` away from `centre` along `axis`, each on the
  // side it was folded from. Nothing happens without sides to go to. With
  // `turn` (a quaternion) the axis is one of those turned by it, and `centre`
  // is in their coordinates.
  unfold(indices, axis, centre, half, turn = null) {
    const { folds, vertices } = this.mesh;
    const fits = this.foldsFit(turn);
    const side = (i) => (fits(i) ? folds.get(i)?.[axis] : undefined);
    const sides = new Set(indices.map(side).filter((sign) => sign));
    if (sides.size < 2) return false;
    const back = turn?.clone().invert();
    for (const i of indices) {
      const vertex = vertices[i];
      if (turn) vertex.applyQuaternion(back);
      vertex[axis] = centre + (side(i) ?? 0) * half;
      if (turn) vertex.applyQuaternion(turn);
    }
    return true;
  }

  // Sets up the snap grid for the move gizmo handle being dragged ('X', 'XY',
  // 'XYZ', ...). The lattice starts at the pivot, so its travel snaps to whole steps.
  beginGizmoSnap() {
    const handle = this.gizmo.axis.toLowerCase();
    const start = this.pivotStart;
    if (this.moveTurn) {
      // Along turned axes (which do not lie on the grid) the lattice is turned
      // too and starts where the gizmo is: the travel goes in whole steps.
      if (handle.length < 3) {
        this.snapGrid.begin(start, handle, null, start, false, this.moveTurn);
      } else {
        const facing = this.viewport.camera.position.clone().sub(start).normalize();
        const across = new THREE.Plane().setFromNormalAndCoplanarPoint(facing, start);
        this.snapGrid.begin(start, 'free', across, start, false, this.moveTurn);
      }
      return;
    }
    // A pivot point being placed lands on the grid itself, not a step away from where it was.
    // (So does the pivot of a whole object being moved: it is its pivot that snaps.)
    const origin = this.tool === 'pivot' || this.pivotEntry() !== null ? undefined : start;
    if (handle.length < 3) {
      this.snapGrid.begin(start, handle, null, origin);
      return;
    }
    // The center handle slides the pivot in the plane that faces the camera.
    const normal = this.viewport.camera.position.clone().sub(start).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, start);
    this.snapGrid.begin(start, 'free', plane, origin);
  }

  // Snaps the move gizmo's pivot to the grid along the axes of the dragged
  // handle and keeps the other axes exactly in place.
  snapPivot() {
    const handle = this.gizmo.axis.toLowerCase();
    if (this.moveTurn) {
      // Along turned axes: nothing along the axes the handle has not got,
      // and the rest onto the turned lattice, see beginGizmoSnap().
      const travel = this.pivot.position.clone().sub(this.pivotStart).applyQuaternion(this.moveTurn.clone().invert());
      for (const axis of ['x', 'y', 'z']) if (!handle.includes(axis)) travel[axis] = 0;
      this.pivot.position.copy(this.pivotStart).add(travel.applyQuaternion(this.moveTurn));
      this.snapGrid.snap(this.pivot.position);
      this.snapGrid.focus(this.pivot.position);
      return;
    }
    for (const axis of ['x', 'y', 'z']) {
      if (!handle.includes(axis)) this.pivot.position[axis] = this.pivotStart[axis];
    }
    this.snapGrid.snap(this.pivot.position);
    this.snapGrid.focus(this.pivot.position);
  }

  // Snaps the scale gizmo so that the selection's size, not the factor, moves
  // in grid steps: along each axis of the dragged handle the side of the
  // selection that is farther from `center` (the point the drag holds still,
  // see scaleCenter()) lands on a grid line. With the centre in the middle of
  // the bounds, so does the other side.
  snapScale(center) {
    const step = this.snapGrid.activeStep;
    const { scale } = this.pivot;
    // How far the selection reaches from the centre along each axis, on the
    // side where it reaches farther (signed).
    const reach = new THREE.Vector3();
    for (const axis of ['x', 'y', 'z']) {
      const up = this.scaleBox.max[axis] - center[axis];
      const down = this.scaleBox.min[axis] - center[axis];
      reach[axis] = Math.abs(up) >= Math.abs(down) ? up : down;
    }
    const snapped = (axis) => {
      const half = reach[axis];
      if (Math.abs(half) < 1e-9) return scale[axis]; // flat along this axis: scaleFlat() takes it
      if (this.scaleTurn) {
        // Turned axes do not lie on the grid: there it is the size along the
        // axis that moves in whole steps (down to nothing, like below).
        const extent = this.scaleBox.max[axis] - this.scaleBox.min[axis];
        return (Math.round((extent * scale[axis]) / step) * step) / extent;
      }
      const side = Math.sign(half);
      let target = Math.round((center[axis] + half * scale[axis]) / step) * step - center[axis];
      // Down to nothing is allowed - the selection goes flat, a face shrinks
      // to a point - but never through to the other side.
      if (target * side < 1e-9) target = 0;
      return target / half;
    };

    const handle = (this.gizmo.axis ?? '').toLowerCase();
    if (handle.length === 3) {
      // Uniform: one factor for all, snapped by the longest side.
      const axis = ['x', 'y', 'z'].reduce((best, candidate) =>
        Math.abs(reach[candidate]) > Math.abs(reach[best]) ? candidate : best);
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
    const entry = this.pivotEntry();
    // The pivot tool needs an object to have a pivot; the others, something to move.
    const nothing = this.tool === 'pivot' ? entry === null : this.selection.size === 0;
    if (!mode || nothing || this.operation) {
      this.gizmo.detach();
    } else {
      // What belongs to a turned object is scaled along that object's own
      // axes: the scale handles (which follow the gizmo's own turn) stand
      // along them, and the bounds are taken along them too.
      // With local axes on, so are the move and the rotate gizmo. (A pivot
      // point is placed in the world.)
      const turn = mode === 'scale' || (this.localAxes && this.tool !== 'pivot') ? this.scaleFrame() : null;
      this.gizmo.setSpace(turn && mode !== 'scale' ? 'local' : 'world');
      if (entry !== null) {
        // One whole object or group: the gizmo stands in its pivot point.
        this.pivot.position.copy(this.pivotPoint(entry));
      } else {
        // Scaling pivots on the middle of the bounds, which keeps both sides on the grid.
        this.pivot.position.copy(
          this.tool === 'scale'
            ? this.selectionBox(turn).getCenter(new THREE.Vector3()).applyQuaternion(turn ?? new THREE.Quaternion())
            : this.selectionCenter(),
        );
      }
      this.pivot.quaternion.identity();
      if (turn) this.pivot.quaternion.copy(turn);
      this.pivot.scale.set(1, 1, 1);
      this.gizmo.setMode(mode);
      this.gizmo.attach(this.pivot);
    }
    this.updatePivotMarker();
    this.viewport.requestRender();
  }

  // --- pivot points --------------------------------------------------------

  // The entry of the objects list whose pivot point is in use: in object mode,
  // the one object or group that is the whole selection. Null otherwise.
  pivotEntry() {
    if (this.mode !== 'object') return null;
    const { islands } = this.topology;
    const whole = [...this.picked].filter(
      (key) => islands[key] && islands[key].group.length === this.selection.size,
    );
    // A group and the only thing in it are the same vertices: the one that
    // was picked by hand wins, or else the innermost.
    const active = whole.find((key) => islands[key].id === this.activeObject);
    if (active !== undefined) return active;
    return whole.find((key) => !islands[key].children.some((child) => whole.includes(child))) ?? null;
  }

  // The pivot point of an entry of the objects list: the one set for it, or
  // the middle of the bounds of everything in it.
  pivotPoint(index) {
    const object = this.mesh.objects[index];
    if (object.pivot) return new THREE.Vector3().fromArray(object.pivot);
    return this.middle(index) ?? new THREE.Vector3();
  }

  // The middle of the bounds of everything in an entry, or null if it is
  // empty. The bounds are taken along the entry's own axes (see frames.js),
  // so the middle turns with the entry instead of wandering as it is turned.
  middle(index) {
    const { vertices } = this.contents([index]);
    if (vertices.size === 0) return null;
    const points = [...vertices].map((i) => this.mesh.vertices[i]);
    const { rotation } = this.mesh.objects[index];
    if (!rotation) return new THREE.Box3().setFromPoints(points).getCenter(new THREE.Vector3());
    const turn = quaternionOf(rotation);
    const back = turn.clone().invert();
    return new THREE.Box3()
      .setFromPoints(points.map((point) => point.clone().applyQuaternion(back)))
      .getCenter(new THREE.Vector3())
      .applyQuaternion(turn);
  }

  // The entries of the objects list that are `index` and everything in it.
  entriesUnder(index, found = []) {
    const island = this.topology.islands[index];
    if (!island) return found;
    found.push(index);
    for (const child of island.children) this.entriesUnder(child, found);
    return found;
  }

  // The objects that travel as a whole with the selection in object mode -
  // the picked entries and what they hold - with the turn each has now.
  rotationsInMotion() {
    const moving = new Map();
    if (this.mode !== 'object') return moving;
    for (const picked of this.picked) {
      for (const index of this.entriesUnder(picked)) {
        const object = this.mesh.objects[index];
        if (!this.topology.islands[index].hidden) moving.set(object, quaternionOf(object.rotation));
      }
    }
    return moving;
  }

  // The pivot points that travel with the selection, as a Map from the object
  // to where its point is now: in object mode, those set on the picked
  // entries and on what they hold.
  pivotsInMotion() {
    const moving = new Map();
    if (this.mode !== 'object') return moving;
    const { islands } = this.topology;
    const add = (index) => {
      const island = islands[index];
      if (!island || island.hidden) return;
      const object = this.mesh.objects[index];
      if (object.pivot) moving.set(object, new THREE.Vector3().fromArray(object.pivot));
      island.children.forEach(add);
    };
    this.picked.forEach(add);
    return moving;
  }

  // Starts a press on the pivot point being edited, from a view that lets it
  // be dragged directly (see OrthoViews). Follow with dragPivotTo() on pointer
  // moves and endPivotDrag() on release. False when there is no such point.
  pressPivot(clientX, clientY, viewer) {
    const entry = this.tool === 'pivot' && !this.busy() ? this.pivotEntry() : null;
    if (entry === null) return false;
    this.pivotDrag = { entry, x: clientX, y: clientY, viewer, start: this.pivotPoint(entry), before: null };
    return true;
  }

  // The point slides in the view's plane, on the grid; an axis lock keeps it on that axis.
  dragPivotTo(clientX, clientY) {
    const drag = this.pivotDrag;
    drag.lastX = clientX;
    drag.lastY = clientY;
    const axis = AXIS_LOCKS[this.axisLock];
    if (!drag.before) {
      if (Math.hypot(clientX - drag.x, clientY - drag.y) <= CLICK_TOLERANCE) return;
      drag.before = this.snapshot();
      drag.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(drag.viewer.planeNormal(), drag.start);
      drag.grab = drag.viewer.ray(drag.x, drag.y).intersectPlane(drag.plane, new THREE.Vector3()) ?? drag.start.clone();
      drag.lock = null; // set below
    }
    const lock = axis ? this.axisLock : drag.viewer.planeAxes ?? 'free';
    if (lock !== drag.lock) {
      drag.lock = lock;
      this.snapGrid.begin(drag.start, lock, drag.plane);
    }
    const point = drag.start.clone();
    const hit = drag.viewer.ray(clientX, clientY).intersectPlane(drag.plane, new THREE.Vector3());
    if (hit) {
      const delta = hit.sub(drag.grab);
      if (axis) delta.projectOnVector(axis);
      this.snapGrid.snap(point.add(delta));
    }
    this.mesh.objects[drag.entry].pivot = point.toArray();
    this.snapGrid.focus(point);
    this.placeGizmo();
    this.emitChange();
  }

  endPivotDrag() {
    const drag = this.pivotDrag;
    this.pivotDrag = null;
    if (!drag?.before) return;
    this.snapGrid.end();
    this.commit(drag.before);
    this.placeGizmo();
    this.emitChange();
  }

  // Aborts the drag of the pivot point and puts it back. Returns false if there was none.
  cancelPivotDrag() {
    const drag = this.pivotDrag;
    if (!drag) return false;
    this.pivotDrag = null;
    if (!drag.before) return true;
    this.snapGrid.end();
    const object = this.mesh.objects[drag.entry];
    const was = drag.before.objects[drag.entry].pivot;
    if (was) object.pivot = was;
    else delete object.pivot;
    this.placeGizmo();
    this.emitChange();
    return true;
  }

  // Puts the pivot point of the entry being edited in the middle of its
  // bounds. Normally that is the pivot nobody has set, which also follows the
  // object as it changes shape; an object with a mirror of its own keeps a
  // set pivot (its mirror planes go through it), moved to the middle.
  centerPivot() {
    const index = this.pivotEntry();
    if (index === null || this.busy()) return;
    const object = this.mesh.objects[index];
    const middle = this.middle(index);
    if (!middle) return;
    const pinned = Boolean(object.mirror?.length);
    if (pinned ? JSON.stringify(object.pivot) === JSON.stringify(middle.toArray()) : !object.pivot) return;
    this.history.push(this.snapshot());
    if (pinned) object.pivot = middle.toArray();
    else delete object.pivot;
    this.placeGizmo();
    this.emitChange();
  }

  // Drops the pivot point set for an entry: it is the middle of the bounds again.
  resetPivot(index) {
    const object = this.mesh.objects[index];
    if (!object?.pivot || this.busy()) return;
    this.history.push(this.snapshot());
    delete object.pivot;
    this.placeGizmo();
    this.emitChange();
  }

  // The entries inside a group of the objects list, at any depth, that are not hidden.
  pivotChildren(index) {
    const { islands } = this.topology;
    const inside = [];
    const collect = (parent) => {
      for (const child of islands[parent].children) {
        if (islands[child].hidden) continue;
        inside.push(child);
        collect(child);
      }
    };
    collect(index);
    return inside;
  }

  updatePivotMarker() {
    const entry = this.operation ? null : this.pivotEntry();
    const children = entry === null ? [] : this.pivotChildren(entry);
    while (this.pivotRings.length < children.length) {
      const ring = new THREE.Sprite(this.pivotMarker.material);
      ring.renderOrder = 7;
      this.viewport.scene.add(ring);
      this.pivotRings.push(ring);
    }
    const ringSize =
      (PIVOT_INNER_SIZE / this.viewport.container.clientHeight) *
      2 * Math.tan(THREE.MathUtils.degToRad(this.viewport.camera.fov / 2));
    this.pivotRings.forEach((ring, i) => {
      ring.visible = i < children.length;
      if (!ring.visible) return;
      ring.position.copy(this.pivotPoint(children[i]));
      ring.scale.set(ringSize, ringSize, 1);
    });
    this.pivotMarker.visible = entry !== null;
    if (entry === null) return;
    this.pivotMarker.position.copy(this.pivotPoint(entry));
    const { camera, container } = this.viewport;
    const size = (PIVOT_MARKER_SIZE / container.clientHeight) * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    this.pivotMarker.scale.set(size, size, 1);
  }

  // --- vertices in one place ----------------------------------------------------

  // The places where two or more vertices of one object stand together, as
  // { object (its id), name, indices, point }.
  overlaps() {
    const { vertices, vertexObject, objects } = this.mesh;
    const places = new Map();
    vertices.forEach((p, i) => {
      const key = `${vertexObject[i]}:${Math.round(p.x * 1e4)}|${Math.round(p.y * 1e4)}|${Math.round(p.z * 1e4)}`;
      if (!places.has(key)) places.set(key, []);
      places.get(key).push(i);
    });
    const names = new Map(objects.map((object) => [object.id, object.name]));
    return [...places.values()]
      .filter((indices) => indices.length > 1)
      .map((indices) => ({
        object: vertexObject[indices[0]],
        name: names.get(vertexObject[indices[0]]) ?? '',
        indices,
        point: vertices[indices[0]].clone(),
      }));
  }

  // Makes one vertex of each of the given groups (index lists), see
  // EditableMesh.mergeVertices(). One undo step.
  mergeOverlaps(groups) {
    if (groups.length === 0 || this.busy()) return;
    if (this.operation) this.setOperation(null);
    const before = this.snapshot();
    const remap = this.mesh.mergeVertices(groups);
    const kept = (set) => new Set([...set].filter((i) => remap.has(i)).map((i) => remap.get(i)));
    this.selection = kept(this.selection);
    this.target = kept(this.target);
    this.edited(before);
    this.rebuildView();
    this.placeGizmo();
    this.emitChange();
  }

  // --- mirror modeling (see mirror.js) ----------------------------------------

  // The axes of the global mirror: planes through the origin, every object.
  setGlobalMirror(axes) {
    const next = ['x', 'y', 'z'].filter((axis) => axes.includes(axis));
    const now = ['x', 'y', 'z'].filter((axis) => this.mirror.globalAxes.has(axis));
    if (next.join() === now.join() || this.busy()) return;
    this.history.push(this.snapshot());
    this.mirror.globalAxes = new Set(next);
    this.emitChange();
  }

  // The object whose local mirror the settings show: in object mode the one
  // object that is the whole selection, otherwise the one object being
  // edited (the target of the three views). Null when it is not one object.
  mirrorEntry() {
    const chosen = this.sizeEntry();
    if (chosen !== null) return chosen;
    const { islands, islandOfVertex } = this.topology;
    const owners = new Set([...this.target].map((vertex) => islandOfVertex[vertex]));
    if (owners.size !== 1) return null;
    const [index] = owners;
    return islands[index]?.kind === 'group' ? null : index;
  }

  // An object's own mirror planes, through its pivot point. Turning one on
  // fixes the pivot where it is, so that the plane stays put while the
  // object changes shape.
  setLocalMirror(index, axes) {
    const object = this.mesh.objects[index];
    if (!object || object.kind === 'group' || this.busy()) return;
    const next = ['x', 'y', 'z'].filter((axis) => axes.includes(axis));
    if (next.join() === (object.mirror ?? []).join()) return;
    this.history.push(this.snapshot());
    if (next.length) {
      object.mirror = next;
      if (!object.pivot) object.pivot = this.pivotPoint(index).toArray();
    } else {
      delete object.mirror;
    }
    this.placeGizmo();
    this.emitChange();
  }

  // --- an object's size ------------------------------------------------------

  // The object whose size is shown and set: in object mode, the one object
  // (not a group) that is the whole selection. Null otherwise.
  sizeEntry() {
    const entry = this.pivotEntry();
    return entry !== null && this.topology.islands[entry].kind !== 'group' ? entry : null;
  }

  // The extent of that object along the axes, or null.
  objectSize() {
    const entry = this.sizeEntry();
    if (entry === null) return null;
    const { vertices } = this.topology.islands[entry];
    if (vertices.length === 0) return null;
    // Along the object's own axes: a turned object is as big as it was.
    const back = quaternionOf(this.mesh.objects[entry].rotation).invert();
    return new THREE.Box3()
      .setFromPoints(vertices.map((i) => this.mesh.vertices[i].clone().applyQuaternion(back)))
      .getSize(new THREE.Vector3());
  }

  // --- texturing (see unwrap.js, atlas.js) ---------------------------------------

  // Lays the faces out on the atlas as the model is now: every face gets its
  // place, or keeps the one it has. Returns whether anything is where it was
  // not. `repack` forgets the places and lays everything out anew.
  layOut(repack = false, sweep = true) {
    const result = unwrap(this.mesh, { ppu: this.ppu, width: this.atlas.width, height: this.atlas.height, repack });
    const resized = result.width !== this.atlas.width || result.height !== this.atlas.height;
    this.atlas.apply(result, this.mesh, { sweep });
    return result.changed || resized;
  }

  // The charts on the atlas that hold any of the given faces - as the atlas
  // has them: { rect, polygons, faces, pinned }.
  chartsOfFaces(faces) {
    const wanted = new Set(faces);
    return this.atlas.charts.filter((chart) => chart.faces.some((face) => wanted.has(face)));
  }

  // How far a chart can go by (dx, dy): whole pixels, and not off the atlas (its rim included).
  chartShift(chart, dx, dy) {
    const { rect } = chart;
    return [
      Math.max(PADDING - rect.x, Math.min(this.atlas.width - PADDING - rect.w - rect.x, Math.round(dx))),
      Math.max(PADDING - rect.y, Math.min(this.atlas.height - PADDING - rect.h - rect.y, Math.round(dy))),
    ];
  }

  // Shows on the model what moving those charts by (dx, dy) would look like,
  // while they are being dragged: nothing is settled until placeCharts().
  // `move` null puts the faces back as they are.
  previewCharts(faces, move) {
    if (this.chartPreview) {
      for (const [face, uv] of this.chartPreview) face.uv = uv;
      this.chartPreview = null;
    }
    if (move) {
      this.chartPreview = new Map();
      for (const chart of this.chartsOfFaces(faces)) {
        const [dx, dy] = this.chartShift(chart, move[0], move[1]);
        for (const index of chart.faces) {
          const face = this.mesh.faces[index];
          this.chartPreview.set(face, face.uv);
          face.uv = face.uv.map(([x, y]) => [x + dx, y + dy]);
        }
      }
    }
    this.view.updateUVs();
    this.viewport.requestRender();
  }

  // Puts charts elsewhere on the atlas by hand - those that hold any of the
  // given faces. Only the faces' places change, not the picture: this is how
  // a face is given another picture, or several faces the same one.
  //   { move: [dx, dy] }   by whole pixels (kept on the atlas)
  //   { turn: 1 | -1 }     a quarter turn, clockwise or back, about the chart's top left room
  //   { flip: 'h' | 'v' }  turned over, left to right or top to bottom
  //   { auto: true }       given back to the unwrap, which finds it free room if it needs any
  // A chart placed so is pinned: the unwrap leaves it where it is. One undo step.
  placeCharts(faces, how) {
    if (this.chartPreview) this.previewCharts(faces, null);
    const charts = this.chartsOfFaces(faces);
    if (charts.length === 0 || this.busy()) return false;
    const before = this.snapshot();
    let changed = false;
    for (const chart of charts) {
      const { rect } = chart;
      const members = chart.faces.map((index) => this.mesh.faces[index]);
      if (how.auto) {
        for (const face of members) {
          if (face.pin) changed = true;
          delete face.pin;
        }
        continue;
      }
      let place;
      if (how.move) {
        const [dx, dy] = this.chartShift(chart, how.move[0], how.move[1]);
        place = ([x, y]) => [x + dx, y + dy];
        if (dx === 0 && dy === 0 && members.every((face) => face.pin)) continue;
      } else if (how.turn) {
        // About the room's top left corner, which stays where it is; the room's sides change places.
        place = how.turn > 0
          ? ([x, y]) => [rect.x + (rect.h - (y - rect.y)), rect.y + (x - rect.x)]
          : ([x, y]) => [rect.x + (y - rect.y), rect.y + (rect.w - (x - rect.x))];
      } else if (how.flip === 'h') {
        place = ([x, y]) => [rect.x + (rect.w - (x - rect.x)), y];
      } else if (how.flip === 'v') {
        place = ([x, y]) => [x, rect.y + (rect.h - (y - rect.y))];
      } else {
        continue;
      }
      for (const face of members) {
        face.uv = face.uv.map((point) => place(point).map((value) => +value.toFixed(6)));
        face.pin = true;
      }
      changed = true;
    }
    if (!changed) return false;
    this.history.push(before);
    // The pictures stay where they are: nothing is swept behind a chart that was moved.
    this.layOut(false, false);
    this.view.updateUVs();
    this.viewport.requestRender();
    this.emitChange();
    return true;
  }

  // What is wrong with the model, as [{ text }] - for now, faces that are not
  // flat: such a face cannot lie on the atlas without stretch, which is the
  // one thing the unwrap is there to rule out.
  problems() {
    const { faces, vertices, vertexObject, objects } = this.mesh;
    const bent = new Map(); // object id -> how many
    faces.forEach((face, index) => {
      if (face.length < 4) return;
      const normal = this.mesh.faceNormal(index);
      if (normal.lengthSq() < 0.5) return;
      const heights = face.map((i) => normal.dot(vertices[i]));
      // Out of its plane by more than a tenth of a pixel.
      if ((Math.max(...heights) - Math.min(...heights)) * this.ppu <= 0.1) return;
      const owner = vertexObject[face[0]];
      bent.set(owner, (bent.get(owner) ?? 0) + 1);
    });
    const plural = (count) => {
      const n = count % 100;
      if (n >= 11 && n <= 14) return 'неплоских граней';
      return n % 10 === 1 ? 'неплоская грань' : n % 10 >= 2 && n % 10 <= 4 ? 'неплоские грани' : 'неплоских граней';
    };
    return [...bent].map(([id, count]) => ({
      text: `${count} ${plural(count)}: текстура ляжет с искажением · ${objects.find((object) => object.id === id)?.name ?? ''}`,
    }));
  }

  // Takes a new picture for the atlas from the bytes of an image file - the
  // painter's work, done outside. One undo step. Returns false if the bytes
  // are no picture.
  async paintAtlas(bytes) {
    const before = this.snapshot();
    if (!(await this.atlas.load(bytes, true))) return false;
    const now = this.atlas.pixels().data;
    if (now.length === before.atlas.data.length && now.every((value, i) => value === before.atlas.data[i])) return true;
    this.history.push(before);
    this.emitChange();
    return true;
  }

  // The project's pixels per unit of length: the whole model is laid out anew at it.
  setPPU(ppu) {
    ppu = Math.round(ppu);
    if (!(ppu >= 1 && ppu <= 256) || ppu === this.ppu || this.busy()) return;
    this.history.push(this.snapshot());
    this.ppu = ppu;
    this.repackAtlas(false);
  }

  // Lays the whole model out on the atlas from scratch, as tightly as it
  // goes. What was painted is lost: the places are new.
  repackAtlas(record = true) {
    if (this.busy()) return;
    if (record) this.history.push(this.snapshot());
    this.atlas.reset(START_SIZE, START_SIZE);
    this.layOut(true);
    this.view.updateUVs();
    this.viewport.requestRender();
    this.emitChange();
  }

  // --- marker colours (see marker-colors.js) ------------------------------------

  // Gives the entries of the objects list a marker colour, by its id; null
  // takes it away. One undo step.
  setObjectColor(indices, color) {
    const objects = indices.map((index) => this.mesh.objects[index]).filter(Boolean);
    if (objects.every((object) => (object.color ?? null) === color) || this.busy()) return;
    this.history.push(this.snapshot());
    for (const object of objects) {
      if (color) object.color = color;
      else delete object.color;
    }
    this.view.updateSurfaceColors();
    this.viewport.requestRender();
    this.emitChange();
  }

  // --- how an entry has been turned (see frames.js) ---------------------------

  // The turn of the entry the panels are about - an object or a group, picked
  // whole in object mode - as { x, y, z } in degrees, or null.
  objectRotation() {
    const entry = this.pivotEntry();
    if (entry === null) return null;
    const [x, y, z] = this.mesh.objects[entry].rotation ?? [0, 0, 0];
    return { x, y, z };
  }

  // Sets one of those angles: the entry, with everything in it, is turned
  // about its pivot point by the difference. `record` as in setSelectionCenter().
  setObjectRotation(axis, value, record = true) {
    const entry = this.pivotEntry();
    if (entry === null || !Number.isFinite(value) || this.busy()) return;
    const object = this.mesh.objects[entry];
    const from = object.rotation ?? [0, 0, 0];
    const to = [...from];
    to['xyz'.indexOf(axis)] = value;
    if (to.join() === from.join()) return;
    const turn = quaternionOf(to).multiply(quaternionOf(from).invert());
    const before = record ? this.snapshot() : null;
    const centre = this.pivotPoint(entry);
    const turned = (point) => point.sub(centre).applyQuaternion(turn).add(centre);
    const { vertices } = this.contents([entry]);
    const moving = new Map([...vertices].map((i) => [i, this.mesh.vertices[i].clone()]));
    for (const i of vertices) turned(this.mesh.vertices[i]);
    for (const index of this.entriesUnder(entry)) {
      const other = this.mesh.objects[index];
      if (other.pivot) other.pivot = turned(new THREE.Vector3().fromArray(other.pivot)).toArray();
      if (other !== object) setRotation(other, rotationOf(turn.clone().multiply(quaternionOf(other.rotation))));
    }
    setRotation(object, to); // the angles as they were given, not recomputed
    this.mirror.moves(moving);
    if (before) this.commit(before);
    this.view.updatePositions();
    this.placeGizmo();
    this.emitChange();
  }

  // Stretches the object along an axis ('x' | 'y' | 'z') to the given size,
  // about its pivot point. An object that is flat along the axis has no size
  // to stretch. `record` as in setSelectionCenter().
  setObjectSize(axis, value, record = true) {
    const entry = this.sizeEntry();
    if (entry === null || !Number.isFinite(value) || value < 0 || this.busy()) return;
    const { vertices } = this.topology.islands[entry];
    const size = this.objectSize()[axis];
    // Along the object's own axes, about its pivot point: the vertices are
    // taken into those axes and back (for an object that is not turned they
    // are the world's, and nothing is taken anywhere).
    const { rotation } = this.mesh.objects[entry];
    const turn = rotation ? quaternionOf(rotation) : null;
    const back = turn?.clone().invert();
    const origin = this.pivotPoint(entry);
    if (turn) origin.applyQuaternion(back);
    const center = origin[axis];
    const flat = size < 1e-9;
    // Flat along the axis: the vertices go back out to the sides they were
    // folded from, if they were (see scaleFlat()).
    if (flat && !vertices.some((i) => this.mesh.folds.get(i)?.[axis])) return;
    const before = record ? this.snapshot() : null;
    const moving = new Map(vertices.map((i) => [i, this.mesh.vertices[i].clone()]));
    if (flat) {
      this.unfold(vertices, axis, center, value / 2, turn);
    } else {
      const factor = value / size;
      for (const i of vertices) {
        const vertex = this.mesh.vertices[i];
        if (turn) vertex.applyQuaternion(back);
        if (value < 1e-9) this.noteFold(i, axis, Math.sign(vertex[axis] - center));
        vertex[axis] = center + (vertex[axis] - center) * factor;
        if (turn) vertex.applyQuaternion(turn);
      }
    }
    this.mirror.moves(moving);
    if (before) this.commit(before);
    this.view.updatePositions();
    this.placeGizmo();
    this.emitChange();
  }

  // What the coordinate fields show and move: the pivot point with the pivot
  // tool, the middle of the selection otherwise. Null when there is nothing.
  panelPoint() {
    if (this.tool === 'pivot') {
      const entry = this.pivotEntry();
      return entry === null ? null : this.pivotPoint(entry);
    }
    return this.selection.size ? this.selectionCenter() : null;
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
          else if (this.operation === 'place') this.pressPlace(event.clientX, event.clientY);
          else this.pressPolygon(event.clientX, event.clientY);
          return;
        }
        // A gizmo handle under the cursor takes the press; otherwise the element does.
        if (this.overGizmo()) return;
        // The pivot tool works on the pivot point alone: nothing of the model
        // is grabbed, selected or deselected while it is in hand.
        if (this.tool === 'pivot') return;
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
      if (this.place) {
        this.movePlace(event.clientX, event.clientY);
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
        const idle = this.overGizmo() || this.tool === 'pivot'; // see pointerdown
        this.setHovered(idle ? null : this.pickElement(event.clientX, event.clientY));
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
    // The place tool needs one object or group picked whole.
    if (name === 'place' && this.pivotEntry() === null) return;
    this.cancelDrag();
    this.cancelBox();
    const wasIdle = this.operation === null;
    this.cancelCut();
    this.cancelExtrude();
    this.endPolygon();
    this.endPlace();

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
      if (name === 'place') this.beginPlace();
      if (name === 'polygon') this.polygon = { axis: null, offset: 0, points: [], cursor: null, problem: null };
    } else {
      this.operation = null;
      if (this.mode !== this.modeBeforeOperation) this.setMode(this.modeBeforeOperation);
    }
    this.refreshHighlight();
    this.placeGizmo();
    this.emitChange();
  }

  // Grid snapping, the user's switch: on, things move and scale by the grid's
  // steps; off, freely. (Tools that work by the grid's points - the polygon
  // tool, the cut - stay on it.)
  setSnapping(on) {
    if (on === this.snapGrid.enabled) return;
    this.snapGrid.enabled = on;
    this.emitChange();
  }

  // Local axes: the move and rotate gizmos stand along the own axes of what
  // they move - the object or group picked whole, or the one object the
  // selection belongs to - when that has been turned (see frames.js). The
  // scale gizmo always does. Off, they stand along the world's axes.
  setLocalAxes(on) {
    if (on === this.localAxes || this.busy()) return;
    this.localAxes = on;
    this.placeGizmo();
    this.emitChange();
  }

  // The focus look, a mode of its own that the user switches: a dark
  // background and the object as a white wireframe with its vertices marked,
  // on top of any shading. Nothing hides anything in it.
  setFocus(on) {
    if (on === this.focus) return;
    this.focus = on;
    this.view.setFocus(on);
    this.viewport.setFocus(on);
    this.refreshHighlight(); // the vertex colours, and a render
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


  // --- placing on a surface --------------------------------------------------
  //
  // The place tool puts the object or group picked whole onto the surface of
  // another object: a ring follows the pointer, lies down on the surface under
  // it and shows the surface's normal; a click moves the object there and
  // turns it so that one of its sides - `placeSide`, a side of its bounds
  // along its own axes - lies against the surface. The side can be changed
  // afterwards: the last placing is then done over.

  // Builds the ring that follows the pointer (once).
  setupPlaceMarker() {
    const material = new THREE.LineBasicMaterial({ color: theme.box, depthTest: false, transparent: true });
    const circle = [];
    for (let k = 0; k < 48; k++) {
      const angle = (k / 48) * Math.PI * 2;
      circle.push(new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0));
    }
    const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(circle), material);
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(1, 48),
      new THREE.MeshBasicMaterial({ color: theme.box, opacity: 0.16, transparent: true, depthTest: false, side: THREE.DoubleSide }),
    );
    // (The normal of the surface, out of the ring's middle, is the view's
    // dashed line, see animatePlace().)
    this.placeMarker = new THREE.Group();
    this.placeMarker.add(disc, ring);
    for (const part of this.placeMarker.children) part.renderOrder = 9;
    this.placeMarker.visible = false;
    this.viewport.scene.add(this.placeMarker);
  }

  // The entry being placed, by the id it was taken with; null if it is gone.
  placeEntry() {
    const index = this.place ? this.mesh.objects.findIndex((object) => object.id === this.place.id) : -1;
    return index === -1 ? null : index;
  }

  beginPlace() {
    if (!this.placeMarker) this.setupPlaceMarker();
    // `pixel` is the size of a screen pixel at the ring, `time` runs the normal's dashes.
    this.place = { id: this.mesh.objects[this.pivotEntry()].id, hover: null, last: null, pixel: 0, time: 0 };
  }

  endPlace() {
    if (!this.place) return;
    this.place = null;
    this.placeMarker.visible = false;
    this.view.setPlacePreview([]);
    this.viewport.requestRender();
  }

  // What the pointer is on: { point, normal } on the surface of an object
  // other than the one being placed, or null.
  placeTarget(clientX, clientY) {
    const entry = this.placeEntry();
    if (entry === null) return null;
    const own = new Set(this.entriesUnder(entry));
    const ray = this.pointerRay(clientX, clientY).clone();
    const { islands, islandOfFace } = this.topology;
    for (const hit of this.raycaster.intersectObject(this.view.solid, false)) {
      const face = this.view.triangleFaces[hit.faceIndex];
      const island = islandOfFace[face];
      if (island === undefined || own.has(island) || islands[island].hidden) continue;
      const normal = this.mesh.faceNormal(face);
      if (normal.lengthSq() < 0.5) continue; // a face with no surface
      if (normal.dot(ray.direction) > 0) normal.negate(); // seen from behind
      // Right under the pointer: a surface has no grid of its own to go by.
      return { point: hit.point.clone(), normal };
    }
    return null;
  }

  // The ring follows the pointer: on a surface it lies on it, with the
  // surface's normal; over nothing it faces the viewer.
  movePlace(clientX, clientY) {
    const { camera, orbit } = this.viewport;
    const hover = this.placeTarget(clientX, clientY);
    this.place.hover = hover;
    const marker = this.placeMarker;
    if (hover) {
      marker.position.copy(hover.point);
      marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), hover.normal);
    } else {
      const ray = this.pointerRay(clientX, clientY);
      marker.position.copy(ray.at(camera.position.distanceTo(orbit.target), new THREE.Vector3()));
      marker.quaternion.copy(camera.quaternion);
    }
    // The same size on screen wherever it is.
    const depth = marker.position.clone().sub(camera.position).dot(camera.getWorldDirection(new THREE.Vector3()));
    const height = this.viewport.renderer.domElement.clientHeight || 1;
    const pixel = (2 * Math.max(depth, 1e-3) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / height;
    this.place.pixel = pixel;
    marker.scale.setScalar(PLACE_RING * pixel);
    marker.visible = true;
    this.animatePlace();
  }

  // Runs while the place tool is on: draws the normal of the surface under
  // the ring as a dashed line whose dashes flow outwards, like the cut's.
  animatePlace() {
    if (this.placeFrame) return;
    let last = performance.now();
    const tick = (now) => {
      this.placeFrame = null;
      const place = this.place;
      if (!place) return;
      place.time += Math.min((now - last) / 1000, 0.1);
      last = now;
      const { hover, pixel } = place;
      this.view.setPlacePreview(
        hover ? [[hover.point, hover.point.clone().addScaledVector(hover.normal, PLACE_NORMAL * pixel)]] : [],
        // The dashes start at the far end of the phase, so that they run away from the surface.
        { dash: CUT_DASH * pixel, gap: CUT_GAP * pixel, phase: place.time * CUT_FLOW * pixel },
      );
      this.viewport.render();
      // Nothing under the ring: nothing to animate until the pointer moves again.
      if (hover) this.placeFrame = requestAnimationFrame(tick);
    };
    tick(last);
  }

  // LMB with the place tool: the object goes to where the ring is.
  pressPlace(clientX, clientY) {
    this.movePlace(clientX, clientY);
    const { hover } = this.place;
    if (!hover) return;
    const before = this.snapshot();
    this.putOnSurface(hover.point, hover.normal);
    const id = this.history.id;
    this.commit(before);
    // What was done, to do it over with another side (see setPlaceSide()).
    this.place.last = { point: hover.point.clone(), normal: hover.normal.clone(), committed: this.history.id !== id, id: this.history.id };
    this.view.updatePositions();
    this.emitChange();
  }

  // Whether the last thing done was a placing whose side can still be changed.
  placed() {
    return Boolean(this.place?.last) && this.history.id === this.place.last.id;
  }

  // Changes the side the placed object lies on; a placing just made is done over with it.
  setPlaceSide(side) {
    if (!(side in PLACE_SIDES) || side === this.placeSide || this.busy()) return;
    this.placeSide = side;
    if (this.placed()) {
      const { last } = this.place;
      // Back to before the placing (it was the last step), and again.
      if (last.committed) this.restore(this.history.undo(this.snapshot()));
      const before = this.snapshot();
      this.putOnSurface(last.point, last.normal);
      const id = this.history.id;
      this.commit(before);
      last.committed = this.history.id !== id;
      last.id = this.history.id;
      this.view.updatePositions();
    }
    this.emitChange();
  }

  // Moves and turns the entry being placed so that the middle of its
  // `placeSide` is at `point` and that side faces into the surface, whose
  // normal there is `normal`. The turn is the shortest one that does it.
  putOnSurface(point, normal) {
    const entry = this.placeEntry();
    const object = this.mesh.objects[entry];
    const { vertices } = this.contents([entry]);
    if (vertices.size === 0) return;
    const { axis, sign } = PLACE_SIDES[this.placeSide];
    const own = quaternionOf(object.rotation);
    const back = own.clone().invert();
    // The middle of that side of the bounds, taken along the entry's own axes.
    const box = new THREE.Box3().setFromPoints([...vertices].map((i) => this.mesh.vertices[i].clone().applyQuaternion(back)));
    const contact = box.getCenter(new THREE.Vector3());
    contact[axis] = sign > 0 ? box.max[axis] : box.min[axis];
    contact.applyQuaternion(own);
    const outward = new THREE.Vector3();
    outward[axis] = sign;
    outward.applyQuaternion(own);
    const turn = new THREE.Quaternion().setFromUnitVectors(outward, normal.clone().negate());
    const plain = turn.angleTo(new THREE.Quaternion()) < 1e-9; // no turn: a move, exact
    const carried = (position) => {
      position.sub(contact);
      if (!plain) position.applyQuaternion(turn);
      position.add(point);
      // Free of the noise a turn leaves in the last digits.
      if (!plain) position.set(+position.x.toFixed(9), +position.y.toFixed(9), +position.z.toFixed(9));
      return position;
    };
    const moving = new Map([...vertices].map((i) => [i, this.mesh.vertices[i].clone()]));
    for (const i of vertices) carried(this.mesh.vertices[i]);
    for (const index of this.entriesUnder(entry)) {
      const other = this.mesh.objects[index];
      if (other.pivot) other.pivot = carried(new THREE.Vector3().fromArray(other.pivot)).toArray();
      if (!plain) setRotation(other, rotationOf(turn.clone().multiply(quaternionOf(other.rotation))));
    }
    this.mirror.moves(moving);
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
    this.snapGrid.begin(start, inPlane, null, undefined, true); // the tool is the grid's points
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

    this.endPolygon();
    this.selection = new Set(vertices);
    this.edited(before);
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
    const { before } = this.extrude;
    this.extrude = null;
    this.edited(before);
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
    // `right` is the screen's right in the view the pointer is in, see cutAxis().
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.viewport.camera.quaternion);
    this.cut = { face, faces: island.faces, axis: null, value: null, shown: null, segments: [], time: 0, right };
    const center = new THREE.Vector3();
    for (const i of this.mesh.faces[face]) center.add(this.mesh.vertices[i]);
    this.placeCut(center.divideScalar(this.mesh.faces[face].length));
  }

  // Moves the cut line under the pointer; `viewer` is the view the pointer is in.
  moveCut(clientX, clientY, viewer = this.mainViewer) {
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
    // (A view hands out one ray object and aims it anew each time: the first is copied.)
    const ray = viewer.ray(clientX, clientY).clone();
    // The screen's right in this view, at the face: where a pointer a little to the right looks.
    const beside = viewer.ray(clientX + 40, clientY);
    const depth = Math.max(ray.origin.distanceTo(this.cut.point), 1);
    this.cut.right = beside.at(depth, new THREE.Vector3()).sub(ray.at(depth, new THREE.Vector3())).normalize();
    let hit = null;
    this.cut.reach = null; // the axes this flat view sees the face edge-on along; null = none
    if (Math.abs(plane.normal.dot(ray.direction)) > MIN_AXIS_SINE) {
      hit = ray.intersectPlane(plane, new THREE.Vector3());
    } else if (viewer.planeAxes) {
      this.cut.reach = [...viewer.planeAxes];
      // A flat view that sees the face edge-on: the pointer gives the two
      // coordinates of the view, the third stays where the line is.
      hit = this.cut.point.clone();
      for (const axis of viewer.planeAxes) hit[axis] = ray.origin[axis];
    }
    if (hit) this.placeCut(hit);
  }

  // Which way the cut goes is the user's choice: 'vertical' or 'horizontal'.
  setCutDirection(direction) {
    if (direction === this.cutDirection) return;
    this.cutDirection = direction;
    if (this.cut) this.placeCut(this.cut.point);
    this.emitChange();
  }

  // The axis the cutting plane is perpendicular to, for a face with the given
  // corners. Of the two axes the face lies along: on a wall the horizontal cut
  // is the one at a height (across Y) and the vertical one is the other; on a
  // floor, where nothing is vertical, the vertical cut is the one whose line
  // looks vertical in the view the pointer is in.
  cutAxis(points) {
    const normal = new THREE.Vector3();
    points.forEach((a, i) => {
      const b = points[(i + 1) % points.length];
      normal.x += (a.y - b.y) * (a.z + b.z);
      normal.y += (a.z - b.z) * (a.x + b.x);
      normal.z += (a.x - b.x) * (a.y + b.y);
    });
    const [first, second] = ['x', 'y', 'z'].sort((a, b) => Math.abs(normal[a]) - Math.abs(normal[b]));
    let vertical;
    let horizontal;
    if (first === 'y' || second === 'y') {
      horizontal = 'y';
      vertical = first === 'y' ? second : first;
    } else {
      const right = this.cut.right;
      vertical = Math.abs(right[first]) >= Math.abs(right[second]) ? first : second;
      horizontal = vertical === first ? second : first;
    }
    return this.cutDirection === 'vertical' ? vertical : horizontal;
  }

  // Puts the cutting plane through `point` (a point in the face's plane),
  // snapped to the grid, across the axis of the chosen direction.
  placeCut(point) {
    const cut = this.cut;
    cut.point = point.clone(); // to re-place the line when the direction or the step changes
    const points = this.mesh.faces[cut.face].map((i) => this.mesh.vertices[i]);
    const axis = this.cutAxis(points);

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
    this.selection = new Set(result.vertices);
    this.edited(before);
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
        if (this.topology.hiddenVertices.has(i)) return;
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

  // The same for an element of the current mode (an edge, a face, an object),
  // by its key; `lead` is the vertex of it that the cursor leads.
  pressElement(key, lead, clientX, clientY, additive, viewer) {
    this.drag = { vertex: lead, key, x: clientX, y: clientY, additive, start: null, viewer };
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
    // The point that is moved and snapped: the grabbed vertex, or, for a whole
    // object, its pivot point - wherever the object was taken by.
    const from = drag.anchor ?? drag.start;
    // Always offset the snapshot, never the current position, to avoid drift.
    const lead = from.clone();
    if (point) {
      const delta = point.sub(drag.grab);
      if (drag.axis) delta.projectOnVector(drag.axis);
      this.snapGrid.snap(lead.add(delta));
    }
    // Everything dragged follows that point rigidly.
    const offset = lead.clone().sub(from);
    vertex.copy(drag.start).add(offset);
    for (const [i, start] of drag.others) this.mesh.vertices[i].copy(start).add(offset);
    for (const [object, start] of drag.pivots) object.pivot = start.clone().add(offset).toArray();
    // The twins follow. (Not for the pencil: its new vertex has none yet.)
    if (drag.parent === undefined) this.mirror.moves(drag.moving);
    this.snapGrid.focus(lead);
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

    // Grabbing a selected element drags the whole selection; grabbing an unselected
    // one drags it alone, or joins it to the selection when Shift is held.
    if (drag.key !== null && !this.picked.has(drag.key)) {
      if (!drag.additive) this.picked.clear();
      this.picked.add(drag.key);
      if (this.mode === 'object') this.activeObject = this.topology.islands[drag.key].id;
      this.syncSelection();
    }
    // A lone vertex pressed outside vertex mode moves by itself unless it
    // belongs to the selection; the selection is left as it is.
    const group = this.selection.has(drag.index) ? this.selection : [];
    drag.others = new Map();
    for (const i of group) {
      if (i !== drag.index) drag.others.set(i, this.mesh.vertices[i].clone());
    }
    // Whole objects carry their pivot points along.
    drag.pivots = this.selection.has(drag.index) ? this.pivotsInMotion() : new Map();
    // Everything the drag moves, where it started: what the mirror goes by.
    drag.moving = new Map([[drag.index, drag.start.clone()], ...drag.others]);
    // A whole object or group goes by its pivot point: that is what lands on the grid.
    const entry = this.selection.has(drag.index) ? this.pivotEntry() : null;
    drag.anchor = entry === null ? null : this.pivotPoint(entry);
    this.constrainDrag();
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
    const from = drag.anchor ?? drag.start; // the point that is snapped, see dragTo()
    if (drag.axis) {
      // Locked: the plane through the axis that faces the viewer as much as possible.
      const view = viewer.viewDirection(from);
      normal.copy(view).addScaledVector(drag.axis, -view.dot(drag.axis));
      // The axis points almost straight at the viewer: the cursor can't express
      // movement along it, so the vertex stays put instead of flying away.
      if (normal.length() < MIN_AXIS_SINE) {
        drag.plane = null;
        this.snapGrid.begin(from, lock, null);
        return;
      }
      normal.normalize();
    }
    drag.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, from);
    drag.grab =
      viewer.ray(drag.x, drag.y).intersectPlane(drag.plane, new THREE.Vector3()) ??
      from.clone();
    this.snapGrid.begin(from, lock, drag.plane);
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
    if (this.pivotDrag) return this.cancelPivotDrag();
    if (!this.drag) return false;
    const { index, start, others, pivots, parent, before } = this.drag;
    this.drag = null;
    this.snapGrid.end();
    this.viewport.renderer.domElement.style.cursor = '';
    if (start && parent !== undefined) {
      this.restore(before); // the pencil's new vertex goes away with its edge
    } else if (start) {
      this.mesh.vertices[index].copy(start);
      for (const [i, position] of others) this.mesh.vertices[i].copy(position);
      for (const [object, position] of pivots) object.pivot = position.toArray();
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
      case 'object': return this.topology.islands[key].group; // a group: everything in it
      default: return [key];
    }
  }

  // Keys of every element of the current mode; what is hidden is left out.
  allElements() {
    const hidden = this.topology.hiddenVertices;
    switch (this.mode) {
      case 'edge': return this.topology.edges.map(([a, b]) => edgeKey(a, b));
      case 'face': return this.mesh.faces.map((_, i) => i).filter((i) => !hidden.has(this.mesh.faces[i][0]));
      case 'object': return this.topology.islands.map((_, i) => i).filter((i) => !this.topology.islands[i].hidden);
      default: return this.mesh.vertices.map((_, i) => i).filter((i) => !hidden.has(i));
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
    // The tree: every entry's place in it, and its `group` - its own vertices
    // or, for a group, those of everything inside, which is what selecting it takes.
    const indexOfId = new Map(islands.map((island, i) => [island.id, i]));
    for (const island of islands) island.children = [];
    islands.forEach((island, i) => {
      island.parentIndex = indexOfId.get(island.parent) ?? null;
      if (island.parentIndex !== null) islands[island.parentIndex].children.push(i);
    });
    // Visibility: `hiddenOwn` is the entry's own switch, `hidden` the outcome -
    // a hidden group hides all it holds. Hidden things are in nobody's `group`.
    const hiddenVertices = new Set();
    const resolve = (island, under) => {
      island.hiddenOwn = island.hidden;
      island.hidden = under || island.hiddenOwn;
      if (island.hidden) for (const vertex of island.vertices) hiddenVertices.add(vertex);
      for (const child of island.children) resolve(islands[child], island.hidden);
    };
    for (const island of islands) if (island.parentIndex === null) resolve(island, false);
    const collect = (island) => {
      if (island.group) return;
      island.group = island.hidden ? [] : [...island.vertices];
      island.groupFaces = island.hidden ? [] : [...island.faces];
      for (const child of island.children) {
        collect(islands[child]);
        island.group.push(...islands[child].group);
        island.groupFaces.push(...islands[child].groupFaces);
      }
    };
    islands.forEach(collect);
    const edges = this.mesh.edges().filter(([a]) => !hiddenVertices.has(a));
    this.topology = { edges, islands, islandOfFace, islandOfVertex, hiddenVertices };
    this.view.hidden = hiddenVertices; // takes effect at the view's next rebuild
  }

  // Takes what has become hidden out of the selection and the target.
  dropHidden() {
    const { hiddenVertices } = this.topology;
    this.selection = new Set([...this.selection].filter((i) => !hiddenVertices.has(i)));
    this.target = new Set([...this.target].filter((i) => !hiddenVertices.has(i)));
  }

  // Makes `selection` the vertices of the picked elements.
  syncSelection() {
    this.selection = new Set([...this.picked].flatMap((key) => this.elementVertices(key)));
    // The groups picked as such, by id: see adoptSelection().
    const { islands } = this.topology;
    this.pickedGroups = new Set(
      this.mode === 'object'
        ? [...this.picked].filter((key) => islands[key]?.kind === 'group').map((key) => islands[key].id)
        : [],
    );
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
    // (An empty group has no vertices to be selected by.) A group is not
    // picked just because everything in it is: only if it was picked itself.
    const groups = this.pickedGroups ?? new Set();
    const isOtherGroup = (key) => {
      const island = this.mode === 'object' ? this.topology.islands[key] : null;
      return island?.kind === 'group' && !groups.has(island.id);
    };
    this.picked = new Set(
      this.allElements().filter((key) => {
        if (isOtherGroup(key)) return false;
        const own = this.elementVertices(key);
        return own.length > 0 && own.every((i) => vertices.has(i));
      }),
    );
    this.syncSelection();
  }

  // Pushes selection and hover to the view.
  refreshHighlight() {
    const { mode, hovered } = this;
    const faces = (keys) => {
      if (mode === 'face') return keys;
      // (The focus look shows objects as bare wireframes, their vertices marked.)
      if (mode === 'object' && !this.focus) {
        return keys.flatMap((key) => this.topology.islands[key].groupFaces);
      }
      return [];
    };
    const edges = (keys) => (mode === 'edge' ? keys.map((key) => this.elementVertices(key)) : []);
    const selected = [...this.picked];
    const hover = hovered === null ? [] : [hovered];
    // With the UV editor open the picture on a face is what is looked at: a
    // picked face is not tinted over, its outline blinks instead (see blink()).
    const outlined = this.uvLook && mode === 'face' && !this.focus;
    const outline = (keys) => keys.flatMap((key) => {
      const face = this.mesh.faces[key];
      return face.map((vertex, k) => [vertex, face[(k + 1) % face.length]]);
    });

    // Vertex points would only get in the way of aiming at edges and faces.
    this.view.points.visible = mode === 'vertex' || this.focus;
    this.view.updateColors(this.selection, mode === 'vertex' && hovered !== null ? hovered : -1);
    this.view.setHighlight({
      selectedFaces: outlined ? [] : faces(selected),
      hoveredFaces: faces(hover),
      selectedEdges: outlined ? outline(selected) : edges(selected),
      hoveredEdges: edges(hover),
    });
    this.blinking = outlined && selected.length > 0;
    if (this.blinking) this.blink();
    else this.view.shadeSelectedEdges(null);
    this.viewport.requestRender();
  }

  // Whether the UV editor is open: picked faces are then shown by a blinking
  // outline, not by a tint (see refreshHighlight()).
  setUVLook(on) {
    if (on === this.uvLook) return;
    this.uvLook = on;
    this.refreshHighlight();
  }

  // Runs while faces are outlined so: the outline goes from white to black and back.
  blink() {
    if (this.blinkFrame) return;
    const tick = (now) => {
      this.blinkFrame = null;
      if (!this.blinking) return;
      // From white down to a dark grey, not to black.
      const wave = 0.5 + 0.5 * Math.cos((now / BLINK_PERIOD) * Math.PI * 2);
      this.view.shadeSelectedEdges(BLINK_DARK + (1 - BLINK_DARK) * wave);
      this.viewport.requestRender();
      this.blinkFrame = requestAnimationFrame(tick);
    };
    this.blinkFrame = requestAnimationFrame(tick);
  }

  // --- selection ---------------------------------------------------------

  select(key, additive) {
    // The object picked by hand last: its pivot is the one used, see pivotEntry().
    if (this.mode === 'object' && key !== null) this.activeObject = this.topology.islands[key]?.id;
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
      if (this.topology.hiddenVertices.has(i)) return;
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
    // A face scaled flat has no surface to hit: it is picked by its corners,
    // and comes first - a ray through them would only find what is behind.
    const screen = this.screenProjector(clientX, clientY);
    const { hiddenVertices } = this.topology;
    let best = null;
    let bestDistance = PICK_RADIUS;
    this.mesh.faces.forEach((face, index) => {
      if (this.mesh.faceNormal(index).lengthSq() > 0.5) return;
      for (const i of face) {
        if (hiddenVertices.has(i) || this.isOccluded(this.mesh.vertices[i])) continue;
        const p = screen.project(this.mesh.vertices[i]);
        const distance = p ? Math.hypot(p.x - screen.x, p.y - screen.y) : Infinity;
        if (distance < bestDistance) {
          best = index;
          bestDistance = distance;
        }
      }
    });
    if (best !== null) return best;
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
    // A wireframe (the shading mode, or the focus look) hides nothing.
    if (this.shading === 'wireframe' || this.focus) return false;
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
    // Pivot points belong to whole objects: the pivot tool works in object
    // mode, on the object that was being edited.
    if (tool === 'pivot' && this.pivotEntry() === null) {
      if (this.busy()) return;
      const seeds = this.selection.size ? this.selection : this.target;
      const owners = new Set([...seeds].map((vertex) => this.topology.islandOfVertex[vertex]));
      this.setMode('object');
      if (this.mode !== 'object') return;
      if (owners.size === 1) this.select([...owners][0], false);
    }
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
    if (this.tool === 'pivot' && mode !== 'object') this.tool = 'select'; // see setTool()
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
    // Switching mid-drag re-applies the whole drag under the new constraint.
    if (this.drag?.start) {
      this.constrainDrag();
      this.dragTo(this.drag.lastX, this.drag.lastY);
    } else if (this.pivotDrag?.before) {
      this.dragPivotTo(this.pivotDrag.lastX, this.pivotDrag.lastY);
    }
    this.emitChange();
  }

  // An element, or the pivot point, is being pulled by the pointer.
  pulling() {
    return Boolean(this.drag || this.pivotDrag) && !this.extrude && !this.polygon;
  }

  // An axis held for a while: holdAxis('x' | 'y' | 'z') locks the movement to
  // it, holdAxis(null) puts back the lock there was before. It is taken only
  // while something is being pulled; returns whether it was.
  holdAxis(axis) {
    if (axis === null) {
      if (this.axisHold === null) return false;
      const back = this.axisHold;
      this.axisHold = null;
      this.setAxisLock(back);
      return true;
    }
    if (!this.pulling()) return false;
    if (this.axisHold === null) this.axisHold = this.axisLock;
    this.setAxisLock(axis);
    return true;
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
    if (this.busy() || this.topology.islands[index]?.hidden) return;
    if (this.operation) this.setOperation(null);
    if (this.mode !== 'object') this.setMode('object');
    this.select(index, additive);
  }

  // Where a new object goes when something is selected: up against the
  // selection, on its side that faces the camera. Returns { point, axis, sign }
  // - the point of the selection the object touches and the side of it the
  // object stands on - or null with nothing selected (the object then stays
  // at the origin). The side is that of a selected face's normal, or else the
  // one towards the camera, in both cases rounded to the nearest axis so that
  // the object stands square to the grid.
  primitiveAnchor() {
    if (this.selection.size === 0) return null;
    const box = this.selectionBox();
    const point = box.getCenter(new THREE.Vector3());
    const toward = this.viewport.camera.position.clone().sub(point);
    if (this.mode === 'face') {
      const normal = new THREE.Vector3();
      for (const face of this.picked) normal.add(this.mesh.faceNormal(face));
      // Whichever side of the faces the camera is on.
      if (normal.lengthSq() > 1e-6) toward.copy(normal.dot(toward) < 0 ? normal.negate() : normal);
    }
    const axis = ['x', 'y', 'z'].reduce((best, candidate) =>
      Math.abs(toward[candidate]) > Math.abs(toward[best]) ? candidate : best);
    const sign = toward[axis] < 0 ? -1 : 1;
    point[axis] = sign > 0 ? box.max[axis] : box.min[axis];
    return { point, axis, sign };
  }

  // Moves the given vertices of a mesh (a freshly built primitive) to an
  // anchor of primitiveAnchor(): its near side on the anchor's point, the
  // rest of it centred on that point. Without an anchor nothing moves.
  attachPrimitive(mesh, vertices, anchor) {
    if (!anchor) return;
    const { point, axis, sign } = anchor;
    const box = new THREE.Box3().setFromPoints(vertices.map((i) => mesh.vertices[i]));
    const offset = point.clone().sub(box.getCenter(new THREE.Vector3()));
    offset[axis] = point[axis] - (sign > 0 ? box.min[axis] : box.max[axis]);
    for (const i of vertices) mesh.vertices[i].add(offset);
  }

  // Shows, as a wireframe in the scene, the object addPrimitive() would make
  // with these arguments; a null kind takes the preview away. Nothing is added
  // to the model.
  previewPrimitive(kind, options = {}) {
    const draft = new EditableMesh();
    const made = kind && buildPrimitive(draft, kind, options);
    if (made) this.attachPrimitive(draft, made, this.primitiveAnchor());
    this.view.setPreview(made ? draft.edges().map(([a, b]) => [draft.vertices[a], draft.vertices[b]]) : []);
    this.viewport.requestRender();
  }

  // Adds an empty group to the scene tree.
  addGroup() {
    if (this.busy()) return;
    this.history.push(this.snapshot());
    this.mesh.addObject('Group', 'group');
    this.updateTopology();
    this.emitChange();
  }

  // Puts an object or a group into a group (indices in the objects list), or,
  // with null, back on the top level. Only a group takes anything in, and not
  // itself or a group it is inside of.
  setParent(index, parentIndex) {
    const child = this.mesh.objects[index];
    const parent = parentIndex === null ? null : this.mesh.objects[parentIndex];
    if (!child || parent === undefined || this.busy()) return;
    const parentId = parent?.id ?? null;
    if ((child.parent ?? null) === parentId || !this.mesh.canParent(child.id, parentId)) return;
    this.history.push(this.snapshot());
    child.parent = parentId;
    // Groups changed, and with them what "selected" means - and what is seen,
    // if the group is a hidden one.
    this.updateTopology();
    this.dropHidden();
    this.rebuildView();
    this.selectionChanged();
  }

  // Hides an object or a group (index in the objects list) with all it holds,
  // or shows it again. What is hidden is not drawn and can't be picked.
  setHidden(index, hidden) {
    const object = this.mesh.objects[index];
    if (!object || Boolean(object.hidden) === hidden || this.busy()) return;
    if (this.operation) this.setOperation(null);
    this.history.push(this.snapshot());
    object.hidden = hidden;
    this.updateTopology();
    this.dropHidden();
    this.rebuildView();
    this.selectionChanged();
  }

  // Deletes an object or a group (index in the objects list) with all it
  // holds, whatever is selected.
  deleteObject(index) {
    const { islands } = this.topology;
    if (!islands[index] || this.busy()) return;
    if (this.operation) this.setOperation(null);
    const before = this.snapshot();
    const { vertices, groups } = this.contents([index]);
    const remap = this.mesh.removeVertices(vertices);
    this.mesh.dropObjects(groups);
    const kept = (set) => new Set([...set].filter((i) => remap.has(i)).map((i) => remap.get(i)));
    this.target = kept(this.target);
    this.selection = kept(this.selection);
    this.edited(before);
    this.rebuildView();
    this.selectionChanged();
  }

  // Everything under the given entries of the objects list, the hidden
  // included: the vertices, and the ids of the groups.
  contents(indices) {
    const { islands } = this.topology;
    const vertices = new Set();
    const groups = new Set();
    const collect = (index) => {
      const island = islands[index];
      for (const vertex of island.vertices) vertices.add(vertex);
      if (island.kind === 'group') groups.add(island.id);
      island.children.forEach(collect);
    };
    indices.forEach(collect);
    return { vertices, groups };
  }

  // --- copying and pasting objects ------------------------------------------

  // Object mode: remembers a copy of the selected objects and groups, a group
  // with all it holds. Returns false if there was nothing to copy.
  copyObjects() {
    if (this.mode !== 'object' || this.picked.size === 0) return false;
    const { islands } = this.topology;
    const { mesh } = this;
    // What is selected through a selected group goes with that group.
    const underPicked = (index) => {
      for (let parent = islands[index].parentIndex; parent !== null; parent = islands[parent].parentIndex) {
        if (this.picked.has(parent)) return true;
      }
      return false;
    };
    const roots = new Set([...this.picked].filter((index) => !underPicked(index)));
    const entries = new Set();
    const collect = (index) => {
      entries.add(index);
      islands[index].children.forEach(collect);
    };
    roots.forEach(collect);
    const order = [...entries].sort((a, b) => a - b);

    const vertices = order.flatMap((index) => islands[index].vertices);
    const place = new Map(vertices.map((vertex, k) => [vertex, k]));
    this.clipboard = {
      // `parent` is an id among the copied ones; a root has `outer`, the group it was taken from.
      objects: order.map((index) => {
        const { id, name, kind, parent, hidden, pivot, rotation, mirror, color } = mesh.objects[index];
        const top = roots.has(index);
        return {
          id, name, kind, hidden: Boolean(hidden), pivot: pivot ? [...pivot] : null, mirror: mirror ? [...mirror] : null,
          rotation: rotation ? [...rotation] : null, color: color ?? null,
          parent: top ? null : parent, outer: top ? parent ?? null : null,
        };
      }),
      vertices: vertices.map((vertex) => mesh.vertices[vertex].clone()),
      vertexObject: vertices.map((vertex) => mesh.vertexObject[vertex]),
      faces: mesh.faces.filter((face) => place.has(face[0])).map((face) => {
        const copy = cloneFace(face);
        face.forEach((vertex, k) => { copy[k] = place.get(vertex); });
        return copy;
      }),
      wires: mesh.wires.filter(([a]) => place.has(a)).map((wire) => wire.map((vertex) => place.get(vertex))),
    };
    return true;
  }

  // Object mode: adds what copyObjects() remembered as new objects, in the
  // same place, and selects them with the move tool in hand. Returns false if
  // there was nothing to paste.
  pasteObjects() {
    const clip = this.clipboard;
    if (!clip || this.mode !== 'object' || this.operation || this.busy()) return false;
    const before = this.snapshot();
    const { mesh } = this;
    const groups = new Set(mesh.objects.filter((object) => object.kind === 'group').map((object) => object.id));

    const made = new Map(); // copied id -> the new object
    for (const source of clip.objects) {
      mesh.addObject(source.name, source.kind);
      const object = mesh.objects[mesh.objects.length - 1];
      if (source.hidden) object.hidden = true;
      if (source.pivot) object.pivot = [...source.pivot];
      if (source.rotation) object.rotation = [...source.rotation];
      if (source.color) object.color = source.color;
      if (source.mirror) object.mirror = [...source.mirror];
      made.set(source.id, object);
    }
    for (const source of clip.objects) {
      const object = made.get(source.id);
      // Inside the copy as it was; a root goes back into its group, if that is still there.
      if (source.parent !== null) object.parent = made.get(source.parent).id;
      else object.parent = groups.has(source.outer) ? source.outer : null;
    }
    const base = mesh.vertices.length;
    clip.vertices.forEach((point, k) => {
      mesh.addVertex(point.x, point.y, point.z, made.get(clip.vertexObject[k]).id);
    });
    for (const face of clip.faces) {
      const copy = cloneFace(face);
      face.forEach((vertex, k) => { copy[k] = base + vertex; });
      mesh.addFace(copy);
    }
    for (const wire of clip.wires) mesh.wires.push(wire.map((vertex) => base + vertex));

    this.selection = new Set(clip.vertices.map((_, k) => base + k));
    this.edited(before);
    this.rebuildView();
    // The copies themselves are what is picked, groups included.
    const roots = clip.objects.filter((source) => source.parent === null).map((source) => made.get(source.id));
    this.picked = new Set(roots.map((object) => mesh.objects.indexOf(object)));
    this.activeObject = roots[roots.length - 1].id;
    this.syncSelection();
    this.refreshHighlight();
    this.setTool('move');
    return true;
  }

  // Flies the camera to an object or a group (index in the objects list).
  focusObject(index) {
    const { vertices } = this.contents([index]);
    this.viewport.frame([...vertices].map((i) => this.mesh.vertices[i]), true);
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

  // Adds a new object at the origin and selects it: 'cube', 'cone'
  // ({ sides, size }), 'cylinder' ({ sides, size, height }) or 'sphere'
  // ({ segments, size }).
  addPrimitive(kind, options = {}) {
    if (this.busy()) return;
    this.previewPrimitive(null);
    const before = this.snapshot();
    const anchor = this.primitiveAnchor(); // from the selection as it is now
    const vertices = buildPrimitive(this.mesh, kind, options);
    if (!vertices) return;
    this.attachPrimitive(this.mesh, vertices, anchor);
    this.selection = new Set(vertices);
    this.commit(before);
    this.rebuildView();
    this.setTool('move');
  }

  // The faces flipFaces() would turn over: the selected ones in face mode, all
  // those of the selected objects in object mode.
  facesToFlip() {
    if (this.operation) return [];
    if (this.mode === 'face') return [...this.picked];
    if (this.mode === 'object') {
      return [...new Set([...this.picked].flatMap((key) => this.topology.islands[key].groupFaces))];
    }
    return [];
  }

  // Turns those faces over: what was a face's front becomes its back. Nothing moves.
  flipFaces() {
    const faces = this.facesToFlip();
    if (faces.length === 0 || this.busy()) return;
    const before = this.snapshot();
    for (const index of faces) {
      this.mesh.faces[index].reverse();
      this.mesh.faces[index].uv?.reverse(); // its corners' places, in step
    }
    this.edited(before);
    this.rebuildView();
    this.placeGizmo();
    this.emitChange();
  }

  // Whether makeFace() has something to work on: in vertex or edge mode, at
  // least two vertices selected (the ends of the selected edges count).
  canMakeFace() {
    return (this.mode === 'vertex' || this.mode === 'edge') && this.selection.size >= 2 && !this.operation;
  }

  // Joins the selected vertices (or the ends of the selected edges): two with
  // an edge, more with one face through them all. See EditableMesh.fill().
  makeFace() {
    if (!this.canMakeFace() || this.busy()) return;
    const before = this.snapshot();
    const facing = this.viewport.camera.getWorldDirection(new THREE.Vector3());
    if (!this.mesh.fill([...this.selection], facing)) return;
    this.edited(before);
    this.rebuildView();
    this.placeGizmo();
    this.emitChange();
  }

  // Vertices and objects go with every face that uses them; faces and edges
  // take only the faces themselves and the vertices left unused.
  deleteSelection() {
    if (this.picked.size === 0 || this.busy()) return;
    const before = this.snapshot();
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
      // A deleted group goes with everything inside it, hidden things too.
      const doomed = new Set(this.selection);
      let groups = new Set();
      if (this.mode === 'object') {
        const { islands } = this.topology;
        const inside = this.contents([...this.picked].filter((key) => islands[key].kind === 'group'));
        for (const vertex of inside.vertices) doomed.add(vertex);
        groups = inside.groups;
      }
      remap = this.mesh.removeVertices(doomed);
      this.mesh.dropObjects(groups);
    }
    // What is left of the edited object stays the target.
    this.target = new Set([...this.target].filter((i) => remap.has(i)).map((i) => remap.get(i)));
    this.selection.clear();
    this.edited(before);
    this.rebuildView();
    this.placeGizmo();
    this.emitChange();
  }

  // --- projects --------------------------------------------------------------

  // Replaces the scene with a project's (see project.js for the data): the
  // mesh and the scene tree, and the camera if the project has one. The
  // history starts anew - there is nothing to undo back to. Returns false if
  // a drag in progress is in the way.
  loadProject({ model, view }) {
    if (this.busy()) return false;
    this.setOperation(null);
    this.cancelDrag();
    this.cancelBox();
    const { mesh } = this;
    mesh.vertices = model.vertices.map(([x, y, z]) => new THREE.Vector3(x, y, z));
    mesh.faces = model.faces.map((face, i) => {
      const loop = [...face];
      const uv = model.uvs?.[i];
      if (uv) loop.uv = uv.map((point) => (point ? [point[0], point[1]] : null));
      if (model.pins?.includes(i)) loop.pin = true;
      return loop;
    });
    mesh.wires = model.wires.map((wire) => [...wire]);
    mesh.objects = model.objects.map(({ id, name, kind, parent, hidden, pivot, rotation, mirror, color }) => ({
      id,
      name,
      kind: kind === 'group' ? 'group' : 'mesh',
      parent: parent ?? null,
      ...(hidden ? { hidden: true } : {}),
      ...(pivot ? { pivot: [...pivot] } : {}),
      ...(rotation?.some(Boolean) ? { rotation: [...rotation] } : {}),
      ...(typeof color === 'string' ? { color } : {}),
      ...(mirror?.length ? { mirror: [...mirror] } : {}),
    }));
    this.mirror.globalAxes = new Set(model.mirror ?? []);
    mesh.vertexObject = [...model.vertexObject];
    const highest = mesh.objects.reduce((most, object) => Math.max(most, object.id), 0);
    mesh.nextObjectId = Math.max(model.nextObjectId ?? 0, highest + 1);
    mesh.folds = new Map((model.folds ?? []).map(([i, fold]) => [i, { ...fold }]));
    // Its texturing: the density, and an atlas of its size - empty until the
    // picture is loaded into it (a project without one gets the template).
    this.ppu = model.ppu ?? 16;
    this.atlas.reset(model.atlas?.width ?? START_SIZE, model.atlas?.height ?? START_SIZE);

    this.history = new History();
    this.clipboard = null;
    this.picked.clear();
    this.selection = new Set();
    this.target = new Set();
    this.rebuildView();
    // The first object is the one being edited, as after a start.
    const first = this.topology.islands.find((island) => island.kind !== 'group' && !island.hidden);
    this.target = new Set(first?.vertices ?? []);
    if (view) {
      const { camera, orbit } = this.viewport;
      camera.position.fromArray(view.camera.position);
      orbit.target.fromArray(view.camera.target);
      orbit.update();
    }
    this.placeGizmo();
    this.emitChange();
    return true;
  }

  // A fresh project: the starting cube and an empty history.
  newProject() {
    const draft = new EditableMesh();
    draft.addCube();
    return this.loadProject({
      model: {
        vertices: draft.vertices.map((vertex) => vertex.toArray()),
        faces: draft.faces,
        wires: [],
        objects: draft.objects,
        vertexObject: draft.vertexObject,
        nextObjectId: draft.nextObjectId,
      },
      view: { camera: { position: [3.5, 3, 4.5], target: [0, 0.5, 0] } },
    });
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
    const visible = vertices.filter((_, i) => !this.topology.hiddenVertices.has(i));
    const points = this.selection.size ? [...this.selection].map((i) => vertices[i]) : visible;
    this.viewport.frame(points);
  }

  // Moves the selection so that its center lands on `value` along `axis` ('x' | 'y' | 'z').
  // With `record` off the move makes no undo step: a caller that changes the
  // value many times in one gesture takes a snapshot() first and commit()s it
  // when the gesture ends.
  // With the pivot tool it is the pivot point that is moved, see panelPoint().
  setSelectionCenter(axis, value, record = true) {
    if (this.tool === 'pivot') {
      const entry = this.pivotEntry();
      if (entry === null || !Number.isFinite(value) || this.busy()) return;
      const before = record ? this.snapshot() : null;
      const point = this.pivotPoint(entry);
      point[axis] = value;
      this.mesh.objects[entry].pivot = point.toArray();
      if (before) this.commit(before);
      this.placeGizmo();
      this.emitChange();
      return;
    }
    if (this.selection.size === 0 || !Number.isFinite(value) || this.busy()) return;
    const before = record ? this.snapshot() : null;
    const offset = value - this.selectionCenter()[axis];
    const moving = new Map([...this.selection].map((i) => [i, this.mesh.vertices[i].clone()]));
    for (const i of this.selection) this.mesh.vertices[i][axis] += offset;
    for (const [object, point] of this.pivotsInMotion()) {
      point[axis] += offset;
      object.pivot = point.toArray();
    }
    this.mirror.moves(moving);
    if (before) this.commit(before);
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
      Boolean(this.pivotDrag?.before) ||
      this.gizmo.dragging ||
      this.extrude !== null ||
      Boolean(this.polygon?.points.length)
    );
  }

  // Copy of the document: the mesh plus the selection that goes with it.
  snapshot() {
    return {
      vertices: this.mesh.vertices.map((vertex) => vertex.clone()),
      faces: this.mesh.faces.map(cloneFace),
      wires: this.mesh.wires.map((wire) => [...wire]),
      objects: this.mesh.objects.map((object) => ({ ...object })),
      vertexObject: [...this.mesh.vertexObject],
      nextObjectId: this.mesh.nextObjectId,
      folds: [...this.mesh.folds].map(([i, fold]) => [i, { ...fold }]),
      selection: [...this.selection],
      target: [...this.target],
      mirror: [...this.mirror.globalAxes],
      ppu: this.ppu,
      atlas: this.atlas.pixels(), // the picture is part of the document
    };
  }

  restore(state) {
    this.mesh.vertices = state.vertices.map((vertex) => vertex.clone());
    this.mesh.faces = state.faces.map(cloneFace);
    this.mesh.wires = state.wires.map((wire) => [...wire]);
    // A state from before objects existed has none; the mesh then makes them up.
    this.mesh.objects = (state.objects ?? []).map((object) => ({ ...object }));
    this.mesh.vertexObject = [...(state.vertexObject ?? [])];
    this.mesh.nextObjectId = Math.max(this.mesh.nextObjectId, state.nextObjectId ?? 1);
    this.mirror.globalAxes = new Set(state.mirror ?? []);
    this.ppu = state.ppu ?? this.ppu;
    if (state.atlas) this.atlas.setPixels(state.atlas);
    this.mesh.folds = new Map((state.folds ?? []).map(([i, fold]) => [i, { ...fold }]));
    this.selection = new Set(state.selection);
    this.target = new Set(state.target);
    this.rebuildView();
    this.placeGizmo();
    this.emitChange();
  }

  // The end of an edit: `before` (the snapshot from before it) becomes the
  // undo step, and the mirror, if one is on, repeats the edit on the other
  // side - which may add and remove vertices, so the selection is carried
  // over and the view rebuilt.
  edited(before) {
    this.history.push(before);
    const remap = this.mirror.reconcile(before);
    if (!remap) {
      // Nothing was added or taken away, but faces may have changed shape.
      if (this.layOut()) this.view.updateUVs();
      return;
    }
    const kept = (set) => new Set([...set].filter((i) => remap.has(i)).map((i) => remap.get(i)));
    this.selection = kept(this.selection);
    this.target = kept(this.target);
    this.rebuildView();
    this.placeGizmo();
    this.emitChange();
  }

  // Records `before` as an undo step if the mesh (or a pivot point) actually
  // changed since then.
  commit(before) {
    const { vertices, faces, wires } = this.mesh;
    const pivots = (objects) => JSON.stringify(objects.map((object) => object.pivot ?? null));
    const changed =
      pivots(this.mesh.objects) !== pivots(before.objects) ||
      vertices.length !== before.vertices.length ||
      faces.length !== before.faces.length ||
      wires.length !== before.wires.length ||
      vertices.some((vertex, i) => !vertex.equals(before.vertices[i]));
    if (changed) this.edited(before);
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
        (island, i) =>
          island.kind === 'group'
            ? `  ${i} группа «${island.name}»${island.hidden ? ' (скрыта)' : ''}: ${list(island.children)}`
            : `  ${i} «${island.name}»${island.parentIndex === null ? '' : ` (в группе ${island.parentIndex})`}${island.hidden ? ' (скрыт)' : ''}: ${list(island.vertices)} | ${list(island.faces)}`,
      ),
      '',
      `выделение, элементы режима «${this.mode}»: ${list([...this.picked])}`,
      `выделение, вершины: ${list(sorted(this.selection))}`,
      `редактируемый объект (таргет), вершины: ${list(sorted(this.target))}`,
    ].join('\n');
  }

  // --- helpers -----------------------------------------------------------

  // Bounds of the selected vertices.
  // The bounds of the selection; with `turn` (a quaternion), along the axes
  // turned by it, in the coordinates of those axes.
  selectionBox(turn = null) {
    const points = [...this.selection].map((i) => this.mesh.vertices[i]);
    if (!turn) return new THREE.Box3().setFromPoints(points);
    const back = turn.clone().invert();
    return new THREE.Box3().setFromPoints(points.map((point) => point.clone().applyQuaternion(back)));
  }

  // The turn of the axes a scale of the selection goes along: that of the
  // object or group picked whole, or of the one object all of the selection
  // belongs to. Null when that is not turned (or there are several objects):
  // the scale then goes along the world's axes.
  scaleFrame() {
    const { objects, vertexObject } = this.mesh;
    const entry = this.pivotEntry();
    let rotation = null;
    if (entry !== null) {
      rotation = objects[entry].rotation;
    } else {
      const owners = new Set([...this.selection].map((i) => vertexObject[i]));
      if (owners.size === 1) rotation = objects.find((object) => object.id === [...owners][0])?.rotation;
    }
    return rotation ? quaternionOf(rotation) : null;
  }

  // A vertex remembers the sides it was folded from along its object's own
  // axes (see scaleFlat()). Returns a test: is a scale along the axes turned
  // by `turn` (null = the world's) along the own axes of vertex i's object?
  foldsFit(turn) {
    const { objects, vertexObject } = this.mesh;
    const wanted = turn ?? new THREE.Quaternion();
    const fits = new Map(objects.map((object) => [object.id, quaternionOf(object.rotation).angleTo(wanted) < 1e-6]));
    return (i) => fits.get(vertexObject[i]) ?? false;
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
    this.updateTopology(); // first: it tells the view what is hidden
    this.layOut();
    this.view.rebuild();
    this.adoptSelection();
    this.refreshHighlight();
  }

  selectionChanged() {
    this.refreshHighlight();
    this.placeGizmo();
    this.emitChange();
  }

  emitChange() {
    this.updatePivotMarker();
    this.dispatchEvent(new Event('change'));
  }
}
