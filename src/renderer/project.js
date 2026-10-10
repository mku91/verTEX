// Project files: what goes into one, how it is read back, and the editor's
// dealings with the file on disk (new, open, save, unsaved changes).
//
// A project is a zip archive (packed and unpacked by the main process, see
// src/main/project-file.js) with these entries:
//
//   manifest.json    { format, version, app, saved } - what the file is
//   model.json       the mesh and the scene tree, see modelOf(); `mirror` is
//                    the global mirror's axes, an object's `mirror` its own
//   view.json        { camera: { position, target } }
//   materials.json   [] - materials, none yet
//   textures/        atlas.png - the texture atlas, see atlas.js
//
// A newer program may add entries and fields; this one reads what it knows.
//
// Since version 2 the model is stored the way such files usually are: every
// entry of the scene tree has a transform - `position` and `rotation` (Euler
// degrees, order XYZ) relative to the group it is in - and the vertices of an
// object are in that object's own frame. (Version 1 had the vertices and the
// pivot points in world coordinates, and no rotation.) The editor itself
// works in world coordinates: modelOf() and worldModel() go between the two.
//
// Since version 3 the model is textured: `ppu` is the project's pixels per
// unit of length, `atlas` the size of its texture atlas, and `uvs` where each
// face's corners are on it, in pixels (see unwrap.js).

import * as THREE from 'three';
import { quaternionOf, rotationOf, toLocal, toWorld } from './frames.js';

const FORMAT = 'vertex-project';
const VERSION = 3;
const UNTITLED = 'Без названия';

const round = (value) => +value.toFixed(6);

// The scene as plain data.
function modelOf(editor) {
  const { mesh } = editor;
  // Every entry's frame in the world: where its pivot point is, how it is turned.
  const frames = new Map(mesh.objects.map((object, index) => [
    object.id,
    { origin: editor.pivotPoint(index), quaternion: quaternionOf(object.rotation), turned: Boolean(object.rotation) },
  ]));
  const triple = (vector) => [round(vector.x), round(vector.y), round(vector.z)];
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
    // Every vertex belongs to an object, by id; groups hold objects and groups.
    objects: mesh.objects.map(({ id, name, kind, parent, hidden, pivot, rotation, mirror, color, atlas }) => {
      const frame = frames.get(id);
      const outer = parent === null || parent === undefined ? null : frames.get(parent) ?? null;
      // Inside a group that is not turned the angles are the entry's own, as they were set.
      const turn = outer?.turned ? rotationOf(outer.quaternion.clone().invert().multiply(frame.quaternion)) : rotation ?? null;
      return {
        id,
        name,
        kind: kind ?? 'mesh',
        parent: parent ?? null,
        ...(hidden ? { hidden: true } : {}),
        position: triple(outer ? toLocal(frame.origin, outer) : frame.origin),
        ...(turn ? { rotation: turn.map(round) } : {}),
        // No pivot point of its own: the position is the middle of its bounds, and follows them.
        ...(pivot ? {} : { autoOrigin: true }),
        ...(mirror?.length ? { mirror: [...mirror] } : {}),
        ...(color ? { color } : {}), // a marker colour's id, see marker-colors.js
        atlas: atlas ?? null, // the atlas the object is on (its id), or null: not textured
      };
    }),
    vertexObject: [...mesh.vertexObject],
    nextObjectId: mesh.nextObjectId,
    mirror: [...editor.mirror.globalAxes],
    ppu: editor.ppu,
    atlas: { width: editor.atlas.width, height: editor.atlas.height },
    // Vertices scaled flat and the sides they came from, see Editor.scaleFlat().
    folds: [...mesh.folds].map(([i, fold]) => [i, { ...fold }]),
  };
}

// The entries of a project file for the editor's scene, as { name: text }.
export function projectFiles(editor) {
  const { camera, orbit } = editor.viewport;
  const json = (value) => JSON.stringify(value, null, 1);
  return {
    'manifest.json': json({ format: FORMAT, version: VERSION, app: 'verTEX', saved: new Date().toISOString() }),
    'model.json': json(modelOf(editor)),
    'view.json': json({ camera: { position: camera.position.toArray().map(round), target: orbit.target.toArray().map(round) } }),
    'materials.json': json([]),
    'textures/': '',
  };
}

