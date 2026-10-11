// Export to FBX: the scene as a binary FBX 7.4 file, which is what Blender,
// Unity, Unreal and Godot all read (a text FBX Blender does not).
//
// The file is a tree of records - a name, a list of typed values, records
// inside - between a fixed header and a fixed footer. The scene in it is a
// graph: `Objects` lists the nodes, each with a 64-bit id, and `Connections`
// joins them, child to parent:
//
//   Model      an entry of the scene tree: an object ("Mesh") or a group
//              ("Null"), with its place and turn relative to what it is in
//   Geometry   an object's mesh: vertices, polygons, and in layers the
//              normals, the places on the atlas and the material
//   Material   one for what is on the atlas, one for what is not
//   Texture    the atlas' picture on the material's colour, and
//   Video      the file that picture is in - a PNG written beside the FBX
//
// What goes in is the model as a project file has it (see modelOf() in
// project.js): every entry with a position and a rotation relative to its
// group, the vertices in their object's own frame. That is how FBX wants it.
//
//   - Up is Y, and a unit of length is a metre (FBX counts in centimetres:
//     UnitScaleFactor 100).
//   - Faces go as they are, polygons of any number of corners; whoever reads
//     the file cuts them into triangles.
//   - The model is flat-shaded: every corner of a face has the face's normal.
//   - Places on the atlas are pixels with y down here, and fractions of the
//     picture with v up there.
//   - Hidden entries and the edges drawn on their own are left out, as the
//     preview leaves them out.
//   - That the picture is to be shown pixel by pixel (no smoothing) FBX has
//     no word for: it is set where the file is taken to.

import * as THREE from 'three';
import { quaternionOf } from './frames.js';

// --- the records ----------------------------------------------------------------

const VERSION = 7400;
const text = new TextEncoder();

// Values of a record that are not told by their JavaScript type.
const int = (value) => ({ type: 'I', value });
const long = (value) => ({ type: 'L', value });
const flag = (value) => ({ type: 'C', value });
const raw = (bytes) => ({ type: 'R', value: bytes });
const doubles = (values) => ({ type: 'd', value: values });
const ints = (values) => ({ type: 'i', value: values });

// A record. Values: a string is a string, a number a double; the rest as above.
const node = (name, values = [], children = []) => ({ name, values, children });

// An object's name as FBX keeps it: the name, a separator, the class.
const named = (name, kind) => `${name}\x00\x01${kind}`;

class Writer {
  constructor() {
    this.bytes = new Uint8Array(1 << 16);
    this.view = new DataView(this.bytes.buffer);
    this.length = 0;
  }

  room(count) {
    if (this.length + count <= this.bytes.length) return;
    const grown = new Uint8Array(Math.max(this.bytes.length * 2, this.length + count));
    grown.set(this.bytes);
    this.bytes = grown;
    this.view = new DataView(grown.buffer);
  }

  put(bytes) {
    this.room(bytes.length);
    this.bytes.set(bytes, this.length);
    this.length += bytes.length;
  }

  zeros(count) {
    this.room(count);
    this.bytes.fill(0, this.length, this.length + count);
    this.length += count;
  }

  u8(value) {
    this.room(1);
    this.view.setUint8(this.length, value);
    this.length += 1;
  }

  u32(value) {
    this.room(4);
    this.view.setUint32(this.length, value, true);
    this.length += 4;
  }

  i32(value) {
    this.room(4);
    this.view.setInt32(this.length, value, true);
    this.length += 4;
  }

  i64(value) {
    this.room(8);
    this.view.setBigInt64(this.length, BigInt(value), true);
    this.length += 8;
  }

  f64(value) {
    this.room(8);
    this.view.setFloat64(this.length, value, true);
    this.length += 8;
  }

  value(value) {
    if (typeof value === 'string') value = { type: 'S', value: text.encode(value) };
    else if (typeof value === 'number') value = { type: 'D', value };
    this.u8(value.type.charCodeAt(0));
    switch (value.type) {
      case 'S':
      case 'R':
        this.u32(value.value.length);
        this.put(value.value);
        break;
      case 'D':
        this.f64(value.value);
        break;
      case 'I':
        this.i32(value.value);
        break;
      case 'L':
        this.i64(value.value);
        break;
      case 'C':
        this.u8(value.value ? 1 : 0);
        break;
      case 'd':
      case 'i': {
        // An array: how many, how packed (0 = not at all), how many bytes.
        const size = value.type === 'd' ? 8 : 4;
        this.u32(value.value.length);
        this.u32(0);
        this.u32(value.value.length * size);
        for (const item of value.value) {
          if (value.type === 'd') this.f64(item);
          else this.i32(item);
        }
        break;
      }
      default:
        throw new Error(`fbx: no such value type, ${value.type}`);
    }
  }

