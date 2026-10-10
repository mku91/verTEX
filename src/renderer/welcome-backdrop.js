// The welcome screen's backdrop: a floor of vertices and edges going off into
// the distance, swaying - a faint picture of what the program is about.
//
// The floor is a regular grid of points. Nothing about it is kept from frame
// to frame: the height of a point is a function of where it is and what time
// it is, a sum of a few sine waves running different ways at different paces
// (one alone would look like a machine, these never quite repeat). The points
// are then seen in perspective, the far ones smaller and fainter.

import { theme } from './theme.js';

const COLUMNS = 56; // points across
const ROWS = 30; // and into the distance
const STEP = 1; // between neighbours
const NEAR = 7; // from the eye to the row that lies along the bottom of the picture at rest
const BELOW = 3; // rows nearer than that: a wave lifting the floor's edge must not show what is under it
const EYE = 3.4; // the eye's height above the floor at rest
const HORIZON = 0.2; // where the floor would end, as a share of the height from the top
const LINE = 0.5; // how strong the nearest edges are drawn, 0..1
const DOT = 0.6; // and the nearest vertices
const DOT_SIZE = 0.04; // a vertex's radius, in floor units

// The waves: [along x, along z, pace, height].
const WAVES = [
  [0.33, 0.21, 0.7, 0.34],
  [-0.19, 0.42, 0.45, 0.26],
  [0.57, -0.11, 1.1, 0.12],
  [0.08, 0.83, 0.9, 0.08],
];

const heightAt = (x, z, time) => WAVES.reduce((sum, [kx, kz, pace, height]) => sum + height * Math.sin(x * kx + z * kz + time * pace), 0);

export class WelcomeBackdrop {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.frame = null; // the animation frame asked for, while it runs
    this.still = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.points = new Float32Array(COLUMNS * ROWS * 3); // x, y on the screen and the scale there
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  // Runs while the screen is shown, and not a frame longer.
  start() {
    if (this.frame !== null) return;
    const tick = (now) => {
      this.draw(now / 1000);
      // Whoever asked the system for less motion gets the picture, not the sway.
      this.frame = this.still.matches ? null : requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  stop() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  resize() {
    const { canvas } = this;
    const ratio = window.devicePixelRatio || 1;
    const [width, height] = [Math.round(canvas.clientWidth * ratio), Math.round(canvas.clientHeight * ratio)];
    if (width === 0 || height === 0 || (canvas.width === width && canvas.height === height)) return;
    canvas.width = width;
    canvas.height = height;
    this.draw(performance.now() / 1000); // a canvas resized is a canvas wiped
  }

  draw(time) {
    const { canvas, context, points } = this;
    const { width, height } = canvas;
    if (width === 0 || height === 0) return;
    context.clearRect(0, 0, width, height);

    // In a window so wide that the farthest row would not reach its sides, the floor is stretched.
    const horizon = height * HORIZON;
    const focal = ((height - horizon) * NEAR) / EYE;
    const spread = Math.max(1, (width * 1.1 * (NEAR + (ROWS - 1 - BELOW) * STEP)) / (focal * (COLUMNS - 1) * STEP));
    for (let row = 0; row < ROWS; row++) {
      const z = (row - BELOW) * STEP;
      const scale = focal / (NEAR + z);
      for (let column = 0; column < COLUMNS; column++) {
        const x = (column - (COLUMNS - 1) / 2) * STEP * spread;
        const at = (row * COLUMNS + column) * 3;
        points[at] = width / 2 + x * scale;
        points[at + 1] = horizon + (EYE - heightAt(x, z, time)) * scale;
        points[at + 2] = scale;
      }
    }

    // Row by row from the far one, each as faint as it is far.
    context.lineWidth = Math.max(1, window.devicePixelRatio || 1);
    for (let row = ROWS - 1; row >= 0; row--) {
      const near = (1 - row / (ROWS - 1)) ** 1.6;
      const first = row * COLUMNS * 3;

      // The row's edges, and those from it to the row behind.
      context.beginPath();
      for (let column = 0; column < COLUMNS; column++) {
        const at = first + column * 3;
        if (column === 0) context.moveTo(points[at], points[at + 1]);
        else context.lineTo(points[at], points[at + 1]);
      }
      if (row < ROWS - 1) {
        for (let column = 0; column < COLUMNS; column++) {
          const at = first + column * 3;
          const behind = at + COLUMNS * 3;
          context.moveTo(points[at], points[at + 1]);
          context.lineTo(points[behind], points[behind + 1]);
        }
      }
      context.globalAlpha = LINE * near;
      context.strokeStyle = theme.textDim;
      context.stroke();

      // Its vertices.
      context.beginPath();
      for (let column = 0; column < COLUMNS; column++) {
        const at = first + column * 3;
        const radius = Math.max(0.6, DOT_SIZE * points[at + 2]);
        context.moveTo(points[at] + radius, points[at + 1]);
        context.arc(points[at], points[at + 1], radius, 0, Math.PI * 2);
      }
      context.globalAlpha = DOT * near;
      context.fillStyle = theme.accent;
      context.fill();
    }
    context.globalAlpha = 1;
  }
}
