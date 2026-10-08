import * as THREE from 'three';
import { theme, axisColor, onThemeChange } from './theme.js';

const FIT_MARGIN = 0.25; // share of a view kept free on each side when framing
const MIN_EXTENT = 0.5; // world units; keeps a tiny object from filling the view
const PICK_RADIUS = 9; // px
const CLICK_TOLERANCE = 4; // px of pointer travel that still counts as a click
const MIN_GRID_SPACING = 8; // px; denser grid lines and snap dots are not drawn
const DOT_OPACITY = 0.35;
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
const FLIP_ICON =
  '<svg viewBox="0 0 24 24"><path d="M11 3h2v18h-2zM9 7v10l-6-5zm6 0l6 5-6 5z"/></svg>';
const FIT_ICON =
  '<svg viewBox="0 0 24 24"><path d="M3 3h6v2H5v4H3zm12 0h6v6h-2V5h-4zM3 15h2v4h4v2H3zm16 0h2v6h-6v-2h4zM9 9h6v6H9z"/></svg>';

// Each view looks along `direction`. `right` / `up` are the world axes that run
// along the screen axes, with their signs. A view can be flipped to look from
// the opposite side: `names` are its two titles, and `mirror` is the screen
// axis that reverses then (X stays to the right in the top/bottom pair, Y stays
// up in the others).
const VIEWS = [
  { names: ['Сверху', 'Снизу'], plane: 'XZ', mirror: 'up', axes: 'xz', direction: [0, -1, 0], right: 'x', rightSign: 1, up: 'z', upSign: -1 },
  { names: ['Спереди', 'Сзади'], plane: 'XY', mirror: 'right', axes: 'xy', direction: [0, 0, -1], right: 'x', rightSign: 1, up: 'y', upSign: 1 },
  { names: ['Справа', 'Слева'], plane: 'ZY', mirror: 'right', axes: 'yz', direction: [-1, 0, 0], right: 'z', rightSign: -1, up: 'y', upSign: 1 },
];

// Bottom panel with three orthographic wireframe views of the editor's target object.
// Vertices can be dragged within a view's plane, Shift+drag selects them with
// a box, RMB pans and the wheel zooms.
export class OrthoViews {
  constructor(container, editor) {
    this.container = container;
    this.editor = editor;
    this.shown = null; // { vertices, edges } of the editor's target object
    this.shownKey = ''; // identifies those objects; a change re-frames the views
    this.hovered = null; // vertex index under the pointer

    this.views = VIEWS.map((definition) => this.createView(definition));
    editor.addEventListener('change', () => this.update());
    onThemeChange(() => this.draw());
    editor.addEventListener('cutframe', () => this.draw()); // the cut line is animated
    // The corner gizmos follow the main view's rotation.
    editor.viewport.orbit.addEventListener('change', () => this.draw());
    this.update();
  }

