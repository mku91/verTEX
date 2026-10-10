import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { markerColor } from './marker-colors.js';
import { theme } from './theme.js';

const PLANE_EPSILON = 1e-6; // a vertex this close to a cutting plane lies on it
const MAX_LOOP = 8; // the pencil fills loops of up to this many vertices

// Identifies an undirected edge by its two vertex indices.
export const edgeKey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);

const AXIS_VECTORS = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

// Splitting a simple polygon, convex or not, with a line: the points of its
// outline that lie on the line are put in order along it, and two neighbours
// are joined when the stretch between them runs inside the polygon and is not
// one of its edges already.
//   outline: the polygon's corners (Vector3[]), those on the line included
//   on:      flags of the corners that lie on the line
//   axis:    the line is where the plane perpendicular to this axis meets the polygon
// Returns the chords as pairs of indices into `outline`.
function cutChords(outline, on, axis) {
  const count = outline.length;
  // Newell's method: the normal even if the polygon is not perfectly flat.
  const normal = new THREE.Vector3();
  outline.forEach((a, i) => {
    const b = outline[(i + 1) % count];
    normal.x += (a.y - b.y) * (a.z + b.z);
    normal.y += (a.z - b.z) * (a.x + b.x);
    normal.z += (a.x - b.x) * (a.y + b.y);
  });
  const along = new THREE.Vector3().crossVectors(normal, AXIS_VECTORS[axis]);
  if (along.lengthSq() < 1e-12) return []; // the polygon lies in the plane: no line

  // The polygon flattened: without the axis its normal is most along.
  const dropped = ['x', 'y', 'z'].reduce((best, candidate) =>
    Math.abs(normal[candidate]) > Math.abs(normal[best]) ? candidate : best);
  const [u, v] = ['x', 'y', 'z'].filter((candidate) => candidate !== dropped);
  const inside = (point) => {
    let odd = false;
    outline.forEach((a, i) => {
      const b = outline[(i + 1) % count];
      if (a[v] > point[v] === b[v] > point[v]) return;
      if (point[u] < ((b[u] - a[u]) * (point[v] - a[v])) / (b[v] - a[v]) + a[u]) odd = !odd;
    });
    return odd;
  };

  const marks = outline.flatMap((_, i) => (on[i] ? [i] : []));
  marks.sort((i, j) => outline[i].dot(along) - outline[j].dot(along));
  const chords = [];
  const middle = new THREE.Vector3();
  for (let k = 0; k + 1 < marks.length; k++) {
    const i = marks[k];
    const j = marks[k + 1];
    const neighbours = (i + 1) % count === j || (j + 1) % count === i;
    if (neighbours || outline[i].distanceToSquared(outline[j]) < 1e-12) continue;
    if (inside(middle.lerpVectors(outline[i], outline[j], 0.5))) chords.push([i, j]);
  }
  return chords;
}

// Editing model: shared vertices, polygonal faces (loops of vertex indices)
// and wires: loose edges between two vertices that belong to no face.
// Every vertex belongs to one of the named objects; a face or a wire belongs
// to the object of its vertices. Objects can be put into groups: entries of the
// same list that have no vertices, only a name and what is inside them.
// This is the source of truth; three.js geometry is derived from it in MeshView.
export class EditableMesh {
  constructor() {
    this.vertices = []; // THREE.Vector3[]
    this.faces = []; // number[][], counter-clockwise when seen from outside
    this.wires = []; // [a, b][], edges drawn on their own
    // { id, name, parent, kind, hidden }[]; `parent` is a group's id or null,
    // `kind` 'mesh' | 'group', `hidden` set on what is switched off in the scene tree,
    // `rotation` how the entry has been turned as a whole, see frames.js;
    // `pivot` an [x, y, z] the entry turns and scales about - absent until one
    // is set, and then the middle of the entry's bounds stands in for it. The
    // array is never changed in place, only replaced.
    this.objects = [];
    this.vertexObject = []; // the object id of every vertex
    this.nextObjectId = 1;
    // Which side of the centre a vertex stood on before it was scaled flat
    // (vertex index -> { x?: 1 | -1, ... }): what lets it be scaled back out.
    this.folds = new Map();
  }

  // Adds a vertex to the object with the given id.
  addVertex(x, y, z, object) {
    this.vertices.push(new THREE.Vector3(x, y, z));
    this.vertexObject.push(object);
    return this.vertices.length - 1;
  }

  // Creates an empty object (or, with kind 'group', a group) and returns its
  // id. A name that is taken gets a numbered suffix: "Cube", "Cube.001", ...
  addObject(name, kind = 'mesh') {
    const id = this.nextObjectId++;
    this.objects.push({ id, name: this.freeName(name), parent: null, kind });
    return id;
  }

