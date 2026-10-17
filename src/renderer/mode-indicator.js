import * as THREE from 'three';

// The selection mode, shown in the view's top left corner as what is picked
// in it, turned with the camera as the axes' gizmo is:
//   object - a wireframe cube
//   face   - a square
//   edge   - a line
//   vertex - a point
// They are all the one cube, squashed along the axes - a face is the cube
// flat in y, an edge flat in y and z, a vertex flat in all three - so that a
// change of mode turns one into the other smoothly: the squashing (and the
// point's dot) eases from where it is to where it is to be. A change in the middle of one goes on from where that one had got to.

const SIZE = 56; // px across
const HALF = 13; // px, half the cube's side
const DURATION = 300; // ms a change takes

// For each mode: the cube's squashing along x, y, z; the point.
const SHAPES = {
  object: { scale: [1, 1, 1], dot: 0 },
  face: { scale: [1, 0, 1], dot: 0 },
  edge: { scale: [1, 0, 0], dot: 0 },
  vertex: { scale: [0, 0, 0], dot: 1 },
};

const CORNERS = [];
for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) CORNERS.push(new THREE.Vector3(x, y, z));
// The cube's edges, by its corners: those of the corners that differ in one sign.
const EDGES = [];
CORNERS.forEach((a, i) => CORNERS.forEach((b, j) => {
  if (j > i && a.clone().sub(b).manhattanLength() === 2) EDGES.push([i, j]);
}));

const ease = (t) => 1 - (1 - t) ** 3; // fast, then slowing down

export class ModeIndicator {
  constructor(element, viewport, editor) {
    this.viewport = viewport;
    this.editor = editor;
    this.canvas = document.createElement('canvas');
    element.append(this.canvas);
    this.mode = editor.mode;
    this.shape = copy(SHAPES[this.mode]); // as it is drawn now
    this.from = null; // a change in progress: { shape, to, start }
    viewport.orbit.addEventListener('change', () => this.draw());
    editor.addEventListener('change', () => {
      if (editor.mode !== this.mode) this.change(editor.mode);
    });
    this.draw();
  }

  // Turns what is shown into the mode's shape, from where it is now.
  change(mode) {
    this.mode = mode;
    this.from = { shape: copy(this.shape), to: SHAPES[mode], start: performance.now() };
    const step = (now) => {
      if (!this.from) return;
      const t = Math.min(1, (now - this.from.start) / DURATION);
      const k = ease(t);
      const { shape: a, to: b } = this.from;
      this.shape = {
        scale: a.scale.map((value, i) => value + (b.scale[i] - value) * k),
        dot: a.dot + (b.dot - a.dot) * k,
      };
      this.draw();
      if (t < 1) requestAnimationFrame(step);
      else this.from = null;
    };
    requestAnimationFrame(step);
  }

  draw() {
    const { canvas } = this;
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(SIZE * ratio)) {
      canvas.width = canvas.height = Math.round(SIZE * ratio);
      canvas.style.width = canvas.style.height = `${SIZE}px`;
    }
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, SIZE, SIZE);
    const style = getComputedStyle(canvas);
    const line = style.getPropertyValue('--text').trim() || '#eee';
    const accent = style.getPropertyValue('--accent').trim() || '#bd93f9';
    // The corners squashed, turned as the camera sees them (camera space: x
    // right, y up, z towards the viewer), and onto the canvas.
    const toCamera = this.viewport.camera.quaternion.clone().invert();
    const [sx, sy, sz] = this.shape.scale;
    const points = CORNERS.map((corner) => {
      const p = new THREE.Vector3(corner.x * sx, corner.y * sy, corner.z * sz).applyQuaternion(toCamera);
      return { x: SIZE / 2 + p.x * HALF, y: SIZE / 2 - p.y * HALF, z: p.z };
    });
    // The edges: the far ones faint, the near ones full - far ones first.
    context.lineWidth = 1.5;
    context.lineCap = 'round';
    context.strokeStyle = line;
    const edges = EDGES.map(([a, b]) => ({ a: points[a], b: points[b], z: (points[a].z + points[b].z) / 2 })).sort((p, q) => p.z - q.z);
    for (const { a, b, z } of edges) {
      context.globalAlpha = z < -0.01 * HALF ? 0.35 : 0.95;
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
    }
    // The point.
    if (this.shape.dot > 0.01) {
      context.globalAlpha = this.shape.dot;
      context.fillStyle = accent;
      context.beginPath();
      context.arc(SIZE / 2, SIZE / 2, 4.5 * this.shape.dot, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
  }
}

function copy(shape) {
  return { scale: [...shape.scale], dot: shape.dot };
}
