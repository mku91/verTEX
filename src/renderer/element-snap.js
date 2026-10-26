// Snapping to elements: with the grid switched off, Ctrl held while dragging
// draws what is dragged onto its like nearby - a vertex onto a vertex, an
// edge onto an edge, a face onto a face, an object against another object's
// face. Vertices left standing on vertices of their own object are merged
// when the drag ends (see mergeLanded()); objects only touch, they are
// never merged.
//
// What is snapped to: in the vertex, edge and face modes, the dragged
// object's own elements that stay where they are; in object mode, the
// faces of every other object. Nothing hidden, and nothing the viewer cannot
// see for what stands in front of it (the far side of a shape).
import * as THREE from 'three';
import { edgeKey } from './mesh.js';

export const SNAP_RADIUS = 14; // px: how near on screen something must come to be snapped to
const SAME_POINT = 1e-5; // vertices this close stand in one place
const PARALLEL = 0.98; // the cosine of the angle within which two faces count as parallel

// Where the drag should go instead of `free` (the offset the pointer asks for,
// from where everything started), or null when there is nothing near.
//   mesh, mode - the editor's;
//   key - the dragged element (an edge's key, a face's index), null for a vertex;
//   lead - the vertex that leads the drag;
//   moving - Map of every dragged vertex to where it started;
//   hidden - vertices that are hidden;
//   cursor - the pointer, and project(point) - a world point to the same
//   pixels (null when it cannot be seen);
//   seen(point) - whether nothing still stands between the viewer and the point.
// Returns { offset, mark }: mark is what was snapped to, as { points, lines }
// (THREE.Vector3[], pairs of them), for showing.
export function snapElement({ mesh, mode, key, lead, moving, hidden, cursor, project, seen, free }) {
  const { vertices, vertexObject } = mesh;
  const own = vertexObject[lead];
  // What may be snapped to: what stays, of the dragged object or of the others.
  const still = (i) => !moving.has(i) && !hidden.has(i) && (mode === 'object' || vertexObject[i] === own);
  const staying = new Set();
  vertices.forEach((_, i) => {
    if (still(i)) staying.add(i);
  });
  if (staying.size === 0) return null;
  const moved = (i) => moving.get(i).clone().add(free);
  const screenGap = (a, b) => {
    const p = project(a);
    const q = project(b);
    return p && q ? Math.hypot(p.x - q.x, p.y - q.y) : Infinity;
  };

  if (mode === 'edge' && key !== null) {
    const ends = key.split('_').map(Number);
    let best = null;
    let bestDistance = SNAP_RADIUS;
    for (const [a, b] of edgesOf(mesh, staying)) {
      const { distance, t } = segmentDistance(cursor, project(vertices[a]), project(vertices[b]));
      if (distance >= bestDistance || !seen(vertices[a].clone().lerp(vertices[b], t))) continue;
      best = [a, b];
      bestDistance = distance;
    }
    if (!best) return null;
    const target = best.map((i) => vertices[i]);
    return { offset: bestFit(ends.map((i) => moving.get(i)), target, free), mark: { points: [], lines: [target] } };
  }

  if (mode === 'face' && key !== null) {
    const face = mesh.faces[key];
    const touch = nearestFace(mesh, face, moved, staying, screenGap, seen, true);
    return touch && { offset: touchOffset(touch, face.map((i) => moving.get(i)), free), mark: faceMark(mesh, touch.face) };
  }

  if (mode === 'object') {
    // The moving faces that face a still face across a gap small on screen.
    let touch = null;
    mesh.faces.forEach((face) => {
      if (!face.every((i) => moving.has(i))) return;
      const near = nearestFace(mesh, face, moved, staying, screenGap, seen, false);
      if (near && (!touch || near.gap < touch.gap)) touch = { ...near, from: face };
    });
    return touch && { offset: touchOffset(touch, touch.from.map((i) => moving.get(i)), free), mark: faceMark(mesh, touch.face) };
  }

  // A vertex: onto the still vertex nearest to where it is being dragged.
  const at = project(moved(lead));
  if (!at) return null;
  let best = null;
  let bestDistance = SNAP_RADIUS;
  for (const i of staying) {
    const p = project(vertices[i]);
    if (!p) continue;
    const distance = Math.hypot(p.x - at.x, p.y - at.y);
    if (distance >= bestDistance || !seen(vertices[i])) continue;
    best = i;
    bestDistance = distance;
  }
  if (best === null) return null;
  return { offset: vertices[best].clone().sub(moving.get(lead)), mark: { points: [vertices[best].clone()], lines: [] } };
}

