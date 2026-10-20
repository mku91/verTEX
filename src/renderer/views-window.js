import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OrthoViews, paintedMaterials } from './ortho-views.js';
import { localize } from './i18n.js';
import { theme, onThemeChange } from './theme.js';

// The views in a window of their own: two by two, a perspective view and the
// three of the bottom panel (see ortho-views.js) - the same three, at work
// as they are there: vertices dragged, or in the animation mode the model
// posed. The perspective one is looked through only: turned with the left
// button, moved with the right, zoomed with the wheel - by a camera of its
// own, to see the model from another side than the main view does.
//
// The window is the page's own (window.open): what is in it is made and run
// from here, on the same editor; it follows the main view as that is drawn.
// The keys pressed in it are the main window's (the tools, undo). It is
// closed with the main one.

export class ViewsWindow extends EventTarget {
  constructor(editor, viewport) {
    super();
    this.editor = editor;
    this.viewport = viewport;
    this.window = null;
    this.ortho = null;
    this.animation = null; // the animation mode, given to the three views
    viewport.afterRender = [...(viewport.afterRender ?? []), () => this.draw()];
    onThemeChange(() => this.applyTheme());
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
    const opened = window.open('views.html', 'vertex-views', 'width=1280,height=860');
    if (!opened) return;
    this.window = opened;
    const ready = () => this.build();
    if (opened.document.readyState === 'complete' && opened.document.getElementById('quad')) ready();
    else opened.addEventListener('load', ready, { once: true });
    const watch = setInterval(() => {
      if (!opened.closed) return;
      clearInterval(watch);
      this.tearDown();
    }, 500);
  }

  close() {
    if (this.open) this.window.close();
    this.tearDown();
  }

  build() {
    const win = this.window;
    const doc = win.document;
    localize(doc); // the window's page runs no scripts of its own
    this.applyTheme();
    // The three views, with the window's own watcher of sizes.
    this.ortho = new OrthoViews(doc.getElementById('quad'), this.editor, { Observer: win.ResizeObserver });
    this.ortho.animation = this.animation;
    // The perspective one.
    const frame = doc.querySelector('.persp-view');
    const canvas = frame.querySelector('canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    this.light = new THREE.DirectionalLight(0xffffff, 1.7);
    this.scene.add(this.light);
    this.makeGrid();
    this.model = new THREE.Mesh();
    this.scene.add(this.model);
    const main = this.viewport.camera;
    this.camera = new THREE.PerspectiveCamera(main.fov, 1, main.near, main.far);
    this.camera.position.copy(main.position);
    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.target.copy(this.viewport.orbit.target);
    this.orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.orbit.update();
    this.orbit.addEventListener('change', () => this.draw());
    new win.ResizeObserver(() => this.draw()).observe(frame);
    // The keys pressed here are the main window's.
    for (const type of ['keydown', 'keyup']) {
      win.addEventListener(type, (event) => {
        if (event.target instanceof win.HTMLInputElement) return;
        const copy = new KeyboardEvent(type, event);
        window.dispatchEvent(copy);
        if (copy.defaultPrevented) event.preventDefault();
      });
    }
    this.dispatchEvent(new Event('change'));
    this.draw();
  }

  tearDown() {
    if (!this.ortho) return;
    this.ortho.dispose();
    this.ortho = null;
    this.orbit?.dispose();
    this.renderer?.dispose();
    for (const material of this.materials?.all ?? []) material.dispose();
    this.renderer = null;
    this.materials = null;
    this.window = null;
    this.dispatchEvent(new Event('change'));
  }

  // The theme's colours, as the window's page reads them.
  applyTheme() {
    if (!this.open) return;
    this.window.document.documentElement.style.cssText = document.documentElement.style.cssText;
    if (this.scene) this.makeGrid();
    this.draw();
  }

  // The floor's grid, in the theme's colours (as the main view's).
  makeGrid() {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      this.grid.material.dispose();
    }
    this.grid = new THREE.GridHelper(40, 40, theme.gridCenter, theme.grid);
    this.scene.add(this.grid);
  }

  // The perspective view drawn anew, and the three views: as the scene is now.
  draw() {
    if (!this.open || !this.renderer) return;
    this.ortho?.draw();
    const frame = this.renderer.domElement.parentElement;
    const [width, height] = [frame.clientWidth, frame.clientHeight];
    if (!width || !height) return;
    const solid = this.editor.view.solid;
    this.model.geometry = solid.geometry;
    this.materials = paintedMaterials(this.editor, solid.material, this.materials);
    this.model.material = this.materials.list;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.light.position.copy(this.camera.position).add(new THREE.Vector3(2, 4, 3));
    this.renderer.setPixelRatio(this.window.devicePixelRatio);
    this.renderer.setSize(width, height, false);
    this.scene.background = new THREE.Color(theme.viewBg);
    this.renderer.render(this.scene, this.camera);
  }
}
