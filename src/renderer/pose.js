import * as THREE from 'three';
import { quaternionOf, rotationOf, toLocal } from './frames.js';
import { poseAt } from './animation.js';

// The scene posed: its entries (objects and nodes) put somewhere other
// than where the model has them, for a while - by the simulation (see
// simulation.js), by an animation - with the model itself left as it is.
//
// An entry's place in its parent (see frames.js) is what is posed, as glTF
// and Godot have it: its position in the parent's frame, its turn relative
// to the parent's, and a scale of its own (the model has none: 1). A child
// goes wherever its node goes, turns and grows with it. Where the model
// has the entries is the rest pose; what a pose does not name stays there.
//
// The editor draws the whole model as one mesh, so a pose is shown by its
// vertices: each object's are taken into its own frame once (begin()), and
// put back out of the posed frame on every apply() - into a copy of them,
// which the view draws instead (MeshView.posed); end() lets it go. The
// model's own vertices are never moved: what is saved, exported or made an
// undo step while a pose is on is the model as it is.

// Every entry's place in its parent, as the model has it (the rest pose):
// Map id -> { parent, position: [x, y, z], rotation: [x, y, z] degrees or
// null }. Inside a node that is not turned the angles are the entry's own,
// as they were set (they may be past 180); else they are worked out from the
// turns, as near as they can be.
export function localTransforms(editor) {
  const { mesh } = editor;
  const frames = worldFrames(editor);
  const out = new Map();
  for (const { id, parent, rotation } of mesh.objects) {
    const frame = frames.get(id);
    const outer = parent === null || parent === undefined ? null : frames.get(parent) ?? null;
    const turn = outer?.turned ? rotationOf(outer.quaternion.clone().invert().multiply(frame.quaternion)) : rotation ?? null;
    out.set(id, {
      parent: outer ? parent : null,
      position: (outer ? toLocal(frame.origin, outer) : frame.origin).toArray(),
      rotation: turn,
    });
  }
  return out;
}

// The pose of every entry at a frame of a clip (none: the rest pose), with
// `overrides` (Map id -> { position?, rotation?, scale? }) over it: Map id ->
// { position, rotation, scale } - the rotation a quaternion for an entry
// turned by them (see Editor.setRotationMode()), else angles.
// (`locals`: localTransforms() as it is now, when it has been worked out already.)
export function clipValues(editor, clip, frame, overrides = new Map(), locals = localTransforms(editor)) {
  const posed = clip ? poseAt(clip, frame) : new Map();
  const values = new Map();
  for (const [id, place] of locals) {
    const own = { ...posed.get(id), ...overrides.get(id) };
    const angles = place.rotation ?? [0, 0, 0];
    const quaternion = editor.mesh.objects.find((object) => object.id === id)?.rotationMode === 'quaternion';
    const restTurn = quaternion
      ? new THREE.Quaternion().setFromEuler(new THREE.Euler(...angles.map((angle) => THREE.MathUtils.degToRad(angle)), 'XYZ')).toArray()
      : angles;
    values.set(id, {
      position: own.position ?? place.position,
      rotation: own.rotation ?? restTurn,
      scale: own.scale ?? [1, 1, 1],
    });
  }
  return values;
}

// Every entry's frame in the world, as the model has it: Map id ->
// { origin (its pivot point), quaternion, turned }.
export function worldFrames(editor) {
  return new Map(editor.mesh.objects.map((object, index) => [
    object.id,
    { origin: editor.pivotPoint(index), quaternion: quaternionOf(object.rotation), turned: Boolean(object.rotation) },
  ]));
}

// A turn as pose.js takes it: angles in degrees, or a quaternion [x, y, z, w].
export function turnOf(rotation) {
  return rotation?.length === 4 ? new THREE.Quaternion(...rotation).normalize() : quaternionOf(rotation);
}

// Every entry's matrix in the world with `pose` on it: Map id -> Matrix4.
// `pose`: Map id -> { position?, rotation?, scale? } - [x, y, z] each, in
// the entry's parent, as localTransforms() gives them (rotation in degrees);
// what it leaves out is the rest pose's. A node's matrix carries its
// children with it.
// (`locals`: localTransforms() as it is now, when it has been worked out already.)
export function posedMatrices(editor, pose = new Map(), locals = localTransforms(editor)) {
  const out = new Map();
  const matrixOf = (id) => {
    if (out.has(id)) return out.get(id);
    const rest = locals.get(id);
    const own = pose.get(id) ?? {};
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(...(own.position ?? rest.position)),
      turnOf(own.rotation ?? rest.rotation),
      new THREE.Vector3(...(own.scale ?? [1, 1, 1])),
    );
    const matrix = rest.parent === null ? local : matrixOf(rest.parent).clone().multiply(local);
    out.set(id, matrix);
    return matrix;
  };
  for (const id of locals.keys()) matrixOf(id);
  return out;
}

