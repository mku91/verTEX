// Import from glTF 2.0, a .glb file (one binary file with all in it): what
// of it verTEX can take, as a scene of entries for Editor.importModel().
//
// A .glb is a header (the word "glTF", the version - 2 - and the length),
// then a chunk of JSON describing the scene, then a chunk of bytes (BIN)
// that the description points into:
//
//   scenes, nodes      the scene tree: each node with its place, turn and size
//                      (or a matrix) relative to its parent, perhaps a mesh
//   meshes             of primitives: triangles whose corners' positions and
//                      places on a picture (TEXCOORD_n) are `accessors`
//   accessors          a run of numbers in a `bufferView` (a piece of a
//                      buffer): their type, count, stride, scaling; perhaps
//                      `sparse` - a few of them replaced
//   materials          a primitive's look: its base colour's picture is
//                      `textures` -> `images`, the bytes of a PNG or JPEG
//
// What verTEX has differs; so:
//   - Every node with a mesh is an object; a node without one that holds some
//     is a node. Only a node holds anything here: a mesh's node that holds
//     more is made a node, with the mesh an object in it (as verTEX's own
//     export writes a body). The rest - cameras, lights, nodes left empty -
//     goes.
//   - An entry's vertices are where they are in the world: the node's size
//     goes into them; its place and turn are the entry's pivot point and
//     frame. (A node seen in a mirror - a scale below zero - turns its
//     triangles over, which is put right.)
//   - glTF has a vertex for every corner that differs - in its place on the
//     picture, its normal: corners in one place in an object are one vertex
//     here, or the model would come apart into its triangles.
//   - glTF knows triangles only: two that lie in one plane, side by side, and
//     make a convex four-cornered face with the same places on the picture
//     along the edge between them are one face again (as Blender's "Tris to
//     Quads"). A face of more corners comes back in quads and triangles -
//     but from a file verTEX wrote, whose primitives say how many corners
//     each face had (`extras.verTEXFaces`, see gltf.js), every face is as it was.
//   - Places on a picture stay fractions of it here (from its top left, as in
//     glTF); the editor makes pixels of them, once it knows the pictures' sizes.
//   - Normals, vertex colours, skins and animations are left out (verTEX
//     works out its normals itself); what was is told in `skipped`.

import * as THREE from 'three';

// What a file needs and this does not read: it is not imported (rather than
// imported wrong). Those named here are read, or harmless to leave unread.
const READ = new Set([
  'KHR_mesh_quantization', // positions and places as scaled integers: read as any accessor
  'KHR_materials_unlit',
  'KHR_materials_emissive_strength',
  'EXT_texture_webp', // the picture is a WebP, which the page reads
  'OMI_physics_body',
  'OMI_physics_shape',
]);

const GLB_MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const SIZES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
// componentType -> [bytes, the largest value, which scales a normalized one to 1, the DataView reader]
const COMPONENTS = {
  5120: [1, 127, 'getInt8'],
  5121: [1, 255, 'getUint8'],
  5122: [2, 32767, 'getInt16'],
  5123: [2, 65535, 'getUint16'],
  5125: [4, 4294967295, 'getUint32'],
  5126: [4, 1, 'getFloat32'],
};
const TRIANGLES = 4;
const TRIANGLE_STRIP = 5;
const TRIANGLE_FAN = 6;
const WELD = 1e5; // corners nearer than 1 / WELD of a unit are one vertex
const PLANAR = 1e-4; // two triangles' normals' cosine from 1 below which they are in one plane
const CONVEX = 1e-9;

// A file that can't be imported; `code` says why (see app.import.error.* in the locales).
export class ImportError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

