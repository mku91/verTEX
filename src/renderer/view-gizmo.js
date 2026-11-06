import * as THREE from 'three';
import { theme, axisColor } from './theme.js';

// The editor's gizmo as the three views show it: drawn on a view's flat
// picture, with the handles of the tool in hand along what can be seen of its
// axes. A drag on a handle is worked out here into what the real gizmo would
// have done (the place, the turn, the pull) and handed to the editor, whose
// code for the real one does the rest - the grid, the mirror, the undo step.

const AXIS_LENGTH = 62; // px
const TIP_SIZE = 7; // px, half of an arrow's or a scale handle's tip
const PLANE_OFFSET = 20; // px from the middle to the middle of the plane handle, along each axis
const PLANE_HALF = 8; // px
const UNIFORM_HALF = 7; // px, the scale's handle in the middle
const RING_RADIUS = 58; // px
const HIT_RADIUS = 7; // px
const LINE_WIDTH = 2;
const EDGE_ON = 0.2; // an axis shorter than this share of its length on the screen points at the viewer
const WORLD_AXES = {
  X: new THREE.Vector3(1, 0, 0),
  Y: new THREE.Vector3(0, 1, 0),
  Z: new THREE.Vector3(0, 0, 1),
};

const distanceToSegment = (p, a, b) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = THREE.MathUtils.clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
};

export class ViewGizmo {
  // `views`: the OrthoViews it is drawn in (their project() and unproject()).
  constructor(views) {
    this.views = views;
    this.editor = views.editor;
    this.drag = null;
  }

  // The handles of a view: [{ name (as the real gizmo names it), kind, ... }]
  // and the middle, in the view's pixels; null when the gizmo is not up.
  layout(view) {
    const { editor, views } = this;
    if (!editor.gizmo.object || views.posing) return null;
    const { mode } = editor.gizmo;
    const place = editor.pivot.position;
    const center = views.project(view, place);
    const handles = [];
    if (mode === 'rotate') {
      const name = Object.keys(WORLD_AXES).find((key) => view.direction[key.toLowerCase()] !== 0);
      handles.push({ name, kind: 'ring', color: axisColor(name.toLowerCase()) });
      return { center, handles };
    }
    const turned = editor.pivot.quaternion.angleTo(new THREE.Quaternion()) > 1e-9;
    const shown = [];
    for (const [name, axis] of Object.entries(WORLD_AXES)) {
      const direction = axis.clone().applyQuaternion(editor.pivot.quaternion);
      const end = views.project(view, place.clone().add(direction));
      // Pixels per world unit along the axis, on the screen.
      const screen = { x: end.x - center.x, y: end.y - center.y };
      const length = Math.hypot(screen.x, screen.y);
      if (length < EDGE_ON * view.scale) continue;
      const unit = { x: screen.x / length, y: screen.y / length };
      shown.push({
        name,
        kind: 'axis',
        color: axisColor(name.toLowerCase()),
        direction,
        screen,
        unit,
        tip: { x: center.x + unit.x * AXIS_LENGTH, y: center.y + unit.y * AXIS_LENGTH },
      });
    }
    // What is on top is taken first: the handles in the middle before the axes.
    if (mode === 'scale') {
      handles.push({ name: 'XYZ', kind: 'uniform', color: theme.text, at: center, half: UNIFORM_HALF });
    } else if (!turned && shown.length === 2) {
      const [a, b] = shown;
      handles.push({
        name: view.axes.toUpperCase(),
        kind: 'plane',
        color: axisColor(Object.keys(WORLD_AXES).find((key) => view.direction[key.toLowerCase()] !== 0).toLowerCase()),
        at: { x: center.x + (a.unit.x + b.unit.x) * PLANE_OFFSET, y: center.y + (a.unit.y + b.unit.y) * PLANE_OFFSET },
        half: PLANE_HALF,
      });
    }
    handles.push(...shown);
    return { center, handles };
  }

  // The handle at a place in a view, or null.
  handleAt(view, x, y) {
    const layout = this.layout(view);
    if (!layout) return null;
    const point = { x, y };
    for (const handle of layout.handles) {
      if (handle.kind === 'ring') {
        if (Math.abs(Math.hypot(x - layout.center.x, y - layout.center.y) - RING_RADIUS) <= HIT_RADIUS) return handle;
      } else if (handle.kind === 'axis') {
        if (distanceToSegment(point, layout.center, handle.tip) <= HIT_RADIUS) return handle;
      } else if (Math.abs(x - handle.at.x) <= handle.half && Math.abs(y - handle.at.y) <= handle.half) {
        return handle;
      }
    }
    return null;
  }

