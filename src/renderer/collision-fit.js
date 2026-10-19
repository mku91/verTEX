import * as THREE from 'three';
import { ConvexHull } from 'three/addons/math/ConvexHull.js';

// Collision shapes fitted to points - an object's vertices in its own frame
// (see frames.js) - for the collision mode (see collisions.js). A shape is
// what the object's `colliders` hold, in the same frame:
//   { type: 'box',      center, rotation, size: [x, y, z] }
//   { type: 'sphere',   center, radius }
//   { type: 'capsule',  center, rotation, radius, height }  - along its y,
//                                                           height end to end
//   { type: 'cylinder', center, rotation, radius, height }  - along its y
//   { type: 'convex',   points: [[x, y, z], ...] }           - the hull of them
//   { type: 'trimesh' }                                       - the object's own faces
// `center` is [x, y, z]; `rotation` Euler angles in degrees, XYZ, as an
// object's (see frames.js) - [0, 0, 0] when not turned. Godot takes them as
// they are (see gltf.js): a capsule's height there is end to end too.

const DEGREE = 180 / Math.PI;

// The hull of the points: its corners and its triangles (indices into the
// corners, counter-clockwise from outside); null if they are too few, or flat.
export function hullOf(points) {
  if (points.length < 4) return null;
  let hull;
  try {
    hull = new ConvexHull().setFromPoints(points.map((p) => new THREE.Vector3(...p)));
  } catch {
    return null; // all in one plane, or on one line
  }
  if (hull.faces.length === 0) return null;
  const corners = [];
  const index = new Map();
  const cornerOf = (point) => {
    const key = point.toArray().map((value) => value.toFixed(6)).join(',');
    if (!index.has(key)) {
      index.set(key, corners.length);
      corners.push(point.toArray());
    }
    return index.get(key);
  };
  const triangles = [];
  for (const face of hull.faces) {
    const loop = [];
    let edge = face.edge;
    do {
      loop.push(cornerOf(edge.head().point));
      edge = edge.next;
    } while (edge !== face.edge);
    for (let k = 1; k + 1 < loop.length; k++) triangles.push([loop[0], loop[k], loop[k + 1]]);
  }
  return { points: corners, triangles };
}

// The volume a hull holds (by its triangles, against its first corner).
function hullVolume(hull) {
  const o = new THREE.Vector3(...hull.points[0]);
  let volume = 0;
  for (const [a, b, c] of hull.triangles) {
    const p = new THREE.Vector3(...hull.points[a]).sub(o);
    const q = new THREE.Vector3(...hull.points[b]).sub(o);
    const r = new THREE.Vector3(...hull.points[c]).sub(o);
    volume += p.dot(q.cross(r)) / 6;
  }
  return Math.abs(volume);
}

const round = (value) => +value.toFixed(5);
const roundAll = (values) => values.map(round);

// The bounds of the points along the frame's own axes.
function boundsOf(points) {
  const box = new THREE.Box3().setFromPoints(points.map((p) => new THREE.Vector3(...p)));
  return { center: box.getCenter(new THREE.Vector3()), size: box.getSize(new THREE.Vector3()) };
}

export function fitBox(points) {
  const { center, size } = boundsOf(points);
  return { type: 'box', center: roundAll(center.toArray()), rotation: [0, 0, 0], size: roundAll(size.toArray()) };
}

// The smallest sphere round them, near enough (Ritter's): from the two
// points farthest apart, grown to take in any left outside.
export function fitSphere(points) {
  const vectors = points.map((p) => new THREE.Vector3(...p));
  const farthest = (from) => vectors.reduce((best, p) => (p.distanceToSquared(from) > best.distanceToSquared(from) ? p : best), vectors[0]);
  const a = farthest(vectors[0]);
  const b = farthest(a);
  const center = a.clone().add(b).multiplyScalar(0.5);
  let radius = a.distanceTo(b) / 2;
  for (const p of vectors) {
    const d = p.distanceTo(center);
    if (d > radius) {
      // Grown just enough: the far side stays where it was.
      const grown = (radius + d) / 2;
      center.addScaledVector(p.clone().sub(center).normalize(), grown - radius);
      radius = grown;
    }
  }
  return { type: 'sphere', center: roundAll(center.toArray()), radius: round(radius) };
}

