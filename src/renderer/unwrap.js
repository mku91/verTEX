import * as THREE from 'three';
import { edgeKey, ATLAS } from './mesh.js';
import { quaternionOf } from './frames.js';

// The unwrap: where every face is on the texture atlas.
//
// Nothing is laid out unasked: an object is put on the atlas by the user
// (`atlas` on the object), and then its faces get places there - `uv` on each
// face, see mesh.js.
//
// Those places are worked out, not drawn. The project has one number - `ppu`,
// pixels per unit of length - and a face is laid on the atlas as it is in
// space, at that scale: no stretch, no skew, so a pixel is the same size on
// every face laid out so. The unit is a chart: the faces of one object that
// lie in one plane and hang together by their edges. A chart is laid flat by
// the axes of its plane (the grid on it stands upright in the object's own
// frame) and given free room on the atlas, which grows when there is none.
//
// That is done once. From then on a face's places are the user's: they are
// not changed when the model is - a face that is stretched afterwards has its
// picture stretched with it - nor moved about. The user moves, turns, flips
// and reshapes charts in the UV editor (`pin` and `shaped` on a face only say
// that it has been done), and "regenerate" has them laid out anew. Only a
// face that has no place yet - one an edit has made - is given one.

const SAME_PLANE = 1e-4; // how far apart two faces' planes may be, and their normals' cosine from 1
// Every chart has room for a rim of this many pixels all round it, which is
// its own: an export can repeat the chart's edge pixels there (see
// Atlas.extrude()), so that a renderer that blends neighbouring pixels at a
// face's edge blends in more of the same and not another face or nothing.
// Charts are therefore two rims apart, and one rim from the atlas' edge.
export const PADDING = 1;
const START_SIZE = 64; // px, an empty project's atlas
const MAX_SIZE = 4096;

const tidy = (value) => (Math.abs(value - Math.round(value)) < 1e-6 ? Math.round(value) : +value.toFixed(6));
const UNFOLD_HAIR = 1e-3; // px: nearer than this, two faces of an unfolded piece only touch (see unfold())
const PROJECT_LIMIT = 0.5; // the cosine of the most a face may be tilted in a projected piece (60 degrees: pixels drawn out twice)
const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const LEVEL_LIMIT = Math.sqrt(3) / 2; // how much of a direction may be height for it to be levelled (past this, no face it holds would stay within PROJECT_LIMIT)

// The charts of a mesh's faces that are still to be placed, each { faces, object, normal, flat } - `flat` a Map
// from a vertex of the chart to its place [x, y] in pixels, and `width`,
// `height` the chart's extent. Faces without a surface are in no chart.
export function chartsOf(mesh, ppu, atlas = ATLAS) {
  const { faces, vertices, vertexObject, objects } = mesh;
  const normals = faces.map((_, i) => mesh.faceNormal(i));
  const offsets = faces.map((face, i) => normals[i].dot(vertices[face[0]]));
  // Only the objects the user has put on this atlas are laid out on it.
  const onAtlas = new Set(objects.filter((object) => object.atlas === atlas).map((object) => object.id));
  // (A face that has places keeps them: see keptCharts().)
  const sound = (i) => normals[i].lengthSq() > 0.5 && onAtlas.has(vertexObject[faces[i][0]]) && !faces[i].uv;

  // Faces that share an edge and a plane are one chart.
  const root = faces.map((_, i) => i);
  const find = (i) => {
    while (root[i] !== i) i = root[i] = root[root[i]];
    return i;
  };
  const byEdge = new Map();
  faces.forEach((face, i) => {
    if (!sound(i)) return;
    face.forEach((a, k) => {
      const key = edgeKey(a, face[(k + 1) % face.length]);
      const other = byEdge.get(key);
      if (other === undefined) {
        byEdge.set(key, i);
      } else if (normals[i].dot(normals[other]) > 1 - SAME_PLANE && Math.abs(offsets[i] - offsets[other]) < SAME_PLANE) {
        root[find(i)] = find(other);
      }
    });
  });
  const groups = new Map();
  faces.forEach((_, i) => {
    if (!sound(i)) return;
    const key = find(i);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });

  const turns = new Map(objects.map((object) => [object.id, quaternionOf(object.rotation)]));
  return [...groups.values()].map((members) => {
    const object = vertexObject[faces[members[0]][0]];
    const normal = normals[members[0]];
    const turn = turns.get(object) ?? new THREE.Quaternion();
    const { right, up } = planeAxes(normal, turn);

    const along = new Map();
    for (const i of members) {
      for (const vertex of faces[i]) {
        if (!along.has(vertex)) along.set(vertex, [vertices[vertex].dot(right), vertices[vertex].dot(up)]);
      }
    }
    const left = Math.min(...[...along.values()].map(([a]) => a));
    const top = Math.max(...[...along.values()].map(([, b]) => b));
    const flat = new Map([...along].map(([vertex, [a, b]]) => [vertex, [tidy((a - left) * ppu), tidy((top - b) * ppu)]]));
    const width = Math.max(...[...flat.values()].map(([x]) => x));
    const height = Math.max(...[...flat.values()].map(([, y]) => y));
    return { faces: members, object, normal, flat, width, height, pinned: false, shaped: false };
  });
}

