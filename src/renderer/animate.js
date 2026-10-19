import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { ModelPose, localTransforms, posedMatrices } from './pose.js';
import { PROPERTIES, poseAt, setKey, removeKeys, keyId } from './animation.js';
import { rotationOf } from './frames.js';
import { scrubbable } from './scrub.js';
import { freeName } from './names.js';

// The animation mode at work (see animation.js, timeline.js): the model
// shown in the pose of the frame looked at, and posed by hand.
//
// The entry picked whole (an object or a group, see Editor.pivotEntry()) has
// a gizmo of its own here - the editor's moves the model, which is not
// edited in this mode - moving, turning or scaling it by the tool in hand.
// What it is moved to is a pose, not the model:
//   - with Autokey on, a key of what was changed, on the frame (rounded);
//   - with it off, only for the time being: gone when the frame changes,
//     unless K keys it first (what was changed, and only that).
// A track's "+" on the timeline keys it as it is shown, changed or not.
// The panel "Поза" has the same three in numbers, with a mark for each that
// has a key on this frame - a press on the mark keys it, or takes its key away.
//
// The first key of an entry fixes its pivot point (Editor.pinPivots()): what
// turns about it must not have it wander as the model is edited.

const GIZMO_MODES = { select: 'translate', move: 'translate', rotate: 'rotate', scale: 'scale' };
const PROPERTY_OF_MODE = { translate: 'position', rotate: 'rotation', scale: 'scale' };
const DEGREE = Math.PI / 180;
const round = (value) => +value.toFixed(5);

// Angles as near as can be to `near`: each axis put 360 this way or that, so
// that a turn taken further does not jump back across 180.
function unwrap(angles, near) {
  return angles.map((angle, i) => angle + 360 * Math.round(((near?.[i] ?? 0) - angle) / 360));
}

export class AnimationMode {
  constructor(panel, viewport, editor, timeline) {
    this.panel = panel;
    this.viewport = viewport;
    this.editor = editor;
    this.timeline = timeline;
    this.pose = new ModelPose(editor);
    this.overrides = new Map(); // id -> { position?, rotation?, scale? }: posed by hand, for the time being
    this.values = new Map(); // id -> { position, rotation, scale }: the pose shown
    this.matrices = new Map(); // id -> Matrix4: where the entries are shown

    this.proxy = new THREE.Object3D();
    viewport.scene.add(this.proxy);
    this.gizmo = new TransformControls(viewport.camera, viewport.renderer.domElement);
    this.gizmo.setSize(0.8);
    viewport.scene.add(this.gizmo.getHelper());
    this.gizmo.addEventListener('change', () => viewport.requestRender());
    this.gizmo.addEventListener('dragging-changed', (event) => {
      viewport.orbit.enabled = !event.value;
      editor.modeDragging = event.value;
    });
    this.gizmo.addEventListener('mouseDown', () => this.beginDrag());
    this.gizmo.addEventListener('objectChange', () => this.drag());
    this.gizmo.addEventListener('mouseUp', () => this.endDrag());
    editor.workspacePress.animation = () => (this.gizmo.object && this.gizmo.axis !== null ? 'gizmo' : false);

    editor.addEventListener('change', () => this.refresh());
    // Another frame: what was posed by hand and not keyed is let go.
    timeline.addEventListener('frame', () => {
      this.overrides.clear();
      this.show();
    });
    this.buildPanel();
  }

  get on() {
    return this.editor.workspace === 'animation';
  }

  // The entry the gizmo and the panel work on: one object or group picked whole.
  entry() {
    const index = this.editor.pivotEntry();
    return index === null ? null : { index, id: this.editor.mesh.objects[index].id };
  }

  refresh() {
    if (!this.on) {
      if (this.pose.on) this.pose.end();
      this.overrides.clear();
      this.gizmo.detach();
      this.panel.hidden = true;
      return;
    }
    if (this.gizmo.dragging) return;
    // The model may be another (an undo, say): its vertices are taken anew.
    this.pose.begin();
    this.show();
  }

