// Project files: what goes into one, how it is read back, and the editor's
// dealings with the file on disk (new, open, save, unsaved changes).
//
// A project is a zip archive (packed and unpacked by project-file.js) with
// these entries:
//
//   manifest.json    { format, version, app, saved } - what the file is
//   model.json       the mesh and the scene tree, see modelOf(); `mirror` is
//                    the global mirror's axes, an object's `mirror` its own
//   view.json        { camera: { position, target } }
//   materials.json   [] - materials, none yet
//   textures/        <atlas id>.png - the texture atlases' pictures, see atlas.js
//   preview.png      a small picture of the model, shown on the welcome screen
//
// A newer program may add entries and fields; this one reads what it knows.
//
// Since version 2 the model is stored the way such files usually are: every
// entry of the scene tree has a transform - `position` and `rotation` (Euler
// degrees, order XYZ) relative to the node it is in - and the vertices of an
// object are in that object's own frame. (Version 1 had the vertices and the
// pivot points in world coordinates, and no rotation.) The editor itself
// works in world coordinates: modelOf() and worldModel() go between the two.
//
// Since version 3 the model is textured: `uvs` is where each face's corners
// are on its object's atlas, in pixels (see unwrap.js). Since version 5 a
// project may have several atlases (`multiAtlas`, chosen when it is made):
// `atlases` is [{ id, name, ppu, width, height }] - each one's pixels per
// unit of length and size - and an object's `atlas` the id of the one it is
// on. (Up to version 4 there was one: `ppu` and `atlas` { width, height }
// were its, and textures/atlas.png its picture.)

import * as THREE from 'three';
import { quaternionOf, rotationOf, toLocal, toWorld } from './frames.js';
import { cloneCollider } from './collision-fit.js';
import { localTransforms, worldFrames } from './pose.js';
import { soundAnimation } from './animation.js';
import { tell } from './ask-dialog.js';
import { ATLAS } from './mesh.js';
import { START_SIZE } from './unwrap.js';
import { t } from './i18n.js';

const FORMAT = 'vertex-project';
const VERSION = 5;

// How a model written in an older version of the format is brought up to the
// next one: applied in turn, from the file's own version up to VERSION, before
// the model is checked - what the program reads is always of the latest kind,
// and is written so. (Versions 1 and 2 are read as they are: their vertices
// and transforms are put into the world after, see worldModel().)
const MIGRATIONS = {
  // 3 -> 4: the entries that hold others are nodes (kind 'node'), not groups.
  3: (model) => ({
    ...model,
    objects: Array.isArray(model.objects) ? model.objects.map((object) => (object?.kind === 'group' ? { ...object, kind: 'node' } : object)) : model.objects,
  }),
  // 4 -> 5: the one atlas there was is the first of a list, `main`.
  4: ({ ppu, atlas, ...model }) => ({
    ...model,
    atlases: [{ id: ATLAS, name: ATLAS, ppu: ppu ?? 16, width: atlas?.width ?? START_SIZE, height: atlas?.height ?? START_SIZE }],
  }),
};

// A model of format `version` as of the latest one (see MIGRATIONS).
export function upgradeModel(model, version) {
  let out = model;
  for (let at = Math.max(1, version); at < VERSION; at++) if (MIGRATIONS[at] && out) out = MIGRATIONS[at](out);
  return out;
}
const UNTITLED = 'Unnamed';

const round = (value) => +value.toFixed(6);

// The bodies an object with collision shapes can be (see gltf.js); and a
// shape (see collision-fit.js) as a project file may have it.
export const BODIES = ['static', 'kinematic', 'dynamic', 'trigger'];
const isTriple = (value) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const positive = (value) => Number.isFinite(value) && value > 0;
function soundCollider(collider) {
  if (!collider || typeof collider !== 'object') return false;
  if (collider.name !== undefined && typeof collider.name !== 'string') return false;
  const placed = isTriple(collider.center) && isTriple(collider.rotation);
  switch (collider.type) {
    case 'box': return placed && isTriple(collider.size) && collider.size.every((value) => value >= 0);
    case 'sphere': return isTriple(collider.center) && positive(collider.radius);
    case 'capsule': case 'cylinder': return placed && positive(collider.radius) && positive(collider.height);
    case 'convex': return Array.isArray(collider.points) && collider.points.length >= 4 && collider.points.every(isTriple);
    case 'trimesh': return true;
    default: return false;
  }
}

