// Carving: a shape cut out of a box by three stacks of sections - as sprite
// stacking builds a model of slices, only from three sides at once. Each
// stack has `count` levels across the box (`box`: { min, max }, [x, y, z]
// each), evenly, the first and the last on its sides: by height (stack 'y',
// drawn as seen from above), by depth (stack 'z', from the front) and by
// width (stack 'x', from the side). A level holds one flat shape - the
// stack's section there; between two levels the section goes from the one
// to the other in straight lines (a loft). The shape is what is inside the
// solids of all three stacks. So a circle from above and a triangle from the
// front and from the side make a cone; a narrow square, a wide one, then a
// narrow one again make a vase.
//
//   carve  { box, stacks: { y, z, x } }
//   stack  { count, slices: slice[] }   (`count` long: a slice is a level)
//   slice  null       - whole: the box's section, as a new level is
//          []         - empty: nothing of the box there (the solid has a gap
//                       from the level before to the level after)
//          [{ points: [[u, v], ...] }]  - its shape, in the stack's plane
//                       (see ACROSS)
//
// buildCarve() gives the shape as the editor's meshes are made: vertices and
// faces - flat polygons, wound counter-clockwise seen from outside.

// For each stack: the world's axes (0 x, 1 y, 2 z) its sections are drawn
// in, as [u, v], and the one its levels go along.
export const ACROSS = { y: [0, 2], z: [0, 1], x: [2, 1] };
export const ALONG = { y: 1, z: 2, x: 0 };
export const STACKS = ['y', 'z', 'x'];

const ROUND = 1e5; // vertices are put on a 1e-5 grid: the library's float32 rounding taken out
const LINE_ANGLE = 1e-3; // radians: a turn this small at a vertex is a straight line

let library = null;

// The geometry library (manifold-3d, WebAssembly), loaded once.
export async function carver() {
  if (!library) {
    library = import('manifold-3d').then(async ({ default: Module }) => {
      const wasm = await Module();
      wasm.setup();
      return wasm;
    });
  }
  return library;
}

// A carve as it starts: `count` whole levels in each stack (a number, or
// { y, z, x }).
export function newCarve(box, count = 4) {
  const counts = typeof count === 'number' ? { y: count, z: count, x: count } : count;
  const stacks = {};
  for (const name of STACKS) stacks[name] = { count: counts[name], slices: Array(counts[name]).fill(null) };
  return { box: { min: [...box.min], max: [...box.max] }, stacks };
}

// Where level `i` of a stack of `count` is, along its axis (one alone: in the middle).
export function levelAt(box, name, count, i) {
  const w = ALONG[name];
  return count === 1 ? (box.min[w] + box.max[w]) / 2 : box.min[w] + ((box.max[w] - box.min[w]) * i) / (count - 1);
}

// The stack made `count` levels: each new one the old one nearest to it.
export function restack(stack, count) {
  const slices = [];
  for (let i = 0; i < count; i++) {
    const at = count === 1 ? 0.5 : i / (count - 1);
    slices.push(structuredClone(stack.slices[Math.round(at * (stack.count - 1))] ?? null));
  }
  return { count, slices };
}

// The box's section in a stack's plane, as a level's rectangle.
export function sectionOf(box, name) {
  const [u, v] = ACROSS[name];
  return [[box.min[u], box.min[v]], [box.max[u], box.min[v]], [box.max[u], box.max[v]], [box.min[u], box.max[v]]];
}

// A level's shape: its points, counter-clockwise; null for none (empty).
function shapeOf(box, name, slice) {
  if (slice === null) return sectionOf(box, name);
  const points = slice[0]?.points;
  if (!points || points.length < 3) return null;
  return signedArea(points) < 0 ? [...points].reverse() : points;
}

function signedArea(points) {
  let sum = 0;
  points.forEach(([x0, y0], i) => {
    const [x1, y1] = points[(i + 1) % points.length];
    sum += x0 * y1 - x1 * y0;
  });
  return sum / 2;
}

