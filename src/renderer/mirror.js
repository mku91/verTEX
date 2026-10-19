import * as THREE from 'three';
import { mirrorRotation, setRotation } from './frames.js';
import { inheritUV } from './mesh.js';
import { mirroredWeights } from './skin.js';

// Mirror modeling: every edit is repeated on the other side of a plane (or of
// several), as if the pointer had a twin there.
//
//   - Global: planes through the origin, chosen axes, every object. The
//     mirror image of an object is an object of its own; an object standing
//     on the plane is its own image.
//   - Local: an object's own planes, through its pivot point, chosen per
//     object (object.mirror = ['x', ...]); the images stay inside the object.
//     An object with local planes is not touched by the global ones.
//
// Two mechanisms:
//   moves()      - while vertices are being moved: their twins (the vertices
//                  at the mirrored positions) move along, and a vertex on a
//                  plane stays on it;
//   reconcile()  - once an edit is done: the side it happened on is the
//                  source, and the other sides are made its mirror images -
//                  what is missing there is added, what is not an image is
//                  removed, faces facing the wrong way are turned. Faces that
//                  cross a plane without being symmetric about it are cut
//                  along it first.

const EPS = 1e-4;
const keyOf = (p) => `${Math.round(p.x / EPS)}|${Math.round(p.y / EPS)}|${Math.round(p.z / EPS)}`;
const pointOf = (key) => new THREE.Vector3().fromArray(key.split('|').map((n) => Number(n) * EPS));

// The point mirrored across every plane of the list.
export function mirrorPoint(point, planes) {
  const q = point.clone();
  for (const { axis, value } of planes) q[axis] = 2 * value - q[axis];
  return q;
}

// Every non-empty sub-list of the planes: the images of one side under one
// plane, two planes, ... (3 images for two planes, 7 for three).
function subsets(planes) {
  const out = [];
  for (let mask = 1; mask < 1 << planes.length; mask++) out.push(planes.filter((_, i) => mask & (1 << i)));
  return out;
}

const sortedKey = (indices) => [...indices].sort((a, b) => a - b).join(',');

// Whether two loops are the same cycle in the same direction.
function sameCycle(a, b) {
  if (a.length !== b.length) return false;
  const start = b.indexOf(a[0]);
  if (start < 0) return false;
  return a.every((vertex, i) => vertex === b[(start + i) % b.length]);
}

export class Mirror {
  constructor(editor) {
    this.editor = editor;
    this.globalAxes = new Set(); // 'x' | 'y' | 'z'; empty = the global mirror is off
  }

  active() {
    return this.globalAxes.size > 0 || this.editor.mesh.objects.some((object) => object.mirror?.length);
  }

  // The planes an object's edits are mirrored across, as { axis, value, local }:
  // its own, through its pivot point, or else the scene's. Empty = none.
  planesFor(objectIndex) {
    const object = this.editor.mesh.objects[objectIndex];
    if (!object || object.kind === 'node') return [];
    if (object.mirror?.length) {
      const pivot = this.editor.pivotPoint(objectIndex);
      return object.mirror.map((axis) => ({ axis, value: pivot[axis], local: true }));
    }
    return [...this.globalAxes].map((axis) => ({ axis, value: 0, local: false }));
  }

