import * as THREE from 'three';

// An object's own frame.
//
// The editor works on vertices in world coordinates, but every entry of the
// objects list - an object or a node - also has a frame of its own: an
// origin (its pivot point) and a rotation, how the entry has been turned as a
// whole. `rotation` on the entry is Euler angles in degrees, [x, y, z], order
// XYZ, absent when it has not been turned. Local coordinates - what a project
// file stores, what an exporter needs, what "the size along its own axes"
// means - are the world ones taken into that frame.

const DEGREE = Math.PI / 180;

export function quaternionOf(rotation) {
  if (!rotation) return new THREE.Quaternion();
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(rotation[0] * DEGREE, rotation[1] * DEGREE, rotation[2] * DEGREE, 'XYZ'),
  );
}

// The angles of a quaternion, or null for no turn at all.
export function rotationOf(quaternion) {
  const euler = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');
  const rotation = [euler.x, euler.y, euler.z].map((angle) => +(angle / DEGREE).toFixed(4) || 0);
  return rotation.some(Boolean) ? rotation : null;
}

export function setRotation(object, rotation) {
  if (rotation?.some(Boolean)) object.rotation = [...rotation];
  else delete object.rotation;
}

// The same turn seen in a mirror across the planes of the given axes.
export function mirrorRotation(rotation, axes) {
  if (!rotation || axes.length === 0) return rotation ?? null;
  const q = quaternionOf(rotation);
  for (const axis of axes) {
    // A turn is about an axis: across a plane, the part of that axis along
    // the plane's normal stays and the rest flips.
    for (const other of ['x', 'y', 'z']) if (other !== axis) q[other] = -q[other];
  }
  return rotationOf(q);
}

// A point taken into a frame { origin, quaternion }, and back out of it.
export function toLocal(point, frame) {
  return point.clone().sub(frame.origin).applyQuaternion(frame.quaternion.clone().invert());
}

export function toWorld(point, frame) {
  return point.clone().applyQuaternion(frame.quaternion).add(frame.origin);
}
