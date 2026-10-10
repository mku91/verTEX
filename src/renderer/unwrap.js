import * as THREE from 'three';
import { edgeKey } from './mesh.js';
import { quaternionOf } from './frames.js';

// The unwrap: where every face is on the texture atlas.
//
// It is worked out, not drawn. The project has one number - `ppu`, pixels per
// unit of length - and every face lies on the atlas as it is in space, at that
// scale: it can be shifted by whole pixels, turned by quarter turns and turned
// over, and nothing else. So a pixel is the same size all over the model and
// its grid is never skewed: there is no way to say otherwise.
//
// The unit is a chart: the faces of one object that lie in one plane and hang
// together by their edges. A chart is laid flat by the axes of its plane (the
// grid on it stands upright in the object's own frame), which gives every
// vertex of it a place in pixels, from (0, 0) at the chart's top left. Where
// the chart is put on the atlas is its placement; the faces keep the outcome
// in `uv` (see mesh.js). A chart that has places already keeps its placement -
// the texture stays where it was painted - and is moved only if it no longer
// fits; a new chart is given free room, and the atlas grows when there is none.
//
// Nothing is laid out unasked: an object is put on the atlas by the user
// (`atlas` on the object), and only then do its faces get places.
//
// A chart the user has placed by hand is pinned (`pin` on its faces): it stays
// where it was put whatever else is there - that is how several faces are
// given the same picture - and only the charts that are not pinned keep out
// of each other's way, and out of the pinned ones'.

const SAME_PLANE = 1e-4; // how far apart two faces' planes may be, and their normals' cosine from 1
// Every chart has a rim of this many pixels all round it, which is its own:
// the atlas repeats the chart's edge pixels there (see Atlas.extrude()), so
// that a renderer that blends neighbouring pixels at a face's edge blends in
// more of the same and not another face or nothing. Charts are therefore two
// rims apart, and one rim from the atlas' edge.
export const PADDING = 1;
const START_SIZE = 64; // px, an empty project's atlas
const MAX_SIZE = 4096;

// The eight ways a chart can lie in its room: quarter turns, and the same turned over.
// Each takes a place (x, y) in a chart `w` by `h` to its place in the room.
const LAYS = [
  { turned: false, place: (x, y) => [x, y] },
  { turned: true, place: (x, y, w, h) => [h - y, x] },
  { turned: false, place: (x, y, w, h) => [w - x, h - y] },
  { turned: true, place: (x, y, w) => [y, w - x] },
  { turned: false, place: (x, y, w) => [w - x, y] },
  { turned: true, place: (x, y) => [y, x] },
  { turned: false, place: (x, y, w, h) => [x, h - y] },
  { turned: true, place: (x, y, w, h) => [h - y, w - x] },
];

const tidy = (value) => (Math.abs(value - Math.round(value)) < 1e-6 ? Math.round(value) : +value.toFixed(6));

// The charts of a mesh, each { faces, object, normal, flat } - `flat` a Map
// from a vertex of the chart to its place [x, y] in pixels, and `width`,
// `height` the chart's extent. Faces without a surface are in no chart.
export function chartsOf(mesh, ppu) {
  const { faces, vertices, vertexObject, objects } = mesh;
  const normals = faces.map((_, i) => mesh.faceNormal(i));
  const offsets = faces.map((face, i) => normals[i].dot(vertices[face[0]]));
  // Only the objects the user has put on the atlas are laid out on it.
  const onAtlas = new Set(objects.filter((object) => object.atlas).map((object) => object.id));
  const sound = (i) => normals[i].lengthSq() > 0.5 && onAtlas.has(vertexObject[faces[i][0]]);

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
    return { faces: members, object, normal, flat, width, height, pinned: members.some((i) => faces[i].pin) };
  });
}

// How the chart lies now, going by the places its faces' corners have, as
// { lay, x, y, votes } - or null if none of its corners has a place.
//
// Corners that have not moved since they were given their places all tell the
// same lay and shift, and if most of those that speak agree, that is it: the
// picture stays on the part of the chart that stayed. When they do not - the
// whole chart was stretched, say - the picture is kept as near as it can be:
// the lay and the shift that leave the corners the least far from where they were.
function placementOf(chart, mesh) {
  let voted = null;
  let nearest = null;
  LAYS.forEach((lay, index) => {
    const votes = new Map();
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    const shifts = [];
    for (const i of chart.faces) {
      const face = mesh.faces[i];
      if (!face.uv) continue;
      face.forEach((vertex, k) => {
        const had = face.uv[k];
        if (!had) return;
        const [fx, fy] = chart.flat.get(vertex);
        const [x, y] = lay.place(fx, fy, chart.width, chart.height);
        const dx = had[0] - x;
        const dy = had[1] - y;
        shifts.push([dx, dy]);
        sumX += dx;
        sumY += dy;
        count++;
        // Only a corner that is a whole number of pixels from where this lay puts it speaks for it.
        if (Math.abs(dx - Math.round(dx)) > 0.01 || Math.abs(dy - Math.round(dy)) > 0.01) return;
        const key = `${Math.round(dx)},${Math.round(dy)}`;
        votes.set(key, (votes.get(key) ?? 0) + 1);
      });
    }
    if (count === 0) return;
    const ranked = [...votes].sort((p, q) => q[1] - p[1]);
    if (ranked.length && ranked[0][1] * 2 > count && (!voted || ranked[0][1] > voted.votes)) {
      const [x, y] = ranked[0][0].split(',').map(Number);
      voted = { lay: index, x, y, votes: ranked[0][1] };
    }
    const x = Math.round(sumX / count);
    const y = Math.round(sumY / count);
    const off = shifts.reduce((sum, [dx, dy]) => sum + (dx - x) ** 2 + (dy - y) ** 2, 0);
    if (!nearest || off < nearest.off - 1e-9) nearest = { lay: index, x, y, votes: 1, off };
  });
  return voted ?? nearest;
}