  // A press on a handle: the drag begins. `x`, `y` in the view's pixels.
  press(view, handle, x, y) {
    const { editor } = this;
    // The way the scale's middle handle counts as outward: up and to the right, on this view.
    const outward = new THREE.Vector3();
    outward[view.right] = view.rightSign;
    outward[view.up] = view.upSign;
    if (!editor.beginDrivenGizmo(handle.name, outward.normalize())) return false;
    const center = this.views.project(view, editor.pivot.position);
    this.drag = {
      view,
      handle,
      x,
      y,
      last: { x, y },
      place: editor.pivot.position.clone(),
      turn: editor.pivot.quaternion.clone(),
      angle: Math.atan2(-(y - center.y), x - center.x),
      total: 0,
    };
    editor.redriveGizmo = () => this.apply();
    return true;
  }

  move(x, y) {
    this.drag.last = { x, y };
    this.apply();
  }

  // What the pointer's place makes of the drag, from where it began.
  apply() {
    const { editor, views } = this;
    const { view, handle, last, x, y, place } = this.drag;
    const dx = last.x - x;
    const dy = last.y - y;
    const { mode } = editor.gizmo;
    if (mode === 'rotate') {
      const center = views.project(view, place);
      const now = Math.atan2(-(last.y - center.y), last.x - center.x);
      // The way round since the last move, the short way: it adds up past half a turn.
      let step = now - this.drag.angle;
      if (step > Math.PI) step -= 2 * Math.PI;
      if (step < -Math.PI) step += 2 * Math.PI;
      this.drag.angle = now;
      this.drag.total += step;
      const snap = editor.gizmo.rotationSnap;
      const angle = snap ? Math.round(this.drag.total / snap) * snap : this.drag.total;
      // About the axis that points at the viewer: on the screen, anticlockwise.
      const toViewer = view.direction.clone().negate();
      editor.pivot.quaternion.setFromAxisAngle(toViewer, angle).multiply(this.drag.turn);
    } else if (handle.kind === 'axis') {
      // How far along the axis, in world units: what of the pointer's way goes along it on the screen.
      const { screen, direction } = handle;
      const along = (dx * screen.x + dy * screen.y) / (screen.x * screen.x + screen.y * screen.y);
      if (mode === 'scale') {
        // (Taken at its tip, on its own side of the gizmo.)
        editor.gizmo.pointStart.copy(direction).multiplyScalar(AXIS_LENGTH / Math.hypot(screen.x, screen.y));
        editor.gizmo.pointEnd.copy(editor.gizmo.pointStart).addScaledVector(direction, along);
      } else {
        editor.pivot.position.copy(place).addScaledVector(direction, along);
      }
    } else {
      const way = views.unproject(view, last.x, last.y).sub(views.unproject(view, x, y));
      if (mode === 'scale') {
        editor.gizmo.pointStart.set(0, 0, 0);
        editor.gizmo.pointEnd.copy(way);
      } else {
        editor.pivot.position.copy(place).add(way);
      }
    }
    editor.applyGizmo();
  }

  end() {
    if (!this.drag) return;
    this.drag = null;
    this.editor.redriveGizmo = null;
    this.editor.endDrivenGizmo();
  }

  // `hot`: the handle's name under the pointer, or being dragged.
  draw(view, hot) {
    const layout = this.layout(view);
    if (!layout) return;
    const { context } = view;
    const { center, handles } = layout;
    const colorOf = (handle) => (handle.name === hot ? theme.hoveredFocus : handle.color);
    context.save();
    context.lineWidth = LINE_WIDTH;
    context.lineCap = 'round';
    // From the last, so that what is taken first is on top.
    for (const handle of [...handles].reverse()) {
      const color = colorOf(handle);
      context.strokeStyle = context.fillStyle = color;
      if (handle.kind === 'ring') {
        context.beginPath();
        context.arc(center.x, center.y, RING_RADIUS, 0, Math.PI * 2);
        context.stroke();
      } else if (handle.kind === 'axis') {
        const { tip, unit } = handle;
        context.beginPath();
        context.moveTo(center.x, center.y);
        context.lineTo(tip.x, tip.y);
        context.stroke();
        if (this.editor.gizmo.mode === 'scale') {
          context.fillRect(tip.x - TIP_SIZE / 2 - 1, tip.y - TIP_SIZE / 2 - 1, TIP_SIZE + 2, TIP_SIZE + 2);
        } else {
          context.beginPath();
          context.moveTo(tip.x + unit.x * TIP_SIZE * 1.6, tip.y + unit.y * TIP_SIZE * 1.6);
          context.lineTo(tip.x - unit.y * TIP_SIZE * 0.8, tip.y + unit.x * TIP_SIZE * 0.8);
          context.lineTo(tip.x + unit.y * TIP_SIZE * 0.8, tip.y - unit.x * TIP_SIZE * 0.8);
          context.closePath();
          context.fill();
        }
      } else {
        const { at, half } = handle;
        context.globalAlpha = 0.35;
        context.fillRect(at.x - half, at.y - half, half * 2, half * 2);
        context.globalAlpha = 1;
        context.strokeRect(at.x - half, at.y - half, half * 2, half * 2);
      }
    }
    context.restore();
  }
}