// The scene as plain data.
export function modelOf(editor) {
  const { mesh } = editor;
  // Every entry's frame in the world, and its place in its parent (see pose.js).
  const frames = worldFrames(editor);
  const locals = localTransforms(editor);
  const triple = (vector) => [round(vector.x), round(vector.y), round(vector.z)];
  const ids = new Set(mesh.objects.map((object) => object.id));
  return {
    // In the frame of the object each belongs to.
    vertices: mesh.vertices.map((vertex, i) => triple(toLocal(vertex, frames.get(mesh.vertexObject[i])))),
    faces: mesh.faces.map((face) => [...face]),
    // Where each face's corners are on the atlas, in pixels (see unwrap.js); null = not placed.
    uvs: mesh.faces.map((face) => (face.uv ? face.uv.map((point) => (point ? [round(point[0]), round(point[1])] : null)) : null)),
    // The faces placed on the atlas by hand, which the unwrap leaves where they are.
    pins: mesh.faces.map((face, i) => (face.pin ? i : -1)).filter((i) => i >= 0),
    // And those whose shape there was changed by hand, which the unwrap does not lay flat again.
    shaped: mesh.faces.map((face, i) => (face.shaped ? i : -1)).filter((i) => i >= 0),
    wires: mesh.wires.map((wire) => [...wire]),
    // Every vertex belongs to an object, by id; nodes hold objects and nodes.
    objects: mesh.objects.map(({ id, name, kind, parent, hidden, pivot, mirror, color, atlas, oneSided, smooth, colliders, body, rotationMode, locked }) => {
      // Inside a node that is not turned the angles are the entry's own, as they were set.
      const { position, rotation: turn } = locals.get(id);
      return {
        id,
        name,
        kind: kind ?? 'mesh',
        parent: parent ?? null,
        ...(hidden ? { hidden: true } : {}),
        position: position.map(round),
        ...(turn ? { rotation: turn.map(round) } : {}),
        // No pivot point of its own: the position is the middle of its bounds, and follows them.
        ...(pivot ? {} : { autoOrigin: true }),
        ...(mirror?.length ? { mirror: [...mirror] } : {}),
        ...(color ? { color } : {}), // a marker colour's id, see marker-colors.js
        atlas: atlas ?? null, // the atlas the object is on (its id), or null: not textured
        ...(oneSided ? { oneSided: true } : {}), // its faces are not drawn from behind
        ...(smooth ? { smooth } : {}), // smooth-shaded, with this angle (degrees): see normals.js
        // Collision shapes, in its own frame (see collision-fit.js), and the body they make.
        ...(colliders?.length ? { colliders: colliders.map(cloneCollider) } : {}),
        ...(body && body !== 'static' ? { body } : {}),
        // How its animations turn it: by angles (left out) or by quaternions.
        ...(rotationMode === 'quaternion' ? { rotationMode } : {}),
        // A node picked only whole: a press on anything in it picks it.
        ...(locked && kind === 'node' ? { locked: locked === 'nearest' ? 'nearest' : true } : {}),
      };
    }),
    vertexObject: [...mesh.vertexObject],
    nextObjectId: mesh.nextObjectId,
    mirror: [...editor.mirror.globalAxes],
    // The atlases (see the top), and whether the project may have several.
    atlases: editor.atlases.map(({ id, name, ppu, width, height }) => ({ id, name, ppu, width, height })),
    ...(editor.multiAtlas ? { multiAtlas: true } : {}),
    // Vertices scaled flat and the sides they came from, see Editor.scaleFlat().
    folds: [...mesh.folds].map(([i, fold]) => [i, { ...fold }]),
    // The skin: the nodes the vertices bend with, and how much (see skin.js).
    weights: [...mesh.weights].map(([i, weights]) => [i, weights.map(([node, weight]) => [node, weight])]),
    // The animations (see animation.js); the tracks of objects no longer there are left out.
    animations: editor.animations.map((clip) => ({
      ...clip,
      tracks: clip.tracks.filter((track) => ids.has(track.object)).map((track) => ({
        ...track,
        keys: track.keys.map((key) => ({ ...key, value: key.value.map(round) })),
      })),
    })),
  };
}