// A capsule or a cylinder along the longest of the frame's axes, through the
// middle of the bounds, as wide as the farthest point is from that line. A
// cylinder is as long as the points reach along it. A capsule is a line with
// a radius round it - every point within the radius of it: its line is made
// just long enough for that, and its height, end to end, is the line and a
// radius at each end.
function fitRound(points, type) {
  const { center, size } = boundsOf(points);
  const axis = ['x', 'y', 'z'].reduce((best, a) => (size[a] > size[best] ? a : best), 'y');
  const others = ['x', 'y', 'z'].filter((a) => a !== axis);
  const local = points.map((p) => ({ x: p[0] - center.x, y: p[1] - center.y, z: p[2] - center.z }));
  const radius = Math.max(...local.map((v) => Math.hypot(v[others[0]], v[others[1]])));
  let height = size[axis];
  if (type === 'capsule') {
    // Half the line: what lets the farthest point along it lie within the radius of its end.
    const half = Math.max(0, ...local.map((v) => Math.abs(v[axis]) - Math.sqrt(Math.max(0, radius ** 2 - v[others[0]] ** 2 - v[others[1]] ** 2))));
    height = 2 * half + 2 * radius;
  }
  // Turned so that the shape's own y lies along the axis.
  const rotation = axis === 'x' ? [0, 0, 90] : axis === 'z' ? [90, 0, 0] : [0, 0, 0];
  return { type, center: roundAll(center.toArray()), rotation, radius: round(radius), height: round(height) };
}

export const fitCapsule = (points) => fitRound(points, 'capsule');
export const fitCylinder = (points) => fitRound(points, 'cylinder');

export function fitConvex(points) {
  const hull = hullOf(points);
  return hull ? { type: 'convex', points: hull.points.map(roundAll) } : null;
}

export function fitTrimesh() {
  return { type: 'trimesh' };
}

// How much room a shape takes.
export function volumeOf(shape) {
  switch (shape.type) {
    case 'box': return shape.size[0] * shape.size[1] * shape.size[2];
    case 'sphere': return (4 / 3) * Math.PI * shape.radius ** 3;
    case 'cylinder': return Math.PI * shape.radius ** 2 * shape.height;
    case 'capsule': return Math.PI * shape.radius ** 2 * Math.max(0, shape.height - 2 * shape.radius) + (4 / 3) * Math.PI * shape.radius ** 3;
    case 'convex': return hullVolume(hullOf(shape.points) ?? { points: [[0, 0, 0]], triangles: [] });
    default: return Infinity;
  }
}

// The shape that fits the points best, by itself: of the simple ones - a
// box, a sphere, a capsule, a cylinder - the one with the least room to
// spare, if it holds no more than LOOSE times what their hull does; else
// the hull. Flat points (a plane, a line) get a box: a hull of them is no shape.
const LOOSE = 1.3;
export function fitAuto(points) {
  const hull = hullOf(points);
  if (!hull) return fitBox(points);
  const tight = hullVolume(hull);
  const simple = [fitBox(points), fitSphere(points), fitCapsule(points), fitCylinder(points)];
  const best = simple.reduce((a, b) => (volumeOf(b) < volumeOf(a) ? b : a));
  return volumeOf(best) <= tight * LOOSE ? best : { type: 'convex', points: hull.points.map(roundAll) };
}

// A copy of a shape that shares nothing with it.
export const cloneCollider = (collider) => JSON.parse(JSON.stringify(collider));

export const FITS = { box: fitBox, sphere: fitSphere, capsule: fitCapsule, cylinder: fitCylinder, convex: fitConvex, trimesh: fitTrimesh, auto: fitAuto };

// A shape's place as a matrix of its own frame within the object's: where
// its center is, how it is turned.
export function shapeMatrix(shape) {
  const position = new THREE.Vector3(...(shape.center ?? [0, 0, 0]));
  const r = shape.rotation ?? [0, 0, 0];
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0] / DEGREE, r[1] / DEGREE, r[2] / DEGREE, 'XYZ'));
  return new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(1, 1, 1));
}
