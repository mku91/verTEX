// Export to glTF 2.0: the scene as a .glb file (one binary file with all in
// it) or a .gltf one (the same as text, the data written into it in base64).
//
// A glTF file is a description of the scene in JSON over a block of bytes:
//
//   nodes        the entries of the scene tree, each with its place and its
//                turn (a quaternion) relative to what it is in
//   meshes       an object's triangles: `accessors` say where in the bytes
//                its positions, normals, places on the atlas and indices are
//   materials    one for what is on each atlas, one for what is on none
//   textures     each atlas' picture (a PNG among the bytes) and a sampler -
//                how it is to be shown: pixel by pixel
//
// What goes in is the model as a project file has it (see modelOf() in
// project.js); up is Y and a unit is a metre in both, so nothing is
// converted.
//
//   - glTF knows triangles only: the faces are cut the way the editor draws
//     them (`triangles`, see EditableMesh.triangulate()).
//   - Every corner of a face is a vertex of its own, with the normal the
//     editor lights it by: the face's, or for a smooth-shaded object the
//     mean of its neighbours' (see normals.js).
//   - Places on the atlas are fractions of the picture, from its top left as
//     here: v is not turned over.
//   - The material shows both sides, as the editor does - but for the
//     objects that are seen from the front only (`oneSided`): theirs is a
//     material of its own, one-sided.
//   - Hidden entries and the edges drawn on their own are left out.
//   - The animations go as glTF animations on the entries' nodes, made to
//     play in Godot as they do here: see gltf-animation.js.
//   - An object with collision shapes (see collision-fit.js) is a physics
//     body - Godot reads it as one (the OMI_physics_body and
//     OMI_physics_shape extensions, Godot 4.3 and on): its node is the
//     body, which Godot makes a StaticBody3D, an AnimatableBody3D, a
//     RigidBody3D or an Area3D; its mesh goes to a child node of it, as a
//     body's mesh is in Godot (a node that is both is made a body, and its
//     mesh lost); and every shape is a child node, where the shape is in the
//     object's frame. A convex shape is a mesh of its hull, which no node
//     shows; a trimesh one is the object's own mesh.
//   - The skin (see skin.js) is a glTF skin, one an object: an object with
//     vertices in it has its mesh bent by the nodes they are weighted to -
//     its joints - with the four weights and joints of every corner
//     (WEIGHTS_0, JOINTS_0); a joint's inverse bind matrix takes the
//     object's frame at rest into the joint's, at rest. Its vertices not in
//     the skin go with the object, as here: they are weighted to the
//     object's own node, wholly, which is a joint too. (A skinned mesh's
//     node moves nothing of it, glTF has it: only the joints do.)

import * as THREE from 'three';
import { quaternionOf } from './frames.js';
import { cornerNormals } from './normals.js';
import { hullOf } from './collision-fit.js';
import { animationsOf } from './gltf-animation.js';

// The normals at every face's corners, as the editor lights them (see
// normals.js): flat, or smooth for the objects that are.
function modelNormals(model) {
  const points = model.vertices.map((position) => new THREE.Vector3(...position));
  const smooth = new Map(model.objects.map((object) => [object.id, object.smooth ?? null]));
  return cornerNormals(points, model.faces, (face) => smooth.get(model.vertexObject[model.faces[face][0]]) ?? null);
}


// The numbers glTF has for these (they are WebGL's).
const FLOAT = 5126;
const UNSIGNED_BYTE = 5121;
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