  // `name`, or its first numbered variant that no other object has.
  freeName(name, except = null) {
    const taken = new Set(this.objects.filter((object) => object !== except).map((object) => object.name));
    if (!taken.has(name)) return name;
    const base = name.replace(/\.\d{3}$/, '');
    for (let n = 1; ; n++) {
      const candidate = `${base}.${String(n).padStart(3, '0')}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  // Makes every vertex of object `gone` part of object `kept`.
  mergeObjects(kept, gone) {
    this.vertexObject = this.vertexObject.map((id) => (id === gone ? kept : id));
    this.dropObjects(new Set([gone]), kept);
  }

  // Takes objects off the list. Their children move up to `heir`, or, without
  // one, to the nearest ancestor that stays.
  dropObjects(gone, heir = null) {
    const byId = new Map(this.objects.map((object) => [object.id, object]));
    const survivor = (id) => {
      while (id !== null && gone.has(id)) id = byId.get(id)?.parent ?? null;
      return id;
    };
    for (const object of this.objects) {
      if (gone.has(object.id) || !gone.has(object.parent)) continue;
      object.parent = heir !== null && heir !== object.id ? heir : survivor(object.parent);
    }
    // The heir itself must not end up under what it absorbed.
    const heirObject = byId.get(heir);
    if (heirObject && gone.has(heirObject.parent)) heirObject.parent = survivor(heirObject.parent);
    this.objects = this.objects.filter((object) => !gone.has(object.id));
  }

  // Whether `child` may be put into `parent` (object ids; null is the top
  // level): only a group holds anything, and nothing goes under itself.
  canParent(child, parent) {
    const byId = new Map(this.objects.map((object) => [object.id, object]));
    if (parent !== null && byId.get(parent)?.kind !== 'group') return false;
    for (let id = parent; id !== null && id !== undefined; id = byId.get(id)?.parent ?? null) {
      if (id === child) return false;
    }
    return true;
  }

  addFace(indices) {
    this.faces.push(indices);
  }

  // Adds a flat polygon through the given points, in order, as an object of
  // its own (new vertices, shared with nothing). It is turned towards the
  // viewer, who looks in the direction `facing`. Returns the new vertices.
  addPolygon(points, facing) {
    const object = this.addObject('Polygon');
    const loop = points.map((point) => this.addVertex(point.x, point.y, point.z, object));
    const indices = [...loop];
    if (this.loopNormal(loop).dot(facing) > 0) loop.reverse();
    this.faces.push(loop);
    return indices;
  }

  // Splits a face into triangles, as [a, b, c] vertex index triples wound the
  // same way as the face. Ear clipping, so faces that are not convex come out
  // right; a fan from the first vertex is the fallback for degenerate ones.
  triangulate(faceIndex) {
    const face = this.faces[faceIndex];
    if (face.length === 3) return [face];
    const fan = () => face.slice(1, -1).map((vertex, i) => [face[0], vertex, face[i + 2]]);

    const normal = this.faceNormal(faceIndex);
    if (normal.lengthSq() < 0.5) return fan();
    // Flatten the face onto its own plane.
    const u = new THREE.Vector3(1, 0, 0);
    if (Math.abs(normal.x) > 0.9) u.set(0, 1, 0);
    u.cross(normal).normalize();
    const v = new THREE.Vector3().crossVectors(normal, u);
    const contour = face.map((i) => new THREE.Vector2(this.vertices[i].dot(u), this.vertices[i].dot(v)));

    const triangles = THREE.ShapeUtils.triangulateShape(contour, []);
    if (triangles.length !== face.length - 2) return fan();
    return triangles.map(([a, b, c]) => {
      // Keep the face's winding: counter-clockwise in the (u, v) plane.
      const area = (contour[b].x - contour[a].x) * (contour[c].y - contour[a].y) -
        (contour[c].x - contour[a].x) * (contour[b].y - contour[a].y);
      return area >= 0 ? [face[a], face[b], face[c]] : [face[a], face[c], face[b]];
    });
  }

  // A cone standing on the grid, as a new object: a base of `sides` vertices,
  // `size` wide, and an apex `size` above its middle. Returns the new vertices.
  addCone(sides = 8, size = 1) {
    const object = this.addObject('Cone');
    const radius = size / 2;
    const base = [];
    for (let i = 0; i < sides; i++) {
      const angle = (i / sides) * Math.PI * 2;
      base.push(this.addVertex(radius * Math.cos(angle), 0, radius * Math.sin(angle), object));
    }
    const apex = this.addVertex(0, size, 0, object);
    this.addFace([...base]); // in this order it looks down
    base.forEach((vertex, i) => this.addFace([base[(i + 1) % sides], vertex, apex]));
    return [...base, apex];
  }

  // A cylinder standing on the grid, as a new object: two rings of `sides`
  // vertices, `size` wide and `height` apart. Returns the new vertices.
  addCylinder(sides = 8, size = 1, height = 1) {
    const object = this.addObject('Cylinder');
    const radius = size / 2;
    const bottom = [];
    const top = [];
    for (let i = 0; i < sides; i++) {
      const angle = (i / sides) * Math.PI * 2;
      const x = radius * Math.cos(angle);
      const z = radius * Math.sin(angle);
      bottom.push(this.addVertex(x, 0, z, object));
      top.push(this.addVertex(x, height, z, object));
    }
    this.addFace([...bottom]); // in this order it looks down
    this.addFace([...top].reverse()); // and this one up
    for (let i = 0; i < sides; i++) {
      const next = (i + 1) % sides;
      this.addFace([bottom[next], bottom[i], top[i], top[next]]);
    }
    return [...bottom, ...top];
  }

  // A sphere standing on the grid, as a new object: `segments` vertices around
  // and half as many rings from pole to pole, `size` across. Quads along the
  // rings, triangles at the poles. Returns the new vertices.
  addSphere(segments = 8, size = 1) {
    const object = this.addObject('Sphere');
    const radius = size / 2;
    const rings = Math.max(2, Math.round(segments / 2));
    const top = this.addVertex(0, size, 0, object);
    const circles = []; // from the top one down
    for (let j = 1; j < rings; j++) {
      const polar = (j / rings) * Math.PI;
      const circle = [];
      for (let i = 0; i < segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        circle.push(this.addVertex(
          radius * Math.sin(polar) * Math.cos(angle),
          radius + radius * Math.cos(polar),
          radius * Math.sin(polar) * Math.sin(angle),
          object,
        ));
      }
      circles.push(circle);
    }
    const bottom = this.addVertex(0, 0, 0, object);

    const next = (i) => (i + 1) % segments;
    const first = circles[0];
    const last = circles[circles.length - 1];
    for (let i = 0; i < segments; i++) {
      this.addFace([top, first[next(i)], first[i]]);
      for (let j = 0; j < circles.length - 1; j++) {
        const upper = circles[j];
        const lower = circles[j + 1];
        this.addFace([upper[i], upper[next(i)], lower[next(i)], lower[i]]);
      }
      this.addFace([bottom, last[i], last[next(i)]]);
    }
    return [top, ...circles.flat(), bottom];
  }

  // Unit cube standing on the grid, as a new object. Returns indices of the new vertices.
  addCube(size = 1) {
    const object = this.addObject('Cube');
    const h = size / 2;
    const base = this.vertices.length;
    const corners = [
      [-h, 0, -h], [h, 0, -h], [h, 0, h], [-h, 0, h],
      [-h, size, -h], [h, size, -h], [h, size, h], [-h, size, h],
    ];
    for (const [x, y, z] of corners) this.addVertex(x, y, z, object);
    const quads = [
      [4, 7, 6, 5], // +Y
      [0, 1, 2, 3], // -Y
      [3, 2, 6, 7], // +Z
      [1, 0, 4, 5], // -Z
      [2, 1, 5, 6], // +X
      [0, 3, 7, 4], // -X
    ];
    for (const quad of quads) this.addFace(quad.map((i) => base + i));
    return corners.map((_, i) => base + i);
  }

  // Size of the model's own data in bytes, as it would be stored compactly:
  // three 32-bit floats per vertex and a 32-bit index per face corner and per
  // wire end. The editor's working copies in memory are several times larger.
  // With `islands` (entries of islands()) only those objects are counted.
  byteSize(islands = null) {
    if (!islands) {
      const corners = this.faces.reduce((sum, face) => sum + face.length, 0);
      return this.vertices.length * 12 + corners * 4 + this.wires.length * 8;
    }
    let bytes = 0;
    const counted = new Set();
    for (const island of islands) {
      bytes += island.vertices.length * 12;
      for (const face of island.faces) bytes += this.faces[face].length * 4;
      for (const vertex of island.vertices) counted.add(vertex);
    }
    // A wire lies wholly inside one object.
    return bytes + this.wires.filter(([a]) => counted.has(a)).length * 8;
  }

  // Unique undirected edges as [a, b] pairs with a < b: the sides of the
  // faces, then the wires.
  edges() {
    const seen = new Set();
    const result = [];
    const add = (a, b) => {
      const key = edgeKey(a, b);
      if (seen.has(key)) return;
      seen.add(key);
      result.push(a < b ? [a, b] : [b, a]);
    };
    for (const face of this.faces) {
      face.forEach((a, i) => add(a, face[(i + 1) % face.length]));
    }
    for (const [a, b] of this.wires) add(a, b);
    return result;
  }

  // --- drawing vertex by vertex (pencil) ---------------------------------

  // Grows a new vertex out of `parent`: a full copy of it (so whatever a
  // vertex carries is inherited), joined to it by a wire. Returns its index.
  sprout(parent) {
    this.vertices.push(this.vertices[parent].clone());
    this.vertexObject.push(this.vertexObject[parent]);
    const child = this.vertices.length - 1;
    this.wires.push([parent, child]);
    return child;
  }

  // Joins two vertices with a wire, unless an edge already runs between them.
  // Vertices of two objects make those one object, the first vertex's: an edge
  // can't belong to two.
  connect(a, b) {
    if (a === b) return;
    const key = edgeKey(a, b);
    if (!this.edges().some(([c, d]) => edgeKey(c, d) === key)) this.wires.push([a, b]);
    if (this.vertexObject[a] !== this.vertexObject[b]) this.mergeObjects(this.vertexObject[a], this.vertexObject[b]);
  }

  // If the edge a-b closes a loop, fills the loop with a face and returns
  // true. Candidates are the flat loops through a-b along existing edges, up
  // to MAX_LOOP vertices, except those that lie inside one existing face
  // (joining two corners of a face must not lay a second face over it). Of
  // several candidates the one turned most towards the viewer wins, and then
  // the shortest; `facing` is the direction the viewer looks in. The new face
  // is turned towards the viewer.
  closeLoop(a, b, facing) {
    const neighbours = new Map();
    for (const [c, d] of this.edges()) {
      if (edgeKey(c, d) === edgeKey(a, b)) continue;
      for (const [from, to] of [[c, d], [d, c]]) {
        if (!neighbours.has(from)) neighbours.set(from, []);
        neighbours.get(from).push(to);
      }
    }
    const faceSets = this.faces.map((face) => new Set(face));

    let best = null;
    const consider = (loop) => {
      if (faceSets.some((face) => loop.every((vertex) => face.has(vertex)))) return;
      const normal = this.loopNormal(loop);
      if (normal.lengthSq() < 0.5) return; // all on one line
      const score = Math.abs(normal.dot(facing));
      const better =
        !best || score > best.score + 1e-6 || (score > best.score - 1e-6 && loop.length < best.loop.length);
      if (better) best = { loop, score, normal };
    };

    // Depth-first from b back to a; a path that has left its plane is dropped at once.
    const path = [b];
    const walk = () => {
      for (const next of neighbours.get(path[path.length - 1]) ?? []) {
        if (next === a) {
          if (path.length >= 2) consider([...path, a]);
          continue;
        }
        if (path.includes(next) || path.length + 1 >= MAX_LOOP) continue;
        path.push(next);
        if (this.isCoplanar([a, ...path])) walk();
        path.pop();
      }
    };
    walk();
    if (!best) return false;

    const { loop, normal } = best;
    if (normal.dot(facing) > 0) loop.reverse();
    this.faces.push(loop);
    // The wires along the loop are sides of the face now.
    const sides = new Set(loop.map((vertex, i) => edgeKey(vertex, loop[(i + 1) % loop.length])));
    this.wires = this.wires.filter(([c, d]) => !sides.has(edgeKey(c, d)));
    return true;
  }

  // --- merging vertices -------------------------------------------------------

  // Makes one vertex of each group of vertices (index lists; the first of a
  // group is the one that stays). Faces and wires go over to it; a face left
  // with fewer than three corners, or pinched, or the double of another, is
  // dropped, and so is a wire that has become a point or an edge that is
  // there already. Returns the old -> new vertex index map of what remains.
  mergeVertices(groups) {
    const into = new Map();
    for (const [kept, ...others] of groups) {
      for (const index of others) into.set(index, kept);
      this.folds.delete(kept); // one vertex has no sides to unfold to
    }
    if (into.size === 0) return new Map(this.vertices.map((_, i) => [i, i]));
    const resolve = (index) => into.get(index) ?? index;

    const seenFaces = new Set();
    this.faces = this.faces
      .map((face) => {
        const loop = face.map(resolve);
        const stays = loop.map((vertex, k) => vertex !== loop[(k + 1) % loop.length]);
        const merged = loop.filter((_, k) => stays[k]);
        if (face.uv) merged.uv = face.uv.filter((_, k) => stays[k]);
        if (face.pin) merged.pin = true;
        return merged;
      })
      .filter((face) => {
        if (face.length < 3 || new Set(face).size !== face.length) return false;
        const key = [...face].sort((a, b) => a - b).join(',');
        if (seenFaces.has(key)) return false;
        seenFaces.add(key);
        return true;
      });
    const edges = new Set();
    for (const face of this.faces) {
      face.forEach((a, k) => edges.add(edgeKey(a, face[(k + 1) % face.length])));
    }
    this.wires = this.wires
      .map((wire) => wire.map(resolve))
      .filter(([a, b]) => {
        if (a === b || edges.has(edgeKey(a, b))) return false;
        edges.add(edgeKey(a, b));
        return true;
      });
    return this.removeVertices(new Set(into.keys()));
  }

  // --- making a face out of chosen vertices ---------------------------------

  // Joins the given vertices: two with an edge, three or more with one face
  // through all of them. Returns false when there is nothing to make (the
  // edge or the face is there already, or the vertices are on one line).
  // The face is turned the way the faces it borders are, or, where it borders
  // none, towards the viewer; `facing` is the direction the viewer looks in.
  // Vertices of several objects become one object, the first vertex's.
  fill(vertices, facing) {
    const chosen = [...new Set(vertices)];
    if (chosen.length < 2) return false;
    if (chosen.length === 2) {
      const [a, b] = chosen;
      if (this.edges().some(([c, d]) => edgeKey(c, d) === edgeKey(a, b))) return false;
      this.connect(a, b);
      return true;
    }
    const loop = this.fillOrder(chosen);
    if (!loop) return false;
    const normal = this.loopNormal(loop);
    if (normal.lengthSq() < 0.5) return false; // all on one line
    const members = new Set(loop);
    if (this.faces.some((face) => face.length === loop.length && face.every((vertex) => members.has(vertex)))) {
      return false;
    }

    // Two faces that are turned the same way run along their common edge in
    // opposite directions.
    const directed = new Set();
    for (const face of this.faces) {
      face.forEach((a, i) => directed.add(`${a}>${face[(i + 1) % face.length]}`));
    }
    let along = 0;
    let against = 0;
    loop.forEach((a, i) => {
      const b = loop[(i + 1) % loop.length];
      if (directed.has(`${a}>${b}`)) along++;
      if (directed.has(`${b}>${a}`)) against++;
    });
    if (along > against || (along === against && normal.dot(facing) > 0)) loop.reverse();

    const object = this.vertexObject[loop[0]];
    for (const vertex of loop) {
      if (this.vertexObject[vertex] !== object) this.mergeObjects(object, this.vertexObject[vertex]);
    }
    this.faces.push(loop);
    // The wires along the loop are sides of the face now.
    const sides = new Set(loop.map((vertex, i) => edgeKey(vertex, loop[(i + 1) % loop.length])));
    this.wires = this.wires.filter(([c, d]) => !sides.has(edgeKey(c, d)));
    return true;
  }

  // The order in which a face goes through the given vertices, or null if
  // they are all on one line. Vertices already joined by edges are walked
  // along those edges, so an outline that is drawn keeps its shape, concave
  // or not; separate chains are put together end to nearest end. Vertices
  // with no edges between them, or with a tangle of them, are taken by angle
  // around their middle.
  fillOrder(chosen) {
    const inside = new Set(chosen);
    const links = new Map(chosen.map((vertex) => [vertex, []]));
    for (const [a, b] of this.edges()) {
      if (!inside.has(a) || !inside.has(b)) continue;
      links.get(a).push(b);
      links.get(b).push(a);
    }
    const tangled = chosen.some((vertex) => links.get(vertex).length > 2);
    const linked = chosen.some((vertex) => links.get(vertex).length > 0);
    if (tangled || !linked) return this.angularOrder(chosen);

    const left = new Set(chosen);
    const walk = (start) => {
      const chain = [start];
      left.delete(start);
      for (let current = start; ; ) {
        const next = links.get(current).find((vertex) => left.has(vertex));
        if (next === undefined) return chain;
        chain.push(next);
        left.delete(next);
        current = next;
      }
    };
    const chains = [];
    // Open chains from their ends first; what is left after that are rings.
    for (const vertex of chosen) if (left.has(vertex) && links.get(vertex).length < 2) chains.push(walk(vertex));
    for (const vertex of chosen) if (left.has(vertex)) chains.push(walk(vertex));

    const loop = chains.shift();
    while (chains.length) {
      const tail = this.vertices[loop[loop.length - 1]];
      let best = null;
      chains.forEach((chain, index) => {
        for (const reversed of [false, true]) {
          const end = this.vertices[reversed ? chain[chain.length - 1] : chain[0]];
          const distance = tail.distanceToSquared(end);
          if (!best || distance < best.distance) best = { index, reversed, distance };
        }
      });
      const [chain] = chains.splice(best.index, 1);
      loop.push(...(best.reversed ? chain.reverse() : chain));
    }
    return loop;
  }

  // The given vertices in order of their angle around their middle, in the
  // plane through the three of them that are farthest apart; null if they
  // are all on one line.
  angularOrder(chosen) {
    const points = chosen.map((vertex) => this.vertices[vertex]);
    let a = points[0];
    let b = points[0];
    for (const p of points) {
      for (const q of points) {
        if (p.distanceToSquared(q) > a.distanceToSquared(b)) [a, b] = [p, q];
      }
    }
    const u = b.clone().sub(a);
    if (u.lengthSq() < 1e-12) return null;
    u.normalize();
    const normal = new THREE.Vector3();
    for (const p of points) {
      const candidate = new THREE.Vector3().crossVectors(u, p.clone().sub(a));
      if (candidate.lengthSq() > normal.lengthSq()) normal.copy(candidate);
    }
    if (normal.lengthSq() < 1e-12) return null;
    normal.normalize();
    const v = new THREE.Vector3().crossVectors(normal, u);
    const middle = points.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(points.length);
    const angle = (p) => {
      const offset = p.clone().sub(middle);
      return Math.atan2(offset.dot(v), offset.dot(u));
    };
    return chosen
      .map((vertex, i) => ({ vertex, angle: angle(points[i]) }))
      .sort((p, q) => p.angle - q.angle)
      .map((entry) => entry.vertex);
  }

  // Unit normal of a loop of vertices (Newell's method); zero if they are all on one line.
  loopNormal(loop) {
    this.faces.push(loop);
    const normal = this.faceNormal(this.faces.length - 1);
    this.faces.pop();
    return normal;
  }

  // Whether the given vertices lie in one plane. Vertices on one line do.
  isCoplanar(indices) {
    const points = indices.map((i) => this.vertices[i]);
    const origin = points[0];
    const along = new THREE.Vector3();
    const normal = new THREE.Vector3();
    for (const point of points) {
      const offset = point.clone().sub(origin);
      if (normal.lengthSq() > 0) {
        if (Math.abs(offset.dot(normal)) > 1e-4) return false;
      } else if (along.lengthSq() < 1e-12) {
        along.copy(offset);
      } else {
        normal.crossVectors(along, offset);
        if (normal.lengthSq() < 1e-12) normal.set(0, 0, 0); // still on the line
        else normal.normalize();
      }
    }
    return true;
  }

  // --- cutting with an axis-aligned plane (axis = value) -------------------

  // -1 / 0 / +1: which side of the plane a vertex is on; 0 means on it.
  planeSide(vertex, axis, value) {
    const distance = this.vertices[vertex][axis] - value;
    return Math.abs(distance) < PLANE_EPSILON ? 0 : Math.sign(distance);
  }

  // A face's loop with a vertex added on every edge the plane crosses:
  // { loop, on }, where `on` flags the entries that lie on the plane. A new
  // point is made by make(a, b, point) for the edge a-b and put in its place.
  cutLoop(face, axis, value, make) {
    const loop = [];
    const on = [];
    face.forEach((a, j) => {
      const b = face[(j + 1) % face.length];
      const sideA = this.planeSide(a, axis, value);
      loop.push(a);
      on.push(sideA === 0);
      if (sideA * this.planeSide(b, axis, value) >= 0) return;
      const start = this.vertices[a];
      const end = this.vertices[b];
      const point = start.clone().lerp(end, (value - start[axis]) / (end[axis] - start[axis]));
      point[axis] = value; // exactly on the plane, free of rounding
      loop.push(make(a, b, point));
      on.push(true);
    });
    return { loop, on };
  }

  // Where the plane crosses the given faces, as [Vector3, Vector3] segments.
  planeSegments(faceIndices, axis, value) {
    const segments = [];
    for (const faceIndex of faceIndices) {
      // Points stand in for vertices here: nothing is added to the mesh.
      const points = [];
      const { loop, on } = this.cutLoop(this.faces[faceIndex], axis, value, (a, b, point) => {
        points.push(point);
        return -points.length; // -1, -2, ...: a made point
      });
      const position = (entry) => (entry < 0 ? points[-entry - 1] : this.vertices[entry]);
      const outline = loop.map(position);
      for (const [i, j] of cutChords(outline, on, axis)) segments.push([outline[i].clone(), outline[j].clone()]);
    }
    return segments;
  }

  // Cuts the given faces with the plane: every edge that crosses it gets a
  // vertex (shared by the faces on both sides of the edge), and every face is
  // split along each stretch of the plane's line that runs inside it - a
  // concave face may be cut into more than two pieces.
  // Returns { changed, vertices }: the vertices that lie on the cut.
  planeCut(faceIndices, axis, value) {
    const cutVertices = new Map(); // edge key -> index of the vertex cut into it
    const onPlane = new Set();
    let changed = false;

    for (const faceIndex of faceIndices) {
      const face = this.faces[faceIndex];
      const { loop, on } = this.cutLoop(face, axis, value, (a, b, point) => {
        const key = edgeKey(a, b);
        if (!cutVertices.has(key)) {
          cutVertices.set(key, this.addVertex(point.x, point.y, point.z, this.vertexObject[a]));
        }
        return cutVertices.get(key);
      });
      if (loop.length !== face.length) changed = true;
      loop.forEach((vertex, i) => {
        if (on[i]) onPlane.add(vertex);
      });

      // The chords never cross (they lie on one line), so each of them
      // simply splits the piece that holds both its ends.
      const pieces = [loop];
      for (const [i, j] of cutChords(loop.map((vertex) => this.vertices[vertex]), on, axis)) {
        const index = pieces.findIndex((piece) => piece.includes(loop[i]) && piece.includes(loop[j]));
        if (index < 0) continue;
        const piece = pieces[index];
        const [p, q] = [piece.indexOf(loop[i]), piece.indexOf(loop[j])].sort((a, b) => a - b);
        // Both halves keep the winding of the original face.
        pieces.splice(index, 1, piece.slice(p, q + 1), [...piece.slice(q), ...piece.slice(0, p + 1)]);
      }
      for (const piece of pieces) inheritUV(piece, face);
      this.faces[faceIndex] = pieces[0];
      for (const piece of pieces.slice(1)) this.faces.push(piece);
      if (pieces.length > 1) changed = true;
    }
    return { changed, vertices: [...onPlane] };
  }

  // --- extrusion ---------------------------------------------------------

  // Unit normal of a face (Newell's method, so it need not be perfectly flat).
  faceNormal(faceIndex) {
    const points = this.faces[faceIndex].map((i) => this.vertices[i]);
    const normal = new THREE.Vector3();
    points.forEach((a, i) => {
      const b = points[(i + 1) % points.length];
      normal.x += (a.y - b.y) * (a.z + b.z);
      normal.y += (a.z - b.z) * (a.x + b.x);
      normal.z += (a.x - b.x) * (a.y + b.y);
    });
    return normal.normalize();
  }

  // Extrudes a region of faces by zero distance: the faces move onto copies of
  // their vertices, and every edge on the region's border gets a side quad
  // between the old and the new pair of vertices. Returns the copies' indices;
  // moving them gives the extrusion its depth.
  extrudeFaces(faceIndices) {
    // Border edges are used by exactly one face of the region.
    const edgeUse = new Map();
    const eachEdge = (callback) => {
      for (const faceIndex of faceIndices) {
        const face = this.faces[faceIndex];
        face.forEach((a, j) => callback(a, face[(j + 1) % face.length]));
      }
    };
    eachEdge((a, b) => edgeUse.set(edgeKey(a, b), (edgeUse.get(edgeKey(a, b)) ?? 0) + 1));

    const copies = new Map(); // original vertex -> its copy
    for (const faceIndex of faceIndices) {
      for (const vertex of this.faces[faceIndex]) {
        if (copies.has(vertex)) continue;
        const { x, y, z } = this.vertices[vertex];
        copies.set(vertex, this.addVertex(x, y, z, this.vertexObject[vertex]));
      }
    }

    // A side runs along its edge the same way the extruded face does, which
    // makes it face outwards.
    const sides = [];
    eachEdge((a, b) => {
      if (edgeUse.get(edgeKey(a, b)) === 1) sides.push([a, b, copies.get(b), copies.get(a)]);
    });
    for (const faceIndex of faceIndices) {
      const cap = this.faces[faceIndex].map((vertex) => copies.get(vertex));
      if (this.faces[faceIndex].uv) cap.uv = this.faces[faceIndex].uv;
      if (this.faces[faceIndex].pin) cap.pin = true;
      this.faces[faceIndex] = cap;
    }
    this.faces.push(...sides);

    // Vertices inside the region are left without faces: drop them.
    const used = new Set(this.faces.flat());
    const orphans = new Set([...copies.keys()].filter((vertex) => !used.has(vertex)));
    const remap = this.removeVertices(orphans);
    return [...copies.values()].map((vertex) => remap.get(vertex));
  }

  // Every place where a face runs along one of the given edges ([a, b] pairs),
  // as { face, from, to }: the face's index and the edge in the face's direction.
  edgeUses(edges) {
    const wanted = new Set(edges.map(([a, b]) => edgeKey(a, b)));
    const uses = [];
    this.faces.forEach((face, faceIndex) => {
      face.forEach((from, j) => {
        const to = face[(j + 1) % face.length];
        if (wanted.has(edgeKey(from, to))) uses.push({ face: faceIndex, from, to });
      });
    });
    return uses;
  }

  // Extrudes edges by zero distance: each gets a quad between itself and a
  // copy of it; edges that share a vertex share its copy, forming one strip.
  // Returns the copies' indices.
  extrudeEdges(edges) {
    const copies = new Map();
    const copyOf = (vertex) => {
      if (!copies.has(vertex)) {
        const { x, y, z } = this.vertices[vertex];
        copies.set(vertex, this.addVertex(x, y, z, this.vertexObject[vertex]));
      }
      return copies.get(vertex);
    };
    // One quad per edge, running along it against a face that uses it, so that
    // the two face the same way.
    const done = new Set();
    for (const { from, to } of this.edgeUses(edges)) {
      const key = edgeKey(from, to);
      if (done.has(key)) continue;
      done.add(key);
      this.faces.push([to, from, copyOf(from), copyOf(to)]);
    }
    return [...copies.values()];
  }

  // The objects and groups as { id, name, kind, parent, vertices, faces } with
  // index lists (empty for a group), in the order of `objects`. (Called
  // "islands" by the callers: before objects had an identity of their own,
  // they were the connected pieces of the mesh.)
  islands() {
    this.adoptObjects();
    const byId = new Map(
      this.objects.map(({ id, name, parent, kind, hidden }) => [
        id,
        { id, name, kind: kind ?? 'mesh', parent: parent ?? null, hidden: Boolean(hidden), vertices: [], faces: [] },
      ]),
    );
    this.vertexObject.forEach((id, vertex) => byId.get(id).vertices.push(vertex));
    this.faces.forEach((face, i) => byId.get(this.vertexObject[face[0]]).faces.push(i));
    return [...byId.values()];
  }

  // Makes sure every vertex has a known object. Data that carries none (a
  // state saved before objects existed) gets one object per connected piece.
  adoptObjects() {
    const known = new Set(this.objects.filter((object) => object.kind !== 'group').map((object) => object.id));
    const complete =
      this.vertexObject.length === this.vertices.length && this.vertexObject.every((id) => known.has(id));
    if (!complete) {
      this.objects = [];
      this.vertexObject = new Array(this.vertices.length);
      for (const piece of this.connectedPieces()) {
        const id = this.addObject('Object');
        for (const vertex of piece) this.vertexObject[vertex] = id;
      }
    }
    // Only groups hold anything. An object nested in another object (a state
    // saved when that was allowed) moves up to the nearest group, or to the top.
    const byId = new Map(this.objects.map((object) => [object.id, object]));
    for (const object of this.objects) {
      let parent = object.parent ?? null;
      while (parent !== null && byId.get(parent)?.kind !== 'group') parent = byId.get(parent)?.parent ?? null;
      object.parent = parent;
    }
  }

  // The vertices of each connected piece of the mesh. A vertex that no face or
  // wire uses is a piece of its own.
  connectedPieces() {
    const parent = this.vertices.map((_, i) => i);
    const find = (i) => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    for (const face of this.faces) {
      for (const vertex of face) parent[find(vertex)] = find(face[0]);
    }
    for (const [a, b] of this.wires) parent[find(a)] = find(b);

    const byRoot = new Map();
    this.vertices.forEach((_, i) => {
      const root = find(i);
      if (!byRoot.has(root)) byRoot.set(root, []);
      byRoot.get(root).push(i);
    });
    return [...byRoot.values()];
  }

  // Removes faces, then the vertices of theirs that no remaining face uses.
  // Returns the old -> new vertex index map, like removeVertices().
  removeFaces(indices) {
    const touched = new Set();
    this.faces = this.faces.filter((face, i) => {
      if (!indices.has(i)) return true;
      for (const vertex of face) touched.add(vertex);
      return false;
    });
    for (const face of this.faces) {
      for (const vertex of face) touched.delete(vertex);
    }
    return this.removeVertices(touched);
  }

  // Removes vertices together with every face that uses them. Returns a Map
  // from the old index of each surviving vertex to its new index.
  removeVertices(indices) {
    const remap = new Map();
    const kept = [];
    this.vertices.forEach((vertex, i) => {
      if (indices.has(i)) return;
      remap.set(i, kept.length);
      kept.push(vertex);
    });
    this.vertices = kept;
    this.faces = this.faces
      .filter((face) => face.every((i) => remap.has(i)))
      .map((face) => {
        const renumbered = face.map((i) => remap.get(i));
        if (face.uv) renumbered.uv = face.uv;
        if (face.pin) renumbered.pin = true;
        return renumbered;
      });
    this.wires = this.wires
      .filter((wire) => wire.every((i) => remap.has(i)))
      .map((wire) => wire.map((i) => remap.get(i)));
    // An object with no vertices left is gone; a group never had any and stays.
    this.vertexObject = this.vertexObject.filter((_, i) => remap.has(i));
    this.folds = new Map([...this.folds].filter(([i]) => remap.has(i)).map(([i, fold]) => [remap.get(i), fold]));
    const alive = new Set(this.vertexObject);
    const gone = this.objects.filter((object) => object.kind !== 'group' && !alive.has(object.id));
    this.dropObjects(new Set(gone.map((object) => object.id)));
    return remap;
  }
}

// The theme's colours as THREE.Color objects; loadColors() refills them.
const COLOR_SURFACE = new THREE.Color();
const COLOR_WHITE = new THREE.Color(1, 1, 1);
const COLOR_WIRE = new THREE.Color();
const COLOR_WIRE_FOCUS = new THREE.Color();
const COLOR_VERTEX = new THREE.Color();
// Focus look: light vertices on a dark background, with a "hovered" that stands out from them.
const COLOR_VERTEX_FOCUS = new THREE.Color();
const COLOR_HOVERED_FOCUS = new THREE.Color();
const COLOR_SELECTED = new THREE.Color();
const COLOR_HOVERED = new THREE.Color();
const COLOR_CUT = new THREE.Color();

function loadColors() {
  COLOR_SURFACE.set(theme.surface);
  COLOR_WIRE.set(theme.wire);
  COLOR_WIRE_FOCUS.set(theme.wireFocus);
  COLOR_VERTEX.set(theme.vertex);
  COLOR_VERTEX_FOCUS.set(theme.vertexFocus);
  COLOR_HOVERED_FOCUS.set(theme.hoveredFocus);
  COLOR_SELECTED.set(theme.selected);
  COLOR_HOVERED.set(theme.hovered);
  COLOR_CUT.set(theme.cut);
}
loadColors();
const NO_HIGHLIGHT = { selectedFaces: [], hoveredFaces: [], selectedEdges: [], hoveredEdges: [] };

function faceOverlay(color, opacity) {
  return new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({
      color,
      opacity,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
}

// Joins [a, b] segments that share end points into polylines (lists of
// points), so that a dash pattern can run along them without breaks.
function chainSegments(segments) {
  const left = segments.map(([a, b]) => [a, b]);
  const chains = [];
  while (left.length) {
    const chain = left.pop();
    for (let grown = true; grown; ) {
      grown = false;
      const tail = chain[chain.length - 1];
      for (let i = 0; i < left.length; i++) {
        const [a, b] = left[i];
        const next = a.distanceToSquared(tail) < 1e-10 ? b : b.distanceToSquared(tail) < 1e-10 ? a : null;
        if (!next) continue;
        chain.push(next);
        left.splice(i, 1);
        grown = true;
        break;
      }
    }
    chains.push(chain);
  }
  return chains;
}

// Vertex markers: round dots of a fixed size on screen.
//
// A dot is a flat sprite at the depth of its vertex, so the ordinary depth
// test would let the faces that meet at the vertex and come towards the camera
// cut into it. Instead a dot is drawn whole or not at all: the surface is
// rendered on its own into a depth map first (see MeshView.prepareDepth), and
// the vertex shader looks its vertex up there - a vertex with something in
// front of it gets no dot. This holds at any distance from the camera.
const POINT_SIZE = 8; // px
const POINT_SELECTED_SCALE = 1.5; // a selected vertex is this much larger

const POINT_VERTEX_SHADER = /* glsl */ `
  uniform float size; // px, in device pixels
  uniform sampler2D depthMap; // the surface's depth, as the camera sees it
  uniform vec2 texel; // one pixel of the map
  uniform float cameraNear;
  uniform float cameraFar;
  uniform float occlusion; // 1: the surface hides the dots behind it; 0: nothing does
  attribute vec3 color;
  attribute float scale; // per-vertex size factor
  varying vec3 vColor;

  // How far from the camera the surface is at a point of the map; negative
  // where there is no surface.
  float surfaceDistance(vec2 uv) {
    float depth = texture2D(depthMap, uv).x;
    if (depth >= 0.9999999) return -1.0;
    float ndc = depth * 2.0 - 1.0;
    return 2.0 * cameraNear * cameraFar / (cameraFar + cameraNear - ndc * (cameraFar - cameraNear));
  }

  void main() {
    vColor = color;
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    gl_PointSize = size * scale;
    bool hidden = scale == 0.0; // of a hidden object

    if (!hidden && occlusion > 0.5) {
      vec2 uv = gl_Position.xy / gl_Position.w * 0.5 + 0.5;
      float own = -viewPosition.z;
      // The vertex is hidden when the surface in front of it is nearer than
      // it is - in the pixel it falls into or in the four around it, so that a
      // vertex just behind an outline does not flicker in and out as it
      // crosses pixels. The vertex's own faces are no nearer than the vertex:
      // the depth pass pushes the surface back by a couple of pixels' worth of
      // its slope (polygon offset), which covers the faces that come towards
      // the camera from a vertex, however steeply.
      float slack = own * 0.0005; // what the depth map can't tell apart
      for (int x = -1; x <= 1; x++) {
        for (int y = -1; y <= 1; y++) {
          if (x != 0 && y != 0) continue;
          float surface = surfaceDistance(uv + vec2(float(x), float(y)) * texel);
          if (surface >= 0.0 && surface < own - slack) hidden = true;
        }
      }
    }
    if (hidden) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // off the screen
  }
`;

const POINT_FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vColor;

  void main() {
    float alpha = 1.0 - smoothstep(0.38, 0.5, length(gl_PointCoord - 0.5));
    if (alpha <= 0.0) discard;
    gl_FragColor = vec4(vColor, alpha);
    #include <colorspace_fragment>
  }
`;

function pointsMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      size: { value: POINT_SIZE },
      depthMap: { value: null },
      texel: { value: new THREE.Vector2(1, 1) },
      cameraNear: { value: 0.1 },
      cameraFar: { value: 1000 },
      occlusion: { value: 0 },
    },
    vertexShader: POINT_VERTEX_SHADER,
    fragmentShader: POINT_FRAGMENT_SHADER,
    transparent: true, // smooth rim; also puts the dots after every opaque object
    depthTest: false, // a dot is hidden as a whole, by its shader
    depthWrite: false,
  });
}