  // Global: which object holds each object's image, as a Map of object id ->
  // Map of (which sub-list of the planes, by its number in subsets()) -> the
  // holder's id. The image of an object is the object whose vertices stand
  // exactly where its own are mirrored to; of several objects standing in
  // one another's place (copies not yet moved apart) the first has the first
  // such image, the second the second. An object that is its own image, or
  // has none yet, has no entry for those planes.
  holders(vertices, vertexObject, objects) {
    const result = new Map();
    if (this.globalAxes.size === 0) return result;
    const lists = subsets([...this.globalAxes].map((axis) => ({ axis, value: 0 })));
    const points = new Map(); // object id -> where its vertices stand
    for (const object of objects) {
      if (object.kind !== 'node' && !object.mirror?.length) points.set(object.id, []);
    }
    vertices.forEach((p, i) => points.get(vertexObject[i])?.push(p));
    const placeOf = (list) => list.map(keyOf).sort().join(';');
    const places = new Map(); // object id -> its place
    const standing = new Map(); // place -> the ids of the objects there, in order
    for (const [id, own] of points) {
      if (own.length === 0) continue;
      const place = placeOf(own);
      places.set(id, place);
      if (!standing.has(place)) standing.set(place, []);
      standing.get(place).push(id);
    }
    for (const [id, place] of places) {
      const turn = standing.get(place).indexOf(id);
      const held = new Map();
      lists.forEach((some, n) => {
        const mirrored = placeOf(points.get(id).map((p) => mirrorPoint(p, some)));
        const holder = mirrored === place ? undefined : standing.get(mirrored)?.[turn];
        if (holder !== undefined) held.set(n, holder);
      });
      result.set(id, held);
    }
    return result;
  }

  // --- while vertices move ----------------------------------------------------

  // `old`: the vertices being moved, index -> where each was when the move
  // began. Their twins, found by those positions among the vertices that are
  // not moving, go to the mirrored positions; a vertex that was on a plane is
  // put back on it.
  moves(old) {
    if (old.size === 0 || !this.active()) return;
    const { mesh } = this.editor;
    const indexOfId = new Map(mesh.objects.map((object, i) => [object.id, i]));
    const planesCache = new Map();
    const planesOf = (objectId) => {
      const index = indexOfId.get(objectId);
      if (!planesCache.has(index)) planesCache.set(index, this.planesFor(index));
      return planesCache.get(index);
    };
    // The vertices that are not moving, by where they stood when the move
    // began: the twins among them have moved along since the first call of
    // this move, so the index is made once per move (per `old`).
    // (And the objects with a vertex that stays behind, `partly`; and whose
    // image was whose as the move began, `held`, see holders().)
    if (this.stillFor !== old) {
      this.stillFor = old;
      this.still = new Map();
      this.partly = new Set();
      mesh.vertices.forEach((vertex, i) => {
        if (old.has(i)) return;
        const key = keyOf(vertex);
        if (!this.still.has(key)) this.still.set(key, []);
        this.still.get(key).push(i);
        this.partly.add(mesh.vertexObject[i]);
      });
      this.held = this.holders(mesh.vertices.map((vertex, i) => old.get(i) ?? vertex), mesh.vertexObject, mesh.objects);
    }
    const { still, partly, held } = this;
    // The objects holding an object's images under global planes, or null.
    const heldBy = (objectId, planes) => (planes.length && !planes[0].local ? held.get(objectId) ?? null : null);
    for (const [v, was] of old) {
      const objectId = mesh.vertexObject[v];
      const planes = planesOf(objectId);
      const now = mesh.vertices[v];
      // An object moved whole is not held by the plane it stands on: holding
      // some of its vertices would pull it out of shape.
      if (!partly.has(objectId)) continue;
      const images = heldBy(objectId, planes);
      planes.forEach(({ axis, value }, k) => {
        // Nor is one whose image under this plane is another object, which
        // it only meets there: the vertex is not its own image.
        if (images?.has((1 << k) - 1)) return;
        if (Math.abs(was[axis] - value) < EPS) now[axis] = value;
      });
    }
    // Twins under one plane first: a vertex that is the twin of one moving
    // vertex under one plane and of another under two follows the first.
    const claimed = new Set();
    for (let count = 1; count <= 3; count++) {
      for (const [v, was] of old) {
        const objectId = mesh.vertexObject[v];
        const planes = planesOf(objectId);
        const images = heldBy(objectId, planes);
        subsets(planes).forEach((some, n) => {
          if (some.length !== count) return;
          // The twins are in the object that holds this image: another, or
          // (its own image, or a local mirror) the object itself.
          const holder = images?.get(n) ?? objectId;
          for (const w of still.get(keyOf(mirrorPoint(was, some))) ?? []) {
            if (claimed.has(w) || mesh.vertexObject[w] !== holder) continue;
            mesh.vertices[w].copy(mirrorPoint(mesh.vertices[v], some));
            claimed.add(w);
          }
        });
      }
    }
  }