// A version 2 model, as the editor wants it: vertices and pivot points in
// world coordinates, `rotation` the entry's turn in the world.
function worldModel(model) {
  const byId = new Map(model.objects.map((object) => [object.id, object]));
  const frames = new Map();
  const frameOf = (object, above = new Set()) => {
    if (frames.has(object.id)) return frames.get(object.id);
    if (above.has(object.id)) throw new Error('модель повреждена: группа вложена сама в себя');
    above.add(object.id);
    const own = { origin: new THREE.Vector3(...object.position), quaternion: quaternionOf(object.rotation) };
    const parent = object.parent === null || object.parent === undefined ? null : byId.get(object.parent);
    const outer = parent ? frameOf(parent, above) : null;
    const frame = outer
      ? {
          origin: toWorld(own.origin, outer),
          quaternion: outer.quaternion.clone().multiply(own.quaternion),
          // As in modelOf(): the angles are kept as they are unless a group above turns them.
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

// The same with the picture of the atlas, which takes a moment to pack.
export async function projectFilesWithTextures(editor) {
  return { ...projectFiles(editor), 'textures/atlas.png': await editor.atlas.png() };
}

// Reads the entries of a project file back: { model, view, atlas }, checked - a
// file that is damaged or not ours is refused with an Error whose message
// says what is wrong, rather than let half of it into the editor.
export function readProject(files) {
  const parse = (name) => {
    if (typeof files[name] !== 'string') throw new Error(`в файле нет «${name}»`);
    try {
      return JSON.parse(files[name]);
    } catch {
      throw new Error(`«${name}» повреждён`);
    }
  };
  const manifest = parse('manifest.json');
  if (manifest.format !== FORMAT) throw new Error('это не проект verTEX');
  if (!(manifest.version <= VERSION)) {
    throw new Error(`файл сохранён более новой версией программы (формат ${manifest.version}, эта читает до ${VERSION})`);
  }

  const model = parse('model.json');
  const fail = (what) => {
    throw new Error(`модель повреждена: ${what}`);
  };
  const isIndex = (value, count) => Number.isInteger(value) && value >= 0 && value < count;
  for (const key of ['vertices', 'faces', 'wires', 'objects', 'vertexObject']) {
    if (!Array.isArray(model[key])) fail(`нет списка «${key}»`);
  }
  const count = model.vertices.length;
  if (!model.vertices.every((v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite))) fail('вершины');
  if (!model.faces.every((f) => Array.isArray(f) && f.length >= 3 && f.every((i) => isIndex(i, count)))) fail('грани');
  if (!model.wires.every((w) => Array.isArray(w) && w.length === 2 && w.every((i) => isIndex(i, count)))) fail('рёбра');
  const axes = (value) => value === undefined || (Array.isArray(value) && value.every((axis) => ['x', 'y', 'z'].includes(axis)));
  if (!axes(model.mirror)) fail('зеркало');
  if (model.folds !== undefined) {
    const sound = Array.isArray(model.folds) && model.folds.every(([i, fold]) =>
      isIndex(i, count) && fold && typeof fold === 'object' && Object.entries(fold).every(([axis, sign]) => 'xyz'.includes(axis) && [1, -1, 0].includes(sign)));
    if (!sound) fail('свёрнутые вершины');
  }
  const ids = new Set();
  const local = manifest.version >= 2; // vertices and transforms in the entries' own frames
  const triple = (value) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
  for (const object of model.objects) {
    const sound =
      object && Number.isInteger(object.id) && !ids.has(object.id) && typeof object.name === 'string' && axes(object.mirror) &&
      (object.color === undefined || typeof object.color === 'string') &&
      (object.atlas === undefined || object.atlas === null || typeof object.atlas === 'string') &&
      (local
        ? triple(object.position) && (object.rotation === undefined || triple(object.rotation))
        : object.pivot === undefined || triple(object.pivot));
    if (!sound) fail('объекты');
    ids.add(object.id);
  }
  if (model.uvs !== undefined) {
    const place = (point) => point === null || (Array.isArray(point) && point.length === 2 && point.every(Number.isFinite));
    const sound = Array.isArray(model.uvs) && model.uvs.length === model.faces.length && model.uvs.every((uv, i) =>
      uv === null || (Array.isArray(uv) && uv.length === model.faces[i].length && uv.every(place)));
    if (!sound) fail('развёртка');
  }
  if (model.shaped !== undefined && !(Array.isArray(model.shaped) && model.shaped.every((i) => isIndex(i, model.faces.length)))) fail('грани с изменённой развёрткой');
  if (model.pins !== undefined && !(Array.isArray(model.pins) && model.pins.every((i) => isIndex(i, model.faces.length)))) fail('закреплённые грани');
  if (model.ppu !== undefined && !(Number.isInteger(model.ppu) && model.ppu >= 1 && model.ppu <= 256)) fail('плотность пикселей');
  const size = (value) => Number.isInteger(value) && value >= 1 && value <= 4096;
  if (model.atlas !== undefined && !(model.atlas && size(model.atlas.width) && size(model.atlas.height))) fail('размер атласа');
  const meshes = new Set(model.objects.filter((object) => object.kind !== 'group').map((object) => object.id));
  if (model.vertexObject.length !== count || !model.vertexObject.every((id) => meshes.has(id))) {
    fail('принадлежность вершин объектам');
  }

  let view = null;
  try {
    const { camera } = parse('view.json');
    const point = (value) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
    if (point(camera?.position) && point(camera?.target)) view = { camera };
  } catch {
    // The view is a convenience: without it the camera stays where it is.
  }
  // The picture of the atlas, as the bytes of its file; a project from before there was one has none.
  const atlas = files['textures/atlas.png'] instanceof Uint8Array && files['textures/atlas.png'].length ? files['textures/atlas.png'] : null;
  return { model: local ? worldModel(model) : model, view, atlas };
}

// The project the editor is working on: its file, whether it has unsaved
// changes, and the commands of the File menu. `api` is the main process's
// side (window.vertex.project), absent when the page runs without it.
// Dispatches 'change' when the name or the unsaved mark changes.
export class Project extends EventTarget {
  constructor(editor, api) {
    super();
    this.editor = editor;
    this.api = api ?? null;
    this.path = null;
    this.savedState = editor.history.id; // the history state that is on disk (or was the start)
    this.working = false; // a command is waiting for a dialog
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

  report() {
    const shown = `${this.name}|${this.dirty}`;
    if (shown === this.shown) return;
    this.shown = shown;
    this.api?.setState({ dirty: this.dirty });
    this.dispatchEvent(new Event('change'));
  }

  // One command at a time: a second one while a dialog is open is dropped.
  async run(command) {
    if (this.working) return;
    const restart = 'Сохранение и открытие проектов заработают после перезапуска программы.';
    if (!this.api) {
      window.alert(restart);
      return;
    }
    this.working = true;
    try {
      await command();
    } catch (error) {
      // The main process does not answer: it is older than this page (the
      // page was reloaded after an update, the program was not restarted).
      window.alert(`${restart}

(${error.message})`);
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
  async write(elsewhere) {
    if (this.editor.busy()) return false;
    const result = await this.api.save(elsewhere ? null : this.path, await projectFilesWithTextures(this.editor));
    if (!result) return false;
    if (result.error) {
      await this.api.alert('Не удалось сохранить проект', result.error);
      return false;
    }
    this.path = result.path;
    this.savedState = this.editor.history.id;
    this.report();
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
    });
  }

  open() {
    return this.run(async () => {
      if (!(await this.mayDiscard())) return;
      const result = await this.api.open();
      if (!result) return;
      let project;
      try {
        if (result.error) throw new Error(result.error);
        project = readProject(result.files);
      } catch (error) {
        await this.api.alert('Не удалось открыть проект', `${result.path}\n\n${error.message}`);
        return;
      }
      if (!this.editor.loadProject(project)) return;
      if (project.atlas) await this.editor.atlas.load(project.atlas);
      this.path = result.path;
      this.savedState = this.editor.history.id;
      this.report();
    });
  }

  save() {
    return this.run(() => this.write(false));
  }

  saveAs() {
    return this.run(() => this.write(true));
  }

  // The window is being closed with unsaved changes.
  close() {
    return this.run(async () => {
      if (await this.mayDiscard()) this.api.close();
    });
  }
}
