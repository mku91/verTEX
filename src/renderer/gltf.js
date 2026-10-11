// Export to glTF 2.0: the scene as a .glb file (one binary file with all in
// it) or a .gltf one (the same as text, the data written into it in base64).
//
// A glTF file is a description of the scene in JSON over a block of bytes:
//
//   nodes        the entries of the scene tree, each with its place and its
//                turn (a quaternion) relative to what it is in
//   meshes       an object's triangles: `accessors` say where in the bytes
//                its positions, normals, places on the atlas and indices are
//   materials    one for what is on the atlas, one for what is not
//   textures     the atlas' picture (a PNG among the bytes) and a sampler -
//                how it is to be shown: pixel by pixel, which is what this
//                format, unlike FBX, has a word for
//
// What goes in is the model as a project file has it (see modelOf() in
// project.js), as with FBX (see fbx.js); up is Y and a unit is a metre in
// both, so nothing is converted.
//
//   - glTF knows triangles only: the faces are cut the way the editor draws
//     them (`triangles`, see EditableMesh.triangulate()).
//   - The model is flat-shaded, so every corner of a face is a vertex of its
//     own, with the face's normal.
//   - Places on the atlas are fractions of the picture, from its top left as
//     here: v is not turned over.
//   - The material shows both sides, as the editor does.
//   - Hidden entries and the edges drawn on their own are left out.

import * as THREE from 'three';
import { quaternionOf } from './frames.js';

// The numbers glTF has for these (they are WebGL's).
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const NEAREST = 9728;
const CLAMP_TO_EDGE = 33071;

// The block of bytes, put together piece by piece; every piece starts at a multiple of four.
class Bytes {
  constructor() {
    this.pieces = [];
    this.length = 0;
  }

  // Adds a piece and returns where it starts.
  add(piece) {
    const bytes = new Uint8Array(piece.buffer, piece.byteOffset, piece.byteLength);
    const start = this.length;
    this.pieces.push(bytes);
    this.length += bytes.length;
    const gap = (4 - (this.length % 4)) % 4;
    if (gap) {
      this.pieces.push(new Uint8Array(gap));
      this.length += gap;
    }
    return start;
  }

  whole() {
    const bytes = new Uint8Array(this.length);
    let at = 0;
    for (const piece of this.pieces) {
      bytes.set(piece, at);
      at += piece.length;
    }
    return bytes;
  }
}

function base64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// The normal of a polygon, by its corners (counter-clockwise from outside).
function normalOf(points) {
  const normal = new THREE.Vector3();
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length];
    normal.x += (a.y - b.y) * (a.z + b.z);
    normal.y += (a.z - b.z) * (a.x + b.x);
    normal.z += (a.x - b.x) * (a.y + b.y);
  });
  return normal.lengthSq() > 0 ? normal.normalize() : normal.set(0, 1, 0);
}

