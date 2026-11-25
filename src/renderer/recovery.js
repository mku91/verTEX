// Unsaved work kept for when the program ends without being closed - a crash,
// the power gone, the page loaded anew: while the project has changes that are
// not in its file, a copy of it is written every so often into the program's
// own folder (see src-tauri/src/recovery.rs) - the project's file is never
// touched. The copy goes as soon as it is not wanted: the project saved, its
// changes thrown away or undone, the window closed as it should be. One that
// is still there at a start was left by a run that did not end well: it is
// offered, and opened as the project it is of, with unsaved changes.
//
// A copy is a project file with one more entry, recovery.json: { path (the
// project's file, or null), name, at (ms) }.
import { ask } from './ask-dialog.js';
import { projectFilesWithTextures } from './project.js';
import { toast } from './toast.js';
import { t, locale } from './i18n.js';

const EVERY = 60_000; // ms between two copies
const RETRY = 2_000; // ms: something was going on (a drag, a stroke), or the pointer is down

export class Recovery {
  constructor(editor, project, api) {
    this.editor = editor;
    this.project = project;
    this.api = api ?? null;
    this.name = null; // this page's copy
    this.kept = null; // the state of the project the copy has, see state()
    this.scene = 0; // which project, of those open one after another
    this.pressed = false;
    this.warned = false;
    this.work = Promise.resolve(); // one writing or removing after another
    if (!this.api) return;
    for (const type of ['pointerdown', 'pointerup', 'pointercancel']) window.addEventListener(type, () => { this.pressed = type === 'pointerdown'; }, true);
    window.addEventListener('blur', () => { this.pressed = false; });
    project.addEventListener('change', () => {
      if (!project.dirty) this.clear();
    });
    project.addEventListener('leave', () => {
      this.scene += 1;
      this.clear();
    });
    this.begun = this.api.begin().then((name) => {
      this.name = name;
      this.wait(EVERY);
    }).catch(() => {}); // (the window is older than this page)
  }

  state() {
    return `${this.scene}|${this.project.path ?? ''}|${this.editor.history.id}`;
  }

  wait(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => this.wait((await this.keep()) ? EVERY : RETRY), ms);
  }

  // Writes the copy, if there is something new to keep. False: not now.
  async keep() {
    const { project, editor } = this;
    if (!this.name || !project.dirty || this.state() === this.kept) return true;
    if (editor.busy() || project.working || this.pressed) return false;
    const state = this.state();
    let failed = false;
    this.work = this.work.then(async () => {
      const files = await projectFilesWithTextures(editor);
      if (this.state() !== state || !project.dirty) return; // (changed while its pictures were made: at the next)
      files['recovery.json'] = JSON.stringify({ path: project.path, name: project.name, at: Date.now() });
      await this.api.write(this.name, files);
      this.kept = state;
      this.warned = false;
    }).catch((error) => {
      failed = true;
      if (!this.warned) toast(t('recovery.failed', { error: String(error?.message ?? error) }), { icon: 'fa-triangle-exclamation' });
      this.warned = true;
    });
    await this.work;
    return failed || this.kept === state; // (failed: told, and tried at the next)
  }

  // The copy is not wanted.
  clear() {
    this.work = this.work.then(async () => {
      if (!this.kept || !this.name || (this.project.dirty && this.kept === this.state())) return;
      this.kept = null;
      await this.api.remove(this.name);
    }).catch(() => {});
  }

  // At the start: what was left over, offered - until one is opened.
  async offer() {
    if (!this.api) return;
    await this.begun;
    const names = await this.api.list().catch(() => []);
    for (const name of names) {
      let copy;
      try {
        const files = await this.api.read(name);
        copy = { files, ...JSON.parse(files['recovery.json']) };
      } catch {
        continue; // unreadable: left where it is
      }
      const time = (ms) => new Date(ms).toLocaleString(locale, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const saved = copy.path ? await this.api.modified(copy.path).catch(() => null) : null;
      const answer = await ask({
        title: t('recovery.title', { name: copy.name }),
        detail: [
          t('recovery.detail', { time: time(copy.at) }),
          copy.path ? (saved ? t(saved > copy.at ? 'recovery.file.newer' : 'recovery.file', { time: time(saved) }) : t('recovery.file.missing')) : t('recovery.file.none'),
          t('recovery.safe'),
        ].join(' '),
        buttons: [
          { label: t('recovery.remove'), value: 'remove', aside: true, tone: 'lose' },
          { label: t('recovery.later'), value: 'later' },
          { label: t('recovery.open'), value: 'open', primary: true, tone: 'keep' },
        ],
        cancel: 'later',
      });
      if (answer === 'remove') await this.api.remove(name).catch(() => {});
      if (answer !== 'open') continue;
      if (!(await this.project.recover(copy.files, copy.path))) continue;
      // This page's own copy first, then the one it was opened from goes.
      for (let tries = 0; tries < 10 && this.kept === null; tries++) {
        await this.keep();
        if (this.kept === null) await new Promise((resolve) => { setTimeout(resolve, 300); });
      }
      if (this.kept !== null) await this.api.remove(name).catch(() => {});
      return;
    }
  }
}