// The model (see modelOf() in project.js) as the bytes of a glTF file.
//   name       what the scene is called
//   triangles  cuts a face (by its number) into triangles: triples of vertices
//   pictures   the atlases' pictures as the bytes of PNGs, Map atlas id ->
//              bytes; an object on an atlas with none is not textured
//              (`picture`: the one atlas' - the first's - instead)
//   binary     a .glb file; or else a .gltf one, as text
export function gltfOf(model, { name, triangles, pictures = null, picture = null, binary }) {
  pictures ??= new Map(picture && model.atlases?.[0] ? [[model.atlases[0].id, picture]] : []);
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
      componentType: piece instanceof Float32Array ? FLOAT : piece instanceof Uint8Array ? UNSIGNED_BYTE : piece instanceof Uint16Array ? UNSIGNED_SHORT : UNSIGNED_INT,
      count,
      type,
      ...more,
    }) - 1;

  // The atlases' pictures as textures, made when first called for: the
  // texture of the atlas with the id, by its number. (One sampler for all.)
  const textures = new Map();
  const several = (model.atlases?.length ?? 0) > 1 || Boolean(model.multiAtlas);
  const atlasName = (id) => model.atlases?.find((atlas) => atlas.id === id)?.name ?? id;
  const textureFor = (id) => {
    if (!textures.has(id)) {
      const bytes = pictures.get(id);
      const label = several ? `${name}.${atlasName(id)}` : name;
      gltf.samplers ??= [{ magFilter: NEAREST, minFilter: NEAREST, wrapS: CLAMP_TO_EDGE, wrapT: CLAMP_TO_EDGE }];
      gltf.images ??= [];
      gltf.textures ??= [];
      const source = gltf.images.push({ name: label, mimeType: 'image/png', ...(binary ? { bufferView: view(bytes) } : { uri: `data:image/png;base64,${base64(bytes)}` }) }) - 1;
      textures.set(id, gltf.textures.push({ name: label, sampler: 0, source }) - 1);
    }
    return textures.get(id);
  };

  // The materials, made when first called for: with an atlas' picture on it
  // (`atlas`, its id) or with none (null), seen from both sides or from the
  // front only. With one atlas they are called as they always were (the
  // scene's name, .plain, .oneSided); with several, after their atlas too.
  const materials = new Map();
  const materialFor = (atlas, doubleSided) => {
    const key = `${atlas ?? ''}/${doubleSided}`;
    if (!materials.has(key)) {
      const base = atlas === null ? `${name}.plain` : several ? `${name}.${atlasName(atlas)}` : name;
      const material = {
        name: `${base}${doubleSided ? '' : '.oneSided'}`,
        pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 },
        doubleSided,
      };
      if (atlas !== null) material.pbrMetallicRoughness.baseColorTexture = { index: textureFor(atlas) };
      materials.set(key, gltf.materials.push(material) - 1);
    }
    return materials.get(key);
  };

  // What is hidden, itself or by a node above it, is left out.
  const byId = new Map(model.objects.map((object) => [object.id, object]));
  const hidden = (object) => Boolean(object) && (Boolean(object.hidden) || hidden(byId.get(object.parent)));
  const shown = model.objects.filter((object) => !hidden(object));
  const numbers = new Map(shown.map((object, i) => [object.id, i]));

  // The skins: an object's joints (ids) and, for every vertex of it, its
  // weights to them as [joint number, weight] - or none, for an object with
  // no vertex in the skin. A weight to a node left out goes to the object.
  const skinWeights = new Map(model.weights ?? []);
  const skins = new Map(); // object id -> { joints, weights: Map vertex -> [[joint, weight]] }
  for (const object of shown) {
    if (object.kind === 'node') continue;
    const vertices = model.vertexObject.flatMap((id, vertex) => (id === object.id ? [vertex] : []));
    if (!vertices.some((vertex) => skinWeights.has(vertex))) continue;
    const joints = [];
    const joint = (id) => (joints.includes(id) ? joints.indexOf(id) : joints.push(id) - 1);
    const weights = new Map();
    for (const vertex of vertices) {
      const own = (skinWeights.get(vertex) ?? []).filter(([node, weight]) => numbers.has(node) && weight > 0);
      const sum = own.reduce((total, [, weight]) => total + weight, 0);
      const entries = own.map(([node, weight]) => [joint(node), weight]);
      if (sum < 1 - 1e-6) entries.push([joint(object.id), 1 - sum]);
      weights.set(vertex, entries);
    }
    skins.set(object.id, { joints, weights });
  }
  // An entry's frame in the world, at rest (as its node has it, in its parents').
  const restFrames = new Map();
  const restOf = (id) => {
    if (!restFrames.has(id)) {
      const object = byId.get(id);
      const local = new THREE.Matrix4().compose(new THREE.Vector3(...object.position), quaternionOf(object.rotation ?? null), new THREE.Vector3(1, 1, 1));
      restFrames.set(id, numbers.has(object.parent) ? restOf(object.parent).clone().multiply(local) : local);
    }
    return restFrames.get(id);
  };

  // An object's mesh: every corner of every face of it a vertex, the faces in triangles.
  const cornerNormal = modelNormals(model);
  const meshOf = (object) => {
    const skin = skins.get(object.id);
    const joints = [];
    const weights = [];
    // On its atlas' picture, if that is given; its places fractions of that atlas.
    const textured = Boolean(object.atlas) && pictures.has(object.atlas);
    const size = model.atlases.find((atlas) => atlas.id === object.atlas) ?? { width: 1, height: 1 };
    const positions = [];
    const normals = [];
    const places = [];
    const indices = [];
    model.faces.forEach((face, i) => {
      if (model.vertexObject[face[0]] !== object.id) return;
      const first = positions.length / 3;
      face.forEach((vertex, corner) => {
        const normal = cornerNormal[i][corner];
        positions.push(...model.vertices[vertex]);
        normals.push(normal.x, normal.y, normal.z);
        const place = model.uvs?.[i]?.[corner];
        places.push(place ? place[0] / size.width : 0, place ? place[1] / size.height : 0);
        if (skin) {
          // (the four greatest; four at most there are, see EditableMesh.setWeights())
          const entries = [...skin.weights.get(vertex)].sort((a, b) => b[1] - a[1]).slice(0, 4);
          const sum = entries.reduce((total, [, weight]) => total + weight, 0);
          for (let k = 0; k < 4; k++) {
            joints.push(entries[k]?.[0] ?? 0);
            weights.push(entries[k] ? entries[k][1] / sum : 0);
          }
        }
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
          ...(skin ? {
            JOINTS_0: accessor(skin.joints.length > 255 ? new Uint16Array(joints) : new Uint8Array(joints), 'VEC4', count),
            WEIGHTS_0: accessor(new Float32Array(weights), 'VEC4', count),
          } : {}),
        },
        indices: accessor(count > 65535 ? new Uint32Array(indices) : new Uint16Array(indices), 'SCALAR', indices.length),
        material: materialFor(textured ? object.atlas : null, !object.oneSided),
      }],
    }) - 1;
  };

  // A collision shape, among the document's (OMI_physics_shape); its number.
  const shapes = [];
  const shapeOf = (collider, mesh) => {
    const { type } = collider;
    const fields = type === 'box' ? { size: [...collider.size] }
      : type === 'sphere' ? { radius: collider.radius }
      : type === 'capsule' || type === 'cylinder' ? { radius: collider.radius, height: collider.height }
      : { mesh };
    return shapes.push({ type, [type]: fields }) - 1;
  };
  // A convex shape's mesh: its hull's corners and triangles, no material.
  const hullMesh = (points) => {
    const hull = hullOf(points);
    if (!hull) return null;
    const corners = new Float32Array(hull.points.flat());
    const box = new THREE.Box3().setFromArray(corners);
    return gltf.meshes.push({
      name: 'hull',
      primitives: [{
        attributes: { POSITION: accessor(corners, 'VEC3', hull.points.length, { min: box.min.toArray(), max: box.max.toArray() }) },
        indices: accessor(new Uint16Array(hull.triangles.flat()), 'SCALAR', hull.triangles.length * 3),
      }],
    }) - 1;
  };
  const BODY_MOTION = { static: 'static', kinematic: 'kinematic', dynamic: 'dynamic' };

  // The nodes a body has besides its objects' - its mesh's, its shapes' -
  // go after all the objects', so as not to move their numbers.
  const extra = [];
  const extraNode = (node) => shown.length + extra.push(node) - 1;
  for (const object of shown) {
    const mesh = object.kind === 'node' ? null : meshOf(object);
    const children = shown.filter((other) => other.parent === object.id).map((other) => numbers.get(other.id));
    const node = {
      name: object.name,
      translation: [...object.position],
      ...(object.rotation ? { rotation: quaternionOf(object.rotation).toArray() } : {}),
      ...(mesh === null ? {} : { mesh }),
    };
    // Its skin: the joints, and the matrices taking its frame at rest into theirs.
    const skin = mesh === null ? null : skins.get(object.id);
    let skinNumber = null;
    if (skin) {
      const matrices = new Float32Array(skin.joints.length * 16);
      skin.joints.forEach((id, k) => restOf(id).clone().invert().multiply(restOf(object.id)).toArray(matrices, k * 16));
      gltf.skins ??= [];
      skinNumber = gltf.skins.push({
        name: object.name,
        joints: skin.joints.map((id) => numbers.get(id)),
        inverseBindMatrices: gltf.accessors.push({ bufferView: view(matrices), componentType: FLOAT, count: skin.joints.length, type: 'MAT4' }) - 1,
      }) - 1;
      node.skin = skinNumber;
    }
    const colliders = object.colliders ?? []; // (a node's too: a bone's, as a ragdoll's)
    if (colliders.length) {
      // A body: the mesh a child of it, and a child for every shape.
      const trigger = object.body === 'trigger';
      const own = [];
      if (mesh !== null) {
        delete node.mesh;
        delete node.skin;
        children.push(extraNode({ name: `${object.name}-mesh`, mesh, ...(skinNumber === null ? {} : { skin: skinNumber }) }));
      }
      colliders.forEach((collider, k) => {
        const shapeMesh = collider.type === 'convex' ? hullMesh(collider.points) : collider.type === 'trimesh' ? mesh : null;
        if ((collider.type === 'convex' || collider.type === 'trimesh') && shapeMesh === null) return; // nothing to make it of
        const shape = shapeOf(collider, shapeMesh);
        const r = collider.rotation ?? [0, 0, 0];
        const index = extraNode({
          name: collider.name ?? `${object.name}-collision${colliders.length > 1 ? k + 1 : ''}`,
          ...(collider.center ? { translation: [...collider.center] } : {}),
          ...(r.some(Boolean) ? { rotation: quaternionOf(r).toArray() } : {}),
          extensions: { OMI_physics_body: trigger ? { trigger: { shape } } : { collider: { shape } } },
        });
        children.push(index);
        own.push(index);
      });
      node.extensions = {
        OMI_physics_body: trigger ? { trigger: { nodes: own } } : { motion: { type: BODY_MOTION[object.body] ?? 'static' } },
      };
    }
    if (children.length) node.children = children;
    gltf.nodes.push(node);
    if (!numbers.has(object.parent)) gltf.scenes[0].nodes.push(numbers.get(object.id));
  }
  gltf.nodes.push(...extra);
  if (shapes.length) {
    gltf.extensionsUsed = ['OMI_physics_shape', 'OMI_physics_body'];
    gltf.extensions = { OMI_physics_shape: { shapes } };
  }

  // The animations (see gltf-animation.js), on the entries' nodes. Their
  // numbers' views have no target: they are not drawn, only read.
  const samples = (piece, type, count, more = {}) =>
    gltf.accessors.push({ bufferView: view(piece), componentType: FLOAT, count, type, ...more }) - 1;
  const animations = animationsOf(model, (id) => numbers.get(id), samples);
  if (animations.length) gltf.animations = animations;

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