// The model (see modelOf() in project.js) as the bytes of a glTF file.
//   name       what the scene is called
//   triangles  cuts a face (by its number) into triangles: triples of vertices
//   picture    the atlas' picture as the bytes of a PNG, or null without one
//   binary     a .glb file; or else a .gltf one, as text
export function gltfOf(model, { name, triangles, picture, binary }) {
  const bytes = new Bytes();
  const gltf = {
    asset: { version: '2.0', generator: 'verTEX' },
    scene: 0,
    scenes: [{ name, nodes: [] }],
    nodes: [],
    meshes: [],
    materials: [],
    accessors: [],
    bufferViews: [],
    buffers: [],
  };
  const view = (piece, target) => gltf.bufferViews.push({ buffer: 0, byteOffset: bytes.add(piece), byteLength: piece.byteLength, ...(target ? { target } : {}) }) - 1;
  const accessor = (piece, type, count, more = {}) =>
    gltf.accessors.push({
      bufferView: view(piece, type === 'SCALAR' ? ELEMENT_ARRAY_BUFFER : ARRAY_BUFFER),
      componentType: piece instanceof Float32Array ? FLOAT : piece instanceof Uint16Array ? UNSIGNED_SHORT : UNSIGNED_INT,
      count,
      type,
      ...more,
    }) - 1;

  // The materials, made when first called for: one with the atlas on it, one without.
  const materials = new Map();
  const materialFor = (textured) => {
    if (!materials.has(textured)) {
      const material = {
        name: textured ? name : `${name}.plain`,
        pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 },
        doubleSided: true,
      };
      if (textured) {
        gltf.samplers = [{ magFilter: NEAREST, minFilter: NEAREST, wrapS: CLAMP_TO_EDGE, wrapT: CLAMP_TO_EDGE }];
        gltf.images = [{ name, mimeType: 'image/png', ...(binary ? { bufferView: view(picture) } : { uri: `data:image/png;base64,${base64(picture)}` }) }];
        gltf.textures = [{ name, sampler: 0, source: 0 }];
        material.pbrMetallicRoughness.baseColorTexture = { index: 0 };
      }
      materials.set(textured, gltf.materials.push(material) - 1);
    }
    return materials.get(textured);
  };

  // An object's mesh: every corner of every face of it a vertex, the faces in triangles.
  const meshOf = (object) => {
    const textured = Boolean(object.atlas) && Boolean(picture);
    const positions = [];
    const normals = [];
    const places = [];
    const indices = [];
    model.faces.forEach((face, i) => {
      if (model.vertexObject[face[0]] !== object.id) return;
      const first = positions.length / 3;
      const points = face.map((vertex) => new THREE.Vector3(...model.vertices[vertex]));
      const normal = normalOf(points);
      face.forEach((vertex, corner) => {
        positions.push(...model.vertices[vertex]);
        normals.push(normal.x, normal.y, normal.z);
        const place = model.uvs?.[i]?.[corner];
        places.push(place ? place[0] / model.atlas.width : 0, place ? place[1] / model.atlas.height : 0);
      });
      for (const triangle of triangles(i)) indices.push(...triangle.map((vertex) => first + face.indexOf(vertex)));
    });
    if (indices.length === 0) return null;
    const count = positions.length / 3;
    const box = new THREE.Box3().setFromArray(positions);
    return gltf.meshes.push({
      name: object.name,
      primitives: [{
        attributes: {
          POSITION: accessor(new Float32Array(positions), 'VEC3', count, { min: box.min.toArray(), max: box.max.toArray() }),
          NORMAL: accessor(new Float32Array(normals), 'VEC3', count),
          ...(textured ? { TEXCOORD_0: accessor(new Float32Array(places), 'VEC2', count) } : {}),
        },
        indices: accessor(count > 65535 ? new Uint32Array(indices) : new Uint16Array(indices), 'SCALAR', indices.length),
        material: materialFor(textured),
      }],
    }) - 1;
  };

  // What is hidden, itself or by a group above it, is left out.
  const byId = new Map(model.objects.map((object) => [object.id, object]));
  const hidden = (object) => Boolean(object) && (Boolean(object.hidden) || hidden(byId.get(object.parent)));
  const shown = model.objects.filter((object) => !hidden(object));
  const numbers = new Map(shown.map((object, i) => [object.id, i]));
  for (const object of shown) {
    const mesh = object.kind === 'group' ? null : meshOf(object);
    const children = shown.filter((other) => other.parent === object.id).map((other) => numbers.get(other.id));
    gltf.nodes.push({
      name: object.name,
      translation: [...object.position],
      ...(object.rotation ? { rotation: quaternionOf(object.rotation).toArray() } : {}),
      ...(mesh === null ? {} : { mesh }),
      ...(children.length ? { children } : {}),
    });
    if (!numbers.has(object.parent)) gltf.scenes[0].nodes.push(numbers.get(object.id));
  }

  const data = bytes.whole();
  gltf.buffers.push({ byteLength: data.length, ...(binary ? {} : { uri: `data:application/octet-stream;base64,${base64(data)}` }) });
  if (!binary) return new TextEncoder().encode(JSON.stringify(gltf, null, 1));

  // A .glb: a header, the JSON (filled up with spaces to a multiple of four), the bytes.
  const text = new TextEncoder().encode(JSON.stringify(gltf));
  const json = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20);
  json.set(text);
  const file = new Uint8Array(12 + 8 + json.length + 8 + data.length);
  const header = new DataView(file.buffer);
  header.setUint32(0, 0x46546c67, true); // "glTF"
  header.setUint32(4, 2, true);
  header.setUint32(8, file.length, true);
  header.setUint32(12, json.length, true);
  header.setUint32(16, 0x4e4f534a, true); // "JSON"
  file.set(json, 20);
  header.setUint32(20 + json.length, data.length, true);
  header.setUint32(24 + json.length, 0x004e4942, true); // "BIN"
  file.set(data, 28 + json.length);
  return file;
}
