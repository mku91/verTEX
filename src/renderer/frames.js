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

// The turn a shape has by the look of it, whatever is known of how it was
// turned: the axes that nearly all its edges run along - a box's, however it
// came to stand aslant (its vertices turned in the vertex mode, say). `edges`:
// [{ length, way (unit), normal (a face's it is of) }]; `turn`: the turn it is
// known to have. A quaternion, or null: it has no such axes (a ball, a tube),
// or those of `turn` do as well.
const ON_AXIS = 0.998; // the cosine of how far off an axis an edge may be
const BOXLIKE = 0.85; // the share of the edges' length that has to run along the axes
const TRIED = 48; // the longest edges, whose axes are tried
export function turnOfShape(edges, turn) {
  const whole = edges.reduce((sum, { length }) => sum + length, 0);
  if (!(whole > 0)) return null;
  const share = (axes) => edges.reduce((sum, { length, way }) => sum + (axes.some((axis) => Math.abs(axis.dot(way)) > ON_AXIS) ? length : 0), 0) / whole;
  const axesOf = (q) => [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((axis) => new THREE.Vector3(...axis).applyQuaternion(q));
  const known = axesOf(turn);
  let best = Math.max(BOXLIKE, share(known) + 0.1);
  let found = null;
  for (const { way, normal } of [...edges].sort((a, b) => b.length - a.length).slice(0, TRIED)) {
    const third = normal.clone().cross(way);
    if (third.lengthSq() < 0.99) continue;
    const axes = [way, normal, third.normalize()];
    const fit = share(axes);
    if (fit > best + 1e-9) [best, found] = [fit, axes];
  }
  if (!found) return null;
  // Each called after the known axis it is nearest to.
  const left = [...found];
  const [x, y] = known.map((axis) => {
    const near = left.reduce((a, b) => (Math.abs(b.dot(axis)) > Math.abs(a.dot(axis)) ? b : a));
    left.splice(left.indexOf(near), 1);
    return near.clone().multiplyScalar(near.dot(axis) < 0 ? -1 : 1);
  });
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, new THREE.Vector3().crossVectors(x, y)));
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
