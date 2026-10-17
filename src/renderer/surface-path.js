import * as THREE from 'three';

// A straight line along the surface: the shortest way from one point of it
// to another that keeps to the surface, across the faces between them - as
// a string pulled tight over the model would lie (a geodesic).
//
// It is found in three steps:
//   1. the strip: the triangles to go through, one after another across
//      shared edges - those a rough shortest way crosses, found from point
//      to point over a few points on every edge (Steiner points, Dijkstra's);
//   2. the strip unfolded: laid flat, each triangle turned about the edge it
//      shares with the one before into that one's plane, as a paper model is
//      opened out - nothing changes length;
//   3. the shortest way through the flat strip (the funnel algorithm): a
//      straight line where the strip lets it be one, bent round the strip's
//      corners where it does not.
// It is the shortest way through that one strip, not over every strip there
// could be: on a low-poly model that is the shortest way, near enough.

const EPSILON = 1e-9;

// The way from `from` to `to` ({ point: Vector3, triangle } each: a point on
// the surface, in that triangle) over the triangles `triangles` (vertex
// indices, three a triangle, into `vertices`). As [{ a, b, triangle }]: the
// line's pieces in order, each within one triangle. Null if the two cannot
// be joined over the surface: no chain of shared edges leads from one to the other.
export function surfacePath(vertices, triangles, from, to) {
  if (from.triangle === to.triangle) return [{ a: from.point.clone(), b: to.point.clone(), triangle: from.triangle }];
  const strip = stripBetween(vertices, triangles, from, to);
  if (!strip) return null;
  const { flat, portals } = unfold(vertices, triangles, strip, from.point, to.point);
  const corners = funnel([{ left: flat.start, right: flat.start }, ...portals.map(({ left, right }) => ({ left, right })), { left: flat.end, right: flat.end }]);
  // Where the line crosses each edge of the strip, back on the model.
  const points = [from.point.clone()];
  let piece = 0;
  for (const portal of portals) {
    let crossing = null;
    while (piece < corners.length - 1) {
      crossing = crossAt(corners[piece], corners[piece + 1], portal.u2, portal.v2);
      if (crossing !== null) break;
      piece++;
    }
    const along = crossing ?? closestOn(corners[Math.min(piece, corners.length - 1)], portal.u2, portal.v2);
    points.push(vertices[portal.u].clone().lerp(vertices[portal.v], along));
  }
  points.push(to.point.clone());
  return strip.map((triangle, k) => ({ a: points[k], b: points[k + 1], triangle }));
}

// Barycentric coordinates of a point in a triangle (three Vector3s): the
// weights of its corners. (For a point that lies in the triangle's plane.)
export function barycentric(point, a, b, c) {
  return new THREE.Triangle(a, b, c).getBarycoord(point, new THREE.Vector3());
}

// --- 1. the strip ---------------------------------------------------------------

// Points on every edge a rough way goes through (Steiner points): the more,
// the surer the strip is the right one.
const EDGE_POINTS = 4;

