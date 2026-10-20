// Keeps the atlases as working files on disk (see src/main/atlas-file.js,
// which says where) - each its own - so that they can be painted in another
// program while the model is open here: what the painter saves shows on the
// model at once, and what the unwrap moves is written to the file. With each
// goes its guide, its faces' outlines. The buttons open the atlas worked on
// (see Editor.atlas).
//
// The files are a project's: one that has no file of its own yet has none,
// and open() saves it first.
//
// The picture is opened in the user's external editor - the program whose
// path is in the settings (EXTERNAL_EDITOR_KEY) - or, with none set, in
// whatever the system opens such files with.
export const EXTERNAL_EDITOR_KEY = 'vertex.externalEditor';

export class AtlasLink extends EventTarget {
  constructor(editor, project, api) {
    super();
    this.editor = editor;
    this.project = project;
    this.api = api ?? null;
    this.path = null; // the picture's file, while the project has one
    this.linked = null; // the project path that is linked
    this.pending = new Map(); // atlas id -> { picture, guide }: what waits to be written
    this.known = ''; // the atlases there were, the last time it was looked (see the 'change' listener)
    if (!this.api) return;

    // Our own changes go to the files; the painter's came from them.
    editor.addEventListener('atlaschange', ({ detail }) => this.queue(detail.atlas.id, !detail.byUser, true));
    editor.addEventListener('atlaslayout', ({ detail }) => this.queue(detail.atlas.id, false, true));
    // A new atlas (or one back by an undo): its files are written.
    editor.addEventListener('change', () => {
      const ids = editor.atlases.map((atlas) => atlas.id).join('|');
      if (ids === this.known) return;
      const before = new Set(this.known.split('|'));
      this.known = ids;
      for (const atlas of editor.atlases) if (!before.has(atlas.id)) this.queue(atlas.id, true, true);
    });
    project.addEventListener('change', () => this.follow());
    // Unsaved changes thrown away: the pictures painted and not saved go with them.
    project.addEventListener('discard', () => this.api.discard());
    this.api.onChanged((bytes, atlas) => editor.atlasById(atlas) && editor.paintAtlas(bytes, atlas));
    this.follow();
  }

  // The project has another file, or none: the link goes with it.
  async follow() {
    const { path } = this.project;
    if (path === this.linked) return;
    this.linked = path;
    this.path = null;
    if (!path) {
      this.api.unlink();
      this.dispatchEvent(new Event('change'));
      return;
    }
    const link = await this.api.link(path, this.editor.atlases.map((atlas) => atlas.id));
    if (this.linked !== path) return; // it has moved on meanwhile
    this.path = link.folder;
    // A picture saved after the project was is the painter's latest work.
    for (const { atlas, bytes, newer } of link.pictures ?? []) {
      if (bytes && newer && this.editor.atlasById(atlas)) await this.editor.paintAtlas(bytes, atlas);
    }
    // What is in the editor is what the files say from here on.
    this.known = this.editor.atlases.map((atlas) => atlas.id).join('|');
    for (const atlas of this.editor.atlases) this.queue(atlas.id, true, true);
    this.dispatchEvent(new Event('change'));
  }

  // Asks for an atlas' files to be written; several askings in a row are one writing.
  queue(atlas, picture, guide) {
    if (!this.path || !atlas) return;
    const was = this.pending.get(atlas);
    this.pending.set(atlas, { picture: picture || was?.picture || false, guide: guide || was?.guide || false });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
  }

  async flush() {
    clearTimeout(this.timer);
    const pending = [...this.pending];
    this.pending.clear();
    if (!this.path) return;
    for (const [id, { picture, guide }] of pending) {
      const atlas = this.editor.atlasById(id);
      if (!atlas) continue; // (taken away meanwhile)
      await this.api.write({
        atlas: id,
        png: picture ? await atlas.png() : null,
        guide: guide ? await atlas.png(atlas.guide()) : null,
      });
    }
  }

  // Opens the picture in the program the system has for it; the project is saved first if it has no file.
  async open() {
    if (!(await this.ready())) return;
    const program = localStorage.getItem(EXTERNAL_EDITOR_KEY) || null;
    const result = await this.api.open(program, this.editor.atlas.id);
    if (result?.error) {
      await this.project.api.alert(
        'Не удалось открыть атлас',
        program ? `Программа из настроек не запустилась:\n${program}\n\n${result.error}` : result.error,
      );
    }
  }

  async reveal() {
    if (await this.ready()) this.api.reveal(this.editor.atlas.id);
  }

  async ready() {
    if (!this.api) return false;
    if (!this.project.path) {
      await this.project.save();
      await this.follow();
    }
    if (!this.path) return false;
    await this.flush();
    return true;
  }
}