// The edges (of faces and on their own) whose both ends are among `vertices`.
function edgesOf(mesh, vertices) {
  const found = new Map();
  const add = (a, b) => {
    if (vertices.has(a) && vertices.has(b)) found.set(edgeKey(a, b), [a, b]);
  };
  for (const face of mesh.faces) face.forEach((a, k) => add(a, face[(k + 1) % face.length]));
  for (const [a, b] of mesh.wires) add(a, b);
  return found.values();
}

// Pixels from a point to a segment on screen, and where along the segment
// (0 to 1) its nearest point is.
function segmentDistance(point, p, q) {
  if (!p || !q) return { distance: Infinity, t: 0 };
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq ? THREE.MathUtils.clamp(((point.x - p.x) * dx + (point.y - p.y) * dy) / lengthSq, 0, 1) : 0;
  return { distance: Math.hypot(p.x + t * dx - point.x, p.y + t * dy - point.y), t };
}

// Of the offsets that put one of `from` onto one of `onto`, the one that puts
// the most of them onto points of `onto` - the closest to `free` among equals.
// (Two edges of one length and direction meet end to end; a shorter one meets
// the other at its nearer end.) Null when `best` would put fewer than `least` there.
function bestFit(from, onto, free, least = 1) {
  let best = null;
  let bestCount = 0;
  let bestDistance = Infinity;
  for (const a of from) {
    for (const b of onto) {
      const offset = b.clone().sub(a);
      const count = from.filter((p) => onto.some((q) => p.clone().add(offset).distanceTo(q) < SAME_POINT)).length;
      const distance = offset.distanceTo(free);
      if (count < bestCount || (count === bestCount && distance >= bestDistance)) continue;
      best = offset;
      bestCount = count;
      bestDistance = distance;
    }
  }
  return bestCount >= least ? best : null;
}

// The still face that the given (moving) face comes closest to: a face
// parallel to it (facing either way with `either`, else facing it) whose
// outline overlaps its own, with the gap between their planes the smallest
// on screen and under SNAP_RADIUS. As { face, normal, depth, gap, corners }:
// depth in world units, gap in pixels.
function nearestFace(mesh, face, moved, staying, screenGap, seen, either) {
  const { vertices } = mesh;
  const points = face.map(moved);
  const normal = loopNormal(points);
  if (normal.lengthSq() < 0.5) return null;
  const middle = points.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(points.length);
  let best = null;
  mesh.faces.forEach((other, index) => {
    if (!other.every((i) => staying.has(i))) return;
    const across = mesh.faceNormal(index);
    const facing = normal.dot(across);
    if (either ? Math.abs(facing) < PARALLEL : facing > -PARALLEL) return;
    const corners = other.map((i) => vertices[i]);
    if (!overlaps(points, corners, across)) return;
    const depth = across.dot(middle.clone().sub(corners[0]));
    const gap = screenGap(middle, middle.clone().addScaledVector(across, -depth));
    if (gap >= SNAP_RADIUS || (best && gap >= best.gap)) return;
    const centre = corners.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(corners.length);
    if (!seen(centre)) return;
    best = { face: index, normal: across, depth, gap, corners };
  });
  return best;
}

// The offset that lays the moving face (its corners where they started) flat
// onto the still one found by nearestFace(): corner on corner when the two
// match, otherwise wherever the pointer has it in the plane.
function touchOffset(touch, from, free) {
  const flat = free.clone().addScaledVector(touch.normal, -touch.depth);
  if (from.length !== touch.corners.length) return flat;
  const exact = bestFit(from, touch.corners, flat, from.length);
  return exact ?? flat;
}

// Whether two flat outlines overlap when seen along `normal`: their boxes in
// that plane, by a hair more than touching.
function overlaps(a, b, normal) {
  const u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(normal.x) > 0.9) u.set(0, 1, 0);
  u.cross(normal).normalize();
  const v = new THREE.Vector3().crossVectors(normal, u);
  const box = (points) => {
    const us = points.map((p) => p.dot(u));
    const vs = points.map((p) => p.dot(v));
    return { u0: Math.min(...us), u1: Math.max(...us), v0: Math.min(...vs), v1: Math.max(...vs) };
  };
  const p = box(a);
  const q = box(b);
  const hair = 1e-4;
  return p.u0 < q.u1 - hair && q.u0 < p.u1 - hair && p.v0 < q.v1 - hair && q.v0 < p.v1 - hair;
}

function loopNormal(points) {
  const normal = new THREE.Vector3();
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length];
    normal.x += (a.y - b.y) * (a.z + b.z);
    normal.y += (a.z - b.z) * (a.x + b.x);
    normal.z += (a.x - b.x) * (a.y + b.y);
  });
  return normal.normalize();
}

