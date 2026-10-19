import * as THREE from 'three';

// The normals the surface is lit by, at the corners of its faces - the same
// for the view and for the glTF files exported, so that a model looks
// in a game as it does here.
//
// An object is flat-shaded, or smooth-shaded with an angle (`smooth`, in
// degrees, see Editor.setSmoothing()):
//   - flat: every corner of a face has the face's own normal; the faces are
//     lit evenly, and every edge shows;
//   - smooth: a corner has the mean of the normals of the faces that meet at
//     its vertex - those of them that meet the face at less than the angle
//     (auto smooth): the light runs on over the gentle edges, and the sharp
//     ones stay sharp. Each face counts by the angle it has at the vertex,
//     so that a face cut in two counts no more than it did whole.

// The normal of a polygon, by its corners (counter-clockwise from outside):
// Newell's, which holds for a polygon that is not quite flat as well.
export function faceNormal(points) {
  const normal = new THREE.Vector3();
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length];
    normal.x += (a.y - b.y) * (a.z + b.z);
    normal.y += (a.z - b.z) * (a.x + b.x);
    normal.z += (a.x - b.x) * (a.y + b.y);
  });
  return normal.lengthSq() > 0 ? normal.normalize() : normal.set(0, 1, 0);
}

// The normals at the corners of the faces: for every face (a loop of vertex
// numbers into `points`, Vector3s), a Vector3 for every corner, in its
// order. `angleOf(face)` says how a face is shaded: null for flat, or the
// smoothing angle in degrees.
export function cornerNormals(points, faces, angleOf) {
  const normals = faces.map((face) => faceNormal(face.map((vertex) => points[vertex])));
  const angles = faces.map((_, i) => angleOf(i));
  // The faces at each vertex that is smoothed, with the angle each has there.
  const around = new Map();
  faces.forEach((face, f) => {
    if (angles[f] === null) return;
    face.forEach((vertex, k) => {
      const previous = points[face[(k + face.length - 1) % face.length]];
      const next = points[face[(k + 1) % face.length]];
      const here = points[vertex];
      const weight = previous.clone().sub(here).angleTo(next.clone().sub(here)) || 1e-6;
      if (!around.has(vertex)) around.set(vertex, []);
      around.get(vertex).push({ face: f, weight });
    });
  });
  return faces.map((face, f) => {
    if (angles[f] === null) return face.map(() => normals[f].clone());
    const least = Math.cos(THREE.MathUtils.degToRad(angles[f]) + 1e-6);
    return face.map((vertex) => {
      const sum = new THREE.Vector3();
      for (const { face: other, weight } of around.get(vertex)) {
        // Of the same smoothing only - and meeting this face gently enough.
        if (angles[other] === null || normals[other].dot(normals[f]) < least) continue;
        sum.addScaledVector(normals[other], weight);
      }
      return sum.lengthSq() > 0 ? sum.normalize() : normals[f].clone();
    });
  });
}