  // The pose of every entry now: the clip's at the frame, over the rest pose,
  // with what is posed by hand over that.
  valuesNow() {
    const rest = localTransforms(this.editor);
    const clip = this.timeline.current();
    const posed = clip ? poseAt(clip, this.timeline.frame) : new Map();
    const values = new Map();
    for (const [id, place] of rest) {
      const own = { ...posed.get(id), ...this.overrides.get(id) };
      values.set(id, {
        position: own.position ?? place.position,
        rotation: own.rotation ?? place.rotation ?? [0, 0, 0],
        scale: own.scale ?? [1, 1, 1],
      });
    }
    return values;
  }

  show() {
    if (!this.on || !this.pose.on) return;
    this.values = this.valuesNow();
    this.matrices = posedMatrices(this.editor, this.values);
    this.pose.apply(this.matrices);
    this.editor.refreshHighlight(); // the outline of what is picked, where it is shown
    if (!this.gizmo.dragging) this.placeGizmo();
    this.showPanel();
  }

  // --- the gizmo ------------------------------------------------------------------

  placeGizmo() {
    const entry = this.entry();
    const mode = GIZMO_MODES[this.editor.tool];
    if (!entry || !mode || this.editor.preview) {
      this.gizmo.detach();
      return;
    }
    this.matrices.get(entry.id).decompose(this.proxy.position, this.proxy.quaternion, this.proxy.scale);
    this.proxy.updateMatrix();
    this.gizmo.setMode(mode);
    this.gizmo.setSpace(mode === 'scale' || this.editor.localAxes ? 'local' : 'world');
    const snap = this.editor.snapGrid.enabled;
    this.gizmo.setTranslationSnap(snap ? this.editor.snapGrid.step : null);
    this.gizmo.setRotationSnap(snap ? 15 * DEGREE : null);
    if (this.gizmo.object !== this.proxy) this.gizmo.attach(this.proxy);
    this.viewport.requestRender();
  }

  // The parent's matrix in the world, as shown (none: the world itself).
  parentMatrix(id) {
    const object = this.editor.mesh.objects.find((other) => other.id === id);
    const parent = object?.parent ?? null;
    return parent !== null && this.matrices.has(parent) ? this.matrices.get(parent) : new THREE.Matrix4();
  }

  beginDrag() {
    const entry = this.entry();
    this.dragging = entry && {
      ...entry,
      property: PROPERTY_OF_MODE[this.gizmo.mode],
      start: structuredClone(this.values.get(entry.id)),
      parent: this.parentMatrix(entry.id).clone().invert(),
    };
  }

  // The stand-in moved: the entry posed where it is, in its parent.
  drag() {
    const drag = this.dragging;
    if (!drag) return;
    this.proxy.updateMatrix();
    const local = drag.parent.clone().multiply(this.proxy.matrix);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    local.decompose(position, quaternion, scale);
    const value = drag.property === 'position' ? position.toArray()
      : drag.property === 'rotation' ? unwrap(rotationOf(quaternion) ?? [0, 0, 0], drag.start.rotation)
      : scale.toArray();
    this.overrides.set(drag.id, { ...this.overrides.get(drag.id), [drag.property]: value.map(round) });
    this.show();
  }

  endDrag() {
    const drag = this.dragging;
    this.dragging = null;
    // (TransformControls tells of the end of its drag only after this: the
    // editor is not busy with it any more as of now)
    this.editor.modeDragging = false;
    if (!drag) return;
    const now = this.values.get(drag.id)?.[drag.property];
    if (this.timeline.autokey && JSON.stringify(now) !== JSON.stringify(drag.start[drag.property])) {
      this.writeKeys([drag.index], [drag.property]);
    } else {
      this.show();
    }
  }

  // --- keys -----------------------------------------------------------------------

  // Keys of these properties of these entries, as they are shown now, on the
  // frame (rounded); in the clip worked on - made if there is none. The
  // entries' pivots are fixed. One undo step.
  writeKeys(indices, properties) {
    const { editor, timeline } = this;
    if (!indices.length || editor.busy()) return;
    const values = this.valuesNow();
    const frame = Math.round(timeline.frame);
    const before = editor.snapshot();
    let clips = editor.animations;
    let clip = timeline.current();
    if (!clip) {
      clip = { name: freeName('idle', new Set(clips.map((other) => other.name))), fps: 12, length: 24, loop: true, tracks: [] };
      clips = [...clips, clip];
      timeline.clip = clip.name;
    }
    editor.pinPivots(indices);
    let changed = clip;
    for (const index of indices) {
      const { id } = editor.mesh.objects[index];
      for (const property of properties) {
        changed = setKey(changed, id, property, frame, values.get(id)[property].map(round));
        const own = { ...this.overrides.get(id) };
        delete own[property];
        this.overrides.set(id, own);
      }
    }
    editor.history.push(before);
    editor.setAnimations(clips.map((other) => (other === clip ? changed : other)), false);
  }