// Thick lines: plain GL lines are always one pixel wide.
function edgeOverlay(color) {
  return new LineSegments2(new LineSegmentsGeometry(), new LineMaterial({ color, linewidth: 3 }));
}

// --- what a face carries ------------------------------------------------------
//
// A face is a loop: an array of vertex indices. The array may also carry
// `uv` - where the face's corners are on the texture atlas, in pixels: an
// array in step with the loop, of [x, y] or null for a corner that has no
// place yet (see unwrap.js, which gives them) - and `pin`, set when the user
// has put the face there by hand, which the unwrap then leaves alone. They
// are properties of the array itself, so a face that is merely moved keeps
// them without anyone's care; code that makes a new array for an old face
// carries them over with these.

// A copy of a face, with what it carries.
export function cloneFace(face) {
  const copy = [...face];
  if (face.uv) copy.uv = face.uv.map((point) => (point ? [point[0], point[1]] : null));
  if (face.pin) copy.pin = true;
  return copy;
}

// Gives `loop` (a new array) the places of `source`'s corners, by vertex: a
// corner whose vertex is in the old face keeps its place, others have none.
// `before` maps a vertex of the new loop to what it was in the old one.
export function inheritUV(loop, source, before = (vertex) => vertex) {
  if (source.pin) loop.pin = true;
  if (!source.uv) return loop;
  const places = new Map(source.map((vertex, k) => [vertex, source.uv[k]]));
  loop.uv = loop.map((vertex) => {
    const place = places.get(before(vertex));
    return place ? [place[0], place[1]] : null;
  });
  return loop;
}