// The JSON and the buffers of a .glb file's bytes.
function readGlb(bytes) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || data.getUint32(0, true) !== GLB_MAGIC) throw new ImportError('not-glb');
  const version = data.getUint32(4, true);
  if (version !== 2) throw new ImportError('version', String(version));
  let json = null;
  let bin = null;
  for (let at = 12; at + 8 <= bytes.byteLength;) {
    const length = data.getUint32(at, true);
    const type = data.getUint32(at + 4, true);
    const chunk = bytes.subarray(at + 8, at + 8 + length);
    if (type === JSON_CHUNK && !json) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (type === BIN_CHUNK && !bin) bin = chunk;
    at += 8 + length + ((4 - (length % 4)) % 4);
  }
  if (!json) throw new ImportError('not-glb');
  const buffers = (json.buffers ?? []).map((buffer, i) => {
    if (buffer.uri === undefined) {
      if (i !== 0 || !bin) throw new ImportError('broken', `buffer ${i}`);
      return bin;
    }
    const match = /^data:[^,]*;base64,(.*)$/.exec(buffer.uri);
    if (!match) throw new ImportError('external', buffer.uri);
    return Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0));
  });
  return { gltf: json, buffers };
}

// Numbers read from a buffer view: `count` items of `size` numbers each, as a
// Float64Array - normalized integers scaled into -1..1 or 0..1.
function readNumbers(gltf, buffers, { bufferView, byteOffset = 0, componentType, normalized = false }, count, size) {
  const [bytes, largest, reader] = COMPONENTS[componentType] ?? [];
  if (!reader) throw new ImportError('broken', `componentType ${componentType}`);
  const out = new Float64Array(count * size);
  if (bufferView === undefined) return out; // all zeros, unless sparse says otherwise
  const view = gltf.bufferViews?.[bufferView];
  const buffer = view && buffers[view.buffer];
  if (!buffer) throw new ImportError('broken', `bufferView ${bufferView}`);
  const stride = view.byteStride || bytes * size;
  const start = (view.byteOffset ?? 0) + byteOffset;
  if (count > 0 && start + (count - 1) * stride + size * bytes > buffer.byteLength) throw new ImportError('broken', `bufferView ${bufferView}`);
  const data = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < size; k++) {
      const value = data[reader](start + i * stride + k * bytes, true);
      out[i * size + k] = normalized && componentType !== 5126 ? Math.max(value / largest, -1) : value;
    }
  }
  return out;
}

// An accessor's numbers, `size` per item: { values, count, size }.
function readAccessor(gltf, buffers, index) {
  const accessor = gltf.accessors?.[index];
  if (!accessor) throw new ImportError('broken', `accessor ${index}`);
  const size = SIZES[accessor.type];
  if (!size) throw new ImportError('broken', `accessor ${index}`);
  const values = readNumbers(gltf, buffers, accessor, accessor.count, size);
  const sparse = accessor.sparse;
  if (sparse?.count) {
    const at = readNumbers(gltf, buffers, { ...sparse.indices, normalized: false }, sparse.count, 1);
    const replaced = readNumbers(gltf, buffers, { ...sparse.values, componentType: accessor.componentType, normalized: accessor.normalized }, sparse.count, size);
    for (let i = 0; i < sparse.count; i++) values.set(replaced.subarray(i * size, (i + 1) * size), at[i] * size);
  }
  return { values, count: accessor.count, size };
}

// A node's matrix relative to its parent.
function localMatrix(node) {
  if (node.matrix) return new THREE.Matrix4().fromArray(node.matrix);
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...(node.translation ?? [0, 0, 0])),
    new THREE.Quaternion(...(node.rotation ?? [0, 0, 0, 1])),
    new THREE.Vector3(...(node.scale ?? [1, 1, 1])),
  );
}

// The picture (its index among `images`) a material shows its base colour
// with, and which TEXCOORD it takes the places from; null for none.
function pictureOf(gltf, material) {
  const info = gltf.materials?.[material]?.pbrMetallicRoughness?.baseColorTexture;
  const texture = info && gltf.textures?.[info.index];
  const source = texture?.extensions?.EXT_texture_webp?.source ?? texture?.source;
  return source === undefined ? null : { image: source, set: info.texCoord ?? 0 };
}

