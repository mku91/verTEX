import * as THREE from 'three';
import { posedMatrices } from './pose.js';
import { rotationOf } from './frames.js';
import { unwrap } from './animation.js';

// Inverse kinematics for the animation mode (see animate.js): an entry
// moved with Shift held is not moved in its parent - the nodes above it
// (the joints, each turning about its pivot point) are turned so that it
// comes as near as it can to where it is moved.
//
// The solver is CCD, cyclic coordinate descent: from the nearest joint up
// to the outermost, each in turn is turned the least that points the entry
// at the target as seen from the joint; round again, until the entry is
// there or the rounds are used up. Every joint may turn any way (no limits);
// the chain is every node above the entry.

const ROUNDS = 16;
const NEAR_ENOUGH = 1e-4;

const positionOf = (matrix) => new THREE.Vector3().setFromMatrixPosition(matrix);
const turnOfMatrix = (matrix) => {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  return quaternion;
};

// The joints' turns (Map id -> rotation, angles or a quaternion as each
// joint has them) that bring the entry `id` to `target` (in the world),
// from the pose `start` (Map id -> { position, rotation, scale }).
export function solveIK(editor, id, joints, target, start, locals) {
  const values = new Map([...start].map(([key, value]) => [key, { ...value }]));
  const parents = new Map(editor.mesh.objects.map((object) => [object.id, object.parent ?? null]));
  for (let round = 0; round < ROUNDS; round++) {
    for (const joint of joints) {
      const matrices = posedMatrices(editor, values, locals);
      const at = positionOf(matrices.get(joint.id));
      const toEntry = positionOf(matrices.get(id)).sub(at);
      const toTarget = target.clone().sub(at);
      if (toEntry.lengthSq() < 1e-12 || toTarget.lengthSq() < 1e-12) continue;
      // The joint's turn in the world, turned further by the least turn
      // from the entry's way to the target's; then in its parent's terms.
      const swing = new THREE.Quaternion().setFromUnitVectors(toEntry.normalize(), toTarget.normalize());
      const world = swing.multiply(turnOfMatrix(matrices.get(joint.id)));
      const parent = parents.get(joint.id);
      const above = parent !== null && matrices.has(parent) ? turnOfMatrix(matrices.get(parent)) : new THREE.Quaternion();
      const local = above.invert().multiply(world);
      const was = values.get(joint.id).rotation;
      let rotation;
      if (was?.length === 4) {
        // (a quaternion: on the side of the one it was)
        if (local.x * was[0] + local.y * was[1] + local.z * was[2] + local.w * was[3] < 0) local.set(-local.x, -local.y, -local.z, -local.w);
        rotation = local.toArray();
      } else {
        rotation = unwrap(rotationOf(local) ?? [0, 0, 0], was);
      }
      values.set(joint.id, { ...values.get(joint.id), rotation });
    }
    const reached = positionOf(posedMatrices(editor, values, locals).get(id)).distanceTo(target);
    if (reached < NEAR_ENOUGH) break;
  }
  return new Map(joints.map(({ id: joint }) => [joint, values.get(joint).rotation]));
}