function faceMark(mesh, index) {
  const corners = mesh.faces[index].map((i) => mesh.vertices[i].clone());
  return { points: [], lines: corners.map((p, k) => [p, corners[(k + 1) % corners.length]]) };
}

// After a snapped drag: every dragged vertex that now stands on a still vertex
// of its own object is merged into it, see weld(). Returns the Map from old
// vertex indices to new ones (see EditableMesh.removeVertices()), or null
// when nothing landed.
export function mergeLanded(mesh, moving) {
  const { vertices, vertexObject } = mesh;
  const groups = new Map(); // still vertex -> the dragged ones on it
  for (const i of moving) {
    for (let j = 0; j < vertices.length; j++) {
      if (moving.has(j) || vertexObject[j] !== vertexObject[i]) continue;
      if (vertices[i].distanceTo(vertices[j]) >= SAME_POINT) continue;
      if (!groups.has(j)) groups.set(j, []);
      groups.get(j).push(i);
      break;
    }
  }
  return weld(mesh, groups);
}

// Every vertex of the object (its id) that stands where another of it stands
// is merged into that one, see weld(): pieces of it that touch, corner on
// corner, become one shape. The same result as mergeLanded().
export function weldTouching(mesh, object) {
  const groups = new Map(); // the first vertex in a place -> the others there
  const first = new Map();
  mesh.vertices.forEach((p, i) => {
    if (mesh.vertexObject[i] !== object) return;
    const place = `${Math.round(p.x / SAME_POINT)}|${Math.round(p.y / SAME_POINT)}|${Math.round(p.z / SAME_POINT)}`;
    if (!first.has(place)) return first.set(place, i);
    const kept = first.get(place);
    if (!groups.has(kept)) groups.set(kept, []);
    groups.get(kept).push(i);
  });
  return weld(mesh, groups);
}

// Whether objects (their ids) touch: a vertex of one stands where a vertex
// of another does - what weldTouching() would weld, once they are one.
export function touching(mesh, objects) {
  const ids = new Set(objects);
  const owner = new Map();
  return mesh.vertices.some((p, i) => {
    const id = mesh.vertexObject[i];
    if (!ids.has(id)) return false;
    const place = `${Math.round(p.x / SAME_POINT)}|${Math.round(p.y / SAME_POINT)}|${Math.round(p.z / SAME_POINT)}`;
    if (!owner.has(place)) owner.set(place, id);
    return owner.get(place) !== id;
  });
}

// Merges each group's vertices (a Map: the kept vertex -> the others) into
// one. Two faces that end up on the same corners facing each other are
// inside the shape now and both go; facing the same way, they are one face
// twice and one goes. Returns the Map from old vertex indices to new ones,
// or null when there was nothing to merge.
function weld(mesh, groups) {
  if (groups.size === 0) return null;
  const into = new Map();
  for (const [kept, others] of groups) for (const i of others) into.set(i, kept);
  const resolve = (i) => into.get(i) ?? i;

  // Faces on the same corners, as they will be.
  const byCorners = new Map();
  mesh.faces.forEach((face, index) => {
    const loop = face.map(resolve);
    if (new Set(loop).size !== loop.length) return;
    const corners = [...loop].sort((a, b) => a - b).join(',');
    if (!byCorners.has(corners)) byCorners.set(corners, []);
    byCorners.get(corners).push({ index, loop });
  });
  const gone = new Set();
  for (const same of byCorners.values()) {
    if (same.length !== 2 || !opposite(same[0].loop, same[1].loop)) continue;
    gone.add(same[0].index);
    gone.add(same[1].index);
  }
  const corners = new Set();
  for (const index of gone) mesh.faces[index].forEach((i) => corners.add(resolve(i)));
  mesh.faces = mesh.faces.filter((_, index) => !gone.has(index));
  const used = new Set();
  for (const face of mesh.faces) face.forEach((i) => used.add(resolve(i)));
  for (const [a, b] of mesh.wires) [a, b].forEach((i) => used.add(resolve(i)));
  const remap = mesh.mergeVertices([...groups].map(([kept, others]) => [kept, ...others]));
  // Corners of the faces that went, held by nothing now, go too.
  const loose = new Set([...corners].filter((i) => !used.has(i)).map((i) => remap.get(i)));
  if (loose.size === 0) return remap;
  const after = mesh.removeVertices(loose);
  return new Map([...remap].filter(([, now]) => after.has(now)).map(([old, now]) => [old, after.get(now)]));
}

// Whether two loops on the same corners run round them in opposite directions.
function opposite(a, b) {
  const start = b.indexOf(a[0]);
  return a.every((vertex, k) => b[(start - k + b.length) % b.length] === vertex);
}
