import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { theme } from './theme.js';

const PLANE_EPSILON = 1e-6; // a vertex this close to a cutting plane lies on it
const MAX_LOOP = 8; // the pencil fills loops of up to this many vertices

// Identifies an undirected edge by its two vertex indices.
export const edgeKey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);

// Editing model: shared vertices, polygonal faces (loops of vertex indices)
// and wires: loose edges between two vertices that belong to no face.
// Every vertex belongs to one of the named objects; a face or a wire belongs
// to the object of its vertices.
// This is the source of truth; three.js geometry is derived from it in MeshView.
export class EditableMesh {
  constructor() {
    this.vertices = []; // THREE.Vector3[]
    this.faces = []; // number[][], counter-clockwise when seen from outside
    this.wires = []; // [a, b][], edges drawn on their own
    this.objects = []; // { id, name }[], in the order they are listed
    this.vertexObject = []; // the object id of every vertex
    this.nextObjectId = 1;
  }

  // Adds a vertex to the object with the given id.
  addVertex(x, y, z, object) {
    this.vertices.push(new THREE.Vector3(x, y, z));
    this.vertexObject.push(object);
    return this.vertices.length - 1;
  }

  // Creates an empty object and returns its id. A name that is taken gets a
  // numbered suffix: "Куб", "Куб.001", ...
  addObject(name) {
    const id = this.nextObjectId++;
    this.objects.push({ id, name: this.freeName(name) });
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
    this.objects = this.objects.filter((object) => object.id !== gone);
  }

  addFace(indices) {
    this.faces.push(indices);
  }