  // --- once an edit is done ---------------------------------------------------

  // Makes the other sides the images of the edited one. `before` is the
  // snapshot from before the edit. Returns a Map of vertex index before this
  // call -> after it (vertices removed are absent) when something was done,
  // or null when there was nothing to do.
  reconcile(before) {
    if (!this.active()) return null;
    const { mesh } = this.editor;
    const beforeIndex = new Map();
    before.vertices.forEach((p, i) => beforeIndex.set(keyOf(p), i));
    const afterKeys = new Set(mesh.vertices.map(keyOf));

    // What the edit touched, by object: the positions of vertices that are
    // new or moved (after), removed (before), and of the corners of faces and
    // wires that changed.
    const touched = new Map();
    const touch = (objectId, p) => {
      if (!touched.has(objectId)) touched.set(objectId, []);
      touched.get(objectId).push(p);
    };
    mesh.vertices.forEach((p, i) => {
      if (!beforeIndex.has(keyOf(p))) touch(mesh.vertexObject[i], p);
    });
    before.vertices.forEach((p, i) => {
      if (!afterKeys.has(keyOf(p))) touch(before.vertexObject[i], p);
    });
    // A new object is all new, also one made in the place of another (a copy).
    const known = new Set(before.objects.map((object) => object.id));
    mesh.vertices.forEach((p, i) => {
      if (!known.has(mesh.vertexObject[i])) touch(mesh.vertexObject[i], p);
    });
    // A face as the cycle of its corners' positions, starting from the
    // smallest: the same face turned over reads differently.
    const cycleKey = (vertices, loop) => {
      const keys = loop.map((i) => keyOf(vertices[i]));
      let start = 0;
      keys.forEach((key, i) => {
        if (key < keys[start]) start = i;
      });
      return keys.map((_, i) => keys[(start + i) % keys.length]).join(';');
    };
    const wireKey = (vertices, wire) => wire.map((i) => keyOf(vertices[i])).sort().join(';');
    for (const [list, key] of [['faces', cycleKey], ['wires', wireKey]]) {
      const was = new Set(before[list].map((loop) => key(before.vertices, loop)));
      const is = new Set(mesh[list].map((loop) => key(mesh.vertices, loop)));
      for (const loop of mesh[list]) {
        if (!was.has(key(mesh.vertices, loop))) for (const i of loop) touch(mesh.vertexObject[i], mesh.vertices[i]);
      }
      for (const loop of before[list]) {
        if (!is.has(key(before.vertices, loop))) for (const i of loop) touch(before.vertexObject[i], before.vertices[i]);
      }
    }
    if (touched.size === 0) return null;
    const held = this.holders(before.vertices, before.vertexObject, before.objects); // whose image was whose

    let changed = false;
    // Vertex indices as they are now -> as they end up, through the removals.
    const remap = new Map(mesh.vertices.map((_, i) => [i, i]));
    const removed = (step) => {
      for (const [from, to] of remap) {
        if (step.has(to)) remap.set(from, step.get(to));
        else remap.delete(from);
      }
    };

    // Objects that are gone take their global images with them.
    const alive = new Set(mesh.objects.map((object) => object.id));
    for (const objectId of touched.keys()) {
      if (alive.has(objectId) || this.globalAxes.size === 0) continue;
      if (before.objects.find((object) => object.id === objectId)?.mirror?.length) continue;
      const planes = [...this.globalAxes].map((axis) => ({ axis, value: 0 }));
      const gone = new Set();
      before.vertices.forEach((p, i) => {
        if (before.vertexObject[i] === objectId) gone.add(keyOf(p));
      });
      if (gone.size === 0) continue;
      // The objects that held its images; or, not known, found by their place.
      const holders = new Set(held.get(objectId)?.values());
      for (const holder of holders) {
        const own = new Set();
        mesh.vertexObject.forEach((id, i) => {
          if (id === holder) own.add(i);
        });
        if (own.size === 0) continue;
        removed(mesh.removeVertices(own));
        changed = true;
      }
      if (holders.size) continue;
      for (const some of subsets(planes)) {
        const imageKeys = new Set([...gone].map((key) => keyOf(mirrorPoint(pointOf(key), some))));
        // An object that is exactly that image goes.
        for (const object of mesh.objects) {
          const own = [];
          mesh.vertexObject.forEach((id, i) => {
            if (id === object.id) own.push(i);
          });
          if (own.length === 0 || own.length !== imageKeys.size) continue;
          if (!own.every((i) => imageKeys.has(keyOf(mesh.vertices[i])))) continue;
          removed(mesh.removeVertices(new Set(own)));
          changed = true;
          break;
        }
      }
    }

    // An object brought to stand exactly where its image stands - vertex on
    // vertex - is its own image from then on: the two are one object, the
    // image's goes.
    const placeOf = (objectId) => mesh.vertices.filter((_, i) => mesh.vertexObject[i] === objectId).map(keyOf).sort().join(';');
    for (const objectId of touched.keys()) {
      const place = placeOf(objectId);
      if (!place) continue;
      for (const holder of new Set(held.get(objectId)?.values())) {
        if (!held.has(holder) || placeOf(holder) !== place) continue;
        const own = new Set();
        mesh.vertexObject.forEach((id, i) => {
          if (id === holder) own.add(i);
        });
        removed(mesh.removeVertices(own));
        changed = true;
        held.delete(holder);
        for (const theirs of held.values()) {
          for (const [n, id] of theirs) if (id === holder) theirs.delete(n);
        }
      }
    }

    // An object that holds the image of one already seen to is that image
    // now: it is not made the source in its turn (its twins moved along, so
    // it is touched too - and might choose another side).
    const imaged = new Set();
    for (const [objectId, positions] of touched) {
      const index = mesh.objects.findIndex((object) => object.id === objectId);
      if (index < 0 || imaged.has(objectId)) continue;
      for (const holder of held.get(objectId)?.values() ?? []) imaged.add(holder);
      const planes = this.planesFor(index);
      if (!planes.length) continue;
      // The edited side: where most of the touched positions are, per plane -
      // those of what is there now, if that tells: an object taken across a
      // plane is on the side it has come to, not the one it left.
      const present = positions.filter((p) => !before.vertices.includes(p));
      const signs = {};
      for (const { axis, value } of planes) {
        const count = (list) => list.reduce((sum, p) => sum + (p[axis] > value + EPS ? 1 : p[axis] < value - EPS ? -1 : 0), 0);
        const vote = count(present) || count(positions);
        signs[axis] = vote < 0 ? -1 : 1;
      }
      const result = this.reconcileObject(index, planes, signs, before, beforeIndex, held);
      if (result.changed) changed = true;
      if (result.remap) removed(result.remap);
    }
    return changed ? remap : null;
  }

