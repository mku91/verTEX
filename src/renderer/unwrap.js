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
    // The plane's axes, in the object's own frame: `up` runs up the surface
    // (on a floor or a ceiling, where nothing does, along the object's Z), and
    // `right` to the right of it for someone looking at the face.
    const own = normal.clone().applyQuaternion(turn.clone().invert());
    const up = Math.abs(own.y) > 0.9999
      ? new THREE.Vector3(0, 0, 1)
      : new THREE.Vector3(0, 1, 0).addScaledVector(own, -own.y).normalize();
    const right = new THREE.Vector3().crossVectors(up, own).applyQuaternion(turn);
    up.applyQuaternion(turn);

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
export function unwrap(mesh, { atlas = ATLAS, ppu, width = START_SIZE, height = START_SIZE, repack = false }) {
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

  // The faces without places, in charts, each laid flat and given free room.
  const charts = chartsOf(mesh, ppu, atlas);
  const fresh = [];
  for (const chart of charts) {
    const w = Math.max(1, Math.ceil(chart.width - 1e-6));
    const h = Math.max(1, Math.ceil(chart.height - 1e-6));
    let spot = room.find(w, h);
    while (!spot) {
      if (Math.max(room.width, room.height) >= MAX_SIZE) throw new Error('the texture atlas is full');
      room = room.grow();
      spot = room.find(w, h);
    }
    room.take(spot.x, spot.y, w, h);
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
  return { width: room.width, height: room.height, charts: [...kept, ...charts], fresh, moved: [], changed };
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