// The triangles from `from`'s to `to`'s, as a list of their numbers; null if none.
// They are those a rough shortest way goes through: from point to point
// over the surface - each point on an edge, a few to an edge - by Dijkstra's.
function stripBetween(vertices, triangles, from, to) {
  const count = triangles.length / 3;
  const corner = (t, k) => triangles[t * 3 + k];
  // The edges, and the triangles on each.
  const edges = [];
  const edgeOf = new Map();
  const triangleEdges = [];
  for (let t = 0; t < count; t++) {
    const own = [];
    for (let k = 0; k < 3; k++) {
      const a = corner(t, k);
      const b = corner(t, (k + 1) % 3);
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (!edgeOf.has(key)) {
        edgeOf.set(key, edges.length);
        edges.push({ a, b, triangles: [] });
      }
      const e = edgeOf.get(key);
      edges[e].triangles.push(t);
      own.push(e);
    }
    triangleEdges.push(own);
  }
  // The points: 0 is the start, 1 the end, then EDGE_POINTS on every edge.
  const START = 0;
  const END = 1;
  const pointOf = (node) => {
    if (node === START) return from.point;
    if (node === END) return to.point;
    const e = Math.floor((node - 2) / EDGE_POINTS);
    const { a, b } = edges[e];
    return vertices[a].clone().lerp(vertices[b], ((node - 2) % EDGE_POINTS + 0.5) / EDGE_POINTS);
  };
  const places = new Map();
  const place = (node) => {
    if (!places.has(node)) places.set(node, pointOf(node));
    return places.get(node);
  };
  // The points that can be gone to from one, each with the triangle crossed on the way.
  const onward = (node) => {
    const through = node === START ? [from.triangle] : node === END ? [] : edges[Math.floor((node - 2) / EDGE_POINTS)].triangles;
    const steps = [];
    for (const t of through) {
      const own = node === START ? -1 : Math.floor((node - 2) / EDGE_POINTS);
      for (const e of triangleEdges[t]) {
        if (e === own) continue;
        for (let i = 0; i < EDGE_POINTS; i++) steps.push([2 + e * EDGE_POINTS + i, t]);
      }
      if (t === to.triangle) steps.push([END, t]);
    }
    return steps;
  };
  const distance = new Map([[START, 0]]);
  const previous = new Map(); // node -> [node before, triangle crossed]
  const done = new Set();
  const queue = new Heap();
  queue.push(0, START);
  while (queue.size) {
    const [d, node] = queue.pop();
    if (done.has(node)) continue;
    done.add(node);
    if (node === END) break;
    const here = place(node);
    for (const [next, t] of onward(node)) {
      if (done.has(next)) continue;
      const way = d + here.distanceTo(place(next));
      if (way < (distance.get(next) ?? Infinity)) {
        distance.set(next, way);
        previous.set(next, [node, t]);
        queue.push(way, next);
      }
    }
  }
  if (!done.has(END)) return null;
  const strip = [];
  for (let node = END; node !== START; node = previous.get(node)[0]) {
    const t = previous.get(node)[1];
    if (strip[0] !== t) strip.unshift(t);
  }
  // Each triangle to share an edge with the next, or the strip cannot be laid flat.
  for (let k = 0; k + 1 < strip.length; k++) {
    const shared = [0, 1, 2].filter((i) => [0, 1, 2].some((j) => corner(strip[k], i) === corner(strip[k + 1], j)));
    if (shared.length !== 2) return null;
  }
  return strip;
}

// A binary heap of [key, value], the smallest key first.
class Heap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(key, value) {
    const { items } = this;
    items.push([key, value]);
    let i = items.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (items[up][0] <= items[i][0]) break;
      [items[up], items[i]] = [items[i], items[up]];
      i = up;
    }
  }

  pop() {
    const { items } = this;
    const top = items[0];
    const last = items.pop();
    if (items.length) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let least = i;
        if (l < items.length && items[l][0] < items[least][0]) least = l;
        if (r < items.length && items[r][0] < items[least][0]) least = r;
        if (least === i) break;
        [items[least], items[i]] = [items[i], items[least]];
        i = least;
      }
    }
    return top;
  }
}

// --- 2. the strip unfolded ---------------------------------------------------------

// Lays the strip flat in the plane of its first triangle. Returns the start
// and the end in that plane (`flat`), and the edges between one triangle and
// the next (`portals`): their vertices (u, v), where those lie flat (u2,
// v2), and which of them is on the left and which on the right going through.
function unfold(vertices, triangles, strip, start, end) {
  const corners = (t) => [triangles[t * 3], triangles[t * 3 + 1], triangles[t * 3 + 2]];
  // The first triangle's plane: x along its first side, y across it.
  const [a, b, c] = corners(strip[0]).map((i) => vertices[i]);
  const xAxis = b.clone().sub(a).normalize();
  const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
  const yAxis = normal.clone().cross(xAxis);
  const flatten = (point) => {
    const d = point.clone().sub(a);
    return new THREE.Vector2(d.dot(xAxis), d.dot(yAxis));
  };
  // Where each corner of the triangle reached so far lies flat.
  let laid = new Map(corners(strip[0]).map((i) => [i, flatten(vertices[i])]));
  const portals = [];
  for (let k = 0; k + 1 < strip.length; k++) {
    const here = corners(strip[k]);
    const next = corners(strip[k + 1]);
    const [u, v] = here.filter((i) => next.includes(i));
    const behind = here.find((i) => i !== u && i !== v);
    const ahead = next.find((i) => i !== u && i !== v);
    const [u2, v2, p2] = [laid.get(u), laid.get(v), laid.get(behind)];
    // The next triangle's third corner: as far from u and v as it is on the
    // model, on the other side of their edge from this triangle's.
    const w2 = apex(u2, v2, vertices[ahead].distanceTo(vertices[u]), vertices[ahead].distanceTo(vertices[v]), p2);
    const vLeft = cross(u2.clone().sub(p2), v2.clone().sub(p2)) > 0;
    portals.push({ u, v, u2, v2, left: vLeft ? v2 : u2, right: vLeft ? u2 : v2 });
    laid = new Map([[u, u2], [v, v2], [ahead, w2]]);
  }
  // The end, where it lies in the last triangle - by its weights there.
  const last = corners(strip[strip.length - 1]);
  const weights = barycentric(end, ...last.map((i) => vertices[i]));
  const flatEnd = new THREE.Vector2();
  last.forEach((i, k) => flatEnd.addScaledVector(laid.get(i), weights.getComponent(k)));
  return { flat: { start: flatten(start), end: flatEnd }, portals };
}

