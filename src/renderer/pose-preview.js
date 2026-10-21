import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { ModelPose, clipValues, posedMatrices } from './pose.js';
import { rotationOf } from './frames.js';
import { themeGizmo } from './theme.js';
import { unwrap } from './animation.js';
import { ringTurn } from './ring-turn.js';

// A pose to try the skin by, in the model workspace (Blender's pose mode,
// for a look): while it is on, the gizmo of the entry picked whole - a node,
// most of all - moves, turns and scales it in a pose of its own, the model
// left as it is and nothing keyed; the skin bends with it (see pose.js), and
// the weights may be set and smoothed meanwhile, the bend shown at once.
// The model's own gizmo and its vertex drags are put away for as long (see
// Editor.posePreview). Off - by its button, Esc, or another workspace - all
// is at rest again.

const GIZMO_MODES = { select: 'translate', move: 'translate', rotate: 'rotate', scale: 'scale' };
const PROPERTY_OF_MODE = { translate: 'position', rotate: 'rotation', scale: 'scale' };
const round = (value) => +value.toFixed(5);

export class PosePreview extends EventTarget {
  constructor(editor) {
    super();
    this.editor = editor;
    this.on = false;
    this.overrides = new Map(); // id -> { position?, rotation?, scale? }
    this.matrices = new Map();
    this.pose = new ModelPose(editor);
    const { viewport } = editor;
    this.proxy = new THREE.Object3D();
    viewport.scene.add(this.proxy);
    this.gizmo = new TransformControls(viewport.camera, viewport.renderer.domElement);
    ringTurn(this.gizmo); // a ring follows the pointer round (see ring-turn.js)
    this.gizmo.setSize(0.8);
    themeGizmo(this.gizmo, viewport);
    viewport.scene.add(this.gizmo.getHelper());
    this.gizmo.addEventListener('change', () => viewport.requestRender());
    this.gizmo.addEventListener('dragging-changed', (event) => {
      viewport.orbit.enabled = !event.value;
      editor.modeDragging = event.value;
    });
    this.gizmo.addEventListener('mouseDown', () => this.begin());
    this.gizmo.addEventListener('objectChange', () => this.drag());
    this.gizmo.addEventListener('mouseUp', () => {
      editor.modeDragging = false;
      this.dragging = null;
      this.placeGizmo();
    });
    editor.addEventListener('change', () => this.refresh());
  }

  // On or off (no argument: the other way).
  toggle(on = !this.on) {
    const { editor } = this;
    if (on === this.on || (on && (editor.workspace !== 'model' || editor.busy()))) return;
    this.on = on;
    editor.posePreview = on ? this : null;
    this.overrides.clear();
    if (on) {
      this.pose.begin();
      this.show();
    } else {
      this.gizmo.detach();
      this.pose.end();
    }
    editor.placeGizmo();
    editor.emitChange();
    this.dispatchEvent(new Event('change'));
  }

  // The model changed (another pick, the weights, an undo): the pose shown anew on it.
  refresh() {
    if (!this.on) return;
    if (this.editor.workspace !== 'model') {
      this.toggle(false);
      return;
    }
    if (this.gizmo.dragging) return;
    this.pose.begin();
    this.show();
  }

  show() {
    const { editor } = this;
    this.matrices = posedMatrices(editor, clipValues(editor, null, 0, this.overrides));
    this.pose.apply(this.matrices);
    editor.refreshHighlight();
    if (!this.gizmo.dragging) this.placeGizmo();
  }

  placeGizmo() {
    const { editor } = this;
    const entry = this.on ? editor.pivotEntry() : null;
    const mode = GIZMO_MODES[editor.tool];
    const matrix = entry === null ? null : this.matrices.get(editor.mesh.objects[entry].id);
    if (!matrix || !mode || editor.preview) {
      this.gizmo.detach();
      return;
    }
    matrix.decompose(this.proxy.position, this.proxy.quaternion, this.proxy.scale);
    this.proxy.updateMatrix();
    this.gizmo.setMode(mode);
    this.gizmo.setSpace(mode === 'scale' || editor.localAxes ? 'local' : 'world');
    if (this.gizmo.object !== this.proxy) this.gizmo.attach(this.proxy);
    editor.viewport.requestRender();
  }

  // A press in the view: the gizmo's, if it is on a handle (see Editor's pointerdown).
  press() {
    return this.gizmo.object && this.gizmo.axis !== null ? 'gizmo' : false;
  }

  begin() {
    const { editor } = this;
    const entry = editor.pivotEntry();
    if (entry === null) return;
    const object = editor.mesh.objects[entry];
    const parent = object.parent !== null && object.parent !== undefined ? this.matrices.get(object.parent) : null;
    this.dragging = {
      id: object.id,
      quaternion: object.rotationMode === 'quaternion',
      property: PROPERTY_OF_MODE[this.gizmo.mode],
      back: (parent ?? new THREE.Matrix4()).clone().invert(),
      start: clipValues(editor, null, 0, this.overrides).get(object.id),
    };
  }

  // The stand-in moved: the entry posed where it is, in its parent.
  drag() {
    const drag = this.dragging;
    if (!drag) return;
    this.proxy.updateMatrix();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    drag.back.clone().multiply(this.proxy.matrix).decompose(position, quaternion, scale);
    let value = drag.property === 'position' ? position.toArray() : scale.toArray();
    if (drag.property === 'rotation') value = drag.quaternion ? quaternion.toArray() : unwrap(rotationOf(quaternion) ?? [0, 0, 0], drag.start.rotation);
    this.overrides.set(drag.id, { ...this.overrides.get(drag.id), [drag.property]: value.map(round) });
    this.show();
  }
}
