import * as THREE from 'three';
import { NODE_MARK, nodePlaces } from './node-marks.js';
import { bones, kite } from './node-bones.js';
import { theme, axisColor, onThemeChange } from './theme.js';
import { edgeKey } from './mesh.js';
import { t } from './i18n.js';

// The surface as these views (and the window of views, see views-window.js)
// draw it: lit, painted with the atlases where it is on them, the rest in
// their objects' colours - materials of their own for the editor's surface
// materials (`source`), made again only when those or the atlases' pictures
// change (`cache`: what this gave the last time).
export function paintedMaterials(editor, source, cache = null) {
  const textures = editor.atlases.map((atlas) => atlas.texture);
  if (cache && cache.key[0] === source && cache.key[1].length === textures.length && cache.key[1].every((texture, i) => texture === textures[i])) return cache;
  for (const material of cache?.all ?? []) material.dispose();
  const made = (material) => {
    // (an atlas' material says which, see MeshView.syncParts())
    const texture = editor.atlasById(material.userData.atlas)?.texture ?? null;
    const painted = Boolean(texture);
    return new THREE.MeshLambertMaterial({
      map: texture,
      vertexColors: !painted, // (the rest in their objects' colours)
      side: material.side,
      alphaTest: painted ? 0.5 : 0,
      visible: material.visible !== false,
    });
  };
  const list = Array.isArray(source) ? source.map(made) : made(source);
  return { key: [source, textures], list, all: Array.isArray(list) ? list : [list] };
}

const FIT_MARGIN = 0.25; // share of a view kept free on each side when framing
const MIN_EXTENT = 0.5; // world units; keeps a tiny object from filling the view
const PICK_RADIUS = 9; // px
const EDGE_PICK_RADIUS = 6; // px, edges (in edge mode)
const CLICK_TOLERANCE = 4; // px of pointer travel that still counts as a click
const MIN_GRID_SPACING = 8; // px; denser grid lines and snap dots are not drawn
const DOT_OPACITY = 0.26;
const AROUND_WIDTH = 1.5; // px; the other objects of the shown object's node
const FAR_EDGE_OPACITY = 0.35; // brightness of lines at the farthest point of the object
const ZOOM_SPEED = 0.0015; // per wheel delta unit
const MIN_SCALE = 2; // px per world unit
const MAX_SCALE = 20000;
const AXIS_VECTORS = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};
const GIZMO_RADIUS = 20; // px, length of an axis in a view's corner gizmo
const GIZMO_MARGIN = 34; // px from the view's top right corner to the gizmo's center
const MIRROR_LINE = '#bd93f9'; // a mirror plane seen edge-on
const FLIP_ICON = '<i class="fa-solid fa-right-left"></i>';
const FIT_ICON = '<i class="fa-solid fa-expand"></i>';

// Each view looks along `direction`. `right` / `up` are the world axes that run
// along the screen axes, with their signs. A view can be flipped to look from
// the opposite side: `names` are its two titles, and `mirror` is the screen
// axis that reverses then (X stays to the right in the top/bottom pair, Y stays
// up in the others).
const VIEWS = [
  { names: [t('ortho-views.top'), t('ortho-views.bottom')], plane: 'XZ', mirror: 'up', axes: 'xz', direction: [0, -1, 0], right: 'x', rightSign: 1, up: 'z', upSign: -1 },
  { names: [t('ortho-views.front'), t('ortho-views.back')], plane: 'XY', mirror: 'right', axes: 'xy', direction: [0, 0, -1], right: 'x', rightSign: 1, up: 'y', upSign: 1 },
  { names: [t('ortho-views.right'), t('ortho-views.left')], plane: 'ZY', mirror: 'right', axes: 'yz', direction: [-1, 0, 0], right: 'z', rightSign: -1, up: 'y', upSign: 1 },
];

// Bottom panel with three orthographic wireframe views of the editor's target object.
// Vertices can be dragged within a view's plane, Shift+drag selects them with
// a box, RMB pans and the wheel zooms.
const PIVOT_RADIUS = 5; // px, the ring of the pivot mark shown by the pivot tool
const PIVOT_INNER_RADIUS = 3.5; // and of those inside a node

export class OrthoViews {
  // `container` may be in a window of its own (see views-window.js): its
  // sizes are then watched by that window's ResizeObserver (`Observer`).
  constructor(container, editor, { Observer = ResizeObserver } = {}) {
    this.container = container;
    this.editor = editor;
    this.Observer = Observer;
    this.disposed = false;
    this.shown = null; // { vertices, edges } of the editor's target object
    this.shownKey = ''; // identifies those objects; a change re-frames the views
    this.hovered = null; // vertex index under the pointer
    this.hoveredKey = null; // outside vertex mode: the key of the mode's element under it

    // The animation mode (see animate.js), set once it is made: in it the
    // views show the whole model posed and painted, and pose it.
    this.animation = null;
    this.poseDrag = null;
    this.views = VIEWS.map((definition) => this.createView(definition));
    this.listeners = [
      [editor, 'change', () => this.update()],
      [editor, 'cutframe', () => this.draw()], // the cut line is animated
      // The corner gizmos follow the main view's rotation.
      [editor.viewport.orbit, 'change', () => this.draw()],
    ];
    for (const [target, type, listener] of this.listeners) target.addEventListener(type, listener);
    onThemeChange(() => this.draw());
    this.update();
  }

  // No longer shown (its window closed): it lets go of the editor.
  dispose() {
    this.disposed = true;
    for (const [target, type, listener] of this.listeners) target.removeEventListener(type, listener);
  }

  get open() {
    return !this.disposed && !this.container.hidden;
  }

  // Shows or hides the panel; returns the new state.
  toggle(open = !this.open) {
    this.container.hidden = !open;
    if (open) this.update();
    return open;
  }

