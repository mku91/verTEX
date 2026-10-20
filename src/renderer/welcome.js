// The welcome screen: what the program starts with, over the whole window. It
// offers a new project, a project from a file, and the projects worked on
// lately - a grid of cards, each with the picture its file holds (see
// project.js: preview.png). It goes away when the editor has a project.
// Behind it all a floor of vertices sways (see welcome-backdrop.js), while
// the screen is there to be seen.
//
// `api` is the window's list of those projects (window.vertex.recent, see
// host.js), absent when the page runs without it.
import { WelcomeBackdrop } from './welcome-backdrop.js';
import { t, locale } from './i18n.js';
import { ask, tell } from './ask-dialog.js';

export class Welcome {
  constructor(element, project, api) {
    this.element = element;
    this.project = project;
    this.api = api ?? null;
    this.grid = element.querySelector('.welcome-grid');
    this.empty = element.querySelector('.welcome-empty');
    this.pictures = []; // the object URLs of the cards' pictures, to be let go of
    this.backdrop = new WelcomeBackdrop(element.querySelector('canvas'));

    element.querySelector('[data-welcome="new"]').addEventListener('click', () => project.newProject());
    element.querySelector('[data-welcome="open"]').addEventListener('click', () => project.open());
    project.addEventListener('open', () => this.hide());
    project.addEventListener('closed', () => this.show());
    this.show();
  }

  get open() {
    return !this.element.hidden;
  }

  show() {
    this.element.hidden = false;
    window.vertex?.editing(false); // the window's menu is the editor's
    this.backdrop.start();
    this.refresh();
  }

  hide() {
    this.element.hidden = true;
    window.vertex?.editing(true); // and the whole screen
    this.backdrop.stop();
    this.fill([]);
  }

  async refresh() {
    let entries = [];
    try {
      entries = (await this.api?.list()) ?? [];
    } catch {
      // The window is older than this page and has no list: none is shown.
    }
    if (this.open) this.fill(entries);
  }

  fill(entries) {
    for (const url of this.pictures) URL.revokeObjectURL(url);
    this.pictures = [];
    this.grid.replaceChildren(...entries.map((entry) => this.card(entry)));
    this.empty.hidden = entries.length > 0;
  }

  card({ path, name, opened, missing, preview }) {
    const card = document.createElement('div');
    card.className = 'welcome-card';
    card.classList.toggle('missing', missing);
    card.title = missing ? t('welcome.missing.title', { path }) : path;

    const picture = document.createElement('div');
    picture.className = 'welcome-picture';
    if (preview) {
      const url = URL.createObjectURL(new Blob([preview], { type: 'image/png' }));
      this.pictures.push(url);
      const image = document.createElement('img');
      image.src = url;
      image.alt = '';
      image.draggable = false;
      picture.append(image);
    } else {
      picture.innerHTML = `<i class="fa-solid ${missing ? 'fa-link-slash' : 'fa-cube'}"></i>`;
    }

    const title = document.createElement('b');
    title.textContent = name;
    const note = document.createElement('small');
    note.textContent = missing ? t('welcome.missing') : new Date(opened).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });

    const remove = document.createElement('button');
    remove.className = 'welcome-remove';
    remove.title = t('welcome.remove');
    remove.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    remove.addEventListener('click', async (event) => {
      event.stopPropagation();
      await this.api.remove(path);
      this.refresh();
    });

    // The project thrown away: its file goes to the Recycle Bin, after asking.
    const trash = document.createElement('button');
    trash.className = 'welcome-trash';
    trash.title = t('welcome.trash');
    trash.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
    trash.addEventListener('click', async (event) => {
      event.stopPropagation();
      const sure = await ask({
        title: t('welcome.trash.message', { name }),
        detail: t('welcome.trash.detail', { path }),
        buttons: [{ label: t('ask.cancel'), value: false, primary: true }, { label: t('welcome.trash.confirm'), value: true, tone: 'lose' }],
        cancel: false,
      });
      if (!sure) return;
      const result = await this.api.trash(path);
      if (result?.error) await tell(t('welcome.trash.failed'), result.error);
      this.refresh();
    });

    card.append(picture, title, note, remove);
    if (!missing && this.api.trash) card.append(trash);
    if (!missing) card.addEventListener('click', () => this.project.open(path));
    return card;
  }
}