  // One object: the orthant given by `signs` is the source; its images under
  // every combination of the planes are brought up to date, and what else
  // is on the other sides goes. Returns { changed, remap } - the remap of a
  // removal, if there was one.
  reconcileObject(index, planes, signs, before, beforeIndex, held) {
    const { mesh } = this.editor;
    const object = mesh.objects[index];
    const id = object.id;
    const local = planes[0].local;
    let changed = false;
    const side = (p, plane) => (p[plane.axis] > plane.value + EPS ? 1 : p[plane.axis] < plane.value - EPS ? -1 : 0);
    const near = (p, plane) => side(p, plane) === 0 || side(p, plane) === signs[plane.axis];
    const ownFaces = () => mesh.faces.map((f, k) => (mesh.vertexObject[f[0]] === id ? k : -1)).filter((k) => k >= 0);
    const crosses = (loop, plane) =>
      loop.some((i) => side(mesh.vertices[i], plane) > 0) && loop.some((i) => side(mesh.vertices[i], plane) < 0);
    // Whether a loop is its own mirror image under these planes.
    const symmetric = (loop, some) => {
      const keys = new Set(loop.map((i) => keyOf(mesh.vertices[i])));
      return loop.every((i) => keys.has(keyOf(mirrorPoint(mesh.vertices[i], some))));
    };

    // A face across a plane that is not its own mirror image: the object is
    // cut along the plane, so that each side has its own faces.
    for (const plane of planes) {
      const asymmetric = ownFaces().some((k) => crosses(mesh.faces[k], plane) && !symmetric(mesh.faces[k], [plane]));
      if (asymmetric) {
        mesh.planeCut(ownFaces(), plane.axis, plane.value);
        changed = true;
      }
    }

    const own = [];
    mesh.vertexObject.forEach((o, i) => {
      if (o === id) own.push(i);
    });
    // The source: the object's vertices in the edited orthant (the planes included).
    const source = own.filter((i) => planes.every((plane) => near(mesh.vertices[i], plane)));
    const sourceSet = new Set(source);
    const keep = new Set(source);
    const keepFaces = new Set();
    const keepWires = new Set();
    const involved = new Set([id]);
    // Global: the objects that held this one's images before the edit are
    // brought up to date too, wherever the images have moved since.
    // An image that was another object's stays that object's (`apart`: which
    // of the `images`, by number -> whose, see holders()), also when the two
    // have come to meet on the plane: objects do not grow into one of
    // themselves. Where that is not known the images are found by their
    // place - but never in an object that holds the image of another
    // (`taken`), as one would be when this object is a copy of that other,
    // standing where it stands.
    const images = subsets(planes);
    const apart = new Map();
    const taken = new Set();
    if (!local) {
      const alive = new Set(mesh.objects.map((candidate) => candidate.id));
      for (const [n, holder] of held.get(id) ?? []) {
        if (!alive.has(holder)) continue;
        apart.set(n, holder);
        involved.add(holder);
      }
      for (const [other, theirs] of held) {
        if (other !== id) for (const holder of theirs.values()) taken.add(holder);
      }
      for (let i = 0; i < before.vertices.length; i++) {
        if (before.vertexObject[i] !== id) continue;
        images.forEach((some, n) => {
          if (apart.has(n)) return;
          const owner = before.vertexObject[beforeIndex.get(keyOf(mirrorPoint(before.vertices[i], some)))];
          if (owner !== undefined && alive.has(owner) && !taken.has(owner)) involved.add(owner);
        });
      }
    }

    const positions = new Map(); // position -> indices of the vertices there
    mesh.vertices.forEach((p, i) => {
      const key = keyOf(p);
      if (!positions.has(key)) positions.set(key, []);
      positions.get(key).push(i);
    });
    const findAt = (p, owner) => {
      const there = positions.get(keyOf(p));
      if (!there) return undefined;
      if (owner !== undefined) return there.find((i) => mesh.vertexObject[i] === owner);
      return there.find((i) => mesh.vertexObject[i] === id) ?? (local ? undefined : there.find((i) => !taken.has(mesh.vertexObject[i])));
    };
    const faceByKey = new Map(mesh.faces.map((f, k) => [sortedKey(f), k]));
    const wireByKey = new Map(mesh.wires.map((w, k) => [sortedKey(w), k]));
    // The faces and wires that are mirrored under `some` of the planes: those
    // on the source side of each of those planes, and, for the other planes,
    // either on the source side or across the plane but symmetric about it
    // (such a loop is its own image there).
    const sourceLoops = (list, some) => {
      const rest = planes.filter((plane) => !some.includes(plane));
      return list.map((loop, k) => k).filter((k) => {
        const loop = list[k];
        if (mesh.vertexObject[loop[0]] !== id) return false;
        if (!loop.every((i) => some.every((plane) => near(mesh.vertices[i], plane)))) return false;
        return rest.every((plane) => loop.every((i) => near(mesh.vertices[i], plane)) || (crosses(loop, plane) && symmetric(loop, [plane])));
      });
    };

    for (const [n, some] of images.entries()) {
      // A vertex's image under these planes: itself when it lies on them, a
      // vertex already at the mirrored position, or a new one. In an image
      // that is another object, always a vertex of that object.
      const owner = apart.get(n);
      const image = new Map();
      const imageOf = (v) => {
        if (image.has(v)) return image.get(v);
        const p = mesh.vertices[v];
        const target = mirrorPoint(p, some);
        let w = v;
        if (owner !== undefined || keyOf(target) !== keyOf(p)) {
          w = findAt(target, owner);
          if (w === undefined) {
            w = mesh.addVertex(target.x, target.y, target.z, owner ?? id);
            // (in the skin as its source is, bent by the nodes mirrored)
            const weights = mesh.weights.get(v);
            if (weights) mesh.setWeights(w, mirroredWeights(this.editor, weights, some));
            const key = keyOf(target);
            if (!positions.has(key)) positions.set(key, []);
            positions.get(key).push(w);
            changed = true;
          }
          involved.add(mesh.vertexObject[w]);
          keep.add(w);
        }
        image.set(v, w);
        return w;
      };
      for (const v of source) imageOf(v);
      // Every source face has its image. A reflection turns a face over, so
      // the image runs the other way round; two reflections make a turn,
      // which leaves it as it is.
      for (const k of sourceLoops(mesh.faces, some)) {
        const f = mesh.faces[k];
        const loop = f.map(imageOf);
        if (some.length % 2 === 1) loop.reverse();
        const key = sortedKey(loop);
        if (key === sortedKey(f)) continue; // its own image
        const existing = faceByKey.get(key);
        if (existing === undefined) {
          mesh.faces.push(loop);
          faceByKey.set(key, mesh.faces.length - 1);
          changed = true;
        } else if (!sameCycle(mesh.faces[existing], loop)) {
          inheritUV(loop, mesh.faces[existing]);
          mesh.faces[existing] = loop;
          changed = true;
        }
        keepFaces.add(key);
      }
      for (const k of sourceLoops(mesh.wires, some)) {
        const wire = mesh.wires[k].map(imageOf);
        const key = sortedKey(wire);
        if (key === sortedKey(mesh.wires[k])) continue;
        if (!wireByKey.has(key)) {
          mesh.wires.push(wire);
          wireByKey.set(key, mesh.wires.length - 1);
          changed = true;
        }
        keepWires.add(key);
      }
    }
    for (const k of sourceLoops(mesh.faces, planes)) keepFaces.add(sortedKey(mesh.faces[k]));
    for (const k of sourceLoops(mesh.wires, planes)) keepWires.add(sortedKey(mesh.wires[k]));
    for (const some of subsets(planes)) {
      for (const k of sourceLoops(mesh.faces, some)) keepFaces.add(sortedKey(mesh.faces[k]));
      for (const k of sourceLoops(mesh.wires, some)) keepWires.add(sortedKey(mesh.wires[k]));
    }

    // What is left on the other sides and is no image goes: faces and wires
    // first, then the vertices nothing uses. A loop of kept vertices that is
    // neither source nor image lies across a plane; it stays if it is its
    // own mirror image.
    const stale = (loop, keepSet) => {
      if (!involved.has(mesh.vertexObject[loop[0]])) return false;
      if (keepSet.has(sortedKey(loop))) return false;
      if (loop.some((i) => !keep.has(i))) return true;
      const crossed = planes.filter((plane) => crosses(loop, plane));
      return crossed.length === 0 || !symmetric(loop, crossed);
    };
    const facesBefore = mesh.faces.length;
    const wiresBefore = mesh.wires.length;
    mesh.faces = mesh.faces.filter((f) => !stale(f, keepFaces));
    mesh.wires = mesh.wires.filter((w) => !stale(w, keepWires));
    if (mesh.faces.length !== facesBefore || mesh.wires.length !== wiresBefore) changed = true;

    // Global: images that do not hang together with the source are objects
    // of their own - each connected piece of them the object it already
    // belongs to, or a new one. (A piece joined to the source by a face, as
    // when the object stands on the plane, stays in the object.)
    if (!local) changed = this.assignImages(index, planes, signs, keep, sourceSet) || changed;

    const doomed = new Set();
    mesh.vertexObject.forEach((o, i) => {
      if (involved.has(o) && !keep.has(i)) doomed.add(i);
    });
    let remap = null;
    if (doomed.size) {
      remap = mesh.removeVertices(doomed);
      changed = true;
    }
    return { changed, remap };
  }