// The point at distances du from u2 and dv from v2, on the side of the line
// u2-v2 away from `away`.
function apex(u2, v2, du, dv, away) {
  const side = v2.clone().sub(u2);
  const d = Math.max(side.length(), EPSILON);
  const along = (du * du - dv * dv + d * d) / (2 * d);
  const height = Math.sqrt(Math.max(0, du * du - along * along));
  const base = u2.clone().addScaledVector(side, along / d);
  const across = new THREE.Vector2(-side.y, side.x).divideScalar(d);
  const flip = cross(side, away.clone().sub(u2)) > 0 ? -1 : 1;
  return base.addScaledVector(across, flip * height);
}

function cross(a, b) {
  return a.x * b.y - a.y * b.x;
}

// --- 3. the shortest way through the strip ---------------------------------------------

// The corners of the shortest way through a row of portals ({ left, right },
// flat points), from the first to the last (each of those a single point):
// the "simple stupid funnel" (Mikko Mononen's).
function funnel(portals) {
  // Twice the signed area of the triangle a b c, negative when c is to the left of a->b.
  const area = (a, b, c) => (c.x - a.x) * (b.y - a.y) - (b.x - a.x) * (c.y - a.y);
  const same = (a, b) => a.distanceToSquared(b) < EPSILON * EPSILON;
  const path = [portals[0].left.clone()];
  let apexPoint = portals[0].left;
  let left = portals[0].left;
  let right = portals[0].right;
  let apexIndex = 0;
  let leftIndex = 0;
  let rightIndex = 0;
  for (let i = 1; i < portals.length; i++) {
    const nextLeft = portals[i].left;
    const nextRight = portals[i].right;
    // The right side closes in, unless it would cross the left one.
    if (area(apexPoint, right, nextRight) <= 0) {
      if (same(apexPoint, right) || area(apexPoint, left, nextRight) > 0) {
        right = nextRight;
        rightIndex = i;
      } else {
        path.push(left.clone());
        apexPoint = left;
        apexIndex = leftIndex;
        right = left = apexPoint;
        rightIndex = leftIndex = apexIndex;
        i = apexIndex;
        continue;
      }
    }
    // The same for the left side.
    if (area(apexPoint, left, nextLeft) >= 0) {
      if (same(apexPoint, left) || area(apexPoint, right, nextLeft) < 0) {
        left = nextLeft;
        leftIndex = i;
      } else {
        path.push(right.clone());
        apexPoint = right;
        apexIndex = rightIndex;
        right = left = apexPoint;
        rightIndex = leftIndex = apexIndex;
        i = apexIndex;
        continue;
      }
    }
  }
  const end = portals[portals.length - 1].left;
  if (!same(path[path.length - 1], end)) path.push(end.clone());
  return path;
}

// Where the piece a-b crosses the edge u-v: how far along the edge (0 at u,
// 1 at v), or null if it does not.
function crossAt(a, b, u, v) {
  const r = b.clone().sub(a);
  const s = v.clone().sub(u);
  const denominator = cross(r, s);
  if (Math.abs(denominator) < EPSILON) return null;
  const q = u.clone().sub(a);
  const t = cross(q, s) / denominator; // along a-b
  const along = cross(q, r) / denominator; // along u-v
  const slack = 1e-6;
  if (t < -slack || t > 1 + slack || along < -slack || along > 1 + slack) return null;
  return Math.min(1, Math.max(0, along));
}

// How far along the edge u-v the point nearest to p is (0..1).
function closestOn(p, u, v) {
  const s = v.clone().sub(u);
  const length = s.lengthSq();
  return length < EPSILON ? 0 : Math.min(1, Math.max(0, p.clone().sub(u).dot(s) / length));
}
