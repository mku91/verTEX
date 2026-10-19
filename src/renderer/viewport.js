import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { theme, onThemeChange } from './theme.js';

const GRID_SIZE = 16;

// Scene, camera, navigation and on-demand rendering.
const FLIGHT_TIME = 400; // ms, a smooth camera move
// The "forward" marker: a flat arrowhead on the floor at the far end of the
// +Z ground axis, where a model's front is meant to face. World units.
const FORWARD_HEAD = 0.3; // long
const FORWARD_WIDTH = 0.233; // wide
const FORWARD_LABEL = 'N'; // written flat on the floor past the arrowhead (never translated)
const FORWARD_LABEL_SIZE = 0.5; // world units
const FORWARD_LABEL_GAP = 0.15; // between the arrowhead's tip and the letter

// The letter as a texture: white on nothing, to be tinted by its material.
function letterTexture(letter) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.font = 'bold 104px "Segoe UI", system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(letter, 64, 70);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
const WHEEL_NOTCH = 100; // wheel travel of one notch
// The light preview (see setLit()): where the sun is, from what it lights -
// high, and from the front left, as a picture is usually lit - and how bright it and the sky are.
const SUN_DIRECTION = new THREE.Vector3(-0.6, 1, 0.8).normalize();
const SUN_INTENSITY = 2.6;
const SKY_INTENSITY = 1.1;
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
    this.preview = false; // see setPreview()
    this.backdrop = []; // grid and ground axes; dimmed in focus mode

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
    this.camera.position.set(3.5, 3, 4.5);
    this.scene.add(this.camera);

    // Headlight: the model is always lit from the viewer's side.
    this.ambient = new THREE.AmbientLight(0xffffff, 1.2);
    this.scene.add(this.ambient);
    this.headlight = new THREE.DirectionalLight(0xffffff, 2);
    this.headlight.position.set(-1, 2, 3);
    this.camera.add(this.headlight);

    // The light preview (see setLit()): instead of the headlight, a sun that
    // stays where it is in the world - so that the model turned about shows
    // its lit side and its shaded one - with shadows, on the model and on
    // the floor; and a sky that lights everything a little from all round,
    // bluish from above, warm from the ground, so that no shade is black.
    this.lit = false;
    this.litSubject = null; // () => THREE.Sphere: what is lit, for the sun to be placed by
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap; // (PCFSoftShadowMap is gone from three: it fell back to this anyway)
    this.sun = new THREE.DirectionalLight(0xfff4e0, SUN_INTENSITY);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sky = new THREE.HemisphereLight(0xdde6ff, 0x4a3f33, SKY_INTENSITY);
    // The floor takes the shadow and nothing else: it darkens what is under it.
    this.shadowCatcher = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.ShadowMaterial({ opacity: 0.35, depthWrite: false }),
    );
    this.shadowCatcher.receiveShadow = true;
    for (const object of [this.sun, this.sun.target, this.sky, this.shadowCatcher]) {
      object.visible = false;
      this.scene.add(object);
    }

    // A pass drawn before the frame into a depth map of its own, for whoever
    // needs to know what the surface hides: { scene, prepare(camera, target) },
    // where prepare() says whether the pass is wanted this frame.
    this.depthPass = null;
    // (A float depth map: the usual 24 bits run out at a distance and make
    // a thin wall and the vertices behind it one and the same.)
    this.depthTarget = new THREE.WebGLRenderTarget(1, 1, {
      depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType),
    });
    this.depthTarget.depthTexture.minFilter = THREE.NearestFilter;
    this.depthTarget.depthTexture.magFilter = THREE.NearestFilter;

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

  // The light preview on or off: the model lit as in a game (a sun with
  // shadows, a sky) or by the headlight. Nothing of the model changes.
  setLit(on) {
    this.lit = on;
    this.ambient.visible = this.headlight.visible = !on;
    this.sun.visible = this.sun.target.visible = this.sky.visible = this.shadowCatcher.visible = on;
    this.requestRender();
  }

  // Puts the sun where it lights what is lit (litSubject) from SUN_DIRECTION,
  // its shadow just covering it, and the floor's shadow under it.
  placeSun() {
    const sphere = this.litSubject?.();
    if (!sphere || !(sphere.radius > 0)) return;
    const { center, radius } = sphere;
    this.sun.target.position.copy(center);
    this.sun.position.copy(center).addScaledVector(SUN_DIRECTION, radius * 4);
    const camera = this.sun.shadow.camera;
    const reach = radius * 2.5; // the model's shadow on the floor reaches past the model
    camera.left = camera.bottom = -reach;
    camera.right = camera.top = reach;
    camera.near = radius * 0.5;
    camera.far = radius * 8;
    camera.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = radius * 0.01;
    this.shadowCatcher.position.set(center.x, 0, center.z);
    this.shadowCatcher.scale.setScalar(reach * 4);
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
      object.material.map?.dispose();
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
    // The forward arrowhead: a flat triangle on the floor, its tip at the end
    // of the +Z ground axis, in the axis' own colour.
    const headGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-FORWARD_WIDTH / 2, 0, half - FORWARD_HEAD),
      new THREE.Vector3(FORWARD_WIDTH / 2, 0, half - FORWARD_HEAD),
      new THREE.Vector3(0, 0, half),
    ]);
    const forwardColor = shade(new THREE.Color(theme.axisZ).lerp(new THREE.Color(theme.viewBg), 0.3));
    const head = new THREE.Mesh(
      headGeometry,
      new THREE.MeshBasicMaterial({ color: forwardColor, side: THREE.DoubleSide }),
    );
    // The letter, flat on the floor just past the tip, upright when seen
    // from the +Z side (its top towards -Z, as the floor is read from there).
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(FORWARD_LABEL_SIZE, FORWARD_LABEL_SIZE),
      new THREE.MeshBasicMaterial({
        map: letterTexture(FORWARD_LABEL),
        color: forwardColor,
        transparent: true,
        side: THREE.DoubleSide,
      }),
    );
    label.rotation.x = -Math.PI / 2;
    label.position.set(0, 0, half + FORWARD_LABEL_GAP + FORWARD_LABEL_SIZE / 2);
    this.backdrop = [
      grid,
      axis(new THREE.Vector3(-half, 0, 0), new THREE.Vector3(half, 0, 0), theme.axisX),
      axis(new THREE.Vector3(0, 0, -half), new THREE.Vector3(0, 0, half), theme.axisZ),
      head,
      label,
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
    this.applyPreview();
    this.requestRender();
  }

  // The preview look: the model alone, on black - no floor, no axes.
  setPreview(on) {
    this.preview = on;
    this.applyTheme(); // the background back in its colour, or black
  }

  applyPreview() {
    for (const object of this.backdrop) object.visible = !this.preview;
    if (this.preview) this.scene.background.set(0x000000);
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
    const buffer = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.depthTarget.setSize(buffer.x, buffer.y);
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
    // (what follows the scene as it is drawn - a node's bounds - first)
    for (const listener of this.beforeRender ?? []) listener();
    // The camera's matrices are brought up to date by the main pass, which
    // comes after the depth pass - so the depth pass does it first, or it
    // would see the camera where it was a frame ago while the camera turns.
    this.camera.updateMatrixWorld();
    if (this.depthPass?.prepare(this.camera, this.depthTarget)) {
      this.renderer.setRenderTarget(this.depthTarget);
      this.renderer.clear();
      this.renderer.render(this.depthPass.scene, this.camera);
      this.renderer.setRenderTarget(null);
    }
    if (this.lit) this.placeSun();
    this.renderer.render(this.scene, this.camera);
    // (whatever else shows the scene - the window of views - goes along)
    for (const listener of this.afterRender ?? []) listener();
  }

  // The view as it is drawn now, on a canvas of the given size: scaled to
  // cover it, what does not fit cut off evenly at the sides. With a sphere
  // given (THREE.Sphere), the picture is taken from the side the camera is on
  // but from as far as it takes for the sphere to fill it.
  capture(width, height, sphere = null) {
    const { camera } = this;
    const source = this.renderer.domElement;
    const [position, quaternion] = [camera.position.clone(), camera.quaternion.clone()];
    if (sphere?.radius > 0) {
      // Half the angle the picture takes up from top to bottom: all of the
      // camera's, or less if the view is narrower than the picture.
      const half = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.min(1, camera.aspect / (width / height)));
      const away = camera.position.clone().sub(this.orbit.target).normalize();
      camera.position.copy(sphere.center).addScaledVector(away, (sphere.radius * 1.15) / Math.sin(half));
      camera.lookAt(sphere.center);
    }
    this.render(); // the drawing is only there to be read right after it is made
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const scale = Math.max(width / source.width, height / source.height);
    const [w, h] = [source.width * scale, source.height * scale];
    canvas.getContext('2d').drawImage(source, (width - w) / 2, (height - h) / 2, w, h);
    camera.position.copy(position);
    camera.quaternion.copy(quaternion);
    this.requestRender(); // the view itself, as it was
    return canvas;
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