// Room on the atlas: which pixels are taken.
class Room {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.taken = new Uint8Array(width * height);
    // Room that pinned charts lie on: not to be given out, but nobody is
    // turned out of it either - a pinned chart lies on top of what is there.
    this.held = new Uint8Array(width * height);
  }

  // Whether the rectangle, with its rim, is on the atlas.
  inside(x, y, w, h) {
    return x >= PADDING && y >= PADDING && x + w + PADDING <= this.width && y + h + PADDING <= this.height;
  }

  // Whether the rectangle, with its rim, is inside and free: of the charts
  // that keep out of each other's way and - unless it is a chart that is
  // there already, which a pinned one lying on it does not turn out (`mine`) -
  // of the pinned ones too.
  free(x, y, w, h, mine = false) {
    if (!this.inside(x, y, w, h)) return false;
    for (let row = y - PADDING; row < y + h + PADDING; row++) {
      for (let column = x - PADDING; column < x + w + PADDING; column++) {
        const at = row * this.width + column;
        if (this.taken[at] || (!mine && this.held[at])) return false;
      }
    }
    return true;
  }

  // Takes the rectangle and its rim, for a chart that keeps its room to itself or for a pinned one.
  take(x, y, w, h, pinned = false) {
    const room = pinned ? this.held : this.taken;
    for (let row = y - PADDING; row < y + h + PADDING; row++) {
      room.fill(1, row * this.width + x - PADDING, row * this.width + x + w + PADDING);
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
      grown.held.set(this.held.subarray(row * this.width, (row + 1) * this.width), row * grown.width);
    }
    return grown;
  }
}

// Lays every face of the mesh on an atlas of the given size and writes the
// outcome into the faces' `uv`. Returns what the atlas has to do about it:
//   width, height  its size now (it may have grown)
//   charts         the charts, each with its `rect` { x, y, w, h } and `faces`
//   fresh          the rects given to charts that had no place: to be cleared
//   moved          { from: {x, y}, to: {x, y}, w, h } - what was painted in a
//                  chart that had to move, to be copied to where it is now
//   changed        whether any face's places are not what they were
export function unwrap(mesh, { ppu, width = START_SIZE, height = START_SIZE, repack = false }) {
  const charts = chartsOf(mesh, ppu);
  let room = new Room(width, height);
  const fresh = [];
  const moved = [];

  for (const chart of charts) {
    chart.placement = repack ? null : placementOf(chart, mesh);
    if (repack) chart.pinned = false;
  }
  // The pinned first: theirs is the say. Then those that have a place, the
  // best-attested first; the rest take what is left.
  const order = [...charts].sort((a, b) => Number(b.pinned) - Number(a.pinned) ||
    (b.placement?.votes ?? 0) - (a.placement?.votes ?? 0) || a.faces[0] - b.faces[0]);
  const settle = (chart, w, h) => {
    for (;;) {
      const spot = room.find(w, h);
      if (spot) return spot;
      if (Math.max(room.width, room.height) >= MAX_SIZE) throw new Error('the texture atlas is full');
      room = room.grow();
    }
  };
  for (const chart of order) {
    const lay = LAYS[chart.placement?.lay ?? 0];
    const w = Math.max(1, Math.ceil((lay.turned ? chart.height : chart.width) - 1e-6));
    const h = Math.max(1, Math.ceil((lay.turned ? chart.width : chart.height) - 1e-6));
    let spot = chart.placement ? { x: chart.placement.x, y: chart.placement.y } : null;
    // A pinned chart stays put as long as it is on the atlas at all; one that
    // has grown off its edge is on its own again.
    if (spot && chart.pinned && !room.inside(spot.x, spot.y, w, h)) chart.pinned = false;
    if (spot && chart.pinned) {
      // (Nothing to find: it is where it is.)
    } else if (spot && !room.free(spot.x, spot.y, w, h, true)) {
      // No room for it where it was: it moves, and takes its picture along.
      const from = spot;
      spot = settle(chart, w, h);
      moved.push({ from, to: spot, w, h });
    } else if (!spot) {
      spot = settle(chart, w, h);
      fresh.push({ ...spot, w, h });
    }
    room.take(spot.x, spot.y, w, h, chart.pinned);
    chart.rect = { ...spot, w, h };
    chart.lay = chart.placement?.lay ?? 0;
  }

  let changed = false;
  // A face that is in no chart - its object is not on the atlas - has no place.
  const placed = new Set(charts.flatMap((chart) => chart.faces));
  mesh.faces.forEach((face, i) => {
    if (placed.has(i) || (!face.uv && !face.pin)) return;
    delete face.uv;
    delete face.pin;
    changed = true;
  });
  for (const chart of charts) {
    const lay = LAYS[chart.lay];
    for (const i of chart.faces) {
      const face = mesh.faces[i];
      const uv = face.map((vertex) => {
        const [fx, fy] = chart.flat.get(vertex);
        const [x, y] = lay.place(fx, fy, chart.width, chart.height);
        return [tidy(x + chart.rect.x), tidy(y + chart.rect.y)];
      });
      const same = face.uv?.length === uv.length && uv.every((point, k) => face.uv[k] && face.uv[k][0] === point[0] && face.uv[k][1] === point[1]);
      if (!same) {
        face.uv = uv;
        changed = true;
      }
      // The whole chart is pinned or is not: a face cut into it takes after the rest.
      if (chart.pinned) face.pin = true;
      else delete face.pin;
    }
  }
  return { width: room.width, height: room.height, charts, fresh, moved, changed };
}

export { START_SIZE };