  // A record: where it ends, how many values and how long they are, the
  // name; the values; the records inside, closed by an empty one.
  record({ name, values, children }, last) {
    const start = this.length;
    this.zeros(12);
    const label = text.encode(name);
    this.u8(label.length);
    this.put(label);
    const valuesStart = this.length;
    for (const value of values) this.value(value);
    const valuesLength = this.length - valuesStart;
    children.forEach((child, i) => this.record(child, i === children.length - 1));
    // (A record with nothing in it at all is closed the same way, unless it
    // is the last of its list - which is how the format's own writer does it.)
    if (children.length || (values.length === 0 && !last)) this.zeros(13);
    this.view.setUint32(start, this.length, true);
    this.view.setUint32(start + 4, values.length, true);
    this.view.setUint32(start + 8, valuesLength, true);
  }
}

// What every FBX file of this version begins and ends with. The id and the
// time are fixed ones that the footer's own numbers answer to.
const HEADER = [...text.encode('Kaydara FBX Binary  '), 0x00, 0x1a, 0x00];
const FILE_ID = [0x28, 0xb3, 0x2a, 0xeb, 0xb6, 0x24, 0xcc, 0xc2, 0xbf, 0xc8, 0xb0, 0x2a, 0xa9, 0x2b, 0xfc, 0xf1];
const FILE_TIME = '1970-01-01 10:00:00:000';
const FOOTER_ID = [0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e];
const FOOTER_END = [0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b];

function fileOf(records) {
  const writer = new Writer();
  writer.put(HEADER);
  writer.u32(VERSION);
  for (const record of records) writer.record(record, false);
  writer.zeros(13);
  writer.put(FOOTER_ID);
  writer.zeros(4);
  writer.zeros(16 - (writer.length % 16)); // to a multiple of 16, and never none
  writer.u32(VERSION);
  writer.zeros(120);
  writer.put(FOOTER_END);
  return writer.bytes.slice(0, writer.length);
}

// --- the scene ------------------------------------------------------------------

// A property: its name, its type three ways as FBX has it, its value.
const property = (name, type, label, flags, ...values) => node('P', [name, type, label, flags, ...values]);
const number = (name, value) => property(name, 'double', 'Number', '', value);
const integer = (name, value) => property(name, 'int', 'Integer', '', int(value));
const color = (name, [r, g, b]) => property(name, 'Color', '', 'A', r, g, b);
const properties = (...list) => node('Properties70', [], list);

