import * as THREE from 'three';
import { atlasMap, cloneFace, edgeKey } from './mesh.js';

// Bevelled (chamfered) edges, as Blender's Bevel of one segment: an edge is
// taken off by a strip, a vertex where strips meet by a face of its own.
//
// Round a vertex, the corners of faces between one bevelled edge and the next
// are a sector. Each face goes in from its bevelled edges by the width: a
// sector's corner goes in from both of the edges it is between at once (a
// mitre) - or, where the faces in it are not in one plane, along an edge
// between them, so that those faces stay together. Where a bevelled edge
// ends, its two sides go along the next edges round the vertex, and what else
// is there meets them.
//
// All that is linear in the width, so the widest there can be - where the
// first edge has come to nothing - is known beforehand (`limit`).

const FLAT = Math.cos((1 * Math.PI) / 180); // faces this near one plane are in one
const STEEP = 0.1; // the sine of the sharpest angle an edge is slid along at

// The edges (keys) of `faces` (indices) that can be bevelled - between two
// faces, that bend there by `angle` degrees at least; `outline`: only those
// that have one of the faces on one side, and another on the other.
export function bevelEdges(mesh, faces, { angle = 0, outline = false } = {}) {
  const chosen = new Set(faces);
  const bend = Math.cos((angle * Math.PI) / 180) + 1e-9;
  const out = new Set();
  for (const [key, uses] of edgeUses(mesh)) {
    if (!sound(uses)) continue;
    const [p, q] = uses.map(({ face }) => face);
    const inside = Number(chosen.has(p)) + Number(chosen.has(q));
    if (inside === 0 || (outline && inside === 2)) continue;
    if (angle > 0 && mesh.faceNormal(p).dot(mesh.faceNormal(q)) > bend) continue;
    out.add(key);
  }
  return out;
}

// edge key -> [{ face, k }]: the faces that have it, and the corner it starts at in each.
function edgeUses(mesh) {
  const uses = new Map();
  mesh.faces.forEach((loop, face) => loop.forEach((a, k) => {
    const key = edgeKey(a, loop[(k + 1) % loop.length]);
    if (!uses.has(key)) uses.set(key, []);
    uses.get(key).push({ face, k, a });
  }));
  return uses;
}

// Between two faces that look out on the same side.
const sound = (uses) => uses.length === 2 && uses[0].face !== uses[1].face && uses[0].a !== uses[1].a;