// The model's vertices, shown moved by a pose for as long as it is on.
//
// A vertex goes with its object, as a whole - unless it is in the skin (see
// mesh.weights, skin.js): then it bends with the nodes it is weighted to,
// as glTF's skins do (linear blend skinning). Each such node takes it from
// where the node is at rest to where it is posed - Mᵢ · Bᵢ⁻¹ - and the
// vertex goes to the mean of those places, by its weights:
//   v' = Σ wᵢ · Mᵢ · Bᵢ⁻¹ · v
// (its own object's pose does not move it, as glTF has it).
const ONE = new THREE.Vector3(1, 1, 1);

export class ModelPose {
  constructor(editor) {
    this.editor = editor;
    this.objects = null; // id -> { vertices, local }, while on
    this.shown = null; // where the vertices are shown
    this.skin = null; // vertex -> { at (at rest, in the world), weights }, while on
    this.rest = null; // node id -> its frame at rest, undone (Bᵢ⁻¹)
  }

  get on() {
    return this.objects !== null;
  }

  // Takes every object's vertices into its frame: from here on they are
  // placed by apply(), until end().
  begin() {
    const { mesh } = this.editor;
    const frames = worldFrames(this.editor);
    this.shown = mesh.vertices.map((vertex) => vertex.clone());
    this.objects = new Map();
    mesh.vertices.forEach((vertex, i) => {
      const id = mesh.vertexObject[i];
      if (!this.objects.has(id)) this.objects.set(id, { vertices: [], local: [] });
      const entry = this.objects.get(id);
      entry.vertices.push(i);
      entry.local.push(toLocal(vertex, frames.get(id)));
    });
    this.skin = new Map();
    this.rest = new Map();
    for (const [vertex, weights] of mesh.weights) {
      if (vertex >= mesh.vertices.length) continue;
      this.skin.set(vertex, { at: mesh.vertices[vertex].clone(), weights });
      for (const [node] of weights) {
        const frame = frames.get(node);
        if (frame && !this.rest.has(node)) this.rest.set(node, new THREE.Matrix4().compose(frame.origin, frame.quaternion, ONE).invert());
      }
    }
  }

  // Where `matrices` (Map id -> Matrix4, in the world) put the vertices,
  // written into `out` (Vector3 per vertex): each object's with its frame,
  // those in the skin bent with their nodes (see the top). What `matrices`
  // does not name is left as it is in `out` - a node it leaves out is at rest.
  place(matrices, out) {
    for (const [id, { vertices, local }] of this.objects) {
      const matrix = matrices.get(id);
      if (!matrix) continue;
      vertices.forEach((vertex, k) => out[vertex].copy(local[k]).applyMatrix4(matrix));
    }
    if (this.skin.size === 0) return out;
    const bends = new Map(); // node id -> Mᵢ · Bᵢ⁻¹
    for (const [node, back] of this.rest) {
      const matrix = matrices.get(node);
      if (matrix) bends.set(node, matrix.clone().multiply(back));
    }
    const point = new THREE.Vector3();
    for (const [vertex, { at, weights }] of this.skin) {
      const sum = out[vertex].set(0, 0, 0);
      for (const [node, weight] of weights) {
        point.copy(at);
        const bend = bends.get(node);
        if (bend) point.applyMatrix4(bend);
        sum.addScaledVector(point, weight);
      }
    }
    return out;
  }

  // Where `matrices` put the vertices, the view left as it is: a list of its own.
  placed(matrices) {
    return this.place(matrices, this.editor.mesh.vertices.map((vertex) => vertex.clone()));
  }

  // The objects where `matrices` (Map id -> Matrix4, in the world) put
  // their frames; those it does not name are left where they are.
  apply(matrices) {
    if (!this.on) return;
    const { view, viewport } = this.editor;
    this.place(matrices, this.shown);
    view.posed = this.shown;
    view.updatePositions();
    viewport.requestRender();
  }

  // The model shown where it is again.
  end() {
    if (!this.on) return;
    const { view, viewport } = this.editor;
    this.objects = null;
    this.shown = null;
    this.skin = null;
    this.rest = null;
    view.posed = null;
    view.updatePositions();
    viewport.requestRender();
  }
}