// The triangles of a primitive, as index triples into its vertices; null if
// it is no surface (points, lines).
function primitiveTriangles(mode, indices, count) {
  const index = indices ?? Array.from({ length: count }, (_, i) => i);
  const triangles = [];
  if (mode === TRIANGLES) {
    for (let i = 0; i + 2 < index.length; i += 3) triangles.push([index[i], index[i + 1], index[i + 2]]);
  } else if (mode === TRIANGLE_STRIP) {
    for (let i = 0; i + 2 < index.length; i++) triangles.push(i % 2 ? [index[i + 1], index[i], index[i + 2]] : [index[i], index[i + 1], index[i + 2]]);
  } else if (mode === TRIANGLE_FAN) {
    for (let i = 1; i + 1 < index.length; i++) triangles.push([index[0], index[i], index[i + 1]]);
  } else {
    return null;
  }
  return triangles;
}

const same = (a, b) => (a === null && b === null) || (a !== null && b !== null && Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7);

// Triangles side by side made quads where they can be, see the top. A
// triangle is { loop: [a, b, c] (vertex indices), uv: [[u, v] x 3] or null,
// image }; so is the result, of three or four corners.
export function quadsOf(triangles, points) {
  const normal = (loop) => new THREE.Vector3().subVectors(points[loop[1]], points[loop[0]]).cross(new THREE.Vector3().subVectors(points[loop[2]], points[loop[0]])).normalize();
  const normals = triangles.map((triangle) => normal(triangle.loop));
  const byEdge = new Map();
  triangles.forEach((triangle, t) => {
    triangle.loop.forEach((a, k) => {
      const b = triangle.loop[(k + 1) % 3];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (!byEdge.has(key)) byEdge.set(key, []);
      byEdge.get(key).push({ t, k });
    });
  });
  const candidates = [];
  for (const sides of byEdge.values()) {
    if (sides.length !== 2) continue;
    const [one, two] = sides;
    const first = triangles[one.t];
    const second = triangles[two.t];
    if (one.t === two.t || first.image !== second.image || (first.uv === null) !== (second.uv === null)) continue;
    if (normals[one.t].dot(normals[two.t]) < 1 - PLANAR) continue;
    // The first from the shared edge: p0 -> p1 -> p2; the second must run it the other way: p1 -> p0 -> d.
    const turn = (triangle, k) => [0, 1, 2].map((j) => (k + j) % 3);
    const [i0, i1, i2] = turn(first, one.k);
    const [j0, j1, j2] = turn(second, two.k);
    const p0 = first.loop[i0];
    const p1 = first.loop[i1];
    if (second.loop[j0] !== p1 || second.loop[j1] !== p0) continue; // the two face opposite ways
    const uv = (triangle, j) => (triangle.uv ? triangle.uv[j] : null);
    if (!same(uv(first, i0), uv(second, j1)) || !same(uv(first, i1), uv(second, j0))) continue; // a seam along the edge
    const loop = [p1, first.loop[i2], p0, second.loop[j2]];
    const places = first.uv ? [uv(first, i1), uv(first, i2), uv(first, i0), uv(second, j2)] : null;
    // Convex, and how far from square (0: right angles) - the squarest go first.
    const n = normals[one.t];
    let convex = true;
    let skew = 0;
    for (let k = 0; k < 4; k++) {
      const before = new THREE.Vector3().subVectors(points[loop[k]], points[loop[(k + 3) % 4]]);
      const after = new THREE.Vector3().subVectors(points[loop[(k + 1) % 4]], points[loop[k]]);
      if (before.clone().cross(after).dot(n) <= CONVEX * before.length() * after.length()) convex = false;
      skew += Math.abs(before.normalize().dot(after.normalize()));
    }
    if (convex) candidates.push({ pair: [one.t, two.t], loop, uv: places, image: first.image, skew });
  }
  candidates.sort((a, b) => a.skew - b.skew);
  const used = new Set();
  const faces = [];
  for (const candidate of candidates) {
    if (candidate.pair.some((t) => used.has(t))) continue;
    candidate.pair.forEach((t) => used.add(t));
    faces.push({ loop: candidate.loop, uv: candidate.uv, image: candidate.image });
  }
  triangles.forEach((triangle, t) => {
    if (!used.has(t)) faces.push(triangle);
  });
  return faces;
}

