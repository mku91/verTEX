import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { ModelPose, localTransforms, posedMatrices, clipValues } from './pose.js';
import { solveIK } from './ik.js';
import { IKSign } from './ik-sign.js';
import { themeGizmo } from './theme.js';
import { PoseGhost } from './ghost.js';
import { PROPERTIES, setKey, removeKeys, keyId, unwrap } from './animation.js';
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
    this.ghost = new PoseGhost(editor); // where what is posed and not keyed goes back to

    this.proxy = new THREE.Object3D();
    viewport.scene.add(this.proxy);
    this.gizmo = new TransformControls(viewport.camera, viewport.renderer.domElement);
    this.gizmo.setSize(0.8);
    themeGizmo(this.gizmo);
    viewport.scene.add(this.gizmo.getHelper());
    this.gizmo.addEventListener('change', () => viewport.requestRender());
    this.gizmo.addEventListener('dragging-changed', (event) => {
      viewport.orbit.enabled = !event.value;
      editor.modeDragging = event.value;
    });
    this.gizmo.addEventListener('mouseDown', () => this.beginDrag());
    // Shift held as the gizmo is taken: a move by inverse kinematics (see ik.js).
    this.shiftDown = false;
    viewport.renderer.domElement.addEventListener('pointerdown', (event) => { this.shiftDown = event.shiftKey; }, { capture: true });
    // ...and its sign, on the entry's pivot point while Shift is held (see ik-sign.js).
    this.shiftHeld = false;
    this.ikSign = new IKSign(viewport, () => this.ikSignAt());
    const shift = (held) => {
      if (this.shiftHeld === held) return;
      this.shiftHeld = held;
      this.ikSign.update();
    };
    window.addEventListener('keydown', (event) => { if (event.key === 'Shift') shift(true); });
    window.addEventListener('keyup', (event) => { if (event.key === 'Shift') shift(false); });
    window.addEventListener('pointermove', (event) => shift(event.shiftKey));
    window.addEventListener('blur', () => shift(false));
    // Alt held or let go while scaling: one side, or both (see oneSided()) -
    // as the editor has it (Editor.altHeld), once it has heard of it.
    for (const type of ['keydown', 'keyup']) {
      window.addEventListener(type, (event) => {
        if (event.key === 'Alt' && this.dragging?.side) queueMicrotask(() => this.drag());
      });
    }
    this.gizmo.addEventListener('objectChange', () => this.drag());
    this.gizmo.addEventListener('mouseUp', () => this.endDrag());
    editor.workspacePress.animation = () => (this.gizmo.object && this.gizmo.axis !== null ? 'gizmo' : false);

    editor.addEventListener('change', () => this.refresh());
    // Another frame: what was posed by hand and not keyed is let go - kept
    // aside, for "Вернуть позу" on the timeline to bring back (restorePose()).
    this.lost = null; // { clip, frame, overrides }, or null
    timeline.addEventListener('frame', () => {
      if (this.posedByHand()) this.lost = { clip: this.timeline.clip, frame: this.frameShown, overrides: this.overrides };
      this.overrides = new Map();
      this.show();
    });
    timeline.addEventListener('restore', () => this.restorePose());
    timeline.addEventListener('groupsonly', () => this.show()); // (the gizmo: on a group only, or anything)
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
      this.lost = null;
      this.ghost.hide();
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
  // with what is posed by hand (`overrides`) over that.
  valuesNow(overrides = this.overrides) {
    return clipValues(this.editor, this.timeline.current(), this.timeline.frame, overrides);
  }

  show() {
    if (!this.on || !this.pose.on) return;
    this.frameShown = this.timeline.frame;
    if (this.posedByHand()) this.lost = null; // (posed anew: what was let go is gone)
    this.timeline.showUnkeyed(this.posedByHand() ? 'pending' : this.lost ? this.lost.frame : null);
    this.values = this.valuesNow();
    this.matrices = posedMatrices(this.editor, this.values);
    this.pose.apply(this.matrices);
    this.showGhost();
    this.editor.refreshHighlight(); // the outline of what is picked, where it is shown
    if (!this.gizmo.dragging) this.placeGizmo();
    this.showPanel();
    this.onShow?.(); // the three views show the pose too
    this.ikSign.update();
  }

  // What is posed by hand and not keyed: its ghost where the keys have it,
  // where it goes back to as the frame changes (see ghost.js). Not while it
  // is being posed with Autokey on - it is keyed as that ends.
  showGhost() {
    if (!this.posedByHand() || (this.dragging && this.timeline.autokey)) {
      this.ghost.hide();
      return;
    }
    this.ghost.update(this.pose, this.matrices, posedMatrices(this.editor, this.valuesNow(new Map())));
  }

  // Whether anything is posed by hand and not keyed.
  posedByHand() {
    return [...this.overrides.values()].some((own) => Object.keys(own).length > 0);
  }

  // "Вернуть позу": what another frame let go, back - on its clip and frame.
  restorePose() {
    const lost = this.lost;
    if (!lost || !this.on) return;
    if (this.editor.animations.some((clip) => clip.name === lost.clip)) this.timeline.clip = lost.clip;
    this.timeline.update();
    this.timeline.setFrame(lost.frame);
    this.overrides = new Map(lost.overrides);
    this.lost = null;
    this.show();
  }

  // Where the sign of IK is now (see ik-sign.js), or null: on the entry's
  // pivot point as it is shown, while Shift would make a move IK - the move
  // tool in hand, groups above the entry to turn - or, while an IK move goes
  // on, on its target.
  ikSignAt() {
    if (!this.on || !this.pose.on || this.editor.preview || this.editor.simulating) return null;
    const pivot = (id) => (this.matrices.has(id) ? new THREE.Vector3().setFromMatrixPosition(this.matrices.get(id)) : null);
    // (moving: on the target, where the entry is pulled to - it may fall short)
    if (this.dragging) return this.dragging.ik ? this.dragging.target ?? pivot(this.dragging.id) : null;
    const entry = this.shiftHeld && GIZMO_MODES[this.editor.tool] === 'translate' ? this.entry() : null;
    if (!entry || (this.editor.topology.islands[entry.index]?.parentIndex ?? null) === null) return null;
    return pivot(entry.id);
  }

  // --- the gizmo ------------------------------------------------------------------

  placeGizmo() {
    const entry = this.entry();
    const mode = GIZMO_MODES[this.editor.tool];
    if (!entry || !mode || this.editor.preview || !this.mayPose(entry.index)) {
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

  // Whether an entry is posed and keyed: with "Только группы" on the
  // timeline (see Timeline.setGroupsOnly()), groups only.
  mayPose(index) {
    return !this.timeline.groupsOnly || this.editor.mesh.objects[index]?.kind === 'group';
  }

  // The parent's matrix in the world, as shown (none: the world itself).
  parentMatrix(id) {
    const object = this.editor.mesh.objects.find((other) => other.id === id);
    const parent = object?.parent ?? null;
    return parent !== null && this.matrices.has(parent) ? this.matrices.get(parent) : new THREE.Matrix4();
  }

  beginDrag() {
    const entry = this.entry();
    const property = PROPERTY_OF_MODE[this.gizmo.mode];
    if (!entry) return;
    this.beginPose(entry.index, property, { ik: this.shiftDown && property === 'position' });
    if (property === 'scale') this.dragging.side = this.sideOf(entry.index);
  }

  // Scaling with Alt held (as in the editor, see Editor.scaleCenter()): the
  // side pulled moves, the one opposite stays where it is. A pose scales
  // about the entry's pivot point, so it is a scale and a move together -
  // both posed (and keyed). What it takes, from the start of the drag: the
  // handle's axes, which way along each it was taken (+1 / -1), and the
  // bounds of what the entry holds, in the entry's own axes as it was then.
  // null for the middle handle, or nothing in the entry.
  sideOf(index) {
    const axes = (this.gizmo.axis ?? '').toLowerCase();
    if (!axes || axes.length === 3) return null;
    const { vertices } = this.editor.contents([index]);
    if (vertices.size === 0) return null;
    const back = this.dragging.world.clone().invert();
    const shown = this.editor.view.shown;
    const box = new THREE.Box3();
    for (const vertex of vertices) box.expandByPoint(shown[vertex].clone().applyMatrix4(back));
    const turn = new THREE.Quaternion();
    this.dragging.world.decompose(new THREE.Vector3(), turn, new THREE.Vector3());
    const grabbed = this.gizmo.pointStart.clone().applyQuaternion(turn.invert()); // (in the entry's axes)
    return { axes: [...axes], way: Object.fromEntries([...axes].map((axis) => [axis, grabbed[axis] >= 0 ? 1 : -1])), box };
  }

  // The world matrix `matrix` (the gizmo's, scaled) as a scale about the
  // side opposite the one pulled (see sideOf()), not about the pivot point.
  oneSided(matrix) {
    const { world, side } = this.dragging;
    const startScale = new THREE.Vector3();
    const nowScale = new THREE.Vector3();
    world.decompose(new THREE.Vector3(), new THREE.Quaternion(), startScale);
    matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), nowScale);
    const ratio = new THREE.Vector3(...['x', 'y', 'z'].map((axis) => (startScale[axis] ? nowScale[axis] / startScale[axis] : 1)));
    const anchor = new THREE.Vector3();
    for (const axis of side.axes) anchor[axis] = side.way[axis] > 0 ? side.box.min[axis] : side.box.max[axis];
    return world.clone()
      .multiply(new THREE.Matrix4().makeTranslation(anchor.x, anchor.y, anchor.z))
      .multiply(new THREE.Matrix4().makeScale(ratio.x, ratio.y, ratio.z))
      .multiply(new THREE.Matrix4().makeTranslation(-anchor.x, -anchor.y, -anchor.z));
  }

  // The stand-in moved: the entry posed where it is.
  drag() {
    if (!this.dragging) return;
    this.proxy.updateMatrix();
    this.poseTo(this.proxy.matrix);
  }

  // Posing an entry by hand - by the gizmo, or in the three views (see
  // ortho-views.js): one of its properties, from where it is shown now.
  // With `ik`, a move is by inverse kinematics: the entry stays as it is in
  // its parent, and the groups above it turn to bring it where it is moved
  // (see ik.js).
  beginPose(index, property, { ik = false } = {}) {
    const { id } = this.editor.mesh.objects[index];
    this.dragging = {
      index,
      id,
      property,
      start: structuredClone(this.values.get(id)),
      parent: this.parentMatrix(id).clone().invert(),
      world: this.matrices.get(id).clone(), // where it was in the world
      ik: ik && property === 'position' ? this.ikChain(index) : null,
    };
  }

  // The groups above an entry, the nearest first: the joints its IK turns.
  ikChain(index) {
    const { islands } = this.editor.topology;
    const { objects } = this.editor.mesh;
    const joints = [];
    for (let at = islands[index]?.parentIndex ?? null; at !== null && at !== undefined; at = islands[at].parentIndex) {
      joints.push({ index: at, id: objects[at].id });
    }
    return joints.length ? { joints, values: structuredClone(this.values), locals: localTransforms(this.editor) } : null;
  }

  // The entry put where `matrix` (in the world) says: its property (the
  // others as they were) in its parent, posed for the time being.
  poseTo(matrix) {
    const drag = this.dragging;
    if (!drag) return;
    if (drag.ik) {
      // Where the entry is moved to: the joints turned to bring it there.
      const target = new THREE.Vector3().setFromMatrixPosition(matrix);
      drag.target = target; // (where the sign of IK is, see ikSignAt())
      const turns = solveIK(this.editor, drag.id, drag.ik.joints, target, drag.ik.values, drag.ik.locals);
      for (const [id, rotation] of turns) this.overrides.set(id, { ...this.overrides.get(id), rotation: rotation.map(round) });
      this.show();
      return;
    }
    // (scaling with Alt: one side - the place posed too; without, back where it started)
    const oneSided = drag.property === 'scale' && drag.side && this.editor.altHeld;
    const local = drag.parent.clone().multiply(oneSided ? this.oneSided(matrix) : matrix);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    local.decompose(position, quaternion, scale);
    if (drag.side) {
      this.overrides.set(drag.id, { ...this.overrides.get(drag.id), position: oneSided ? position.toArray().map(round) : drag.start.position });
    }
    let value = drag.property === 'position' ? position.toArray() : scale.toArray();
    if (drag.property === 'rotation') {
      if (drag.start.rotation.length === 4) {
        // A quaternion, on the side of the one it started from.
        const s = drag.start.rotation;
        if (quaternion.x * s[0] + quaternion.y * s[1] + quaternion.z * s[2] + quaternion.w * s[3] < 0) quaternion.set(-quaternion.x, -quaternion.y, -quaternion.z, -quaternion.w);
        value = quaternion.toArray();
      } else {
        value = unwrap(rotationOf(quaternion) ?? [0, 0, 0], drag.start.rotation);
      }
    }
    this.overrides.set(drag.id, { ...this.overrides.get(drag.id), [drag.property]: value.map(round) });
    this.show();
  }

  endDrag() {
    // (TransformControls tells of the end of its drag only after this: the
    // editor is not busy with it any more as of now)
    this.editor.modeDragging = false;
    this.endPose();
    // ...nor does show() put the gizmo back on the entry while it still
    // drags: put here - an IK move may have left the entry short of it.
    this.placeGizmo();
  }

  // The end of posing by hand: with Autokey, a key of what was changed.
  endPose() {
    const drag = this.dragging;
    this.dragging = null;
    if (!drag) return;
    if (drag.ik) {
      // The joints that turned: keyed, with Autokey.
      const turned = drag.ik.joints.filter(({ id }) => JSON.stringify(this.values.get(id)?.rotation) !== JSON.stringify(drag.ik.values.get(id)?.rotation));
      if (this.timeline.autokey && turned.length) this.writeKeys(turned.map(({ index }) => index), ['rotation']);
      else this.show();
      return;
    }
    // (what was changed: the property - and, scaled on one side, the place too)
    const changed = PROPERTIES.filter((property) => JSON.stringify(this.values.get(drag.id)?.[property]) !== JSON.stringify(drag.start[property]));
    if (this.timeline.autokey && changed.length) {
      this.writeKeys([drag.index], changed);
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
    indices = indices.filter((index) => this.mayPose(index));
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
    // (the keys set - new or put over ones that were there - pop in, see Timeline.popKeys())
    timeline.popKeys(indices.flatMap((index) => properties.map((property) => keyId(editor.mesh.objects[index].id, property, frame))));
  }

  // The corner's "+" on the timeline: every property of every entry keyed on
  // the frame, as it is shown - the whole pose, changed or not.
  keyAll() {
    if (!this.on) return;
    this.writeKeys(this.editor.mesh.objects.map((_, index) => index), PROPERTIES);
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
    // A quaternion's turn has a fourth number, W, shown first (as Blender does).
    const quaternion = values.rotation.length === 4;
    this.panel.querySelector('[data-pose="rotation.3"]').closest('label').hidden = !quaternion;
    this.panel.querySelector('.pose-rotation-title').textContent = quaternion ? 'Поворот (кватернион)' : 'Поворот';
    for (const input of this.inputs) {
      if (document.activeElement === input) continue;
      const [property, axis] = input.dataset.pose.split('.');
      const value = values[property][+axis];
      input.value = value === undefined ? '' : +value.toFixed(4);
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
