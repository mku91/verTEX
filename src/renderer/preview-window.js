import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { paintedMaterials } from './ortho-views.js';
import { localize, t } from './i18n.js';

// The preview: the model as it will be seen outside the editor - painted, on
// black, with no floor, no edges or vertices, no selection - in a window of
// its own, to be put where there is room (another monitor). It is looked at
// by a camera of its own (left button or right: turned; middle, or with Shift:
// moved; the wheel: nearer, further; a double click: all of the model), and
// the model goes on being edited in the main window, which it follows as that
// is drawn.
//
// The window is the page's own (window.open, as the views' is, see
// views-window.js): what is in it is made and run from here, and the keys
// pressed in it are the main window's. It is closed with the project and with
// the main window; whether it was open is not kept.

const FOV = 45;
let count = 0; // windows opened: each is called differently, not to be taken for one on its way out
const SIZE = { width: 480, height: 520 };

export class PreviewWindow extends EventTarget {
  constructor(editor, viewport) {
    super();
    this.editor = editor;
    this.viewport = viewport;
    this.window = null;
    this.camera = null; // kept while the program runs, with what it looks at
    this.target = new THREE.Vector3();
    this.offset = null; // from a window's frame to its inside, px
    this.place = null; // where the window was when it was closed last, in this run
    viewport.afterRender = [...(viewport.afterRender ?? []), () => this.draw()];
    window.addEventListener('beforeunload', () => this.close());
  }

  get open() {
    return Boolean(this.window && !this.window.closed);
  }

  toggle() {
    if (this.open) this.close();
    else this.show();
  }

  show() {
    if (this.open) {
      this.window.focus();
      return;
    }
    // At the screen's right at first. (A window is put by its frame and tells
    // where its inside is: how far apart they are is seen once it is there.)
    const at = this.place ?? {
      ...SIZE,
      x: Math.round(window.screen.availLeft + window.screen.availWidth - SIZE.width - 40),
      y: Math.round(window.screen.availTop + 120),
    };
    const frame = this.offset ?? { x: 0, y: 0 };
    const asked = { x: at.x - frame.x, y: at.y - frame.y };
    const features = `left=${asked.x},top=${asked.y},width=${at.width},height=${at.height}`;
    const opened = window.open('preview.html', `vertex-preview-${count += 1}`, features);
    if (!opened) return;
    this.window = opened;
    const ready = () => {
      if (this.window !== opened || opened.closed || this.renderer) return;
      this.offset ??= { x: opened.screenX - asked.x, y: opened.screenY - asked.y };
      this.build();
    };
    if (opened.document.readyState === 'complete' && opened.document.querySelector('canvas')) ready();
    else opened.addEventListener('load', ready, { once: true });
    const watch = setInterval(() => {
      if (!opened.closed) return this.remember(opened);
      clearInterval(watch);
      if (this.window === opened) this.tearDown();
      return undefined;
    }, 500);
    this.dispatchEvent(new Event('change'));
  }

  close() {
    if (this.open) {
      this.remember(this.window);
      if (window.vertex?.closeChild) window.vertex.closeChild('preview');
      else this.window.close();
    }
    this.tearDown();
  }

  remember(win) {
    if (!win.innerWidth || !win.innerHeight || win.document.hidden) return; // (minimized: not a place)
    this.place = { x: win.screenX, y: win.screenY, width: win.innerWidth, height: win.innerHeight };
  }

  build() {
    const win = this.window;
    localize(win.document); // the window's page runs no scripts of its own
    win.document.title = t('preview.title');
    const canvas = win.document.querySelector('canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    this.model = new THREE.Mesh();
    this.model.frustumCulled = false;
    const first = !this.camera;
    if (first) {
      this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 1000);
      // Lit from the viewer's side, as the main view.
      const light = new THREE.DirectionalLight(0xffffff, 2);
      light.position.set(-1, 2, 3);
      this.camera.add(light);
      // As the main view looks at it.
      this.camera.position.copy(this.viewport.camera.position);
      this.target.copy(this.viewport.orbit.target);
    }
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.2), this.camera, this.model);
    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.target = this.target;
    this.orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.orbit.update();
    this.orbit.addEventListener('change', () => this.draw());
    canvas.addEventListener('dblclick', () => this.frame());
    new win.ResizeObserver(() => this.draw()).observe(canvas.parentElement);
    win.addEventListener('contextmenu', (event) => event.preventDefault(), true); // (as the main window, see app.js)
    // The keys pressed here are the main window's.
    for (const type of ['keydown', 'keyup']) {
      win.addEventListener(type, (event) => {
        const copy = new KeyboardEvent(type, event);
        window.dispatchEvent(copy);
        if (copy.defaultPrevented) event.preventDefault();
      });
    }
    if (first) this.frame();
    this.draw();
  }

  tearDown() {
    if (!this.window) return;
    this.window = null;
    this.orbit?.dispose();
    this.renderer?.dispose();
    for (const material of this.materials?.all ?? []) material.dispose();
    this.orbit = null;
    this.renderer = null;
    this.materials = null;
    this.dispatchEvent(new Event('change'));
  }

  // All of the model in sight, from the side it is looked at.
  frame() {
    if (!this.open || !this.renderer) return;
    const position = this.editor.view.solid.geometry.getAttribute('position');
    const box = new THREE.Box3();
    const point = new THREE.Vector3();
    for (let i = 0; i < (position?.count ?? 0); i++) box.expandByPoint(point.fromBufferAttribute(position, i));
    if (!box.isEmpty()) {
      const { center, radius } = box.getBoundingSphere(new THREE.Sphere());
      const body = this.renderer.domElement.parentElement;
      const aspect = body.clientHeight ? body.clientWidth / body.clientHeight : 1;
      const half = THREE.MathUtils.degToRad(FOV / 2);
      const narrow = Math.min(half, Math.atan(Math.tan(half) * aspect));
      const way = this.camera.position.clone().sub(this.target).normalize();
      if (way.lengthSq() < 0.5) way.set(0.6, 0.5, 0.8).normalize();
      this.target.copy(center);
      this.camera.position.copy(center).addScaledVector(way, Math.max(0.05, (radius / Math.sin(narrow)) * 1.05));
    }
    this.orbit.update();
    this.draw();
  }

  draw() {
    if (!this.open || !this.renderer) return;
    const body = this.renderer.domElement.parentElement;
    const [width, height] = [body.clientWidth, body.clientHeight];
    if (!width || !height) return;
    const { solid } = this.editor.view;
    this.model.geometry = solid.geometry;
    this.materials = paintedMaterials(this.editor, solid.material, this.materials);
    for (const material of this.materials.all) material.visible = true; // (whatever the main view's look)
    this.model.material = this.materials.list;
    const away = this.camera.position.distanceTo(this.target);
    this.camera.near = Math.max(0.001, away / 200);
    this.camera.far = Math.max(100, away * 20);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(this.window.devicePixelRatio);
    this.renderer.setSize(width, height, false);
    this.renderer.render(this.scene, this.camera);
  }
}