// The scene of a .glb file's bytes:
//   entries   [{ name, kind ('mesh' | 'node'), parent (an index among them,
//             or null), matrix (in the world), points ([Vector3], in the
//             world), faces ([{ loop, uv, image }]) }] - parents before children
//   images    [{ bytes, mimeType, name }] - the pictures the faces' `image`
//             counts in
//   skipped   names of what was in the file and is left out
export function sceneOfGlb(bytes) {
  const { gltf, buffers } = readGlb(bytes);
  const unread = (gltf.extensionsRequired ?? []).filter((name) => !READ.has(name));
  if (unread.length) throw new ImportError('extensions', unread.join(', '));
  const nodes = gltf.nodes ?? [];
  const skipped = new Set();
  if (gltf.animations?.length) skipped.add('animations');
  if (gltf.skins?.length) skipped.add('skins');

  // The roots: the scene's, or every node that is in none.
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  let roots = scene?.nodes;
  if (!roots) {
    const children = new Set(nodes.flatMap((node) => node.children ?? []));
    roots = nodes.map((_, i) => i).filter((i) => !children.has(i));
  }

  // The geometry of a mesh seen through a world matrix: the points, welded, and the faces.
  const meshGeometry = (meshIndex, matrix) => {
    const mesh = gltf.meshes?.[meshIndex];
    if (!mesh) throw new ImportError('broken', `mesh ${meshIndex}`);
    const mirrored = matrix.determinant() < 0;
    const points = [];
    const welded = new Map();
    const vertexAt = (point) => {
      const key = `${Math.round(point.x * WELD)},${Math.round(point.y * WELD)},${Math.round(point.z * WELD)}`;
      if (!welded.has(key)) {
        welded.set(key, points.length);
        points.push(point);
      }
      return welded.get(key);
    };
    const triangles = [];
    const faces = []; // those of verTEX's own files, whole
    for (const primitive of mesh.primitives ?? []) {
      if (primitive.extensions?.KHR_draco_mesh_compression) throw new ImportError('extensions', 'KHR_draco_mesh_compression');
      const position = primitive.attributes?.POSITION;
      if (position === undefined) continue;
      if (primitive.attributes.COLOR_0 !== undefined) skipped.add('colors');
      const positions = readAccessor(gltf, buffers, position);
      const indices = primitive.indices === undefined ? null : Array.from(readAccessor(gltf, buffers, primitive.indices).values);
      const corners = primitiveTriangles(primitive.mode ?? TRIANGLES, indices, positions.count);
      if (!corners) {
        skipped.add('lines');
        continue;
      }
      const picture = primitive.material === undefined ? null : pictureOf(gltf, primitive.material);
      const set = picture && primitive.attributes[`TEXCOORD_${picture.set}`];
      const places = set === undefined || set === null ? null : readAccessor(gltf, buffers, set);
      const vertex = positions.values;
      const ids = new Map(); // the primitive's vertex -> ours
      const ours = (i) => {
        if (!ids.has(i)) ids.set(i, vertexAt(new THREE.Vector3(vertex[i * 3], vertex[i * 3 + 1], vertex[i * 3 + 2]).applyMatrix4(matrix)));
        return ids.get(i);
      };
      const placeOf = (i) => [places.values[i * 2], places.values[i * 2 + 1]];
      // Written by verTEX: its faces as they were, each its corners in a row.
      const loops = primitive.extras?.verTEXFaces;
      if (Array.isArray(loops) && loops.every((n) => Number.isInteger(n) && n >= 3) && loops.reduce((sum, n) => sum + n, 0) === positions.count) {
        let first = 0;
        for (const n of loops) {
          let corner = Array.from({ length: n }, (_, k) => first + k);
          first += n;
          if (mirrored) corner = corner.reverse();
          // (corners welded together are one)
          const kept = corner.filter((i, k) => ours(i) !== ours(corner[(k + n - 1) % n]));
          if (new Set(kept.map(ours)).size < 3) continue;
          faces.push({ loop: kept.map(ours), uv: places ? kept.map(placeOf) : null, image: places ? picture.image : null });
        }
        continue;
      }
      for (let corner of corners) {
        if (corner.some((i) => i >= positions.count)) throw new ImportError('broken', `mesh ${meshIndex}`);
        if (mirrored) corner = [corner[0], corner[2], corner[1]];
        const loop = corner.map(ours);
        if (new Set(loop).size < 3) continue; // welded to nothing
        const area = new THREE.Vector3().subVectors(points[loop[1]], points[loop[0]]).cross(new THREE.Vector3().subVectors(points[loop[2]], points[loop[0]])).length();
        if (area < 1e-12) continue;
        triangles.push({ loop, uv: places ? corner.map(placeOf) : null, image: places ? picture.image : null });
      }
    }
    return { points, faces: [...faces, ...quadsOf(triangles, points)] };
  };

  // The tree, walked from the roots: what is kept, parents first.
  const entries = [];
  const walk = (index, parentMatrix, parent, seen) => {
    const node = nodes[index];
    if (!node || seen.has(index)) throw new ImportError('broken', `node ${index}`);
    seen = new Set(seen).add(index);
    const matrix = parentMatrix.clone().multiply(localMatrix(node));
    const name = node.name || (node.mesh !== undefined ? gltf.meshes?.[node.mesh]?.name : '') || (node.mesh !== undefined ? 'Mesh' : 'Node');
    const children = node.children ?? [];
    const geometry = node.mesh !== undefined ? meshGeometry(node.mesh, matrix) : null;
    const hasMesh = geometry && geometry.faces.length > 0;
    if (!hasMesh && children.length === 0) return false;
    const at = entries.length;
    entries.push({ name, kind: hasMesh && children.length === 0 ? 'mesh' : 'node', parent, matrix, points: [], faces: [] });
    let holds = false;
    if (hasMesh && children.length) {
      // A mesh's node that holds more: a node, its mesh an object in it.
      entries.push({ name: gltf.meshes[node.mesh]?.name || `${name}_mesh`, kind: 'mesh', parent: at, matrix, ...geometry });
      holds = true;
    } else if (hasMesh) {
      Object.assign(entries[at], geometry);
      return true;
    }
    for (const child of children) if (walk(child, matrix, at, seen)) holds = true;
    if (!holds) {
      // Nothing came of it: it goes, and whatever was added under it went with nothing.
      entries.length = at;
      return false;
    }
    return true;
  };
  for (const root of roots) walk(root, new THREE.Matrix4(), null, new Set());

  const images = (gltf.images ?? []).map((image, i) => {
    let bytesOf = null;
    if (image.bufferView !== undefined) {
      const view = gltf.bufferViews?.[image.bufferView];
      const buffer = view && buffers[view.buffer];
      if (buffer) bytesOf = buffer.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    } else if (image.uri) {
      const match = /^data:([^,;]*)[^,]*;base64,(.*)$/.exec(image.uri);
      if (match) bytesOf = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
      else skipped.add('external pictures');
    }
    return { bytes: bytesOf, mimeType: image.mimeType ?? 'image/png', name: image.name || `picture_${i}` };
  });
  return { entries, images, skipped: [...skipped] };
}