  createView(definition) {
    const frame = document.createElement('div');
    frame.className = 'ortho-view';
    const canvas = document.createElement('canvas');
    const header = document.createElement('div');
    header.className = 'ortho-header';
    const label = document.createElement('span');
    const fitButton = document.createElement('button');
    fitButton.title = t('ortho-views.fit');
    fitButton.innerHTML = FIT_ICON;
    const flipButton = document.createElement('button');
    flipButton.title = t('ortho-views.flip');
    flipButton.innerHTML = FLIP_ICON;
    // Buttons first: the title changes width when the view is flipped.
    header.append(fitButton, flipButton, label);
    frame.append(canvas, header);
    this.container.append(frame);

    const direction = new THREE.Vector3(...definition.direction);
    const view = {
      ...definition,
      frame,
      label,
      flipButton,
      flipped: false,
      canvas,
      context: canvas.getContext('2d'),
      direction,
      // The view's camera: the world point at its middle and px per world unit.
      center: new THREE.Vector3(),
      scale: 100,
      width: 0,
      height: 0,
      fitted: false,
      pan: null, // last pointer position while panning
      box: null, // Shift+drag selection box, in view pixels
      emptyPress: null, // where LMB went down on empty space; a click there deselects
    };

    // How the editor's drag code sees this view: pointer -> world ray, and
    // which way the viewer looks.
    view.viewer = {
      planeAxes: definition.axes,
      planeNormal: () => direction.clone(),
      viewDirection: () => direction.clone(),
      ray: (clientX, clientY) => {
        const { x, y } = this.localPoint(view, clientX, clientY);
        const origin = this.unproject(view, x, y).addScaledVector(direction, -1000);
        return new THREE.Ray(origin, direction.clone());
      },
      // A world point to the pointer's pixels.
      project: (point) => {
        const p = this.project(view, point);
        const rect = view.canvas.getBoundingClientRect();
        return { x: p.x + rect.left, y: p.y + rect.top };
      },
    };

    this.updateTitle(view);
    for (const button of [fitButton, flipButton]) {
      button.addEventListener('mousedown', (event) => event.preventDefault()); // keep keyboard focus
    }
    flipButton.addEventListener('click', () => this.flip(view));
    fitButton.addEventListener('click', () => {
      this.fit(view);
      this.drawView(view);
    });
    new this.Observer(() => this.resize(view)).observe(frame);
    this.bindPointer(view);
    return view;
  }

  // Turns the view around to look from the opposite side. Its center and zoom stay.
  flip(view) {
    view.flipped = !view.flipped;
    view.direction.negate(); // the viewer's closures share this vector
    view[`${view.mirror}Sign`] *= -1;
    this.updateTitle(view);
    this.hovered = null;
    this.drawView(view);
  }

  updateTitle(view) {
    view.label.textContent = `${view.names[view.flipped ? 1 : 0]} · ${view.plane}`;
    view.flipButton.classList.toggle('active', view.flipped);
  }

  resize(view) {
    const width = view.frame.clientWidth;
    const height = view.frame.clientHeight;
    if (width === 0 || height === 0) return; // the panel is hidden
    const ratio = window.devicePixelRatio;
    view.canvas.width = width * ratio;
    view.canvas.height = height * ratio;
    view.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    view.width = width;
    view.height = height;
    if (!view.fitted) this.fit(view);
    this.drawView(view);
  }

  // --- pointer -----------------------------------------------------------