  get open() {
    return !this.container.hidden;
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
    fitButton.title = 'Центрировать вид';
    fitButton.innerHTML = FIT_ICON;
    const flipButton = document.createElement('button');
    flipButton.title = 'Инвертировать вид: смотреть с противоположной стороны';
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
    new ResizeObserver(() => this.resize(view)).observe(frame);
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

    canvas.addEventListener('pointerdown', (event) => {
      if (event.button === 1 || event.button === 2) {
        canvas.setPointerCapture(event.pointerId);
        view.pan = { x: event.clientX, y: event.clientY };
        canvas.style.cursor = 'move';
        return;
      }
      if (event.button !== 0) return;
      view.emptyPress = null;
      const vertex = pickAt(event);
      if (event.shiftKey) {
        // Shift: a drag draws a selection box, even when it starts on a vertex.
        canvas.setPointerCapture(event.pointerId);
        const { x, y } = this.localPoint(view, event.clientX, event.clientY);
        view.box = { x0: x, y0: y, x1: x, y1: y, vertex, active: false };
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
      // The release was missed (it can happen outside the window): finish the drag.
      if (editor.drag && !(event.buttons & 1)) editor.endDrag();
      if (editor.drag) {
        editor.dragTo(event.clientX, event.clientY);
      } else if (event.buttons === 0) {
        this.setHovered(pickAt(event));
        canvas.style.cursor = this.hovered === null ? '' : 'grab';
      }
    });
    canvas.addEventListener('pointerleave', () => {
      if (!editor.drag) this.setHovered(null);
    });
    canvas.addEventListener('pointerup', (event) => {
      if (view.pan && event.button !== 0) {
        view.pan = null;
        canvas.style.cursor = '';
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

  setHovered(vertex) {
    if (vertex === this.hovered) return;
    this.hovered = vertex;
    this.draw();
  }

  // --- what is shown and how it is framed --------------------------------

  update() {
    const { topology, target } = this.editor;

    const islands = [...new Set([...target].map((vertex) => topology.islandOfVertex[vertex]))];
    if (islands.length === 0) {
      this.shown = null;
    } else {
      const vertices = islands.flatMap((island) => topology.islands[island].vertices);
      const inside = new Set(vertices);
      this.shown = { vertices, edges: topology.edges.filter(([a]) => inside.has(a)) };
      if (!inside.has(this.hovered)) this.hovered = null;
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
    this.drawContent(view);
    this.drawGizmo(view);
  }

  drawContent(view) {
    const { context, width, height } = view;
    const { mesh, selection } = this.editor;

    if (!this.shown) {
      context.fillStyle = theme.textDim;
      context.font = '12px "Segoe UI", system-ui, sans-serif';
      context.textAlign = 'center';
      context.fillText('Нет объекта', width / 2, height / 2 + 4);
      return;
    }

    this.drawSnapDots(view);

    this.drawEdges(view);

    // The line of a cut being placed.
    const cut = this.editor.cut;
    if (cut?.segments.length) {
      // Dashed and flowing, like in the main view.
      context.strokeStyle = theme.cut;
      context.lineWidth = 2.5;
      context.lineCap = 'round';
      context.setLineDash([7, 8]);
      context.lineDashOffset = -cut.time * 40;
      context.beginPath();
      for (const [a, b] of cut.segments) {
        const p = this.project(view, a);
        const q = this.project(view, b);
        context.moveTo(p.x, p.y);
        context.lineTo(q.x, q.y);
      }
      context.stroke();
      context.lineWidth = 1;
      context.lineCap = 'butt';
      context.setLineDash([]);
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
      context.fillStyle = selection.has(index) ? theme.selected : theme.textDim;
      if (index === this.hovered || boxed.has(index)) context.fillStyle = theme.hovered;
      context.beginPath();
      context.arc(p.x, p.y, selection.has(index) ? 5 : 3.5, 0, Math.PI * 2); // selected ones are larger
      context.fill();
    }

    if (box) {
      const x = Math.round(Math.min(box.x0, box.x1)) + 0.5;
      const y = Math.round(Math.min(box.y0, box.y1)) + 0.5;
      const w = Math.round(Math.abs(box.x1 - box.x0));
      const h = Math.round(Math.abs(box.y1 - box.y0));
      context.fillStyle = context.strokeStyle = theme.selected;
      context.globalAlpha = 0.12;
      context.fillRect(x, y, w, h);
      context.globalAlpha = 1;
      context.strokeRect(x, y, w, h);
    }
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

    const { context } = view;
    const range = (axis) => this.visibleRange(view, axis).map((value) => grid.index(value, axis));
    const [r0, r1] = range(view.right);
    const [u0, u1] = range(view.up);
    const focus = this.project(view, grid.dots.material.uniforms.focus.value);
    const radius = Math.min(view.width, view.height) * 0.45;
    const point = new THREE.Vector3();

    context.fillStyle = theme.snapDot;
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
    context.globalAlpha = 1;
  }
}

// A '#rrggbb' colour as an rgba() string with the given opacity.
function withAlpha(hex, alpha) {
  const value = parseInt(hex.slice(1), 16);
  return `rgba(${value >> 16}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}