// A collision shape (see collision-fit.js) made `times` as large, about its object's origin.
function scaledCollider(collider, times) {
  const out = { ...collider };
  const by = (value) => round(value * times);
  if (out.center) out.center = out.center.map(by);
  if (out.size) out.size = out.size.map(by);
  if (out.radius !== undefined) out.radius = by(out.radius);
  if (out.height !== undefined) out.height = by(out.height);
  if (out.points) out.points = out.points.map((point) => point.map(by));
  return out;
}

// A model (as modelOf() gives it) so many times its size: the vertices, each
// in its object's frame, and the entries' places are that many times farther
// from where they are counted from; nothing is turned, and the picture is
// the same. What an export at another size is made of.
export function scaledModel(model, times) {
  const scaled = (triple) => triple.map((value) => round(value * times));
  return {
    ...model,
    vertices: model.vertices.map(scaled),
    objects: model.objects.map((object) => ({
      ...object,
      position: scaled(object.position),
      // The collision shapes too (see collision-fit.js): places and sizes alike.
      ...(object.colliders ? { colliders: object.colliders.map((collider) => scaledCollider(collider, times)) } : {}),
    })),
    // And where the animations move things to; turns and scales stay as they are.
    ...(model.animations ? {
      animations: model.animations.map((clip) => ({
        ...clip,
        tracks: clip.tracks.map((track) => (track.property === 'position'
          ? { ...track, keys: track.keys.map((key) => ({ ...key, value: scaled(key.value) })) }
          : track)),
      })),
    } : {}),
  };
}

// The entries of a project file for the editor's scene, as { name: text }.
export function projectFiles(editor) {
  const { camera, orbit } = editor.viewport;
  const json = (value) => JSON.stringify(value, null, 1);
  return {
    'manifest.json': json({ format: FORMAT, version: VERSION, app: 'verTEX', saved: new Date().toISOString() }),
    'model.json': json(modelOf(editor)),
    'view.json': json({
      camera: { position: camera.position.toArray().map(round), target: orbit.target.toArray().map(round) },
      // How the timeline shows the scene: only its nodes, or all.
      timeline: { nodesOnly: Boolean(editor.animationNodesOnly) },
    }),
    'materials.json': json([]),
    'textures/': '',
  };
}

// An atlas' id, as it may be: a file's name in textures/.
const ATLAS_ID = /^[A-Za-z0-9_-]{1,64}$/;

// A version 2 model, as the editor wants it: vertices and pivot points in
// world coordinates, `rotation` the entry's turn in the world.
function worldModel(model) {
  const byId = new Map(model.objects.map((object) => [object.id, object]));
  const frames = new Map();
  const frameOf = (object, above = new Set()) => {
    if (frames.has(object.id)) return frames.get(object.id);
    if (above.has(object.id)) throw new Error(t('project.error.cycle'));
    above.add(object.id);
    const own = { origin: new THREE.Vector3(...object.position), quaternion: quaternionOf(object.rotation) };
    const parent = object.parent === null || object.parent === undefined ? null : byId.get(object.parent);
    const outer = parent ? frameOf(parent, above) : null;
    const frame = outer
      ? {
          origin: toWorld(own.origin, outer),
          quaternion: outer.quaternion.clone().multiply(own.quaternion),
          // As in modelOf(): the angles are kept as they are unless a node above turns them.
          rotation: outer.rotation ? rotationOf(outer.quaternion.clone().multiply(own.quaternion)) : object.rotation ?? null,
        }
      : { ...own, rotation: object.rotation ?? null };
    frames.set(object.id, frame);
    return frame;
  };
  for (const object of model.objects) frameOf(object);
  // What is not turned lands where it was saved, to the digit; what is turned, as near as it can.
  const digits = (frame) => (frame.rotation ? 9 : 6);
  const triple = (vector, frame) => vector.toArray().map((value) => +value.toFixed(digits(frame)) || 0);
  return {
    ...model,
    vertices: model.vertices.map((vertex, i) => {
      const frame = frames.get(model.vertexObject[i]);
      return triple(toWorld(new THREE.Vector3(...vertex), frame), frame);
    }),
    objects: model.objects.map(({ position, rotation, autoOrigin, ...object }) => {
      const frame = frames.get(object.id);
      return {
        ...object,
        ...(autoOrigin ? {} : { pivot: triple(frame.origin, frame) }),
        ...(frame.rotation ? { rotation: frame.rotation } : {}),
      };
    }),
  };
}