// The solid between two sections - `a` at `wa` and `b` at `wb` along the
// stack's axis (wa < wb) - as the library's: their faces the two caps, and a
// band of triangles between their outlines, each step along the one that
// leaves the shorter diagonal (the usual way of joining two outlines), both
// begun at their corners nearest each other. A band that does not make a
// sound solid (very unlike outlines) is the two sections' hull instead.
// `frame` takes a point of the stack's (u, v, w) into the world.
function loft(wasm, a, wa, b, wb, frame) {
  const n = a.length;
  const m = b.length;
  // b turned to begin at its corner nearest a's first.
  let first = 0;
  const away = (p) => Math.hypot(p[0] - a[0][0], p[1] - a[0][1]);
  b.forEach((p, k) => {
    if (away(p) < away(b[first])) first = k;
  });
  const bb = b.map((_, k) => b[(first + k) % m]);
  const local = [...a.map(([u, v]) => [u, v, wa]), ...bb.map(([u, v]) => [u, v, wb])];
  const triangles = [];
  // The caps: a looks back along the axis, b forward.
  for (const [i, j, k] of earcut2(a)) triangles.push([i, k, j]);
  for (const [i, j, k] of earcut2(bb)) triangles.push([n + i, n + j, n + k]);
  // The band.
  const dist = (p, q) => Math.hypot(local[p][0] - local[q][0], local[p][1] - local[q][1], local[p][2] - local[q][2]);
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    const here = i % n;
    const there = n + (j % m);
    const nextA = (i + 1) % n;
    const nextB = n + ((j + 1) % m);
    if (j >= m || (i < n && dist(nextA, there) <= dist(here, nextB))) {
      triangles.push([here, nextA, there]);
      i++;
    } else {
      triangles.push([here, nextB, there]);
      j++;
    }
  }
  const world = local.map((p) => frame.place(p));
  const mesh = new wasm.Mesh({
    numProp: 3,
    vertProperties: new Float32Array(world.flat()),
    // (a frame that mirrors turns every triangle over)
    triVerts: new Uint32Array(triangles.flatMap(([p, q, r]) => (frame.mirrored ? [p, r, q] : [p, q, r]))),
  });
  let solid = null;
  try {
    solid = new wasm.Manifold(mesh);
    if (solid.status() === 'NoError' && solid.volume() > 1e-12) return solid;
  } catch {
    // (not a sound solid)
  }
  solid?.delete();
  return wasm.Manifold.hull(world);
}

// A polygon's triangles ([u, v] points, counter-clockwise), by index: ear
// clipping - a corner whose triangle turns left and holds no other corner is
// cut off, again and again.
function earcut2(points) {
  const result = [];
  const left = points.map((_, i) => i);
  const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const inside = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  for (let guard = 0; left.length > 3 && guard < 10000; guard++) {
    let cut = false;
    for (let k = 0; k < left.length; k++) {
      const i0 = left[(k - 1 + left.length) % left.length];
      const i1 = left[k];
      const i2 = left[(k + 1) % left.length];
      const [a, b, c] = [points[i0], points[i1], points[i2]];
      if (cross(a, b, c) <= 1e-12) continue;
      if (left.some((x) => x !== i0 && x !== i1 && x !== i2 && inside(points[x], a, b, c))) continue;
      result.push([i0, i1, i2]);
      left.splice(k, 1);
      cut = true;
      break;
    }
    if (!cut) break; // (what is left is no simple polygon: fanned out below)
  }
  for (let k = 1; k < left.length - 1; k++) result.push([left[0], left[k], left[k + 1]]);
  return result;
}

// The solid of one stack: its levels' sections lofted one to the next (one
// level alone: its section through the whole box). Null if nothing of it is
// there.
function solidOf(wasm, box, name, stack) {
  const [u, v] = ACROSS[name];
  const w = ALONG[name];
  const frame = {
    place: (p) => {
      const out = [0, 0, 0];
      out[u] = p[0];
      out[v] = p[1];
      out[w] = p[2];
      return out;
    },
    // (the axes in an odd order: the frame is the world mirrored)
    mirrored: !['0,1,2', '1,2,0', '2,0,1'].includes(`${u},${v},${w}`),
  };
  const shapes = stack.slices.map((slice) => shapeOf(box, name, slice));
  const pieces = [];
  try {
    if (stack.count === 1) {
      if (shapes[0]) pieces.push(loft(wasm, shapes[0], box.min[w], shapes[0], box.max[w], frame));
    } else {
      for (let i = 0; i + 1 < stack.count; i++) {
        if (!shapes[i] || !shapes[i + 1]) continue; // (an empty level: a gap)
        pieces.push(loft(wasm, shapes[i], levelAt(box, name, stack.count, i), shapes[i + 1], levelAt(box, name, stack.count, i + 1), frame));
      }
    }
    if (pieces.length === 0) return null;
    return wasm.Manifold.union(pieces);
  } finally {
    for (const piece of pieces) piece.delete();
  }
}

// The shape: { vertices: [[x, y, z]], faces: [[i, ...]] }, or null if nothing
// of the box is left.
export async function buildCarve(carve) {
  const wasm = await carver();
  const solids = STACKS.map((name) => solidOf(wasm, carve.box, name, carve.stacks[name]));
  try {
    if (solids.some((solid) => solid === null)) return null;
    const shape = wasm.Manifold.intersection(solids);
    try {
      if (shape.isEmpty()) return null;
      const mesh = shape.getMesh();
      return polygonsOf(mesh.vertProperties, mesh.numProp, mesh.triVerts);
    } finally {
      shape.delete();
    }
  } finally {
    for (const solid of solids) solid?.delete();
  }
}

