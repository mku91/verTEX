import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { theme, onThemeChange } from './theme.js';

const GRID_SIZE = 16;

// Scene, camera, navigation and on-demand rendering.
const FLIGHT_TIME = 400; // ms, a smooth camera move
const WHEEL_NOTCH = 100; // wheel travel of one notch
const MIN_DISTANCE = 0.2;
const MAX_DISTANCE = 300;

export class Viewport {
  constructor(container) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color();
    this.focus = false;
    this.backdrop = []; // grid and ground axes; dimmed in focus mode

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
    this.camera.position.set(3.5, 3, 4.5);
    this.scene.add(this.camera);

    // Headlight: the model is always lit from the viewer's side.
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    const headlight = new THREE.DirectionalLight(0xffffff, 2);
    headlight.position.set(-1, 2, 3);
    this.camera.add(headlight);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.flight = null; // a camera move in progress, see frame()
    // Taking the camera by hand ends a flight.
    this.orbit.addEventListener('start', () => {
      this.flight = null;
    });
    // The wheel zooms, but not in jumps: it sets the distance to be at, and
    // the camera glides there (see zoom()).
    this.orbit.enableZoom = false;
    this.zoomTarget = null; // the distance asked for while the camera is on its way
    // Both are the user's to set (Settings -> Controls).
    this.zoomStrength = 10; // % of the distance per notch of the wheel
    this.zoomSmoothness = 2; // 0 = at once ... 10 = a long glide
    this.renderer.domElement.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        // Lines and pages are turned into something like pixels.
        const travel = event.deltaY * (event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? 400 : 1);
        this.zoom((1 + this.zoomStrength / 100) ** (travel / WHEEL_NOTCH));
      },
      { passive: false },
    );
    // LMB belongs to vertex editing; the camera lives on RMB and the wheel.
    this.orbit.mouseButtons.LEFT = null;
    // Dragging with the wheel pressed pans, like Shift+RMB; rolling it zooms.
    this.orbit.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
    this.setPanMode(false);
    this.orbit.target.set(0, 0.5, 0);
    this.orbit.update();
    this.orbit.addEventListener('change', () => this.requestRender());

    this.applyTheme();
    onThemeChange(() => this.applyTheme());

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  // RMB orbits; while pan mode is on (Space held) it pans instead.
  setPanMode(on) {
    this.orbit.mouseButtons.RIGHT = on ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
  }

  // The spacing of the floor grid's lines: the snap grid's step.
  setGridStep(step) {
    if (step === this.gridStep) return;
    this.gridStep = step;
    this.applyTheme();
    this.requestRender();
  }

  // (Re)builds everything whose colours come from the theme.
  applyTheme() {
    for (const object of this.backdrop) {
      this.scene.remove(object);
      object.geometry.dispose();
      object.material.dispose();
    }
    // The floor grid: a line every snap step, those on whole units a shade stronger.
    const half = GRID_SIZE / 2;
    const step = this.gridStep ?? 1;
    const positions = [];
    const colors = [];
    // In the focus look the floor is faint: its colours go most of the way to the background.
    const background = new THREE.Color(this.focus ? theme.viewBgFocus : theme.viewBg);
    const shade = (color) => new THREE.Color(color).lerp(background, this.focus ? 0.7 : 0);
    const minor = shade(theme.grid);
    const major = shade(theme.gridCenter);
    for (let i = 0; i <= Math.round(GRID_SIZE / step); i++) {
      const at = -half + i * step;
      const tint = Math.abs(at - Math.round(at)) < 1e-6 ? major : minor;
      positions.push(-half, 0, at, half, 0, at, at, 0, -half, at, 0, half);
      for (let k = 0; k < 4; k++) colors.push(tint.r, tint.g, tint.b);
    }
    const gridGeometry = new THREE.BufferGeometry();
    gridGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    gridGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const grid = new THREE.LineSegments(gridGeometry, new THREE.LineBasicMaterial({ vertexColors: true }));
    // The ground axes are toned down towards the background.
    const axis = (from, to, color) => {
      const geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
      const toned = shade(new THREE.Color(color).lerp(new THREE.Color(theme.viewBg), 0.3));
      return new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: toned }));
    };
    this.backdrop = [
      grid,
      axis(new THREE.Vector3(-half, 0, 0), new THREE.Vector3(half, 0, 0), theme.axisX),
      axis(new THREE.Vector3(0, 0, -half), new THREE.Vector3(0, 0, half), theme.axisZ),
    ];
    // The floor is a backdrop: drawn before everything else and leaving no
    // trace in the depth buffer, so whatever lies on it - an edge, a vertex, a
    // face at floor level - is painted over it instead of fighting with it.
    for (const object of this.backdrop) {
      object.renderOrder = -1;
      object.material.depthWrite = false;
    }
    this.scene.add(...this.backdrop);
    this.scene.background.set(background);
    this.requestRender();
  }

  // Focus look for modal operations: a darker background with a faint grid.
  setFocus(on) {
    this.focus = on;
    this.applyTheme(); // the background, and the floor in its colours for this look
  }

  resize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  // Size of one screen pixel in world units, at the distance of the orbit target.
  worldPerPixel() {
    const distance = this.camera.position.distanceTo(this.orbit.target);
    const viewHeight = 2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    return viewHeight / this.container.clientHeight;
  }

  requestRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => this.render());
  }

  render() {
    this.renderQueued = false;
    this.renderer.render(this.scene, this.camera);
  }

  // Moves the camera towards its orbit target (factor < 1) or away from it,
  // smoothly: turns of the wheel add up into one distance to be at, and every
  // frame the camera covers a share of what is left.
  zoom(factor) {
    const { camera, orbit } = this;
    const distance = () => camera.position.distanceTo(orbit.target);
    const running = this.zoomTarget !== null;
    this.flight = null;
    this.zoomTarget = THREE.MathUtils.clamp((this.zoomTarget ?? distance()) * factor, MIN_DISTANCE, MAX_DISTANCE);
    if (running) return;
    if (this.zoomSmoothness <= 0) {
      // No glide: the camera is there at once.
      const direction = camera.position.clone().sub(orbit.target).normalize();
      camera.position.copy(orbit.target).addScaledVector(direction, this.zoomTarget);
      this.zoomTarget = null;
      orbit.update();
      this.requestRender();
      return;
    }
    let last = performance.now();
    const step = (now) => {
      if (this.zoomTarget === null) return;
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const current = distance();
      // The share of the way left that is covered in a second grows as the glide shortens.
      const rate = 30 / Math.max(this.zoomSmoothness, 0.1);
      let next = current + (this.zoomTarget - current) * (1 - Math.exp(-rate * dt));
      const arrived = Math.abs(this.zoomTarget - next) < this.zoomTarget * 1e-3;
      if (arrived) next = this.zoomTarget;
      // Along the line of sight as it is now, so orbiting meanwhile goes on.
      const direction = camera.position.clone().sub(orbit.target).normalize();
      camera.position.copy(orbit.target).addScaledVector(direction, next);
      orbit.update();
      this.requestRender();
      if (arrived) this.zoomTarget = null;
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // Moves the camera so that the given points fill the view, keeping its
  // direction. With `smooth` it flies there, easing in and out, instead of jumping.
  frame(points, smooth = false) {
    if (points.length === 0) return;
    const sphere = new THREE.Box3().setFromPoints(points).getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 0.5);
    const distance = (radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.2;
    const direction = this.camera.position.clone().sub(this.orbit.target).normalize();
    const target = sphere.center;
    const position = target.clone().addScaledVector(direction, distance);
    this.flight = null;
    this.zoomTarget = null; // a zoom on its way would fight the move
    if (!smooth) {
      this.orbit.target.copy(target);
      this.camera.position.copy(position);
      this.orbit.update();
      this.requestRender();
      return;
    }
    const from = { target: this.orbit.target.clone(), position: this.camera.position.clone() };
    const flight = { started: performance.now() };
    this.flight = flight;
    const step = (now) => {
      if (this.flight !== flight) return; // interrupted
      const t = Math.min(Math.max((now - flight.started) / FLIGHT_TIME, 0), 1);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      this.orbit.target.lerpVectors(from.target, target, eased);
      this.camera.position.lerpVectors(from.position, position, eased);
      this.orbit.update();
      this.requestRender();
      if (t < 1) requestAnimationFrame(step);
      else this.flight = null;
    };
    requestAnimationFrame(step);
  }
}