// The same with the pictures of the atlases, which take a moment to pack.
export async function projectFilesWithTextures(editor) {
  const files = projectFiles(editor);
  for (const atlas of editor.atlases) files[`textures/${atlas.id}.png`] = await atlas.png();
  return files;
}

// Reads the entries of a project file back: { model, view, atlas }, checked - a
// file that is damaged or not ours is refused with an Error whose message
// says what is wrong, rather than let half of it into the editor.
export function readProject(files) {
  const parse = (name) => {
    if (typeof files[name] !== 'string') throw new Error(t('project.error.missing', { name }));
    try {
      return JSON.parse(files[name]);
    } catch {
      throw new Error(t('project.error.damaged-entry', { name }));
    }
  };
  const manifest = parse('manifest.json');
  if (manifest.format !== FORMAT) throw new Error(t('project.error.not-project'));
  if (!(manifest.version <= VERSION)) {
    throw new Error(t('project.error.newer', { version: manifest.version, supported: VERSION }));
  }

  const model = upgradeModel(parse('model.json'), manifest.version);
  const fail = (what) => {
    throw new Error(t('project.error.damaged', { what }));
  };
  const isIndex = (value, count) => Number.isInteger(value) && value >= 0 && value < count;
  for (const key of ['vertices', 'faces', 'wires', 'objects', 'vertexObject']) {
    if (!Array.isArray(model[key])) fail(t('project.error.no-list', { key }));
  }
  const count = model.vertices.length;
  if (!model.vertices.every((v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite))) fail(t('project.part.vertices'));
  if (!model.faces.every((f) => Array.isArray(f) && f.length >= 3 && f.every((i) => isIndex(i, count)))) fail(t('project.part.faces'));
  if (!model.wires.every((w) => Array.isArray(w) && w.length === 2 && w.every((i) => isIndex(i, count)))) fail(t('project.part.wires'));
  const axes = (value) => value === undefined || (Array.isArray(value) && value.every((axis) => ['x', 'y', 'z'].includes(axis)));
  if (!axes(model.mirror)) fail(t('project.part.mirror'));
  if (model.folds !== undefined) {
    const sound = Array.isArray(model.folds) && model.folds.every(([i, fold]) =>
      isIndex(i, count) && fold && typeof fold === 'object' && Object.entries(fold).every(([axis, sign]) => 'xyz'.includes(axis) && [1, -1, 0].includes(sign)));
    if (!sound) fail(t('project.part.folds'));
  }
  const ids = new Set();
  const local = manifest.version >= 2; // vertices and transforms in the entries' own frames
  const triple = (value) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
  for (const object of model.objects) {
    const sound =
      object && Number.isInteger(object.id) && !ids.has(object.id) && typeof object.name === 'string' && axes(object.mirror) &&
      (object.kind === undefined || object.kind === 'mesh' || object.kind === 'node') &&
      (object.color === undefined || typeof object.color === 'string') &&
      (object.oneSided === undefined || typeof object.oneSided === 'boolean') &&
      (object.smooth === undefined || (Number.isFinite(object.smooth) && object.smooth > 0 && object.smooth <= 180)) &&
      (object.colliders === undefined || (Array.isArray(object.colliders) && object.colliders.every(soundCollider))) &&
      (object.body === undefined || BODIES.includes(object.body)) &&
      (object.rotationMode === undefined || object.rotationMode === 'quaternion') &&
      (object.locked === undefined || typeof object.locked === 'boolean' || object.locked === 'nearest') &&
      (object.atlas === undefined || object.atlas === null || typeof object.atlas === 'string') &&
      (local
        ? triple(object.position) && (object.rotation === undefined || triple(object.rotation))
        : object.pivot === undefined || triple(object.pivot));
    if (!sound) fail(t('project.part.objects'));
    ids.add(object.id);
  }
  if (model.uvs !== undefined) {
    const place = (point) => point === null || (Array.isArray(point) && point.length === 2 && point.every(Number.isFinite));
    const sound = Array.isArray(model.uvs) && model.uvs.length === model.faces.length && model.uvs.every((uv, i) =>
      uv === null || (Array.isArray(uv) && uv.length === model.faces[i].length && uv.every(place)));
    if (!sound) fail(t('project.part.uvs'));
  }
  if (model.shaped !== undefined && !(Array.isArray(model.shaped) && model.shaped.every((i) => isIndex(i, model.faces.length)))) fail(t('project.part.shaped'));
  if (model.pins !== undefined && !(Array.isArray(model.pins) && model.pins.every((i) => isIndex(i, model.faces.length)))) fail(t('project.part.pins'));
  const size = (value) => Number.isInteger(value) && value >= 1 && value <= 4096;
  const atlasIds = new Set();
  const soundAtlas = (atlas) => {
    const sound = atlas && typeof atlas.id === 'string' && ATLAS_ID.test(atlas.id) && !atlasIds.has(atlas.id) &&
      (atlas.name === undefined || typeof atlas.name === 'string') &&
      Number.isInteger(atlas.ppu) && atlas.ppu >= 1 && atlas.ppu <= 256 && size(atlas.width) && size(atlas.height);
    if (sound) atlasIds.add(atlas.id);
    return sound;
  };
  // (one at least - but in a project with several, which begins with none)
  if (model.multiAtlas !== undefined && typeof model.multiAtlas !== 'boolean') fail(t('project.part.atlases'));
  if (!(Array.isArray(model.atlases) && (model.atlases.length >= 1 || model.multiAtlas) && model.atlases.every(soundAtlas))) fail(t('project.part.atlases'));
  if (model.animations !== undefined && !(Array.isArray(model.animations) && model.animations.every((clip) => soundAnimation(clip, ids)))) fail(t('project.part.animations'));
  const meshes = new Set(model.objects.filter((object) => object.kind !== 'node').map((object) => object.id));
  if (model.vertexObject.length !== count || !model.vertexObject.every((id) => meshes.has(id))) {
    fail(t('project.part.vertex-object'));
  }
  if (model.weights !== undefined) {
    // [vertex, [[node id, weight], ...]]: up to four nodes, each once, weights from 0 to 1.
    const nodes = new Set(model.objects.filter((object) => object.kind === 'node').map((object) => object.id));
    const sound = Array.isArray(model.weights) && model.weights.every((entry) => Array.isArray(entry) && isIndex(entry[0], count) &&
      Array.isArray(entry[1]) && entry[1].length >= 1 && entry[1].length <= 4 &&
      new Set(entry[1].map(([node]) => node)).size === entry[1].length &&
      entry[1].every((pair) => Array.isArray(pair) && nodes.has(pair[0]) && Number.isFinite(pair[1]) && pair[1] >= 0 && pair[1] <= 1));
    if (!sound) fail(t('project.part.weights'));
  }

  let view = null;
  try {
    const { camera, timeline } = parse('view.json');
    const point = (value) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
    view = {
      ...(point(camera?.position) && point(camera?.target) ? { camera } : {}),
      ...(typeof timeline?.nodesOnly === 'boolean' ? { timeline: { nodesOnly: timeline.nodesOnly } } : {}),
    };
  } catch {
    // The view is a convenience: without it the camera stays where it is, and the timeline shows all.
  }
  // The pictures of the atlases, as the bytes of their files, by id (one of
  // a project from before there were several is textures/atlas.png; a
  // project from before there was one has none).
  const pictures = new Map();
  for (const { id } of model.atlases) {
    const bytes = files[`textures/${id}.png`] ?? (manifest.version < 5 && id === ATLAS ? files['textures/atlas.png'] : undefined);
    if (bytes instanceof Uint8Array && bytes.length) pictures.set(id, bytes);
  }
  return { model: local ? worldModel(model) : model, view, pictures };
}