  // K: what was changed by hand - and only that - of every entry picked
  // whole: if its position alone was moved, a key of its position.
  keyPicked() {
    if (!this.on) return false;
    const picked = this.editor.mode === 'object' ? [...this.editor.picked] : [];
    const { mesh } = this.editor;
    for (const index of picked) {
      const changed = PROPERTIES.filter((property) => this.overrides.get(mesh.objects[index].id)?.[property] !== undefined);
      if (changed.length) this.writeKeys([index], changed);
    }
    return true;
  }

  // A property's key on this frame: put, or taken away if there is one.
  toggleKey(property) {
    const entry = this.entry();
    const clip = this.timeline.current();
    if (!entry) return;
    const frame = Math.round(this.timeline.frame);
    const has = clip?.tracks.some((track) => track.object === entry.id && track.property === property && track.keys.some((key) => key.frame === frame));
    if (!has) return this.writeKeys([entry.index], [property]);
    const changed = removeKeys(clip, new Set([keyId(entry.id, property, frame)]));
    this.editor.setAnimations(this.editor.animations.map((other) => (other === clip ? changed : other)));
  }

  // --- the panel "Поза" -----------------------------------------------------------

  buildPanel() {
    const { panel, editor } = this;
    this.inputs = [...panel.querySelectorAll('input[data-pose]')];
    this.marks = [...panel.querySelectorAll('[data-key]')];
    for (const button of panel.querySelectorAll('button')) button.addEventListener('mousedown', (event) => event.preventDefault());
    for (const mark of this.marks) mark.addEventListener('click', () => this.toggleKey(mark.dataset.key));
    panel.querySelector('.pose-key').addEventListener('click', () => this.keyPicked());
    // A number of the pose: typed, or dragged by its handle. Like the gizmo,
    // it poses for the time being, or keys with Autokey on.
    for (const input of this.inputs) {
      const [property, axis] = input.dataset.pose.split('.');
      const read = () => parseFloat(input.value.replace(',', '.'));
      const write = (value, key) => {
        const entry = this.entry();
        if (!entry || !Number.isFinite(value)) return this.showPanel();
        const current = [...this.values.get(entry.id)[property]];
        current[+axis] = value;
        this.overrides.set(entry.id, { ...this.overrides.get(entry.id), [property]: current });
        if (key && this.timeline.autokey) this.writeKeys([entry.index], [property]);
        else this.show();
      };
      input.addEventListener('change', () => write(read(), true));
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === 'Escape') input.blur();
        event.stopPropagation(); // the keys are the field's, not the shortcuts'
      });
      scrubbable(input, {
        read,
        write: (value) => {
          input.value = value;
          write(value, false);
        },
        end: () => {
          const entry = this.entry();
          if (entry && this.timeline.autokey) this.writeKeys([entry.index], [property]);
        },
      });
    }
    editor.addEventListener('change', () => this.showPanel());
  }

  showPanel() {
    const entry = this.on ? this.entry() : null;
    this.panel.hidden = !entry;
    if (!entry) return;
    const values = this.values.get(entry.id);
    if (!values) return;
    for (const input of this.inputs) {
      if (document.activeElement === input) continue;
      const [property, axis] = input.dataset.pose.split('.');
      input.value = +values[property][+axis].toFixed(4);
    }
    const clip = this.timeline.current();
    const frame = Math.round(this.timeline.frame);
    for (const mark of this.marks) {
      const keyed = Boolean(clip?.tracks.some((track) => track.object === entry.id && track.property === mark.dataset.key && track.keys.some((key) => key.frame === frame)));
      const posed = this.overrides.get(entry.id)?.[mark.dataset.key] !== undefined;
      mark.classList.toggle('keyed', keyed);
      mark.classList.toggle('posed', posed && !keyed);
      mark.title = keyed ? 'Ключ на этом кадре — нажмите, чтобы убрать' : 'Нет ключа на этом кадре — нажмите, чтобы поставить';
    }
  }
}