// --- triangles into flat polygons ----------------------------------------------
//
// The library gives triangles. Those in one plane that touch are grown into
// polygons as large as they go while each stays one simple polygon - no
// holes: a face with a hole in it comes out as several. Every vertex on a
// polygon's border is kept (a vertex dropped from one face and not from its
// neighbour would leave a crack).

function polygonsOf(positions, stride, triangles) {
  // Vertices, the same place once.
  const index = new Map();
  const vertices = [];
  const remap = [];
  for (let i = 0; i < positions.length / stride; i++) {
    const p = [0, 1, 2].map((k) => Math.round(positions[i * stride + k] * ROUND) / ROUND);
    const key = p.join(',');
    if (!index.has(key)) {
      index.set(key, vertices.length);
      vertices.push(p.map((value) => (Object.is(value, -0) ? 0 : value)));
    }
    remap.push(index.get(key));
  }
  const tris = [];
  for (let t = 0; t < triangles.length; t += 3) {
    const tri = [remap[triangles[t]], remap[triangles[t + 1]], remap[triangles[t + 2]]];
    if (new Set(tri).size === 3) tris.push(tri);
  }
  // Each triangle's plane, as a key: its normal and its distance, rounded.
  const planeOf = (tri) => {
    const [a, b, c] = tri.map((i) => vertices[i]);
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const length = Math.hypot(...n) || 1;
    const unit = n.map((value) => Math.round((value / length) * 1e4) / 1e4);
    const distance = Math.round((unit[0] * a[0] + unit[1] * a[1] + unit[2] * a[2]) * 1e4) / 1e4;
    return `${unit.join(',')}|${distance}`;
  };
  const planes = tris.map(planeOf);
  // Who is across each edge (a -> b is one triangle's, b -> a its neighbour's).
  const owner = new Map();
  tris.forEach((tri, t) => tri.forEach((a, k) => owner.set(`${a}>${tri[(k + 1) % 3]}`, t)));

  const taken = new Array(tris.length).fill(false);
  const faces = [];
  for (let seed = 0; seed < tris.length; seed++) {
    if (taken[seed]) continue;
    // The region's border: directed edges a -> b (its inside on their left).
    const border = new Map(); // a -> b
    const onBorder = new Map(); // vertex -> times on the border
    const addEdge = (a, b) => {
      border.set(a, b);
      onBorder.set(a, (onBorder.get(a) ?? 0) + 1);
    };
    const removeEdge = (a) => {
      border.delete(a);
      const left = onBorder.get(a) - 1;
      if (left) onBorder.set(a, left);
      else onBorder.delete(a);
    };
    taken[seed] = true;
    tris[seed].forEach((a, k) => addEdge(a, tris[seed][(k + 1) % 3]));
    const queue = [seed];
    while (queue.length) {
      const t = queue.shift();
      for (let k = 0; k < 3; k++) {
        const a = tris[t][k];
        const b = tris[t][(k + 1) % 3];
        const next = owner.get(`${b}>${a}`);
        if (next === undefined || taken[next] || planes[next] !== planes[seed] || border.get(a) !== b) continue;
        // The neighbour across a -> b: shares this edge, perhaps more of the border.
        const tri = tris[next];
        const edges = tri.map((x, j) => [x, tri[(j + 1) % 3]]);
        const shared = edges.filter(([x, y]) => border.get(y) === x);
        const free = edges.filter(([x, y]) => border.get(y) !== x);
        if (shared.length === 1) {
          // Its far corner must not be on the border already: the region would pinch.
          const far = tri.find((x) => x !== a && x !== b);
          if (onBorder.has(far)) continue;
        }
        // (Two shared: it fills a notch, the corner between them leaves the border.)
        for (const [, y] of shared) removeEdge(y);
        for (const [x, y] of free) addEdge(x, y);
        taken[next] = true;
        queue.push(next);
      }
    }
    // The border as one loop.
    const start = border.keys().next().value;
    const loop = [start];
    for (let at = border.get(start); at !== start && loop.length <= border.size; at = border.get(at)) loop.push(at);
    faces.push(loop);
  }
  return withoutMidpoints(vertices, mergeFlat(faces, vertices));
}