// The project the editor is working on: its file, whether it has unsaved
// changes, and the commands of the File menu. `api` is the window's
// side (window.vertex.project, see host.js), absent when the page runs without it.
// Dispatches 'change' when the name or the unsaved mark changes, 'open'
// when the editor has got another project: a new one, or one from a file -
// and 'saved' when it has been written.
export class Project extends EventTarget {
  constructor(editor, api) {
    super();
    this.editor = editor;
    this.api = api ?? null;
    this.path = null;
    this.savedState = editor.history.id; // the history state that is on disk (or was the start)
    this.working = false; // a command is waiting for a dialog
    this.ask = null; // asks what kind of project a new one is to be, see newProject()
    this.picture = null; // gives the picture of the model that goes into the file (PNG bytes), see write()
    this.shown = '';
    editor.addEventListener('change', () => this.report());
    this.report();
  }

  get name() {
    if (!this.path) return UNTITLED;
    return this.path.split(/[\\/]/).pop().replace(/\.[^.]*$/, '');
  }

  get dirty() {
    return this.editor.history.id !== this.savedState;
  }

  // Tells of the project's file, name or unsaved changes being other than
  // they were ('change'). Its file too, not its name only: a file named as a
  // project without one is ("Unnamed") is another project all the same -
  // what follows the file (the atlases' working files, see atlas-link.js)
  // must hear of it as it is opened, not at the next change made.
  report() {
    const shown = `${this.path ?? ''}|${this.name}|${this.dirty}`;
    if (shown === this.shown) return;
    this.shown = shown;
    this.api?.setState({ dirty: this.dirty });
    this.dispatchEvent(new Event('change'));
  }