  bindPointer(view) {
    const { canvas } = view;
    const { editor } = this;
    const pickAt = (event) => {
      const { x, y } = this.localPoint(view, event.clientX, event.clientY);
      return this.pick(view, x, y);
    };
    // The pointer takes the kind of element the mode is for: vertices in
    // vertex mode only, and in the other modes their edges, faces or objects.
    const elementAt = (event) => {
      const { x, y } = this.localPoint(view, event.clientX, event.clientY);
      return this.pickElement(view, x, y);
    };
    const vertexAt = (event) => (editor.mode === 'vertex' ? pickAt(event) : null);
    // Whether the pointer is on the pivot point the pivot tool is editing.
    const onPivot = (event) => {
      const entry = editor.tool === 'pivot' ? editor.pivotEntry() : null;
      if (entry === null || !this.shown) return false;
      const { x, y } = this.localPoint(view, event.clientX, event.clientY);
      const p = this.project(view, editor.pivotPoint(entry));
      return Math.hypot(p.x - x, p.y - y) <= PICK_RADIUS;
    };

    canvas.addEventListener('pointerdown', (event) => {
      if (event.button === 1 || event.button === 2) {
        canvas.setPointerCapture(event.pointerId);
        view.pan = { x: event.clientX, y: event.clientY };
        canvas.style.cursor = 'move';
        return;
      }
      if (event.button !== 0) return;
      view.emptyPress = null;
      if (this.posing) {
        this.pressPose(view, event);
        return;
      }
      // The cut tool: the line follows the pointer here too, and a click cuts.
      // (The face to cut across is chosen in the main view.)
      if (editor.operation === 'cut') {
        if (editor.cut) {
          editor.moveCut(event.clientX, event.clientY, view.viewer);
          editor.applyCut();
        }
        return;
      }
      // The pivot point comes before the vertices under it.
      if (!event.shiftKey && onPivot(event) && editor.pressPivot(event.clientX, event.clientY, view.viewer)) {
        canvas.setPointerCapture(event.pointerId);
        return;
      }
      // The pivot tool works on the pivot point alone.
      if (editor.tool === 'pivot') return;
      const element = elementAt(event);
      const vertex = vertexAt(event);
      if (event.shiftKey) {
        // Shift: a drag draws a selection box, even when it starts on a vertex.
        canvas.setPointerCapture(event.pointerId);
        const { x, y } = this.localPoint(view, event.clientX, event.clientY);
        view.box = { x0: x, y0: y, x1: x, y1: y, vertex, element, active: false };
        return;
      }
      if (element !== null) {
        // The element's vertex nearest to the pointer leads the drag.
        const { x, y } = this.localPoint(view, event.clientX, event.clientY);
        const distance = (index) => {
          const p = this.project(view, editor.mesh.vertices[index]);
          return Math.hypot(p.x - x, p.y - y);
        };
        const lead = editor.elementVertices(element).reduce((best, index) =>
          distance(index) < distance(best) ? index : best);
        canvas.setPointerCapture(event.pointerId);
        editor.pressElement(element, lead, event.clientX, event.clientY, false, view.viewer);
        return;
      }
      if (vertex === null) {
        view.emptyPress = { x: event.clientX, y: event.clientY };
        return;
      }
      canvas.setPointerCapture(event.pointerId);
      editor.pressVertex(vertex, event.clientX, event.clientY, event.shiftKey, view.viewer);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (view.pan) {
        // The grabbed point follows the cursor.
        view.center[view.right] -= (view.rightSign * (event.clientX - view.pan.x)) / view.scale;
        view.center[view.up] += (view.upSign * (event.clientY - view.pan.y)) / view.scale;
        view.pan = { x: event.clientX, y: event.clientY };
        this.drawView(view);
        return;
      }
      if (this.poseDrag) {
        if (event.buttons & 1) this.movePose(event);
        else {
          this.poseDrag = null; // the release was missed
          this.animation.endPose();
        }
        return;
      }
      if (this.posing) {
        if (event.buttons === 0) {
          const { x, y } = this.localPoint(view, event.clientX, event.clientY);
          canvas.style.cursor = this.pickPosed(view, x, y) === null ? '' : 'grab';
        }
        return;
      }
      if (view.box) {
        // The release was missed: apply the box as it is.
        if (!(event.buttons & 1)) {
          this.finishBox(view);
          return;
        }
        const { x, y } = this.localPoint(view, event.clientX, event.clientY);
        const box = view.box;
        box.x1 = x;
        box.y1 = y;
        box.active ||= Math.hypot(x - box.x0, y - box.y0) > CLICK_TOLERANCE;
        this.drawView(view);
        return;
      }
      editor.setFineSnap(event.ctrlKey);
      if (editor.operation === 'cut') {
        if (editor.cut) editor.moveCut(event.clientX, event.clientY, view.viewer);
        canvas.style.cursor = editor.cut ? 'crosshair' : '';
        return;
      }
      if (editor.pivotDrag) {
        if (event.buttons & 1) editor.dragPivotTo(event.clientX, event.clientY);
        else editor.endPivotDrag(); // the release was missed
        canvas.style.cursor = editor.pivotDrag ? 'grabbing' : '';
        return;
      }
      // The release was missed (it can happen outside the window): finish the drag.
      if (editor.drag && !(event.buttons & 1)) editor.endDrag();
      if (editor.drag) {
        editor.dragTo(event.clientX, event.clientY);
      } else if (event.buttons === 0) {
        const pivotOnly = editor.tool === 'pivot';
        const element = pivotOnly ? null : elementAt(event);
        this.setHovered(pivotOnly ? null : vertexAt(event), element);
        canvas.style.cursor = this.hovered === null && element === null && !onPivot(event) ? '' : 'grab';
      }
    });
    canvas.addEventListener('pointerleave', () => {
      if (!editor.drag) this.setHovered(null, null);
    });
    canvas.addEventListener('pointerup', (event) => {
      if (view.pan && event.button !== 0) {
        view.pan = null;
        canvas.style.cursor = '';
      } else if (event.button === 0 && this.poseDrag) {
        this.poseDrag = null;
        this.animation.endPose();
      } else if (event.button === 0 && editor.pivotDrag) {
        editor.endPivotDrag();
        canvas.style.cursor = 'grab';
      } else if (event.button === 0 && view.box) {
        this.finishBox(view);
      } else if (event.button === 0 && view.emptyPress) {
        const { x, y } = view.emptyPress;
        view.emptyPress = null;
        const travel = Math.hypot(event.clientX - x, event.clientY - y);
        if (travel <= CLICK_TOLERANCE) editor.clearSelection();
      } else if (event.button === 0 && editor.drag) {
        editor.endDrag();
      }
    });
    canvas.addEventListener('pointercancel', () => {
      view.pan = null;
      view.box = null;
      editor.cancelDrag();
    });
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        // Zoom about the cursor: the world point under it stays where it is.
        const { x, y } = this.localPoint(view, event.clientX, event.clientY);
        const anchor = this.unproject(view, x, y);
        const factor = Math.exp(-event.deltaY * ZOOM_SPEED);
        view.scale = THREE.MathUtils.clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
        const moved = this.unproject(view, x, y);
        view.center[view.right] += anchor[view.right] - moved[view.right];
        view.center[view.up] += anchor[view.up] - moved[view.up];
        this.drawView(view);
      },
      { passive: false },
    );
  }

  // Ends a Shift press: a drag replaces the selection with every shown vertex
  // inside the box (through the wireframe, hidden ones included); a plain click
  // toggles the vertex under the pointer, or deselects everything on empty space.
  finishBox(view) {
    const { box } = view;
    view.box = null;
    if (box.active) {
      this.editor.selectVertices(this.verticesInBox(view, box));
    } else if (box.element !== null) {
      this.editor.select(box.element, true);
    } else if (box.vertex === null) {
      this.editor.clearSelection();
    } else if (this.editor.mode === 'vertex') {
      this.editor.select(box.vertex, true);
    }
    this.drawView(view);
  }

  // Drops a selection box in progress. Returns false if there was none.
  cancelBox() {
    const view = this.views.find((candidate) => candidate.box);
    if (!view) return false;
    view.box = null;
    this.drawView(view);
    return true;
  }

  verticesInBox(view, box) {
    if (!this.shown) return [];
    const left = Math.min(box.x0, box.x1);
    const right = Math.max(box.x0, box.x1);
    const top = Math.min(box.y0, box.y1);
    const bottom = Math.max(box.y0, box.y1);
    return this.shown.vertices.filter((index) => {
      // The vertex the box was started on counts even if it sits on the border.
      if (index === box.vertex) return true;
      const p = this.project(view, this.editor.mesh.vertices[index]);
      return p.x >= left && p.x <= right && p.y >= top && p.y <= bottom;
    });
  }

  setHovered(vertex, key = null) {
    if (vertex === this.hovered && key === this.hoveredKey) return;
    this.hovered = vertex;
    this.hoveredKey = key;
    this.hoveredMode = this.editor.mode;
    this.draw();
  }

  // --- what is shown and how it is framed --------------------------------

  // In the animation mode: the model posed and painted, posed by the tools.
  get posing() {
    return this.editor.workspace === 'animation' && Boolean(this.animation);
  }

  update() {
    const { topology, target } = this.editor;
    if (this.posing) {
      // The whole model shown (what is not hidden), framed once.
      const { hiddenVertices } = topology;
      const vertices = this.editor.mesh.vertices.map((_, i) => i).filter((i) => !hiddenVertices.has(i));
      this.shown = vertices.length ? { vertices, faces: [], edges: [], around: [] } : null;
      if (this.shownKey !== 'posed' && !this.poseDrag) {
        this.shownKey = 'posed';
        for (const view of this.views) this.fit(view);
      }
      this.draw();
      return;
    }
    if (this.shownKey === 'posed') this.shownKey = '';

    const islands = [...new Set([...target].map((vertex) => topology.islandOfVertex[vertex]))];
    if (islands.length === 0) {
      this.shown = null;
    } else {
      const vertices = islands.flatMap((island) => topology.islands[island].vertices);
      const inside = new Set(vertices);
      const faces = islands.flatMap((island) => topology.islands[island].faces);
      this.shown = { vertices, faces, edges: topology.edges.filter(([a]) => inside.has(a)) };
      // What else is in the nodes the shown objects are in, up to the
      // outermost one: drawn faintly for reference, not to be touched.
      const around = new Set();
      const collect = (index) => {
        const entry = topology.islands[index];
        if (entry.hidden) return;
        for (const vertex of entry.vertices) if (!inside.has(vertex)) around.add(vertex);
        entry.children.forEach(collect);
      };
      for (const island of islands) {
        let top = island;
        while (topology.islands[top].parentIndex !== null) top = topology.islands[top].parentIndex;
        if (top !== island) collect(top);
      }
      this.shown.around = topology.edges.filter(([a]) => around.has(a));
      if (!inside.has(this.hovered)) this.hovered = null;
    }
    // The hovered element is of the mode it was found in, and may be gone by now.
    if (this.hoveredKey !== null && (this.hoveredMode !== this.editor.mode || !this.elementShown(this.hoveredKey))) {
      this.hoveredKey = null;
    }

    // Another object came into view: frame it. Otherwise the cameras are left
    // alone, and never moved during a drag, or the vertex would slide away
    // from the cursor.
    const key = islands.sort((a, b) => a - b).join(',');
    if (key !== this.shownKey && !this.editor.drag) {
      this.shownKey = key;
      for (const view of this.views) this.fit(view);
    }
    this.draw();
  }

  // Frames the shown objects in every view.
  frame() {
    for (const view of this.views) this.fit(view);
    this.draw();
  }

  fit(view) {
    view.fitted = false;
    if (!this.shown || view.width === 0) return;
    const { vertices } = this.editor.mesh;
    const box = new THREE.Box3().setFromPoints(this.shown.vertices.map((i) => vertices[i]));
    const size = box.getSize(new THREE.Vector3());
    box.getCenter(view.center);
    const room = 1 - 2 * FIT_MARGIN;
    view.scale = Math.min(
      (view.width * room) / Math.max(size[view.right], MIN_EXTENT),
      (view.height * room) / Math.max(size[view.up], MIN_EXTENT),
    );
    view.fitted = true;
  }

  project(view, point) {
    return {
      x: view.width / 2 + view.rightSign * (point[view.right] - view.center[view.right]) * view.scale,
      y: view.height / 2 - view.upSign * (point[view.up] - view.center[view.up]) * view.scale,
    };
  }

  // World point for a view pixel, at the depth of the view's center.
  unproject(view, x, y) {
    const point = view.center.clone();
    point[view.right] += (view.rightSign * (x - view.width / 2)) / view.scale;
    point[view.up] -= (view.upSign * (y - view.height / 2)) / view.scale;
    return point;
  }

  localPoint(view, clientX, clientY) {
    const rect = view.canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  // World range covered by a view along one of its axes.
  visibleRange(view, axis) {
    const a = this.unproject(view, 0, 0)[axis];
    const b = this.unproject(view, view.width, view.height)[axis];
    return [Math.min(a, b), Math.max(a, b)];
  }

  // Key of the current mode's element at a view pixel, or null: an edge, a
  // face, or the object the face (or, failing that, the edge) there belongs to.
  // Vertex mode has none: its vertices are picked by pick().
  pickElement(view, x, y) {
    const { mode, topology } = this.editor;
    if (mode === 'vertex' || !this.shown) return null;
    if (mode === 'face') return this.pickFace(view, x, y);
    const edge = this.pickEdge(view, x, y);
    if (mode === 'edge') return edge && edgeKey(...edge);
    const face = this.pickFace(view, x, y);
    if (face !== null) return topology.islandOfFace[face];
    return edge ? topology.islandOfVertex[edge[0]] : null;
  }

  // Whether an element key of the current mode names something shown here.
  elementShown(key) {
    if (!this.shown) return false;
    const { mode, topology, mesh } = this.editor;
    if (mode === 'edge') return this.shown.edges.some(([a, b]) => edgeKey(a, b) === key);
    if (mode === 'face') return this.shown.faces.includes(key) && key < mesh.faces.length;
    if (mode === 'object') return key < topology.islands.length;
    return false;
  }

  // Shown face whose outline, as this view sees it, holds a view pixel; of
  // overlapping ones, the one closest to the viewer. A face seen edge-on has
  // no inside and is not found.
  pickFace(view, x, y) {
    if (!this.shown) return null;
    const { vertices, faces } = this.editor.mesh;
    let best = null;
    let bestDepth = -Infinity;
    for (const index of this.shown.faces) {
      const face = faces[index];
      if (!face) continue;
      const outline = face.map((vertex) => this.project(view, vertices[vertex]));
      let area = 0;
      let inside = false;
      outline.forEach((a, i) => {
        const b = outline[(i + 1) % outline.length];
        area += a.x * b.y - b.x * a.y;
        if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      });
      if (!inside || Math.abs(area) < 8) continue;
      const depth = -face.reduce((sum, vertex) => sum + vertices[vertex].dot(view.direction), 0) / face.length;
      if (depth <= bestDepth) continue;
      best = index;
      bestDepth = depth;
    }
    return best;
  }

  // Shown edge nearest to a view pixel, as [a, b]; of overlapping ones, the
  // one closest to the viewer. An edge seen end-on is a dot and is left to its vertices.
  pickEdge(view, x, y) {
    if (!this.shown) return null;
    const { vertices } = this.editor.mesh;
    let best = null;
    let bestDistance = EDGE_PICK_RADIUS;
    let bestDepth = -Infinity;
    for (const [a, b] of this.shown.edges) {
      const p = this.project(view, vertices[a]);
      const q = this.project(view, vertices[b]);
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const lengthSq = dx * dx + dy * dy;
      if (lengthSq < 4) continue;
      const t = THREE.MathUtils.clamp(((x - p.x) * dx + (y - p.y) * dy) / lengthSq, 0, 1);
      const distance = Math.round(Math.hypot(p.x + t * dx - x, p.y + t * dy - y));
      const depth = -(vertices[a].dot(view.direction) + vertices[b].dot(view.direction)) / 2;
      if (distance > bestDistance || (distance === bestDistance && depth <= bestDepth)) continue;
      best = [a, b];
      bestDistance = distance;
      bestDepth = depth;
    }
    return best;
  }

  // Shown vertex nearest to a view pixel; of overlapping ones, the one closest to the viewer.
  pick(view, x, y) {
    if (!this.shown) return null;
    let best = null;
    let bestDistance = PICK_RADIUS;
    let bestDepth = -Infinity;
    for (const index of this.shown.vertices) {
      const vertex = this.editor.mesh.vertices[index];
      const p = this.project(view, vertex);
      const distance = Math.round(Math.hypot(p.x - x, p.y - y));
      const depth = -vertex.dot(view.direction); // larger = closer to the viewer
      if (distance > bestDistance || (distance === bestDistance && depth <= bestDepth)) continue;
      best = index;
      bestDistance = distance;
      bestDepth = depth;
    }
    return best;
  }

  // --- drawing -----------------------------------------------------------

  draw() {
    if (!this.open) return;
    for (const view of this.views) this.drawView(view);
  }

  drawView(view) {
    const { context, width, height } = view;
    if (width === 0) return;
    context.clearRect(0, 0, width, height);
    this.drawGrid(view);
    if (this.posing) {
      this.drawModel(view);
      this.drawPicked(view);
    } else {
      this.drawContent(view);
    }
    this.drawNodes(view);
    this.drawGizmo(view);
  }

  // Every node: a hollow square on its pivot point, over everything - as in
  // the main view (see node-marks.js).
  drawNodes(view) {
    const { context } = view;
    context.save();
    context.strokeStyle = NODE_MARK.color;
    const places = nodePlaces(this.editor, this.posing ? this.animation : null);
    // The bones first, under the squares: kites facing this view.
    const right = new THREE.Vector3();
    right[view.right] = view.rightSign;
    const up = new THREE.Vector3();
    up[view.up] = view.upSign;
    const look = right.clone().cross(up).negate(); // (into the view)
    context.lineWidth = 1;
    for (const bone of bones(this.editor, places)) {
      const corners = kite(bone, look).map((point) => this.project(view, point));
      context.globalAlpha = bone.picked ? 1 : 0.55;
      context.beginPath();
      corners.forEach(({ x, y }, k) => (k ? context.lineTo(x, y) : context.moveTo(x, y)));
      context.closePath();
      context.stroke();
    }
    for (const { at, picked, size } of places) {
      const p = this.project(view, at);
      context.globalAlpha = picked ? 1 : NODE_MARK.faint;
      context.lineWidth = NODE_MARK.line * (picked ? 2 : 1);
      const inset = context.lineWidth / 2;
      context.strokeRect(Math.round(p.x - size / 2) + inset, Math.round(p.y - size / 2) + inset, size - 2 * inset, size - 2 * inset);
    }
    context.restore();
    // (a square growing or shrinking: the views drawn again on the next frame)
    if (places.growing && !this.nodesGrowing) {
      this.nodesGrowing = requestAnimationFrame(() => {
        this.nodesGrowing = 0;
        this.draw();
      });
    }
  }

  // --- the animation mode: the model posed and painted ---------------------------------
  //
  // The model is drawn by a renderer of the views' own, looking along the
  // view as it is framed: the editor's surface (its geometry - posed, see
  // pose.js - shared), painted with the atlas, lit from the viewer. What is
  // picked whole is outlined over it.

  modelMaterials(source) {
    this.materials = paintedMaterials(this.editor, source, this.materials);
    return this.materials.list;
  }

  drawModel(view) {
    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
      this.modelScene = new THREE.Scene();
      this.modelScene.add(new THREE.AmbientLight(0xffffff, 1.2));
      this.modelLight = new THREE.DirectionalLight(0xffffff, 1.8);
      this.modelScene.add(this.modelLight, this.modelLight.target);
      this.model = new THREE.Mesh();
      this.modelScene.add(this.model);
      this.modelCamera = new THREE.OrthographicCamera();
    }
    const solid = this.editor.view.solid;
    this.model.geometry = solid.geometry;
    this.model.material = this.modelMaterials(solid.material);
    // The camera: the view's screen axes, from its centre, as project() has them.
    const right = new THREE.Vector3();
    right[view.right] = view.rightSign;
    const up = new THREE.Vector3();
    up[view.up] = view.upSign;
    const back = right.clone().cross(up);
    const camera = this.modelCamera;
    const [w, h] = [view.width / 2 / view.scale, view.height / 2 / view.scale];
    Object.assign(camera, { left: -w, right: w, top: h, bottom: -h, near: -10000, far: 10000 });
    camera.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, back));
    camera.position.copy(view.center);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    this.modelLight.position.copy(view.center).addScaledVector(back, 10).addScaledVector(up, 4).addScaledVector(right, 2);
    this.modelLight.target.position.copy(view.center);
    this.modelLight.target.updateMatrixWorld();
    const ratio = window.devicePixelRatio;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(view.width, view.height, false);
    this.renderer.render(this.modelScene, camera);
    view.context.drawImage(this.renderer.domElement, 0, 0, view.width, view.height);
  }

  // The edges of what is picked whole, where they are shown.
  drawPicked(view) {
    const { editor } = this;
    const entry = editor.pivotEntry();
    if (entry === null) return;
    const inside = editor.contents([entry]).vertices;
    const shown = editor.view.shown;
    const { context } = view;
    context.strokeStyle = theme.selected;
    context.lineWidth = 1.5;
    context.beginPath();
    for (const [a, b] of editor.topology.edges) {
      if (!inside.has(a)) continue;
      const p = this.project(view, shown[a]);
      const q = this.project(view, shown[b]);
      context.moveTo(p.x, p.y);
      context.lineTo(q.x, q.y);
    }
    context.stroke();
  }

  // The object under a point of a view (its index in the objects list), as
  // the model is shown: the face nearest the viewer that the point is on.
  pickPosed(view, x, y) {
    const { mesh, topology } = this.editor;
    const shown = this.editor.view.shown;
    let best = null;
    let nearest = Infinity;
    const inside = (p, a, b, c) => {
      const s = (u, v, w) => (u.x - w.x) * (v.y - w.y) - (v.x - w.x) * (u.y - w.y);
      const d1 = s(p, a, b);
      const d2 = s(p, b, c);
      const d3 = s(p, c, a);
      return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
    };
    mesh.faces.forEach((face, i) => {
      if (topology.hiddenVertices.has(face[0])) return;
      for (const triangle of mesh.triangulate(i)) {
        const points = triangle.map((vertex) => this.project(view, shown[vertex]));
        if (!inside({ x, y }, ...points)) continue;
        const depth = triangle.reduce((sum, vertex) => sum + shown[vertex].dot(view.direction), 0) / 3;
        if (depth < nearest) {
          nearest = depth;
          best = topology.islandOfVertex[face[0]];
        }
      }
    });
    return best;
  }

  // A press in a view, in the animation mode: on an object, it is picked (if
  // what is picked whole is not it, or a node it is in) and posed by the
  // tool in hand as the pointer moves - moved in the view's plane, turned
  // about the view's axis round its pivot, scaled from it. On nothing, a
  // click lets go of what was picked.
  pressPose(view, event) {
    const { editor } = this;
    const { x, y } = this.localPoint(view, event.clientX, event.clientY);
    const hit = this.pickPosed(view, x, y);
    if (hit === null) {
      view.emptyPress = { x: event.clientX, y: event.clientY };
      return;
    }
    let entry = editor.pivotEntry();
    const within = (index) => {
      for (let at = index; at !== null && at !== undefined; at = editor.topology.islands[at].parentIndex) if (at === entry) return true;
      return false;
    };
    if (entry === null || !within(hit)) {
      editor.select(hit, false);
      entry = editor.pivotEntry();
    }
    if (entry === null) return;
    const property = editor.tool === 'rotate' ? 'rotation' : editor.tool === 'scale' ? 'scale' : 'position';
    // (Shift, moving: by inverse kinematics, see ik.js)
    this.animation.beginPose(entry, property, { ik: event.shiftKey });
    const world = this.animation.dragging.world;
    view.canvas.setPointerCapture(event.pointerId);
    this.poseDrag = { view, property, x, y, world, pivot: new THREE.Vector3().setFromMatrixPosition(world) };
  }

  movePose(event) {
    const drag = this.poseDrag;
    const { view } = drag;
    const { x, y } = this.localPoint(view, event.clientX, event.clientY);
    const snap = this.editor.snapGrid.enabled;
    let matrix;
    if (drag.property === 'position') {
      const delta = this.unproject(view, x, y).sub(this.unproject(view, drag.x, drag.y));
      if (snap) {
        const step = this.editor.snapGrid.step / (event.ctrlKey ? this.editor.snapGrid.fineDivisor : 1);
        for (const axis of [view.right, view.up]) delta[axis] = Math.round(delta[axis] / step) * step;
      }
      matrix = new THREE.Matrix4().makeTranslation(delta).multiply(drag.world);
    } else {
      const p = this.project(view, drag.pivot);
      if (drag.property === 'rotation') {
        // About the axis that points at the viewer: on the screen, anticlockwise.
        let angle = Math.atan2(-(y - p.y), x - p.x) - Math.atan2(-(drag.y - p.y), drag.x - p.x);
        if (snap) angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
        const axis = view.direction.clone().negate();
        const turn = new THREE.Matrix4().makeRotationAxis(axis, angle);
        const to = new THREE.Matrix4().makeTranslation(drag.pivot);
        const from = new THREE.Matrix4().makeTranslation(drag.pivot.clone().negate());
        matrix = to.multiply(turn).multiply(from).multiply(drag.world);
      } else {
        const factor = Math.max(0.01, Math.hypot(x - p.x, y - p.y) / Math.max(1, Math.hypot(drag.x - p.x, drag.y - p.y)));
        matrix = drag.world.clone().multiply(new THREE.Matrix4().makeScale(factor, factor, factor));
      }
    }
    this.animation.poseTo(matrix);
  }

  drawContent(view) {
    const { context, width, height } = view;
    const { mesh, selection } = this.editor;

    if (!this.shown) {
      context.fillStyle = theme.textDim;
      context.font = '12px "Segoe UI", system-ui, sans-serif';
      context.textAlign = 'center';
      context.fillText(t('ortho-views.no-object'), width / 2, height / 2 + 4);
      return;
    }

    this.drawSnapDots(view);

    // The rest of the node, behind everything: dark lines, for reference only.
    if (this.shown.around.length) {
      context.strokeStyle = theme.around;
      context.lineWidth = AROUND_WIDTH;
      context.beginPath();
      for (const [a, b] of this.shown.around) {
        const p = this.project(view, mesh.vertices[a]);
        const q = this.project(view, mesh.vertices[b]);
        context.moveTo(p.x, p.y);
        context.lineTo(q.x, q.y);
      }
      context.stroke();
      context.lineWidth = 1;
    }

    this.drawMirrorPlanes(view);
    this.drawEdges(view);

    // The selected elements of the mode, and the one under the pointer.
    const { mode, picked, topology } = this.editor;
    if (mode !== 'vertex') {
      const inside = new Set(this.shown.vertices);
      const stroke = (pairs, color) => {
        context.strokeStyle = color;
        context.lineWidth = 2.5;
        context.lineCap = 'round';
        context.beginPath();
        for (const [a, b] of pairs) {
          if (!inside.has(a) || !inside.has(b)) continue;
          const p = this.project(view, mesh.vertices[a]);
          const q = this.project(view, mesh.vertices[b]);
          context.moveTo(p.x, p.y);
          context.lineTo(q.x, q.y);
        }
        context.stroke();
        context.lineWidth = 1;
        context.lineCap = 'butt';
      };
      // A face is tinted and outlined.
      const fill = (faces, color) => {
        for (const index of faces) {
          const face = mesh.faces[index];
          if (!face || !inside.has(face[0])) continue;
          context.beginPath();
          face.forEach((vertex, i) => {
            const p = this.project(view, mesh.vertices[vertex]);
            if (i === 0) context.moveTo(p.x, p.y);
            else context.lineTo(p.x, p.y);
          });
          context.closePath();
          context.fillStyle = withAlpha(color, 0.22);
          context.fill();
          context.strokeStyle = color;
          context.lineWidth = 2;
          context.stroke();
          context.lineWidth = 1;
        }
      };
      const show = (keys, color) => {
        if (mode === 'edge') {
          stroke(keys.map((key) => String(key).split('_').map(Number)), color);
        } else if (mode === 'face') {
          fill(keys, color);
        } else {
          // An object: all of its edges.
          const own = new Set(keys.flatMap((key) => topology.islands[key]?.node ?? []));
          stroke(this.shown.edges.filter(([a]) => own.has(a)), color);
        }
      };
      show([...picked], theme.selected);
      if (this.hoveredKey !== null) show([this.hoveredKey], theme.hovered);
    }

    // The line of a cut being placed.
    const cut = this.editor.cut;
    if (cut?.segments.length) {
      // A plain solid line here; the dashes that flow are the main view's.
      context.strokeStyle = theme.cut;
      context.lineWidth = 2;
      context.beginPath();
      for (const [a, b] of cut.segments) {
        const p = this.project(view, a);
        const q = this.project(view, b);
        context.moveTo(p.x, p.y);
        context.lineTo(q.x, q.y);
      }
      context.stroke();
      context.lineWidth = 1;
    }

    // Farthest first, so the vertex a click would grab is drawn on top.
    const order = [...this.shown.vertices].sort(
      (a, b) => mesh.vertices[b].dot(view.direction) - mesh.vertices[a].dot(view.direction),
    );
    // Vertices a selection box would take are previewed like hovered ones.
    const box = view.box?.active ? view.box : null;
    const boxed = new Set(box ? this.verticesInBox(view, box) : []);
    for (const index of order) {
      const p = this.project(view, mesh.vertices[index]);
      context.fillStyle = selection.has(index) ? theme.selected : theme.vertex;
      if (index === this.hovered || boxed.has(index)) context.fillStyle = theme.hovered;
      context.beginPath();
      context.arc(p.x, p.y, selection.has(index) ? 5 : 3.5, 0, Math.PI * 2); // selected ones are larger
      context.fill();
    }

    // With the pivot tool: the pivot point being edited and, smaller, those of
    // what a node holds - the same mark as in the main view.
    const entry = this.editor.tool === 'pivot' ? this.editor.pivotEntry() : null;
    if (entry !== null) {
      const mark = (index, radius) => {
        const p = this.project(view, this.editor.pivotPoint(index));
        context.beginPath();
        context.arc(p.x, p.y, radius, 0, Math.PI * 2);
        // Four ticks sticking out of the ring.
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          context.moveTo(p.x + dx * radius, p.y + dy * radius);
          context.lineTo(p.x + dx * radius * 1.8, p.y + dy * radius * 1.8);
        }
        context.stroke();
        context.beginPath();
        context.arc(p.x, p.y, radius * 0.35, 0, Math.PI * 2);
        context.fill();
      };
      context.strokeStyle = context.fillStyle = theme.pivot;
      context.lineWidth = 1.5;
      for (const child of this.editor.pivotChildren(entry)) mark(child, PIVOT_INNER_RADIUS);
      mark(entry, PIVOT_RADIUS);
      context.lineWidth = 1;
    }

    if (box) {
      const x = Math.round(Math.min(box.x0, box.x1)) + 0.5;
      const y = Math.round(Math.min(box.y0, box.y1)) + 0.5;
      const w = Math.round(Math.abs(box.x1 - box.x0));
      const h = Math.round(Math.abs(box.y1 - box.y0));
      context.fillStyle = context.strokeStyle = theme.box;
      context.globalAlpha = 0.12;
      context.fillRect(x, y, w, h);
      context.globalAlpha = 1;
      context.strokeRect(x, y, w, h);
    }
  }

  // The mirror planes seen edge-on in this view: dash-dot lines of one
  // colour - the global ones, and those of the shown objects' own mirrors.
  drawMirrorPlanes(view) {
    const { context, width, height } = view;
    const { editor } = this;
    const planes = [...editor.mirror.globalAxes].map((axis) => ({ axis, value: 0 }));
    const shown = [...new Set(this.shown.vertices.map((vertex) => editor.topology.islandOfVertex[vertex]))];
    for (const index of shown) {
      if (!editor.mesh.objects[index]?.mirror?.length) continue;
      for (const plane of editor.mirror.planesFor(index)) planes.push(plane);
    }
    if (planes.length === 0) return;
    context.save();
    // Dash-dot, the way a drawing marks an axis of symmetry; with round caps
    // a dash of no length comes out as a dot.
    context.setLineDash([9, 5, 0, 5]);
    context.lineCap = 'round';
    context.lineWidth = 1.5;
    const point = new THREE.Vector3();
    for (const { axis, value } of planes) {
      if (axis !== view.right && axis !== view.up) continue; // the plane of the view itself
      point.set(0, 0, 0);
      point[axis] = value;
      const p = this.project(view, point);
      context.beginPath();
      if (axis === view.right) {
        context.moveTo(p.x, 0);
        context.lineTo(p.x, height);
      } else {
        context.moveTo(0, p.y);
        context.lineTo(width, p.y);
      }
      // The grid's own line is often right under it (a mirror through the
      // origin lies on an axis): that is wiped first, or the dashes drown in it.
      context.save();
      context.globalCompositeOperation = 'destination-out';
      context.setLineDash([]);
      context.lineWidth = 3;
      context.stroke();
      context.restore();
      context.strokeStyle = MIRROR_LINE;
      context.stroke();
    }
    context.restore();
  }

  // The wireframe, with a depth cue: the nearer a vertex is to the viewer of
  // this view, the brighter the lines at it, from full brightness at the
  // nearest point of the object down to FAR_EDGE_OPACITY (never black) at the
  // farthest. Every edge is a gradient between its two ends.
  drawEdges(view) {
    const { context } = view;
    const { vertices } = this.editor.mesh;
    // Depth grows towards the viewer.
    const depth = (index) => -vertices[index].dot(view.direction);
    const depths = this.shown.vertices.map(depth);
    const farthest = Math.min(...depths);
    const range = Math.max(...depths) - farthest;
    const opacity = (index) =>
      range < 1e-9 ? 1 : FAR_EDGE_OPACITY + (1 - FAR_EDGE_OPACITY) * ((depth(index) - farthest) / range);

    // Far edges first, so that the near, brighter ones lie on top of them.
    const edges = [...this.shown.edges].sort((e, f) => depth(e[0]) + depth(e[1]) - depth(f[0]) - depth(f[1]));
    context.lineWidth = 1;
    for (const [a, b] of edges) {
      const p = this.project(view, vertices[a]);
      const q = this.project(view, vertices[b]);
      // An edge seen end-on is just a dot, and a gradient needs some length.
      if (Math.hypot(q.x - p.x, q.y - p.y) < 0.5) continue;
      const gradient = context.createLinearGradient(p.x, p.y, q.x, q.y);
      gradient.addColorStop(0, withAlpha(theme.text, opacity(a)));
      gradient.addColorStop(1, withAlpha(theme.text, opacity(b)));
      context.strokeStyle = gradient;
      context.beginPath();
      context.moveTo(p.x, p.y);
      context.lineTo(q.x, q.y);
      context.stroke();
    }
  }

  // Corner gizmo: the world axes as the main view sees them, with the axis
  // this view looks along drawn as a full line. Its dot marks the side the
  // view looks from.
  drawGizmo(view) {
    const { context } = view;
    const cx = view.width - GIZMO_MARGIN;
    const cy = GIZMO_MARGIN;
    const toCamera = this.editor.viewport.camera.quaternion.clone().invert();
    const end = (axis, length) => {
      // Camera space: x right, y up.
      const d = AXIS_VECTORS[axis].clone().applyQuaternion(toCamera);
      return { x: cx + d.x * length, y: cy - d.y * length };
    };

    context.fillStyle = theme.bgRaised;
    context.globalAlpha = 0.8;
    context.beginPath();
    context.arc(cx, cy, GIZMO_RADIUS + 8, 0, Math.PI * 2);
    context.fill();
    context.globalAlpha = 1;

    const viewAxis = Object.keys(AXIS_VECTORS).find((axis) => view.direction[axis] !== 0);
    context.lineCap = 'round';
    for (const axis of Object.keys(AXIS_VECTORS)) {
      if (axis === viewAxis) continue;
      const p = end(axis, GIZMO_RADIUS * 0.8);
      context.strokeStyle = axisColor(axis);
      context.globalAlpha = 0.4;
      context.lineWidth = 1.5;
      context.beginPath();
      context.moveTo(cx, cy);
      context.lineTo(p.x, p.y);
      context.stroke();
    }

    // The viewer stands on the side opposite to the looking direction.
    const viewerSide = -view.direction[viewAxis];
    const from = end(viewAxis, GIZMO_RADIUS * viewerSide);
    const to = end(viewAxis, -GIZMO_RADIUS * viewerSide);
    context.globalAlpha = 1;
    context.strokeStyle = context.fillStyle = axisColor(viewAxis);
    context.lineWidth = 2.5;
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    context.beginPath();
    context.arc(from.x, from.y, 4, 0, Math.PI * 2);
    context.fill();
    context.lineCap = 'butt';
  }

  // Unit grid (coarser when zoomed out) and the two world axes of the view.
  drawGrid(view) {
    const { context, width, height } = view;
    let step = 1;
    while (step * view.scale < MIN_GRID_SPACING) step *= 10;

    const point = new THREE.Vector3();
    const line = (axis, value) => {
      point.set(0, 0, 0);
      point[axis] = value;
      const p = this.project(view, point);
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
    context.globalAlpha = 0.06;
    context.beginPath();
    for (const axis of [view.right, view.up]) {
      const [min, max] = this.visibleRange(view, axis);
      for (let i = Math.ceil(min / step); i <= Math.floor(max / step); i++) line(axis, i * step);
    }
    context.stroke();

    // The line where one axis is zero runs along the other axis and takes its color.
    context.globalAlpha = 0.45;
    for (const [axis, along] of [[view.right, view.up], [view.up, view.right]]) {
      context.strokeStyle = axisColor(along);
      context.beginPath();
      line(axis, 0);
      context.stroke();
    }
    context.globalAlpha = 1;
  }

  // The snap lattice of the drag in progress, fading with distance from the dragged point.
  drawSnapDots(view) {
    const grid = this.editor.snapGrid;
    if (!grid.dots.visible || grid.active * view.scale < MIN_GRID_SPACING) return;
    // A lattice turned along an object's own axes is no flat grid seen from here.
    if (grid.turn) return;

    const { context } = view;
    const range = (axis) => this.visibleRange(view, axis).map((value) => grid.index(value, axis));
    const [r0, r1] = range(view.right);
    const [u0, u1] = range(view.up);
    const focus = this.project(view, grid.dots.material.uniforms.focus.value);
    const radius = Math.min(view.width, view.height) * 0.45;
    const point = new THREE.Vector3();

    // A dot for every axis of the drag, in the axis' colour; they add up like
    // lights, as in the main view.
    context.globalCompositeOperation = 'lighter';
    for (const axis of grid.dotAxes()) {
      context.fillStyle = axisColor(axis);
      for (let r = r0; r <= r1; r++) {
        for (let u = u0; u <= u1; u++) {
          point[view.right] = grid.coordinate(r, view.right);
          point[view.up] = grid.coordinate(u, view.up);
          const p = this.project(view, point);
          const weight = 1 - THREE.MathUtils.smoothstep(Math.hypot(p.x - focus.x, p.y - focus.y), 0, radius);
          context.globalAlpha = DOT_OPACITY * (0.15 + 0.85 * weight);
          context.beginPath();
          context.arc(p.x, p.y, 1 + 1.5 * weight, 0, Math.PI * 2);
          context.fill();
        }
      }
    }
    context.globalCompositeOperation = 'source-over';
    context.globalAlpha = 1;
  }
}

// A '#rrggbb' colour as an rgba() string with the given opacity.
function withAlpha(hex, alpha) {
  const value = parseInt(hex.slice(1), 16);
  return `rgba(${value >> 16}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}