// The growing above can leave one flat region in several polygons (the
// order it takes triangles in). Two neighbours in one plane are made one
// while their shared border is one unbroken chain, the chain's inner
// vertices used by no other face (else a face would end in the middle of
// another's side), and the outcome no polygon that touches itself.
function mergeFlat(faces, vertices) {
  let polygons = faces.map((face) => [...face]);
  // A polygon's plane, as a key: its normal (Newell's, of all its corners) and distance, rounded.
  const planeKey = (face) => {
    const n = [0, 0, 0];
    face.forEach((i, k) => {
      const a = vertices[i];
      const b = vertices[face[(k + 1) % face.length]];
      n[0] += (a[1] - b[1]) * (a[2] + b[2]);
      n[1] += (a[2] - b[2]) * (a[0] + b[0]);
      n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    });
    const length = Math.hypot(...n) || 1;
    const unit = n.map((value) => Math.round((value / length) * 1e4) / 1e4);
    const p = vertices[face[0]];
    return `${unit.join(',')}|${Math.round((unit[0] * p[0] + unit[1] * p[1] + unit[2] * p[2]) * 1e4) / 1e4}`;
  };
  let merged = true;
  while (merged) {
    merged = false;
    const users = new Map(); // vertex -> how many faces use it
    for (const face of polygons) for (const v of face) users.set(v, (users.get(v) ?? 0) + 1);
    const owner = new Map(); // directed edge -> face index
    polygons.forEach((face, f) => face.forEach((a, k) => owner.set(`${a}>${face[(k + 1) % face.length]}`, f)));
    const keys = polygons.map(planeKey);
    for (let f = 0; f < polygons.length && !merged; f++) {
      const a = polygons[f];
      const neighbours = new Set();
      a.forEach((x, k) => {
        const g = owner.get(`${a[(k + 1) % a.length]}>${x}`);
        if (g !== undefined && g !== f && keys[g] === keys[f]) neighbours.add(g);
      });
      for (const g of neighbours) {
        const joined = join(a, polygons[g], users);
        if (!joined) continue;
        polygons = polygons.filter((_, i) => i !== f && i !== g);
        polygons.push(joined);
        merged = true;
        break;
      }
    }
  }
  return polygons;
}

// Polygons `a` and `b` (sharing edges a: x -> y, b: y -> x) made one, or null.
function join(a, b, users) {
  const n = a.length;
  const inB = new Set(b.map((x, k) => `${x}>${b[(k + 1) % b.length]}`));
  const shared = a.map((x, k) => inB.has(`${a[(k + 1) % n]}>${x}`));
  const count = shared.filter(Boolean).length;
  if (count === 0 || count === n) return null;
  // The run of shared edges must be one: it starts after a free edge.
  const start = shared.findIndex((s, k) => s && !shared[(k - 1 + n) % n]);
  for (let k = 0; k < count; k++) if (!shared[(start + k) % n]) return null;
  const chain = Array.from({ length: count + 1 }, (_, k) => a[(start + k) % n]); // a's order
  // Its inner vertices go: only if these two faces are all that use them.
  for (const v of chain.slice(1, -1)) if (users.get(v) !== 2) return null;
  // a from the chain's end round to its start, then b from there round to the chain's end.
  const out = [];
  for (let k = 0; k <= n - count; k++) out.push(a[(start + count + k) % n]);
  const m = b.length;
  const from = b.indexOf(chain[0]);
  for (let k = 1; ; k++) {
    const v = b[(from + k) % m];
    if (v === chain[count]) break;
    out.push(v);
    if (k > m) return null;
  }
  return new Set(out).size === out.length && out.length >= 3 ? out : null;
}

// Vertices that are only a point on a straight edge - two neighbours, in a
// line with them (left where the slices were put together) - taken out of
// every face, and the vertices numbered anew.
function withoutMidpoints(vertices, faces) {
  // (Again while any goes: one taken out can leave its neighbour in a line too.)
  for (;;) {
    const neighbours = vertices.map(() => new Set());
    for (const face of faces) face.forEach((a, k) => {
      const b = face[(k + 1) % face.length];
      neighbours[a].add(b);
      neighbours[b].add(a);
    });
    // In a line: the turn at v less than LINE_ANGLE (the corners come from
    // the library rounded, see ROUND - a straight edge is not exactly so).
    const inLine = (a, v, b) => {
      const e1 = [0, 1, 2].map((k) => vertices[v][k] - vertices[a][k]);
      const e2 = [0, 1, 2].map((k) => vertices[b][k] - vertices[v][k]);
      const cross = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const dot = e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2];
      return dot > 0 && Math.hypot(...cross) <= LINE_ANGLE * Math.hypot(...e1) * Math.hypot(...e2);
    };
    // Gone: a vertex no face has any more (left over by mergeFlat()), and one only on a straight edge.
    const gone = vertices.map((_, v) => {
      if (neighbours[v].size === 0) return true;
      if (neighbours[v].size !== 2) return false;
      const [a, b] = neighbours[v];
      return inLine(a, v, b);
    });
    if (!gone.some(Boolean)) return { vertices, faces };
    const kept = [];
    const number = vertices.map((p, v) => (gone[v] ? -1 : kept.push(p) - 1));
    vertices = kept;
    faces = faces.map((face) => face.filter((v) => !gone[v]).map((v) => number[v])).filter((face) => face.length >= 3);
  }
}