  // One command at a time: a second one while a dialog is open is dropped.
  async run(command) {
    if (this.working) return;
    const restart = t('project.restart');
    if (!this.api) {
      await tell(restart);
      return;
    }
    this.working = true;
    try {
      await command();
    } catch (error) {
      // The window does not answer: it is older than this page (the page
      // was reloaded after an update, the program was not restarted).
      await tell(restart, error.message);
    } finally {
      this.working = false;
    }
  }

  // Whether the scene may be replaced: asks about unsaved changes, and saves
  // them if told to.
  async mayDiscard() {
    if (!this.dirty) return true;
    const answer = await this.api.confirm(this.name);
    if (answer === 'save') return this.write(false);
    if (answer !== 'discard') return false;
    // What was not saved is thrown away - wherever else it is kept, too.
    this.dispatchEvent(new Event('discard'));
    return true;
  }

  // Writes the project; asks where if it has no file yet or `elsewhere` is
  // set. Returns whether it was written.
  // (Nothing changed since the file was written: there is nothing to write -
  // unless it is to go elsewhere.)
  async write(elsewhere) {
    if (this.editor.busy()) return false;
    if (!elsewhere && this.path && !this.dirty) return true;
    const files = await projectFilesWithTextures(this.editor);
    const picture = await this.picture?.();
    if (picture) files['preview.png'] = picture;
    const result = await this.api.save(elsewhere ? null : this.path, files);
    if (!result) return false;
    if (result.error) {
      await this.api.alert(t('project.error.save'), result.error);
      return false;
    }
    this.path = result.path;
    this.savedState = this.editor.history.id;
    this.report();
    this.dispatchEvent(new Event('saved'));
    return true;
  }

  newProject() {
    return this.run(async () => {
      if (!(await this.mayDiscard())) return;
      // What kind of project: asked by the window (see app.js), if it has a way to ask.
      const options = this.ask ? await this.ask() : {};
      if (!options) return;
      if (!this.editor.newProject(options)) return;
      this.path = null;
      this.savedState = this.editor.history.id;
      this.report();
      this.dispatchEvent(new Event('open'));
    });
  }

  // Opens the project in the given file; without one the user is asked for it.
  open(path = null) {
    return this.run(async () => {
      if (!(await this.mayDiscard())) return;
      const result = await this.api.open(path);
      if (!result) return;
      let project;
      try {
        if (result.error) throw new Error(result.error);
        project = readProject(result.files);
      } catch (error) {
        await this.api.alert(t('project.error.open'), `${result.path}\n\n${error.message}`);
        return;
      }
      if (!this.editor.loadProject(project)) return;
      for (const [id, bytes] of project.pictures) await this.editor.atlasById(id)?.load(bytes);
      this.path = result.path;
      this.savedState = this.editor.history.id;
      this.report();
      this.dispatchEvent(new Event('open'));
    });
  }

  save() {
    return this.run(() => this.write(false));
  }

  saveAs() {
    return this.run(() => this.write(true));
  }

  // Back to the welcome screen (see welcome.js): the project closed - its
  // unsaved changes asked about first, as before opening another - and a
  // new scene put in its place behind the screen, with nothing to undo.
  closeProject() {
    return this.run(async () => {
      if (!(await this.mayDiscard())) return;
      if (!this.editor.newProject()) return;
      this.path = null;
      this.savedState = this.editor.history.id;
      this.report();
      this.dispatchEvent(new Event('closed'));
    });
  }

  // The window is being closed with unsaved changes.
  close() {
    return this.run(async () => {
      if (await this.mayDiscard()) this.api.close();
    });
  }
}