// Render model: surface, edges and vertex points built from an EditableMesh.
export class MeshView {
  constructor(mesh) {
    this.mesh = mesh;
    this.group = new THREE.Group();

    this.solid = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshStandardMaterial({
        // The colour is the geometry's, per object: see updateSurfaceColors().
        vertexColors: true,
        roughness: 1,
        flatShading: true,
        side: THREE.DoubleSide,
        // Push the surface back so edges and points don't z-fight with it.
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      }),
    );
    this.wire = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: COLOR_WIRE }),
    );
    this.points = new THREE.Points(new THREE.BufferGeometry(), pointsMaterial());
    // Drawn last: over the edges, the face highlights and the cut line.
    this.points.renderOrder = 5;
    this.points.onBeforeRender = (renderer) => {
      this.points.material.uniforms.size.value = POINT_SIZE * renderer.getPixelRatio();
    };
    // The surface alone, for the depth map the dots are tested against. It
    // shares the surface's geometry and is pushed back the same way.
    this.depthMesh = new THREE.Mesh(
      this.solid.geometry,
      new THREE.MeshBasicMaterial({
        colorWrite: false,
        side: THREE.DoubleSide,
        // Pushed back by two pixels' worth of each face's slope, see the dots' shader.
        polygonOffset: true,
        polygonOffsetFactor: 2,
        polygonOffsetUnits: 2,
      }),
    );
    this.depthScene = new THREE.Scene();
    this.depthScene.add(this.depthMesh);

    // 'orientation' shading: the surface drawn once more, front sides in one
    // colour and back sides in another. They share the surface's geometry and
    // depth offset, so they cover it exactly; the surface itself stays as it is
    // for picking.
    const tint = (side) => {
      const mesh = new THREE.Mesh(this.solid.geometry, this.solid.material.clone());
      mesh.material.side = side;
      mesh.renderOrder = 0.5;
      mesh.visible = false;
      return mesh;
    };
    this.tints = { front: tint(THREE.FrontSide), back: tint(THREE.BackSide) };
    this.shading = 'solid'; // 'solid' | 'wireframe' | 'orientation'
    this.focus = false;
    this.light = false; // light edges and vertices, as on a dark wireframe

    // Selected and hovered faces/edges, drawn over the surface.
    this.overlays = {
      selectedFaces: faceOverlay(COLOR_SELECTED, 0.45),
      hoveredFaces: faceOverlay(COLOR_HOVERED, 0.2),
      selectedEdges: edgeOverlay(COLOR_SELECTED),
      hoveredEdges: edgeOverlay(COLOR_HOVERED),
    };
    this.overlays.hoveredFaces.renderOrder = 1;
    this.highlight = NO_HIGHLIGHT;

    // The polygon tool's outline in progress: its sides and its points, drawn
    // over everything.
    this.sketchLine = edgeOverlay(COLOR_SELECTED);
    this.sketchLine.material.depthTest = false;
    this.sketchLine.material.transparent = true; // drawn after the floor grid
    this.sketchLine.renderOrder = 3;
    this.sketchLine.visible = false;
    this.sketchPoints = new THREE.Points(new THREE.BufferGeometry(), pointsMaterial());
    this.sketchPoints.material.depthTest = false;
    this.sketchPoints.renderOrder = 6;
    this.sketchPoints.onBeforeRender = this.points.onBeforeRender;
    this.sketchPoints.visible = false;

    // Wireframe of an object that is about to be added.
    this.previewLine = edgeOverlay(COLOR_SELECTED);
    this.previewLine.material.linewidth = 2;
    this.previewLine.material.depthTest = false;
    this.previewLine.material.transparent = true; // drawn after the floor grid
    this.previewLine.renderOrder = 3;
    this.previewLine.visible = false;

    // Preview of a cut; drawn through the model so the whole outline is seen.
    this.cutLine = edgeOverlay(COLOR_CUT);
    this.cutLine.material.depthTest = false;
    this.cutLine.material.transparent = true; // drawn after the floor grid
    this.cutLine.renderOrder = 2;
    this.cutLine.visible = false;

    // The normal of the surface under the place tool's ring: the same kind of line.
    this.placeLine = edgeOverlay(COLOR_CUT);
    this.placeLine.material.depthTest = false;
    this.placeLine.material.transparent = true;
    this.placeLine.renderOrder = 9;
    this.placeLine.visible = false;

    const objects = [
      this.solid,
      ...Object.values(this.tints),
      this.wire,
      this.points,
      ...Object.values(this.overlays),
      this.cutLine,
      this.placeLine,
      this.sketchLine,
      this.sketchPoints,
      this.previewLine,
    ];
    for (const object of objects) {
      object.frustumCulled = false;
      this.group.add(object);
    }
    this.rebuild();
  }

  // Gets the depth pass ready for a frame: `target` is the render target its
  // scene (depthScene) is about to be drawn into with `camera`. Returns false
  // when the pass is not needed - no dots are shown, or the surface is not
  // (a wireframe hides nothing).
  prepareDepth(camera, target) {
    const { uniforms } = this.points.material;
    const needed = this.points.visible && this.solid.visible;
    uniforms.occlusion.value = needed ? 1 : 0;
    if (!needed) return false;
    this.depthMesh.geometry = this.solid.geometry; // replaced at every rebuild
    uniforms.depthMap.value = target.depthTexture;
    uniforms.texel.value.set(1 / target.width, 1 / target.height);
    uniforms.cameraNear.value = camera.near;
    uniforms.cameraFar.value = camera.far;
    return true;
  }

  // Call after topology changes (vertices or faces added/removed).
  rebuild() {
    const { vertices, faces } = this.mesh;
    // Vertices of hidden objects, set by the owner before a rebuild: nothing
    // of theirs is drawn or hit by picking rays.
    const hidden = (this.hidden ??= new Set());

    this.triangleIndices = [];
    this.triangleFaces = []; // triangle index -> face index, for picking
    this.faceTriangles = faces.map((_, faceIndex) => this.mesh.triangulate(faceIndex));
    this.faceTriangles.forEach((triangles, faceIndex) => {
      if (hidden.has(faces[faceIndex][0])) return;
      for (const triangle of triangles) {
        this.triangleIndices.push(...triangle);
        this.triangleFaces.push(faceIndex);
      }
    });
    this.edgeIndices = this.mesh.edges().filter(([a]) => !hidden.has(a)).flat();

    this.setPositions(this.solid, this.triangleIndices.length);
    for (const tint of Object.values(this.tints)) tint.geometry = this.solid.geometry;
    this.setPositions(this.wire, this.edgeIndices.length);
    this.setPositions(this.points, vertices.length);
    this.points.geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(new Float32Array(vertices.length * 3), 3),
    );
    this.points.geometry.setAttribute('scale', new THREE.BufferAttribute(new Float32Array(vertices.length).fill(1), 1));

    this.highlight = NO_HIGHLIGHT; // its indices referred to the old topology
    this.updateSurfaceColors();
    this.updateUVs();
    this.updatePositions();
    this.updateColors(new Set(), -1);
  }

  // Paints the surface: every object in its marker colour (see
  // marker-colors.js), or in the theme's surface colour if it has none. Call
  // after an object's colour changes; rebuild() and applyTheme() do it themselves.
  updateSurfaceColors() {
    const { faces, objects, vertexObject } = this.mesh;
    const painted = Boolean(this.solid.material.map); // the atlas is the colour then
    const tints = new Map(objects.map((object) => {
      const hex = markerColor(object.color);
      return [object.id, painted ? COLOR_WHITE : hex ? new THREE.Color(hex) : COLOR_SURFACE];
    }));
    const colors = new Float32Array(this.triangleFaces.length * 9);
    this.triangleFaces.forEach((face, triangle) => {
      const tint = tints.get(vertexObject[faces[face][0]]) ?? (painted ? COLOR_WHITE : COLOR_SURFACE);
      for (let corner = 0; corner < 3; corner++) tint.toArray(colors, triangle * 9 + corner * 3);
    });
    this.solid.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }

  // Tells the surface where each of its corners is on the atlas, from the
  // faces' `uv` (pixels, y down) - call when those or the atlas' size change.
  updateUVs() {
    const { faces } = this.mesh;
    const width = this.atlas?.width || 1;
    const height = this.atlas?.height || 1;
    const uvs = new Float32Array(this.triangleFaces.length * 6);
    this.triangleFaces.forEach((faceIndex, triangle) => {
      const face = faces[faceIndex];
      if (!face.uv) return;
      for (let corner = 0; corner < 3; corner++) {
        const place = face.uv[face.indexOf(this.triangleIndices[triangle * 3 + corner])];
        if (!place) continue;
        uvs[triangle * 6 + corner * 2] = place[0] / width;
        uvs[triangle * 6 + corner * 2 + 1] = 1 - place[1] / height; // a texture's rows run upwards
      }
    });
    this.solid.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  }

  setPositions(object, count) {
    object.geometry.dispose();
    object.geometry = new THREE.BufferGeometry();
    object.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(count * 3), 3),
    );
  }

  // Call after vertices moved without topology changes.
  updatePositions() {
    const { vertices } = this.mesh;
    const write = (object, indices) => {
      const attribute = object.geometry.getAttribute('position');
      indices.forEach((vertexIndex, i) => {
        const v = vertices[vertexIndex];
        attribute.setXYZ(i, v.x, v.y, v.z);
      });
      attribute.needsUpdate = true;
    };
    write(this.solid, this.triangleIndices);
    write(this.wire, this.edgeIndices);
    write(this.points, vertices.map((_, i) => i));
    // Raycasting against the surface relies on an up-to-date bounding sphere.
    this.solid.geometry.computeBoundingSphere();
    this.applyHighlight();
  }

  // Takes the colours of the current theme. The vertex colours are the
  // caller's to refresh, see updateColors().
  applyTheme() {
    loadColors();
    this.updateSurfaceColors();
    this.applyLook();
    this.overlays.selectedFaces.material.color.copy(COLOR_SELECTED);
    this.overlays.hoveredFaces.material.color.copy(COLOR_HOVERED);
    this.overlays.selectedEdges.material.color.copy(COLOR_SELECTED);
    this.overlays.hoveredEdges.material.color.copy(COLOR_HOVERED);
    this.cutLine.material.color.copy(COLOR_CUT);
    this.placeLine.material.color.copy(COLOR_CUT);
    this.sketchLine.material.color.copy(COLOR_SELECTED);
    this.previewLine.material.color.copy(COLOR_SELECTED);
    this.tints.front.material.color.set(theme.faceFront);
    this.tints.back.material.color.set(theme.faceBack);
  }

  // How the object is drawn:
  //   'solid'       - the lit surface;
  //   'wireframe'   - edges and vertices only;
  //   'orientation' - the surface with front sides in one colour and back sides in another;
  //   'textured'    - the surface painted with the atlas (see atlas.js).
  // The vertex colours are the caller's to refresh, see updateColors().
  setShading(mode) {
    this.shading = mode;
    this.applyLook();
  }

  // Focus look for modal operations, on top of any shading: a wireframe.
  // The caller refreshes the vertex colours.
  setFocus(on) {
    this.focus = on;
    this.applyLook();
  }

  applyLook() {
    const wireframe = this.focus || this.shading === 'wireframe';
    this.light = wireframe;
    this.solid.visible = !wireframe; // still hit by picking rays when not drawn
    // Painted: the atlas' pixels as they are, and its see-through ones as holes.
    const map = this.shading === 'textured' && this.atlas ? this.atlas.texture : null;
    const { material } = this.solid;
    if (material.map !== map) {
      material.map = map;
      material.alphaTest = map ? 0.5 : 0;
      material.needsUpdate = true;
      this.updateSurfaceColors(); // the marker colours give way to the picture
    }
    for (const tint of Object.values(this.tints)) {
      tint.visible = !this.focus && this.shading === 'orientation';
    }
    this.wire.material.color.copy(wireframe ? COLOR_WIRE_FOCUS : COLOR_WIRE);
  }

  // Shows a wireframe given as [Vector3, Vector3] segments; an empty list hides it.
  setPreview(segments) {
    this.previewLine.visible = segments.length > 0;
    if (!this.previewLine.visible) return;
    const positions = segments.flatMap(([a, b]) => [...a.toArray(), ...b.toArray()]);
    this.previewLine.geometry.dispose();
    this.previewLine.geometry = new LineSegmentsGeometry().setPositions(positions);
  }

  // Shows the polygon tool's outline: its points so far, joined in order, and
  // the point under the cursor, which the outline stretches to. `closing`
  // marks that a click would close the outline at its first point. Null hides it.
  setSketch(sketch) {
    this.sketchLine.visible = false;
    this.sketchPoints.visible = false;
    if (!sketch) return;
    const { points, cursor, closing } = sketch;
    const path = cursor ? [...points, cursor] : points;

    if (path.length >= 2) {
      const positions = [];
      for (let i = 0; i < path.length - 1; i++) positions.push(...path[i].toArray(), ...path[i + 1].toArray());
      this.sketchLine.geometry.dispose();
      this.sketchLine.geometry = new LineSegmentsGeometry().setPositions(positions);
      this.sketchLine.visible = true;
    }
    if (path.length >= 1) {
      const colors = [];
      const scales = [];
      path.forEach((point, i) => {
        const isCursor = cursor && i === path.length - 1;
        const marked = isCursor || (closing && i === 0);
        colors.push(...(marked ? COLOR_HOVERED_FOCUS : COLOR_SELECTED).toArray());
        scales.push(closing && i === 0 ? POINT_SELECTED_SCALE : 1);
      });
      this.sketchPoints.geometry.dispose();
      const geometry = new THREE.BufferGeometry().setFromPoints(path);
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geometry.setAttribute('scale', new THREE.Float32BufferAttribute(scales, 1));
      this.sketchPoints.geometry = geometry;
      this.sketchPoints.visible = true;
    }
  }

  // Shows where a cut would go: a list of [Vector3, Vector3] segments, drawn
  // as dashes of the given length with gaps between them, all in world units.
  // `phase` shifts the pattern along the line; growing it makes the dashes run.
  // Each dash is a segment of its own, which gives it round ends.
  // The place tool's line: dashed and flowing like the cut's.
  setPlacePreview(segments, dashes) {
    this.setCutPreview(segments, dashes, this.placeLine);
  }

  setCutPreview(segments, { dash = 0.1, gap = 0.1, phase = 0 } = {}, line = this.cutLine) {
    line.visible = segments.length > 0;
    if (!line.visible) return;

    const period = dash + gap;
    const offset = phase % period;
    const positions = [];
    const point = new THREE.Vector3();
    for (const chain of chainSegments(segments)) {
      let travelled = 0; // distance along the chain to the current segment's start
      for (let i = 0; i < chain.length - 1; i++) {
        const start = chain[i];
        const end = chain[i + 1];
        const length = start.distanceTo(end);
        // Dashes begin at offset + n * period; take the parts inside this segment.
        const first = Math.floor((travelled - offset) / period) * period + offset;
        for (let from = first; from < travelled + length; from += period) {
          const a = Math.max(from, travelled);
          const b = Math.min(from + dash, travelled + length);
          if (b <= a) continue;
          positions.push(...point.lerpVectors(start, end, (a - travelled) / length).toArray());
          positions.push(...point.lerpVectors(start, end, (b - travelled) / length).toArray());
        }
        travelled += length;
      }
    }
    line.geometry.dispose();
    line.geometry = new LineSegmentsGeometry().setPositions(positions);
  }

  // `highlight` lists face indices and [a, b] vertex pairs, see NO_HIGHLIGHT.
  setHighlight(highlight) {
    this.highlight = highlight;
    this.applyHighlight();
  }

  // The colour of the outline of what is selected: a shade of grey from black
  // (0) to white (1), for an outline that blinks; null gives it back the
  // selection's own colour.
  shadeSelectedEdges(shade) {
    const { color } = this.overlays.selectedEdges.material;
    if (shade === null) color.copy(COLOR_SELECTED);
    else color.setScalar(shade);
  }

  applyHighlight() {
    const { vertices } = this.mesh;

    for (const name of ['selectedFaces', 'hoveredFaces']) {
      const points = [];
      for (const faceIndex of this.highlight[name]) {
        for (const triangle of this.faceTriangles[faceIndex]) {
          points.push(...triangle.map((i) => vertices[i]));
        }
      }
      const overlay = this.overlays[name];
      overlay.geometry.dispose();
      overlay.geometry = new THREE.BufferGeometry().setFromPoints(points);
      overlay.visible = points.length > 0;
    }

    for (const name of ['selectedEdges', 'hoveredEdges']) {
      const positions = this.highlight[name].flatMap(([a, b]) => [
        ...vertices[a].toArray(),
        ...vertices[b].toArray(),
      ]);
      const overlay = this.overlays[name];
      overlay.visible = positions.length > 0;
      if (!overlay.visible) continue;
      overlay.geometry.dispose();
      overlay.geometry = new LineSegmentsGeometry().setPositions(positions);
    }
  }

  updateColors(selection, hovered) {
    const attribute = this.points.geometry.getAttribute('color');
    const scale = this.points.geometry.getAttribute('scale');
    for (let i = 0; i < attribute.count; i++) {
      let color = selection.has(i) ? COLOR_SELECTED : this.light ? COLOR_VERTEX_FOCUS : COLOR_VERTEX;
      if (i === hovered) color = this.light ? COLOR_HOVERED_FOCUS : COLOR_HOVERED;
      attribute.setXYZ(i, color.r, color.g, color.b);
      scale.setX(i, this.hidden.has(i) ? 0 : selection.has(i) ? POINT_SELECTED_SCALE : 1);
    }
    attribute.needsUpdate = true;
    scale.needsUpdate = true;
  }
}