// What bevelling the edges (a Set of keys) makes of the mesh, for any width
// (see bevelTo()); null if none of them can be. A point of it is a vertex
// there is (its index) or a new one (~ its place in `points`).
//   points  [{ vertex, way }]: new vertices, each at its vertex's place and
//           `way` times the width from there
//   changed Map(face -> its new loop)
//   made    [{ loop, beside }]: new faces, each beside the face `beside`
//   gone    the vertices that are no face's any more
//   limit   the widest
export function planBevel(mesh, edges) {
  const { faces, vertices } = mesh;
  const uses = edgeUses(mesh);
  const bevelled = new Set([...edges].filter((key) => uses.has(key) && sound(uses.get(key))));
  if (bevelled.size === 0) return null;
  const points = [];
  const point = (vertex, way) => ~(points.push({ vertex, way }) - 1);
  const next = (face, k) => faces[face][(k + 1) % faces[face].length];
  const prev = (face, k) => faces[face][(k - 1 + faces[face].length) % faces[face].length];
  const outKey = ({ face, k }) => edgeKey(faces[face][k], next(face, k));
  const inKey = ({ face, k }) => edgeKey(prev(face, k), faces[face][k]);
  const normals = new Map();
  const normal = (face) => {
    if (!normals.has(face)) normals.set(face, mesh.faceNormal(face));
    return normals.get(face);
  };
  const toward = (from, to) => vertices[to].clone().sub(vertices[from]).normalize();
  // Into the face from the edge out of a corner, or into it.
  const inOut = ({ face, k }) => normal(face).clone().cross(toward(faces[face][k], next(face, k))).normalize();
  const inIn = ({ face, k }) => normal(face).clone().cross(toward(prev(face, k), faces[face][k])).normalize();
  const mitre = (a, b) => a.clone().add(b).divideScalar(Math.max(STEEP, 1 + a.dot(b)));
  const slide = (along, ...inward) => along.clone().multiplyScalar(inward.reduce((sum, n) => sum + 1 / Math.max(STEEP, Math.abs(along.dot(n))), 0) / inward.length);
  const id = ({ face, k }) => `${face}_${k}`;
  const starts = new Map(); // corner -> the point its bevelled edge out of it starts from
  const ends = new Map(); // corner -> the point its bevelled edge into it ends at
  const corners = new Map(); // corner -> the points in its place
  const made = [];

  // The corners at each vertex that has a bevelled edge.
  const at = new Map();
  for (const key of bevelled) for (const vertex of key.split('_').map(Number)) at.set(vertex, []);
  faces.forEach((loop, face) => loop.forEach((vertex, k) => at.get(vertex)?.push({ face, k })));
  for (const [vertex, list] of at) {
    const byOut = new Map(list.map((corner) => [outKey(corner), corner]));
    const byIn = new Map(list.map((corner) => [inKey(corner), corner]));
    // Counter-clockwise round the vertex: over the edge into a corner to the one it goes out of.
    const after = (corner) => (sound(uses.get(inKey(corner))) ? byOut.get(inKey(corner)) : undefined);
    const before = (corner) => (sound(uses.get(outKey(corner))) ? byIn.get(outKey(corner)) : undefined);
    const done = new Set();
    for (const first of list) {
      if (done.has(id(first))) continue;
      // One fan of corners: from its open end - or, closed, from a bevelled edge.
      let start = first;
      for (let back = before(start); back && back !== first; back = before(start)) start = back;
      const open = !before(start);
      if (!open) {
        start = first;
        for (let i = 0; i < list.length && !bevelled.has(outKey(start)); i++) start = after(start);
      }
      const fan = [];
      for (let corner = start; corner && !done.has(id(corner)); corner = after(corner)) {
        done.add(id(corner));
        fan.push(corner);
      }
      if (!fan.some((corner) => bevelled.has(inKey(corner)) || bevelled.has(outKey(corner)))) continue;
      const sectors = [[]];
      fan.forEach((corner, i) => {
        sectors.at(-1).push(corner);
        if (bevelled.has(inKey(corner)) && i < fan.length - 1) sectors.push([]);
      });
      const cap = [];
      sectors.forEach((sector, number) => {
        const a = sector[0];
        const b = sector.at(-1);
        const from = bevelled.has(outKey(a)); // a bevelled edge where it begins, and where it ends
        const to = bevelled.has(inKey(b));
        const last = sector.length - 1;
        const set = (corner, ...list_) => corners.set(id(corner), list_);
        const alongIn = (corner) => toward(vertex, prev(corner.face, corner.k));
        const alongOut = (corner) => toward(vertex, next(corner.face, corner.k));
        const one = (way) => {
          const p = point(vertex, way);
          for (const corner of sector) set(corner, p);
          if (from) starts.set(id(a), p);
          if (to) ends.set(id(b), p);
          cap.push(p);
        };
        if (from && to && sectors.length > 1) {
          const flat = sector.every(({ face }) => normal(face).dot(normal(a.face)) > FLAT);
          if (flat) return one(mitre(inOut(a), inIn(b)));
          // Along an edge inside it: the one nearest the middle.
          const middle = inOut(a).add(inIn(b));
          const inner = sector.slice(0, -1).map(alongIn);
          return one(slide(inner.reduce((best, way) => (way.dot(middle) > best.dot(middle) ? way : best)), inOut(a), inIn(b)));
        }
        if (from && to) {
          // All round the end of the one bevelled edge.
          if (last === 1) return one(slide(alongIn(a), inOut(a), inIn(b)));
          const p = point(vertex, slide(alongIn(a), inOut(a)));
          const q = point(vertex, slide(alongOut(b), inIn(b)));
          set(a, p);
          set(b, q);
          starts.set(id(a), p);
          ends.set(id(b), q);
          if (last === 2) {
            set(sector[1], q, p);
            cap.push(p, q);
            return undefined;
          }
          set(sector[1], vertex, p);
          set(sector[last - 1], q, vertex);
          cap.push(p, vertex, q);
          return undefined;
        }
        if (from) {
          // To the mesh's border.
          const p = point(vertex, slide(alongIn(a), inOut(a)));
          set(a, p);
          starts.set(id(a), p);
          cap.push(p);
          if (last > 0) {
            set(sector[1], vertex, p);
            cap.push(vertex);
          }
          return undefined;
        }
        // From the border.
        const q = point(vertex, slide(alongOut(b), inIn(b)));
        set(b, q);
        ends.set(id(b), q);
        if (last > 0) {
          set(sector[last - 1], q, vertex);
          cap.push(vertex);
        }
        cap.push(q);
        return number;
      });
      const loop = cap.filter((p, i) => cap.indexOf(p) === i);
      if (loop.length > 2) made.push({ loop, beside: fan[0].face });
    }
  }
  // The faces whose corners are elsewhere now, and the strips.
  const changed = new Map();
  faces.forEach((loop, face) => {
    if (!loop.some((vertex, k) => corners.has(`${face}_${k}`))) return;
    changed.set(face, loop.flatMap((vertex, k) => corners.get(`${face}_${k}`) ?? [vertex]));
  });
  for (const key of bevelled) {
    const [l, r] = uses.get(key);
    const far = ({ face, k }) => `${face}_${(k + 1) % faces[face].length}`;
    const loop = [ends.get(far(l)), starts.get(id(l)), ends.get(far(r)), starts.get(id(r))];
    const clean = loop.filter((p, i) => p !== loop[(i + 1) % loop.length]);
    if (clean.length > 2) made.push({ loop: clean, beside: l.face });
  }
  const left = new Set(mesh.wires.flat());
  faces.forEach((loop, face) => (changed.get(face) ?? loop).forEach((p) => left.add(p)));
  for (const { loop } of made) for (const p of loop) left.add(p);
  const gone = new Set([...at.keys()].filter((vertex) => !left.has(vertex)));
  // How wide: until the first edge of a face has come to nothing.
  let limit = Infinity;
  const base = (p) => (p < 0 ? points[~p].vertex : p);
  const wayOf = (p) => (p < 0 ? points[~p].way : new THREE.Vector3());
  for (const loop of changed.values()) {
    loop.forEach((p, i) => {
      const q = loop[(i + 1) % loop.length];
      if (base(p) === base(q)) return;
      const side = vertices[base(q)].clone().sub(vertices[base(p)]);
      const closing = side.dot(wayOf(q).clone().sub(wayOf(p)));
      if (closing < -1e-12) limit = Math.min(limit, -side.lengthSq() / closing);
    });
  }
  return { points, changed, made, gone, limit };
}

