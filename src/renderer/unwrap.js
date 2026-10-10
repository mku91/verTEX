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
// The one way out of all this is the user's own: a face whose shape on the
// atlas the user has changed by hand is `shaped`. Its places are then the
// user's altogether - it is not laid flat again, so it may be stretched and
// skewed, which is the price of fitting its edges to the pixels - until it is
// given back to the unwrap.
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
  // (Shaped faces are not laid out: see shapedCharts().)
  const sound = (i) => normals[i].lengthSq() > 0.5 && onAtlas.has(vertexObject[faces[i][0]]) && !faces[i].shaped;

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

// The faces whose shape on the atlas is the user's, as charts - the pieces
// they hang together in there, by edges whose ends have the same places in
// both faces - each { faces, rect, pinned, shaped }. A corner that has no
// place (the face was cut since) gets one between its neighbours'; a face
// that cannot be kept so - none of its corners has a place, or its object is
// off the atlas - is the unwrap's again.
function shapedCharts(mesh) {
  const { faces, vertices, vertexObject, objects } = mesh;
  const onAtlas = new Set(objects.filter((object) => object.atlas).map((object) => object.id));
  const members = [];
  faces.forEach((face, i) => {
    if (!face.shaped) return;
    if (!face.uv || !face.uv.some(Boolean) || !onAtlas.has(vertexObject[face[0]])) {
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
    return { faces: group, rect: { x, y, w, h }, pinned: true, shaped: true };
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

  // Holds a rectangle that may reach off the atlas, for a shaped chart: what of it is on the atlas.
  hold({ x, y, w, h }) {
    for (let row = Math.max(0, y); row < Math.min(this.height, y + h); row++) {
      const from = Math.max(0, x);
      const to = Math.min(this.width, x + w);
      if (to > from) this.held.fill(1, row * this.width + from, row * this.width + to);
    }
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
  // A repack gives every face back to the unwrap, the shaped ones too.
  if (repack) for (const face of mesh.faces) delete face.shaped;
  // The shaped faces first: they are as they are, and the rest keeps off their room.
  const shaped = shapedCharts(mesh);
  const charts = chartsOf(mesh, ppu);
  let room = new Room(width, height);
  for (const chart of shaped) room.hold(chart.rect);
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
  const placed = new Set([...charts, ...shaped].flatMap((chart) => chart.faces));
  for (const chart of shaped) for (const i of chart.faces) mesh.faces[i].pin = true;
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
  return { width: room.width, height: room.height, charts: [...charts, ...shaped], fresh, moved, changed };
}

export { START_SIZE };