// The faces that have places on the atlas, as charts - the pieces they hang
// together in there, by edges whose ends have the same places in both faces -
// each { faces, rect, pinned, shaped }. They are kept as they are. A corner
// that has no place (the face was cut since) gets one between its
// neighbours'; a face whose object is on no atlas, or none of whose corners
// has a place, has none. The faces of the objects on other atlases than
// `atlas` are left as they are: they are those atlases' to keep.
function keptCharts(mesh, atlas = ATLAS) {
  const { faces, vertices, vertexObject, objects } = mesh;
  const onAny = new Set(objects.filter((object) => object.atlas).map((object) => object.id));
  const onAtlas = new Set(objects.filter((object) => object.atlas === atlas).map((object) => object.id));
  const members = [];
  faces.forEach((face, i) => {
    if (!face.uv) return;
    const owner = vertexObject[face[0]];
    if (onAny.has(owner) && !onAtlas.has(owner)) return;
    if (!face.uv.some(Boolean) || face.uv.length !== face.length || !onAtlas.has(owner)) {
      delete face.uv;
      delete face.pin;
      delete face.shaped;
      return;
    }
    if (face.uv.some((place) => !place)) {
      // Along the face's outline from one placed corner to the next, by distance.
      const count = face.length;
      const filled = [...face.uv];
      for (let k = 0; k < count; k++) {
        if (face.uv[k]) continue;
        let before = k;
        let after = k;
        while (!face.uv[before]) before = (before - 1 + count) % count;
        while (!face.uv[after]) after = (after + 1) % count;
        let gone = 0; // from the placed corner before it to this one
        let whole = 0; // and on to the placed corner after it
        let reached = false;
        for (let j = before; j !== after; j = (j + 1) % count) {
          if (j === k) reached = true;
          const step = vertices[face[j]].distanceTo(vertices[face[(j + 1) % count]]);
          whole += step;
          if (!reached) gone += step;
        }
        const t = whole > 0 ? gone / whole : 0.5;
        filled[k] = [0, 1].map((axis) => tidy(face.uv[before][axis] + (face.uv[after][axis] - face.uv[before][axis]) * t));
      }
      face.uv = filled;
    }
    members.push(i);
  });

  const root = new Map(members.map((i) => [i, i]));
  const find = (i) => {
    while (root.get(i) !== i) i = root.get(i);
    return i;
  };
  const byEdge = new Map();
  for (const i of members) {
    const face = faces[i];
    face.forEach((a, k) => {
      const next = (k + 1) % face.length;
      const key = edgeKey(a, face[next]);
      const ends = new Map([[a, face.uv[k]], [face[next], face.uv[next]]]);
      const other = byEdge.get(key);
      if (!other) {
        byEdge.set(key, { face: i, ends });
        return;
      }
      const same = [...ends].every(([vertex, place]) => {
        const there = other.ends.get(vertex);
        return there && Math.abs(there[0] - place[0]) < 1e-6 && Math.abs(there[1] - place[1]) < 1e-6;
      });
      if (same) root.set(find(i), find(other.face));
    });
  }
  const groups = new Map();
  for (const i of members) {
    const key = find(i);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  return [...groups.values()].map((group) => {
    const places = group.flatMap((i) => faces[i].uv);
    const x = Math.floor(Math.min(...places.map((place) => place[0])) + 1e-6);
    const y = Math.floor(Math.min(...places.map((place) => place[1])) + 1e-6);
    const w = Math.max(1, Math.ceil(Math.max(...places.map((place) => place[0])) - 1e-6) - x);
    const h = Math.max(1, Math.ceil(Math.max(...places.map((place) => place[1])) - 1e-6) - y);
    return {
      faces: group,
      rect: { x, y, w, h },
      pinned: group.some((i) => faces[i].pin),
      shaped: group.some((i) => faces[i].shaped),
    };
  });
}

// A plane's axes, as a chart is laid flat by them (see chartsOf()), in the
// object's own frame: `up` runs up the surface (on a floor or a ceiling, where
// nothing does, along the object's Z), and `right` to the right of it for
// someone looking at the face.
function planeAxes(normal, turn, along = 'y') {
  const own = normal.clone().applyQuaternion(turn.clone().invert());
  const axis = AXES[along];
  const up = Math.abs(own.dot(axis)) > 0.9999
    ? AXES[along === 'y' ? 'z' : 'y'].clone()
    : axis.clone().addScaledVector(own, -own.dot(axis)).normalize();
  const right = new THREE.Vector3().crossVectors(up, own).applyQuaternion(turn);
  up.applyQuaternion(turn);
  return { right, up };
}

// Whether a point is inside a polygon ([[x, y]]), by more than a hair from its sides.
function within(point, polygon) {
  let inside = false;
  for (let k = 0; k < polygon.length; k++) {
    const a = polygon[k];
    const b = polygon[(k + 1) % polygon.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    if (Math.hypot(a[0] + t * dx - point[0], a[1] + t * dy - point[1]) < UNFOLD_HAIR) return false;
    if (a[1] > point[1] !== b[1] > point[1] && point[0] < (dx * (point[1] - a[1])) / dy + a[0]) inside = !inside;
  }
  return inside;
}

// A polygon's extent.
function boxOf(polygon) {
  const xs = polygon.map(([x]) => x);
  const ys = polygon.map(([, y]) => y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

// Whether two polygons overlap: more than touching along a side or at a corner.
function overlapping(p, q) {
  const middle = (polygon) => [0, 1].map((axis) => polygon.reduce((sum, point) => sum + point[axis], 0) / polygon.length);
  if (within(middle(p), q) || within(middle(q), p)) return true;
  if (p.some((point) => within(point, q)) || q.some((point) => within(point, p))) return true;
  // A side may go in through a corner they share, and no corner be inside: points along the sides.
  const along = (polygon, other) => polygon.some((a, k) => {
    const c = polygon[(k + 1) % polygon.length];
    return [0.25, 0.5, 0.75].some((t) => within([a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t], other));
  });
  if (along(p, q) || along(q, p)) return true;
  const side = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    for (let j = 0; j < q.length; j++) {
      const c = q[j];
      const d = q[(j + 1) % q.length];
      const [s1, s2, s3, s4] = [side(a, b, c), side(a, b, d), side(c, d, a), side(c, d, b)];
      if (Math.abs(s1) > UNFOLD_HAIR && Math.abs(s2) > UNFOLD_HAIR && Math.abs(s3) > UNFOLD_HAIR && Math.abs(s4) > UNFOLD_HAIR && s1 * s2 < 0 && s3 * s4 < 0) return true;
    }
  }
  return false;
}

// A piece of laid faces, its top left at nought (on a whole pixel: the faces'
// corners keep their fractions, and so the grid they lie on).
function pieceFrom(places) {
  const all = [...places.values()].flat();
  const minX = Math.floor(Math.min(...all.map(([x]) => x)) + 1e-6);
  const minY = Math.floor(Math.min(...all.map(([, y]) => y)) + 1e-6);
  const moved = new Map([...places].map(([i, polygon]) => [i, polygon.map(([x, y]) => [tidy(x - minX), tidy(y - minY)])]));
  const shifted = [...moved.values()].flat();
  return {
    faces: [...moved.keys()],
    places: moved,
    width: Math.max(...shifted.map(([x]) => x)),
    height: Math.max(...shifted.map(([, y]) => y)),
  };
}

// The faces by the edges they have, each edge's list of faces.
function facesByEdge(faces, indices) {
  const byEdge = new Map();
  for (const i of indices) {
    faces[i].forEach((a, k) => {
      const key = edgeKey(a, faces[i][(k + 1) % faces[i].length]);
      if (!byEdge.has(key)) byEdge.set(key, []);
      byEdge.get(key).push(i);
    });
  }
  return byEdge;
}

// A face's area along its normal (Newell's formula): its length is the area,
// and several added up lean as those faces do together.
function areaVector(mesh, i) {
  const face = mesh.faces[i];
  const sum = new THREE.Vector3();
  face.forEach((vertex, k) => {
    sum.add(new THREE.Vector3().crossVectors(mesh.vertices[vertex], mesh.vertices[face[(k + 1) % face.length]]));
  });
  return sum.multiplyScalar(0.5);
}

// The given faces projected along one direction (planar projection): the
// pixel grid is one for all of them, straight on the atlas and running on
// across every edge, a vertex having one place in all its faces. What it costs
// is pixels drawn out on a face tilted from that direction, by 1 / cos of the
// tilt. The direction is that of the faces together. `along` is how the grid
// lies: 'body', as those faces look together; or 'x', 'y', 'z', an axis of the
// object's own, which is taken out of the direction: columns of pixels run
// along that axis and a row is one place on it, whatever the face's slope. (Faces
// that look mostly along the axis cannot be seen so, and are looked at as they
// are.) A face tilted by more than PROJECT_LIMIT, or landing on what is laid, is
// left for a piece of its own, projected along a direction of its own. Returns
// the pieces, each { faces, places: Map(face -> [[x, y]], its corners, in
// pixels), width, height }, ready for unwrap() (see `unfolded`).
export function unfold(mesh, faceIndices, ppu, along = 'y') {
  const { faces, vertices, vertexObject, objects } = mesh;
  const turns = new Map(objects.map((object) => [object.id, quaternionOf(object.rotation)]));
  const normals = new Map(faceIndices.map((i) => [i, mesh.faceNormal(i)]));
  const sound = faceIndices.filter((i) => normals.get(i).lengthSq() > 0.5);
  const areas = new Map(sound.map((i) => [i, areaVector(mesh, i)]));
  const byEdge = facesByEdge(faces, sound);
  const left = new Set(sound);
  // The faces left that hang together with `seed`, over edges, those tilted too far from `axis` out.
  const flood = (seed, axis) => {
    const reached = new Set([seed]);
    const order = [seed];
    for (const i of order) {
      faces[i].forEach((a, k) => {
        for (const other of byEdge.get(edgeKey(a, faces[i][(k + 1) % faces[i].length]))) {
          if (reached.has(other) || !left.has(other)) continue;
          if (axis && normals.get(other).dot(axis) < PROJECT_LIMIT) continue;
          reached.add(other);
          order.push(other);
        }
      });
    }
    return order;
  };
  // A direction with the chosen axis taken out, in the object's own terms - unless it is mostly that axis.
  const levelled = (axis, i) => {
    if (along === 'body') return axis;
    const turn = turns.get(vertexObject[faces[i][0]]) ?? new THREE.Quaternion();
    const own = axis.clone().applyQuaternion(turn.clone().invert());
    const part = own.dot(AXES[along]);
    if (Math.abs(part) > LEVEL_LIMIT) return axis;
    return own.addScaledVector(AXES[along], -part).normalize().applyQuaternion(turn);
  };
  // Which way faces look together; a closed surface looks no way: then as `fallback`.
  const lookOf = (list, fallback) => {
    const sum = new THREE.Vector3();
    let whole = 0;
    for (const i of list) {
      sum.add(areas.get(i));
      whole += areas.get(i).length();
    }
    return levelled(sum.length() > whole * 0.01 ? sum.normalize() : normals.get(fallback).clone(), fallback);
  };
  const pieces = [];
  while (left.size) {
    const biggest = [...left].reduce((a, b) => (areas.get(b).lengthSq() > areas.get(a).lengthSq() ? b : a));
    let axis = lookOf(flood(biggest, null), biggest);
    const seed = flood(biggest, null).reduce((a, b) => (normals.get(b).dot(axis) > normals.get(a).dot(axis) ? b : a));
    // Its direction settles on what it takes.
    for (let round = 0; round < 2; round++) axis = lookOf(flood(seed, axis), seed);
    if (normals.get(seed).dot(axis) < PROJECT_LIMIT) axis = normals.get(seed).clone(); // (it is always taken: not edge on)
    const { right, up } = planeAxes(axis, turns.get(vertexObject[faces[seed][0]]) ?? new THREE.Quaternion(), along === 'body' ? 'y' : along);
    const flatOf = (i) => faces[i].map((vertex) => [vertices[vertex].dot(right) * ppu, -vertices[vertex].dot(up) * ppu]);
    // (The first face's top left corner on a pixel.)
    const start = flatOf(seed);
    const originX = Math.min(...start.map(([x]) => x));
    const originY = Math.min(...start.map(([, y]) => y));
    const places = new Map();
    const boxes = [];
    for (const i of flood(seed, axis)) {
      const polygon = flatOf(i).map(([x, y]) => [x - originX, y - originY]);
      const box = boxOf(polygon);
      if (boxes.some((there) => box.x0 < there.box.x1 && there.box.x0 < box.x1 && box.y0 < there.box.y1 && there.box.y0 < box.y1 && overlapping(polygon, there.polygon))) continue;
      places.set(i, polygon);
      boxes.push({ polygon, box });
      left.delete(i);
    }
    pieces.push(pieceFrom(places));
  }
  return pieces;
}

// Room on the atlas: which pixels are spoken for.
class Room {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.taken = new Uint8Array(width * height);
  }

  // Whether the rectangle, with its rim, is on the atlas.
  inside(x, y, w, h) {
    return x >= PADDING && y >= PADDING && x + w + PADDING <= this.width && y + h + PADDING <= this.height;
  }

  // Whether the rectangle, with its rim, is inside and free.
  free(x, y, w, h) {
    if (!this.inside(x, y, w, h)) return false;
    for (let row = y - PADDING; row < y + h + PADDING; row++) {
      for (let column = x - PADDING; column < x + w + PADDING; column++) {
        if (this.taken[row * this.width + column]) return false;
      }
    }
    return true;
  }

  // Takes the rectangle and its rim - what of them is on the atlas (a chart
  // that the user has put by the edge may reach off it).
  take(x, y, w, h) {
    const from = Math.max(0, x - PADDING);
    const to = Math.min(this.width, x + w + PADDING);
    if (to <= from) return;
    for (let row = Math.max(0, y - PADDING); row < Math.min(this.height, y + h + PADDING); row++) {
      this.taken.fill(1, row * this.width + from, row * this.width + to);
    }
  }

  // The first free place for a rectangle, row by row; null if there is none.
  find(w, h) {
    for (let y = PADDING; y + h + PADDING <= this.height; y++) {
      for (let x = PADDING; x + w + PADDING <= this.width; x++) {
        if (this.free(x, y, w, h)) return { x, y };
      }
    }
    return null;
  }

  // Twice as big along its shorter side; what is taken stays where it is.
  grow() {
    const wider = this.width <= this.height;
    const grown = new Room(wider ? this.width * 2 : this.width, wider ? this.height : this.height * 2);
    for (let row = 0; row < this.height; row++) {
      grown.taken.set(this.taken.subarray(row * this.width, (row + 1) * this.width), row * grown.width);
    }
    return grown;
  }
}

// Gives every face of the objects on the atlas `atlas` (an id, see
// object.atlas; each atlas is laid out on its own, at its own `ppu`) a place there that has none,
// on an atlas of the given size, and writes it into the face's `uv`. Faces
// that have places keep them, whatever has become of the faces since.
// Returns what the atlas has to do about it:
//   width, height  its size now (it may have grown)
//   charts         all the charts, each with its `rect` { x, y, w, h } and `faces`
//   fresh          the rects given to the charts laid out now: to be cleared
//   changed        whether any face's places are not what they were
// `repack` forgets every place on it first: its objects are laid out anew.
// `unfolded`: pieces worked out by unfold(), whose faces have no places now: given room as they are, pinned.
export function unwrap(mesh, { atlas = ATLAS, ppu, width = START_SIZE, height = START_SIZE, repack = false, unfolded = [] }) {
  let changed = false;
  if (repack) {
    const own = new Set(mesh.objects.filter((object) => object.atlas === atlas).map((object) => object.id));
    for (const face of mesh.faces) {
      if (!own.has(mesh.vertexObject[face[0]])) continue;
      if (face.uv) changed = true;
      delete face.uv;
      delete face.pin;
      delete face.shaped;
    }
  }
  const had = mesh.faces.map((face) => face.uv);
  // What is there stays there, and the rest keeps off its room.
  const kept = keptCharts(mesh, atlas);
  mesh.faces.forEach((face, i) => {
    if (face.uv !== had[i]) changed = true; // a corner was given a place, or the face lost its places
  });
  let room = new Room(width, height);
  for (const { rect } of kept) room.take(rect.x, rect.y, rect.w, rect.h);

  const fresh = [];
  // Room for a rectangle, the atlas growing until there is some.
  const place = (w, h) => {
    let spot = room.find(w, h);
    while (!spot) {
      if (Math.max(room.width, room.height) >= MAX_SIZE) throw new Error('the texture atlas is full');
      room = room.grow();
      spot = room.find(w, h);
    }
    room.take(spot.x, spot.y, w, h);
    return spot;
  };
  const pieces = unfolded.map((piece) => {
    const w = Math.max(1, Math.ceil(piece.width - 1e-6));
    const h = Math.max(1, Math.ceil(piece.height - 1e-6));
    const spot = place(w, h);
    const rect = { ...spot, w, h };
    fresh.push(rect);
    for (const i of piece.faces) {
      const face = mesh.faces[i];
      face.uv = piece.places.get(i).map(([x, y]) => [tidy(x + spot.x), tidy(y + spot.y)]);
      face.pin = true;
    }
    changed = true;
    return { faces: piece.faces, rect, pinned: true, shaped: false };
  });

  // The faces without places, in charts, each laid flat and given free room.
  const charts = chartsOf(mesh, ppu, atlas);
  for (const chart of charts) {
    const w = Math.max(1, Math.ceil(chart.width - 1e-6));
    const h = Math.max(1, Math.ceil(chart.height - 1e-6));
    const spot = place(w, h);
    chart.rect = { ...spot, w, h };
    fresh.push(chart.rect);
    for (const i of chart.faces) {
      const face = mesh.faces[i];
      face.uv = face.map((vertex) => {
        const [x, y] = chart.flat.get(vertex);
        return [tidy(x + spot.x), tidy(y + spot.y)];
      });
    }
    changed = true;
  }
  return { width: room.width, height: room.height, charts: [...kept, ...pieces, ...charts], fresh, moved: [], changed };
}

// Rectangles ([{ w, h }]) packed on an atlas as an unwrap lays charts out
// (see Room): each at the first free place row by row, a rim round it -
// the tallest first, then the widest, which packs them tightest - on one of
// START_SIZE, doubled along its shorter side until they fit. Returns { width,
// height, spots: [{ x, y }] in the rectangles' order }, or null if they do
// not fit in the largest atlas there may be.
export function packRects(rects) {
  const order = rects.map((_, k) => k).sort((a, b) => rects[b].h - rects[a].h || rects[b].w - rects[a].w || a - b);
  let room = new Room(START_SIZE, START_SIZE);
  const spots = new Array(rects.length);
  for (const k of order) {
    const { w, h } = rects[k];
    let spot = room.find(w, h);
    while (!spot) {
      if (Math.max(room.width, room.height) >= MAX_SIZE) return null;
      room = room.grow();
      spot = room.find(w, h);
    }
    room.take(spot.x, spot.y, w, h);
    spots[k] = spot;
  }
  return { width: room.width, height: room.height, spots };
}

export { START_SIZE };
