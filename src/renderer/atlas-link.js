// Keeps the atlas as working files on disk (see src/main/atlas-file.js, which
// says where), so that it can be painted in another program while the model
// is open here: what the painter saves shows on the model at once, and what
// the unwrap moves is written to the file. With it goes the guide, the faces'
// outlines.
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
    this.pending = null; // { picture, guide }: what waits to be written
    if (!this.api) return;

    // Our own changes go to the file; the painter's came from it.
    editor.atlas.addEventListener('change', (event) => this.queue(!event.detail.byUser, true));
    editor.atlas.addEventListener('layout', () => this.queue(false, true));
    project.addEventListener('change', () => this.follow());
    // Unsaved changes thrown away: the picture painted and not saved goes with them.
    project.addEventListener('discard', () => this.api.discard());
    this.api.onChanged((bytes) => editor.paintAtlas(bytes));
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
    const link = await this.api.link(path);
    if (this.linked !== path) return; // it has moved on meanwhile
    this.path = link.path;
    // A picture saved after the project was is the painter's latest work.
    if (link.bytes && link.newer) await this.editor.paintAtlas(link.bytes);
    // What is in the editor is what the files say from here on.
    this.queue(true, true);
    this.dispatchEvent(new Event('change'));
  }

  // Asks for the files to be written; several askings in a row are one writing.
  queue(picture, guide) {
    if (!this.path) return;
    this.pending = { picture: picture || this.pending?.picture || false, guide: guide || this.pending?.guide || false };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
  }

  async flush() {
    clearTimeout(this.timer);
    const pending = this.pending;
    this.pending = null;
    if (!pending || !this.path) return;
    const { atlas } = this.editor;
    await this.api.write({
      png: pending.picture ? await atlas.png() : null,
      guide: pending.guide ? await atlas.png(atlas.guide()) : null,
    });
  }

  // Opens the picture in the program the system has for it; the project is saved first if it has no file.
  async open() {
    if (!(await this.ready())) return;
    const program = localStorage.getItem(EXTERNAL_EDITOR_KEY) || null;
    const result = await this.api.open(program);
    if (result?.error) {
      await this.project.api.alert(
        'Не удалось открыть атлас',
        program ? `Программа из настроек не запустилась:\n${program}\n\n${result.error}` : result.error,
      );
    }
  }

  async reveal() {
    if (await this.ready()) this.api.reveal();
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