  // See reconcileObject(): the image vertices (kept, not source) in connected
  // pieces, each given its object. Returns whether anything changed.
  assignImages(index, planes, signs, keep, sourceSet) {
    const { mesh } = this.editor;
    const object = mesh.objects[index];
    const images = [...keep].filter((i) => !sourceSet.has(i));
    if (images.length === 0) return false;
    const imageSet = new Set(images);
    // Union-find over the image vertices, joined by the faces and wires that remain.
    const parent = new Map(images.map((i) => [i, i]));
    const find = (i) => {
      while (parent.get(i) !== i) {
        parent.set(i, parent.get(parent.get(i)));
        i = parent.get(i);
      }
      return i;
    };
    const touching = new Set(); // roots of pieces that share a face with the source
    for (const loop of [...mesh.faces, ...mesh.wires]) {
      const mine = loop.filter((i) => imageSet.has(i));
      for (let k = 1; k < mine.length; k++) parent.set(find(mine[k]), find(mine[0]));
      if (mine.length && loop.some((i) => sourceSet.has(i))) touching.add(mine[0]);
    }
    const pieces = new Map();
    for (const i of images) {
      const root = find(i);
      if (!pieces.has(root)) pieces.set(root, []);
      pieces.get(root).push(i);
    }
    const touchingRoots = new Set([...touching].map(find));
    let changed = false;
    for (const [root, piece] of pieces) {
      let target;
      if (touchingRoots.has(root)) {
        target = object.id;
      } else {
        // The object most of the piece is in already, unless that is this one.
        const count = new Map();
        for (const i of piece) {
          const o = mesh.vertexObject[i];
          if (o !== object.id) count.set(o, (count.get(o) ?? 0) + 1);
        }
        target = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        if (target === undefined) {
          target = mesh.addObject(object.name, 'mesh');
          const made = mesh.objects[mesh.objects.length - 1];
          made.parent = object.parent ?? null;
          if (object.hidden) made.hidden = true;
          if (object.color) made.color = object.color;
          if (object.oneSided) made.oneSided = true;
          if (object.smooth) made.smooth = object.smooth;
          if (object.atlas) made.atlas = object.atlas;
          else delete made.atlas;
          changed = true;
        }
        // Its pivot point and its turn: this object's, mirrored the way the piece is.
        if (object.pivot || object.rotation) {
          const centre = piece.reduce((sum, i) => sum.add(mesh.vertices[i]), new THREE.Vector3()).divideScalar(piece.length);
          const across = planes.filter(({ axis, value }) => Math.sign(centre[axis] - value) === -signs[axis]);
          const other = mesh.objects.find((candidate) => candidate.id === target);
          const pivot = object.pivot ? mirrorPoint(new THREE.Vector3().fromArray(object.pivot), across).toArray() : null;
          if (other && pivot && JSON.stringify(other.pivot) !== JSON.stringify(pivot)) {
            other.pivot = pivot;
            changed = true;
          }
          const rotation = mirrorRotation(object.rotation, across.map(({ axis }) => axis));
          if (other && JSON.stringify(other.rotation ?? null) !== JSON.stringify(rotation)) {
            setRotation(other, rotation);
            changed = true;
          }
        }
      }
      for (const i of piece) {
        if (mesh.vertexObject[i] !== target) {
          mesh.vertexObject[i] = target;
          changed = true;
        }
      }
    }
    return changed;
  }
}