// A turn, as FBX's Euler angles (degrees). Its usual order, "XYZ", turns
// about X first and Z last - which is three.js's 'ZYX'.
function eulerOf(rotation) {
  const euler = new THREE.Euler().setFromQuaternion(quaternionOf(rotation), 'ZYX');
  return [euler.x, euler.y, euler.z].map((angle) => +THREE.MathUtils.radToDeg(angle).toFixed(6) || 0);
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

// An object's mesh: its own vertices and faces out of the model's.
function geometryOf(id, object, model, textured) {
  const index = new Map(); // a vertex of the model -> of this object
  const positions = [];
  model.vertexObject.forEach((owner, vertex) => {
    if (owner !== object.id) return;
    index.set(vertex, index.size);
    positions.push(...model.vertices[vertex]);
  });
  const corners = [];
  const normals = [];
  const places = [];
  model.faces.forEach((face, i) => {
    if (model.vertexObject[face[0]] !== object.id) return;
    const normal = normalOf(face.map((vertex) => new THREE.Vector3(...model.vertices[vertex])));
    face.forEach((vertex, corner) => {
      // The last corner of a polygon is marked: written as -(index + 1).
      corners.push(corner === face.length - 1 ? -index.get(vertex) - 1 : index.get(vertex));
      normals.push(normal.x, normal.y, normal.z);
      const place = model.uvs?.[i]?.[corner];
      places.push(place ? place[0] / model.atlas.width : 0, place ? 1 - place[1] / model.atlas.height : 0);
    });
  });
  if (corners.length === 0) return null;
  const layer = (kind, name, mapping, reference, ...data) =>
    node(kind, [int(0)], [
      node('Version', [int(101)]),
      node('Name', [name]),
      node('MappingInformationType', [mapping]),
      node('ReferenceInformationType', [reference]),
      ...data,
    ]);
  const used = (kind) => node('LayerElement', [], [node('Type', [kind]), node('TypedIndex', [int(0)])]);
  return node('Geometry', [long(id), named(object.name, 'Geometry'), 'Mesh'], [
    node('GeometryVersion', [int(124)]),
    node('Vertices', [doubles(positions)]),
    node('PolygonVertexIndex', [ints(corners)]),
    layer('LayerElementNormal', '', 'ByPolygonVertex', 'Direct', node('Normals', [doubles(normals)])),
    ...(textured
      ? [layer('LayerElementUV', 'UVMap', 'ByPolygonVertex', 'IndexToDirect',
          node('UV', [doubles(places)]),
          node('UVIndex', [ints(corners.map((_, i) => i))]))]
      : []),
    layer('LayerElementMaterial', '', 'AllSame', 'IndexToDirect', node('Materials', [ints([0])])),
    node('Layer', [int(0)], [
      node('Version', [int(100)]),
      used('LayerElementNormal'),
      ...(textured ? [used('LayerElementUV')] : []),
      used('LayerElementMaterial'),
    ]),
  ]);
}

const materialOf = (id, name) =>
  node('Material', [long(id), named(name, 'Material'), ''], [
    node('Version', [int(102)]),
    node('ShadingModel', ['lambert']),
    node('MultiLayer', [int(0)]),
    properties(
      color('DiffuseColor', [1, 1, 1]),
      number('DiffuseFactor', 1),
      color('AmbientColor', [0, 0, 0]),
      color('EmissiveColor', [0, 0, 0]),
      number('EmissiveFactor', 0),
    ),
  ]);

// The model (see modelOf() in project.js) as the bytes of an FBX file.
// `name` is what the scene is called; `texture` the name of the file, beside
// the FBX, that the atlas' picture is written to.
export function fbxOf(model, { name, texture }) {
  let nextId = 1000000;
  const objects = [];
  const links = [];
  const link = (child, parent, slot = null) =>
    links.push(node('C', slot ? ['OP', long(child), long(parent), slot] : ['OO', long(child), long(parent)]));
  const counts = new Map(); // a kind of object -> how many there are
  const add = (kind, record) => {
    objects.push(record);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  };

  // What is hidden, itself or by a group above it, is left out.
  const byId = new Map(model.objects.map((object) => [object.id, object]));
  const hidden = (object) => Boolean(object) && (Boolean(object.hidden) || hidden(byId.get(object.parent)));
  const shown = model.objects.filter((object) => !hidden(object));

  // The materials, made when first called for: one with the atlas on it, one without.
  const materials = new Map();
  const materialFor = (textured) => {
    if (!materials.has(textured)) {
      const id = nextId++;
      materials.set(textured, id);
      add('Material', materialOf(id, textured ? name : `${name}.plain`));
      if (textured) {
        const pictureId = nextId++;
        const fileId = nextId++;
        add('Texture', node('Texture', [long(pictureId), named(name, 'Texture'), ''], [
          node('Type', ['TextureVideoClip']),
          node('Version', [int(202)]),
          node('TextureName', [named(name, 'Texture')]),
          properties(
            property('UseMaterial', 'bool', '', '', int(1)),
            // The nearest FBX comes to "pixel by pixel": no smaller copies of the picture.
            property('UseMipMap', 'bool', '', '', int(0)),
          ),
          node('Media', [named(name, 'Video')]),
          node('FileName', [texture]),
          node('RelativeFilename', [texture]),
          node('ModelUVTranslation', [0, 0]),
          node('ModelUVScaling', [1, 1]),
          node('Texture_Alpha_Source', ['None']),
          node('Cropping', [int(0), int(0), int(0), int(0)]),
        ]));
        add('Video', node('Video', [long(fileId), named(name, 'Video'), 'Clip'], [
          node('Type', ['Clip']),
          properties(property('Path', 'KString', 'XRefUrl', '', texture)),
          node('UseMipMap', [int(0)]),
          node('Filename', [texture]),
          node('RelativeFilename', [texture]),
        ]));
        link(pictureId, id, 'DiffuseColor');
        link(fileId, pictureId);
      }
    }
    return materials.get(textured);
  };

  const ids = new Map(shown.map((object) => [object.id, nextId++]));
  for (const object of shown) {
    const id = ids.get(object.id);
    const textured = Boolean(object.atlas);
    const geometryId = nextId++;
    const geometry = object.kind === 'group' ? null : geometryOf(geometryId, object, model, textured);
    add('Model', node('Model', [long(id), named(object.name, 'Model'), geometry ? 'Mesh' : 'Null'], [
      node('Version', [int(232)]),
      properties(
        property('Lcl Translation', 'Lcl Translation', '', 'A', ...object.position),
        property('Lcl Rotation', 'Lcl Rotation', '', 'A', ...eulerOf(object.rotation)),
        property('Lcl Scaling', 'Lcl Scaling', '', 'A', 1, 1, 1),
        property('DefaultAttributeIndex', 'int', 'Integer', '', int(0)),
        property('InheritType', 'enum', '', '', int(1)),
      ),
      node('MultiLayer', [int(0)]),
      node('MultiTake', [int(0)]),
      node('Shading', [flag(true)]),
      node('Culling', ['CullingOff']),
    ]));
    link(id, ids.get(object.parent) ?? 0); // 0 is the scene itself
    if (geometry) {
      add('Geometry', geometry);
      link(geometryId, id);
      link(materialFor(textured), id);
    }
  }

  const now = new Date();
  const stamp = node('CreationTimeStamp', [], [
    node('Version', [int(1000)]),
    node('Year', [int(now.getFullYear())]),
    node('Month', [int(now.getMonth() + 1)]),
    node('Day', [int(now.getDate())]),
    node('Hour', [int(now.getHours())]),
    node('Minute', [int(now.getMinutes())]),
    node('Second', [int(now.getSeconds())]),
    node('Millisecond', [int(now.getMilliseconds())]),
  ]);
  const total = [...counts.values()].reduce((sum, count) => sum + count, 1); // and the settings
  return fileOf([
    node('FBXHeaderExtension', [], [
      node('FBXHeaderVersion', [int(1003)]),
      node('FBXVersion', [int(VERSION)]),
      node('EncryptionType', [int(0)]),
      stamp,
      node('Creator', ['verTEX']),
    ]),
    node('FileId', [raw(new Uint8Array(FILE_ID))]),
    node('CreationTime', [FILE_TIME]),
    node('Creator', ['verTEX']),
    node('GlobalSettings', [], [
      node('Version', [int(1000)]),
      properties(
        integer('UpAxis', 1),
        integer('UpAxisSign', 1),
        integer('FrontAxis', 2),
        integer('FrontAxisSign', 1),
        integer('CoordAxis', 0),
        integer('CoordAxisSign', 1),
        integer('OriginalUpAxis', 1),
        integer('OriginalUpAxisSign', 1),
        number('UnitScaleFactor', 100),
        number('OriginalUnitScaleFactor', 100),
        property('AmbientColor', 'ColorRGB', 'Color', '', 0, 0, 0),
        property('DefaultCamera', 'KString', '', '', 'Producer Perspective'),
        property('TimeMode', 'enum', '', '', int(11)),
        property('TimeSpanStart', 'KTime', 'Time', '', long(0)),
        property('TimeSpanStop', 'KTime', 'Time', '', long(46186158000)),
        number('CustomFrameRate', -1),
      ),
    ]),
    node('Documents', [], [
      node('Count', [int(1)]),
      node('Document', [long(nextId++), named(name, 'Scene'), 'Scene'], [
        properties(
          property('SourceObject', 'object', '', ''),
          property('ActiveAnimStackName', 'KString', '', '', ''),
        ),
        node('RootNode', [long(0)]),
      ]),
    ]),
    node('References'),
    node('Definitions', [], [
      node('Version', [int(100)]),
      node('Count', [int(total)]),
      node('ObjectType', ['GlobalSettings'], [node('Count', [int(1)])]),
      ...[...counts].map(([kind, count]) => node('ObjectType', [kind], [node('Count', [int(count)])])),
    ]),
    node('Objects', [], objects),
    node('Connections', [], links),
    node('Takes', [], [node('Current', [''])]),
  ]);
}