// Bevels `mesh` - as it is in `base`, { vertices, vertexObject, faces, wires,
// weights, folds }, which is left as it was - by a plan of that (see
// planBevel()), `width` wide. `preview`: the new faces have the colour of
// those beside them, nothing laid out yet. Returns { first, remap }: the index
// of the first new vertex, and what the vertices (those there were and the
// new) are now - null in a preview.
export function bevelTo(mesh, base, plan, width, { preview = false } = {}) {
  const wide = Math.min(width, plan.limit);
  mesh.vertices = base.vertices.map((vertex) => vertex.clone());
  mesh.vertexObject = [...base.vertexObject];
  mesh.wires = base.wires.map((wire) => [...wire]);
  mesh.folds = new Map(base.folds);
  mesh.weights = new Map([...base.weights].map(([i, weights]) => [i, weights.map((pair) => [...pair])]));
  mesh.faces = base.faces.map(cloneFace);
  const count = base.vertices.length;
  for (const { vertex, way } of plan.points) {
    const place = base.vertices[vertex].clone().addScaledVector(way, wide);
    mesh.copyWeights(vertex, mesh.addVertex(place.x, place.y, place.z, base.vertexObject[vertex]));
  }
  const index = (p) => (p < 0 ? count + ~p : p);
  for (const [face, loop] of plan.changed) {
    const old = base.faces[face];
    const now = loop.map(index);
    if (old.uv?.every(Boolean)) {
      // (the normal as it was: the old corners are still where they were)
      const normal = normalOf(base.vertices, old);
      const map = atlasMap({ vertices: base.vertices }, old, old.uv, normal);
      now.uv = now.map((vertex) => map(mesh.vertices[vertex]));
    }
    if (old.pin) now.pin = true;
    if (old.shaped) now.shaped = true;
    mesh.faces[face] = now;
  }
  for (const { loop, beside } of plan.made) {
    const now = loop.map(index);
    const uv = base.faces[beside].uv;
    if (preview && uv?.every(Boolean)) {
      const middle = [0, 1].map((axis) => uv.reduce((sum, place) => sum + place[axis], 0) / uv.length);
      now.uv = now.map(() => [...middle]);
    }
    mesh.faces.push(now);
  }
  let remap = null;
  if (!preview) {
    // At its widest, corners have met: those are one vertex.
    if (plan.limit - wide < 1e-9) {
      const groups = new Map();
      plan.points.forEach((_, i) => {
        const vertex = count + i;
        const { x, y, z } = mesh.vertices[vertex];
        const key = [mesh.vertexObject[vertex], ...[x, y, z].map((c) => Math.round(c * 1e5))].join();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(vertex);
      });
      const met = [...groups.values()].filter((group) => group.length > 1);
      if (met.length) remap = mesh.mergeVertices(met);
    }
    const gone = new Set([...plan.gone].map((vertex) => (remap ? remap.get(vertex) : vertex)).filter((vertex) => vertex !== undefined));
    const then = mesh.removeVertices(gone);
    remap = remap ? new Map([...remap].filter(([, to]) => then.has(to)).map(([from, to]) => [from, then.get(to)])) : then;
  }
  return { first: count, remap };
}

function normalOf(vertices, loop) {
  const sum = new THREE.Vector3();
  loop.forEach((vertex, k) => sum.add(new THREE.Vector3().crossVectors(vertices[vertex], vertices[loop[(k + 1) % loop.length]])));
  return sum.normalize();
}
