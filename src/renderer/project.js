// Project files: what goes into one, how it is read back, and the editor's
// dealings with the file on disk (new, open, save, unsaved changes).
//
// A project is a zip archive (packed and unpacked by the main process, see
// src/main/project-file.js) with these entries:
//
//   manifest.json    { format, version, app, saved } - what the file is
//   model.json       the mesh and the scene tree, see modelOf()
//   view.json        { camera: { position, target } }
//   materials.json   [] - materials, none yet
//   textures/        texture files, none yet
//
// A newer program may add entries and fields; this one reads what it knows.

const FORMAT = 'vertex-project';
const VERSION = 1;
const UNTITLED = 'Без названия';

const round = (value) => +value.toFixed(6);

// The scene as plain data.
function modelOf(editor) {
  const { mesh } = editor;
  return {
    vertices: mesh.vertices.map((vertex) => [round(vertex.x), round(vertex.y), round(vertex.z)]),
    faces: mesh.faces.map((face) => [...face]),
    wires: mesh.wires.map((wire) => [...wire]),
    // Every vertex belongs to an object, by id; groups hold objects and groups.
    objects: mesh.objects.map(({ id, name, kind, parent, hidden, pivot }) => ({
      id,
      name,
      kind: kind ?? 'mesh',
      parent: parent ?? null,
      ...(hidden ? { hidden: true } : {}),
      ...(pivot ? { pivot: pivot.map(round) } : {}),
    })),
    vertexObject: [...mesh.vertexObject],
    nextObjectId: mesh.nextObjectId,
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

// Reads the entries of a project file back: { model, view }, checked - a
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
  const ids = new Set();
  for (const object of model.objects) {
    const sound =
      object && Number.isInteger(object.id) && !ids.has(object.id) && typeof object.name === 'string' &&
      (object.pivot === undefined || (Array.isArray(object.pivot) && object.pivot.length === 3 && object.pivot.every(Number.isFinite)));
    if (!sound) fail('объекты');
    ids.add(object.id);
  }
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
  return { model, view };
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
    return answer === 'discard';
  }

  // Writes the project; asks where if it has no file yet or `elsewhere` is
  // set. Returns whether it was written.
  async write(elsewhere) {
    if (this.editor.busy()) return false;
    const result = await this.api.save(elsewhere ? null : this.path, projectFiles(this.editor));
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
      if (!this.editor.newProject()) return;
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
