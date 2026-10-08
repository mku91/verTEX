import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { theme, onThemeChange } from './theme.js';

const GRID_SIZE = 16;

// Scene, camera, navigation and on-demand rendering.
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

  // (Re)builds everything whose colours come from the theme.
  applyTheme() {
    for (const object of this.backdrop) {
      this.scene.remove(object);
      object.geometry.dispose();
      object.material.dispose();
    }
    const grid = new THREE.GridHelper(GRID_SIZE, GRID_SIZE, theme.gridCenter, theme.grid);
    const half = GRID_SIZE / 2;
    // The ground axes are toned down towards the background.
    const axis = (from, to, color) => {
      const geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
      const toned = new THREE.Color(color).lerp(new THREE.Color(theme.viewBg), 0.3);
      return new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: toned }));
    };
    this.backdrop = [
      grid,
      axis(new THREE.Vector3(-half, 0, 0), new THREE.Vector3(half, 0, 0), theme.axisX),
      axis(new THREE.Vector3(0, 0, -half), new THREE.Vector3(0, 0, half), theme.axisZ),
    ];
    this.scene.add(...this.backdrop);
    this.setFocus(this.focus);
  }

  // Focus look for modal operations: a darker background with a faint grid.
  setFocus(on) {
    this.focus = on;
    this.scene.background.set(on ? theme.viewBgFocus : theme.viewBg);
    for (const object of this.backdrop) {
      object.material.transparent = true;
      object.material.opacity = on ? 0.3 : 1;
    }
    this.requestRender();
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

  // Moves the camera so that the given points fill the view, keeping its direction.
  frame(points) {
    if (points.length === 0) return;
    const sphere = new THREE.Box3().setFromPoints(points).getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 0.5);
    const distance = (radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.2;
    const direction = this.camera.position.clone().sub(this.orbit.target).normalize();
    this.orbit.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(direction, distance);
    this.orbit.update();
    this.requestRender();
  }
}
