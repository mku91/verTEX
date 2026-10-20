import * as THREE from 'three';
import { AXIS_LOCKS } from './editor.js';
import { t } from './i18n.js';

const AXIS_LENGTH = 34; // SVG units, see the viewBox in MARKUP
const LOCK_LINE_LENGTH = 54;

const CAPTIONS = {
  free: t('axis-gizmo.free'),
  x: t('axis-gizmo.only', { axis: 'X' }),
  y: t('axis-gizmo.only', { axis: 'Y' }),
  z: t('axis-gizmo.only', { axis: 'Z' }),
};

const MARKUP = `
  <svg viewBox="-60 -60 120 120">
    <line class="lock-line"/>
    <g class="axis" data-lock="x"><line class="neg"/><line class="pos"/><circle r="9"/><text>X</text></g>
    <g class="axis" data-lock="y"><line class="neg"/><line class="pos"/><circle r="9"/><text>Y</text></g>
    <g class="axis" data-lock="z"><line class="neg"/><line class="pos"/><circle r="9"/><text>Z</text></g>
    <circle class="center" data-lock="free" r="5"/>
  </svg>
  <div class="caption"></div>`;

// Widget with the world axes as seen by the camera, on which one axis (or
// none, 'free') can be picked by a click. By default it shows and sets the
// axis lock for dragging; `options` point it at another setting:
//   value()      -> the current choice: 'free' | 'x' | 'y' | 'z'
//   choose(axis) -> called with the clicked choice
//   captions     -> text under the widget for each choice
export class AxisGizmo {
  constructor(element, viewport, editor, options = {}) {
    this.viewport = viewport;
    this.value = options.value ?? (() => editor.axisLock);
    this.choose = options.choose ?? ((axis) => editor.setAxisLock(axis));
    this.captions = options.captions ?? CAPTIONS;
    element.classList.add('axis-gizmo');
    element.innerHTML = MARKUP;
    this.svg = element.querySelector('svg');
    this.caption = element.querySelector('.caption');
    this.lockLine = this.svg.querySelector('.lock-line');
    this.center = this.svg.querySelector('.center');
    this.axes = [...this.svg.querySelectorAll('.axis')].map((group) => ({
      id: group.dataset.lock,
      group,
      positive: group.querySelector('.pos'),
      negative: group.querySelector('.neg'),
      handle: group.querySelector('circle'),
      label: group.querySelector('text'),
      direction: new THREE.Vector3(),
    }));

    this.svg.addEventListener('click', (event) => {
      const mode = event.target.closest('[data-lock]')?.dataset.lock;
      if (!mode) return;
      // Clicking the active axis again releases it.
      this.choose(mode === this.value() ? 'free' : mode);
    });
    viewport.orbit.addEventListener('change', () => this.update());
    editor.addEventListener('change', () => this.update());
    this.update();
  }

  update() {
    const mode = this.value();
    const toCamera = this.viewport.camera.quaternion.clone().invert();

    for (const axis of this.axes) {
      // Camera space: x right, y up, z towards the viewer.
      const d = axis.direction.copy(AXIS_LOCKS[axis.id]).applyQuaternion(toCamera);
      const x = d.x * AXIS_LENGTH;
      const y = -d.y * AXIS_LENGTH;
      setLine(axis.positive, 0, 0, x, y);
      setLine(axis.negative, 0, 0, -x, -y);
      axis.handle.setAttribute('cx', x);
      axis.handle.setAttribute('cy', y);
      axis.label.setAttribute('x', x);
      axis.label.setAttribute('y', y);
      axis.group.classList.toggle('locked', axis.id === mode);
      axis.group.classList.toggle('dimmed', mode !== 'free' && axis.id !== mode);

      if (axis.id === mode) {
        const lx = d.x * LOCK_LINE_LENGTH;
        const ly = -d.y * LOCK_LINE_LENGTH;
        setLine(this.lockLine, -lx, -ly, lx, ly);
      }
    }

    // Painter's algorithm: far axes first. The lock line stays put in the DOM,
    // because moving a node restarts its CSS animation.
    [...this.axes]
      .sort((a, b) => a.direction.z - b.direction.z)
      .forEach((axis) => this.svg.insertBefore(axis.group, this.center));

    this.svg.dataset.mode = mode;
    this.caption.textContent = this.captions[mode];
  }
}

function setLine(line, x1, y1, x2, y2) {
  line.setAttribute('x1', x1);
  line.setAttribute('y1', y1);
  line.setAttribute('x2', x2);
  line.setAttribute('y2', y2);
}