  // Adds a flat polygon through the given points, in order, as an object of
  // its own (new vertices, shared with nothing). It is turned towards the
  // viewer, who looks in the direction `facing`. Returns the new vertices.
  addPolygon(points, facing) {
    const object = this.addObject('Полигон');
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

  // Unit cube standing on the grid, as a new object. Returns indices of the new vertices.
  addCube(size = 1) {
    const object = this.addObject('Куб');
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

  // Where the plane crosses the given faces, as [Vector3, Vector3] segments.
  planeSegments(faceIndices, axis, value) {
    const segments = [];
    for (const faceIndex of faceIndices) {
      const face = this.faces[faceIndex];
      const points = [];
      face.forEach((a, j) => {
        const b = face[(j + 1) % face.length];
        const sideA = this.planeSide(a, axis, value);
        const start = this.vertices[a];
        if (sideA === 0) {
          points.push(start.clone());
        } else if (sideA * this.planeSide(b, axis, value) < 0) {
          const end = this.vertices[b];
          points.push(start.clone().lerp(end, (value - start[axis]) / (end[axis] - start[axis])));
        }
      });
      if (points.length === 2) segments.push(points);
    }
    return segments;
  }

  // Cuts the given faces with the plane: every edge that crosses it gets a
  // vertex (shared by the faces on both sides of the edge), and every face
  // crossed in two places is split in two along the line between them.
  // Returns { changed, vertices }: the vertices that lie on the cut.
  planeCut(faceIndices, axis, value) {
    const cutVertices = new Map(); // edge key -> index of the vertex cut into it
    const onPlane = new Set();
    let changed = false;

    for (const faceIndex of faceIndices) {
      const face = this.faces[faceIndex];
      const loop = [];
      face.forEach((a, j) => {
        const b = face[(j + 1) % face.length];
        loop.push(a);
        const sideA = this.planeSide(a, axis, value);
        if (sideA === 0) onPlane.add(a);
        if (sideA * this.planeSide(b, axis, value) >= 0) return;

        const key = edgeKey(a, b);
        if (!cutVertices.has(key)) {
          const start = this.vertices[a];
          const end = this.vertices[b];
          const point = start.clone().lerp(end, (value - start[axis]) / (end[axis] - start[axis]));
          point[axis] = value; // exactly on the plane, free of rounding
          cutVertices.set(key, this.addVertex(point.x, point.y, point.z, this.vertexObject[a]));
        }
        loop.push(cutVertices.get(key));
        onPlane.add(cutVertices.get(key));
      });
      if (loop.length !== face.length) changed = true;

      // Positions in the loop of the two points the cut runs between.
      const marks = loop.flatMap((vertex, i) => (onPlane.has(vertex) ? [i] : []));
      const [p, q] = marks;
      const splits = marks.length === 2 && q - p > 1 && q - p < loop.length - 1;
      if (splits) {
        // Both halves keep the winding of the original face.
        this.faces[faceIndex] = loop.slice(p, q + 1);
        this.faces.push([...loop.slice(q), ...loop.slice(0, p + 1)]);
        changed = true;
      } else {
        this.faces[faceIndex] = loop;
      }
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
      this.faces[faceIndex] = this.faces[faceIndex].map((vertex) => copies.get(vertex));
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

  // The objects as { id, name, vertices, faces } with index lists, in the
  // order of `objects`. (Called "islands" by the callers: before objects had
  // an identity of their own, they were the connected pieces of the mesh.)
  islands() {
    this.adoptObjects();
    const byId = new Map(
      this.objects.map(({ id, name }) => [id, { id, name, vertices: [], faces: [] }]),
    );
    this.vertexObject.forEach((id, vertex) => byId.get(id).vertices.push(vertex));
    this.faces.forEach((face, i) => byId.get(this.vertexObject[face[0]]).faces.push(i));
    return [...byId.values()];
  }

  // Makes sure every vertex has a known object. Data that carries none (a
  // state saved before objects existed) gets one object per connected piece.
  adoptObjects() {
    const known = new Set(this.objects.map((object) => object.id));
    const complete =
      this.vertexObject.length === this.vertices.length && this.vertexObject.every((id) => known.has(id));
    if (complete) return;
    this.objects = [];
    this.vertexObject = new Array(this.vertices.length);
    for (const piece of this.connectedPieces()) {
      const id = this.addObject('Объект');
      for (const vertex of piece) this.vertexObject[vertex] = id;
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
      .map((face) => face.map((i) => remap.get(i)));
    this.wires = this.wires
      .filter((wire) => wire.every((i) => remap.has(i)))
      .map((wire) => wire.map((i) => remap.get(i)));
    // An object with no vertices left is gone.
    this.vertexObject = this.vertexObject.filter((_, i) => remap.has(i));
    const alive = new Set(this.vertexObject);
    this.objects = this.objects.filter((object) => alive.has(object.id));
    return remap;
  }
}

// The theme's colours as THREE.Color objects; loadColors() refills them.
const COLOR_SURFACE = new THREE.Color();
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
// A dot is a flat sprite at the depth of its vertex, so the faces and edges
// that meet at the vertex and come towards the camera would cut into it. To
// stay whole, each dot is pulled towards the eye along its own line of sight
// (which leaves it in place on screen) by POINT_DEPTH_BIAS times its radius,
// measured in world units at its depth. Vertices on the far side of the object
// are still hidden; only a wall thinner than that pull lets one show through.
const POINT_SIZE = 8; // px
const POINT_SELECTED_SCALE = 1.5; // a selected vertex is this much larger
const POINT_DEPTH_BIAS = 3;

const POINT_VERTEX_SHADER = /* glsl */ `
  uniform float size; // px, in device pixels
  uniform float pixelWorld; // world size of a CSS pixel at unit distance
  attribute vec3 color;
  attribute float scale; // per-vertex size factor
  varying vec3 vColor;

  void main() {
    vColor = color;
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    float pull = ${POINT_DEPTH_BIAS.toFixed(1)} * ${(POINT_SIZE / 2).toFixed(1)} * scale * pixelWorld * -viewPosition.z;
    viewPosition.xyz -= normalize(viewPosition.xyz) * pull;
    gl_Position = projectionMatrix * viewPosition;
    gl_PointSize = size * scale;
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
    uniforms: { size: { value: POINT_SIZE }, pixelWorld: { value: 0.001 } },
    vertexShader: POINT_VERTEX_SHADER,
    fragmentShader: POINT_FRAGMENT_SHADER,
    transparent: true, // smooth rim; also puts the dots after every opaque object
    depthWrite: false,
  });
}

// Thick lines: plain GL lines are always one pixel wide.
function edgeOverlay(color) {
  return new LineSegments2(new LineSegmentsGeometry(), new LineMaterial({ color, linewidth: 3 }));
}

// Render model: surface, edges and vertex points built from an EditableMesh.
export class MeshView {
  constructor(mesh) {
    this.mesh = mesh;
    this.group = new THREE.Group();

    this.solid = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshStandardMaterial({
        color: COLOR_SURFACE,
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
    this.points.onBeforeRender = (renderer, _scene, camera) => {
      const { uniforms } = this.points.material;
      uniforms.size.value = POINT_SIZE * renderer.getPixelRatio();
      uniforms.pixelWorld.value =
        (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / renderer.domElement.clientHeight;
    };

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
    this.sketchLine.renderOrder = 3;
    this.sketchLine.visible = false;
    this.sketchPoints = new THREE.Points(new THREE.BufferGeometry(), pointsMaterial());
    this.sketchPoints.material.depthTest = false;
    this.sketchPoints.renderOrder = 6;
    this.sketchPoints.onBeforeRender = this.points.onBeforeRender;
    this.sketchPoints.visible = false;

    // Preview of a cut; drawn through the model so the whole outline is seen.
    this.cutLine = edgeOverlay(COLOR_CUT);
    this.cutLine.material.depthTest = false;
    this.cutLine.renderOrder = 2;
    this.cutLine.visible = false;

    const objects = [
      this.solid,
      ...Object.values(this.tints),
      this.wire,
      this.points,
      ...Object.values(this.overlays),
      this.cutLine,
      this.sketchLine,
      this.sketchPoints,
    ];
    for (const object of objects) {
      object.frustumCulled = false;
      this.group.add(object);
    }
    this.rebuild();
  }

  // Call after topology changes (vertices or faces added/removed).
  rebuild() {
    const { vertices, faces } = this.mesh;

    this.triangleIndices = [];
    this.triangleFaces = []; // triangle index -> face index, for picking
    this.faceTriangles = faces.map((_, faceIndex) => this.mesh.triangulate(faceIndex));
    this.faceTriangles.forEach((triangles, faceIndex) => {
      for (const triangle of triangles) {
        this.triangleIndices.push(...triangle);
        this.triangleFaces.push(faceIndex);
      }
    });
    this.edgeIndices = this.mesh.edges().flat();

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
    this.updatePositions();
    this.updateColors(new Set(), -1);
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
    this.solid.material.color.copy(COLOR_SURFACE);
    this.applyLook();
    this.overlays.selectedFaces.material.color.copy(COLOR_SELECTED);
    this.overlays.hoveredFaces.material.color.copy(COLOR_HOVERED);
    this.overlays.selectedEdges.material.color.copy(COLOR_SELECTED);
    this.overlays.hoveredEdges.material.color.copy(COLOR_HOVERED);
    this.cutLine.material.color.copy(COLOR_CUT);
    this.sketchLine.material.color.copy(COLOR_SELECTED);
    this.tints.front.material.color.set(theme.faceFront);
    this.tints.back.material.color.set(theme.faceBack);
  }

  // How the object is drawn:
  //   'solid'       - the lit surface;
  //   'wireframe'   - edges and vertices only;
  //   'orientation' - the surface with front sides in one colour and back sides in another.
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
    for (const tint of Object.values(this.tints)) {
      tint.visible = !this.focus && this.shading === 'orientation';
    }
    this.wire.material.color.copy(wireframe ? COLOR_WIRE_FOCUS : COLOR_WIRE);
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
  setCutPreview(segments, { dash = 0.1, gap = 0.1, phase = 0 } = {}) {
    this.cutLine.visible = segments.length > 0;
    if (!this.cutLine.visible) return;

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
    this.cutLine.geometry.dispose();
    this.cutLine.geometry = new LineSegmentsGeometry().setPositions(positions);
  }

  // `highlight` lists face indices and [a, b] vertex pairs, see NO_HIGHLIGHT.
  setHighlight(highlight) {
    this.highlight = highlight;
    this.applyHighlight();
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
      scale.setX(i, selection.has(i) ? POINT_SELECTED_SCALE : 1);
    }
    attribute.needsUpdate = true;
    scale.needsUpdate = true;
  }
}
