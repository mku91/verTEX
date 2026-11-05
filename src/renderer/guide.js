// The guide (Help -> Guide): a big dialog of pages, one a tool or a part of
// the program - what it does, how it is used, and its keys. The keys that can
// be rebound (Settings -> Hotkeys) are shown as they are bound now, not as
// written once: the guide never tells of a key that does something else.
//
// A page is a list of blocks, every text a key into the catalogs (en, ru):
//   { p: key }                       - a paragraph;
//   { steps: [key, ...] }            - numbered steps;
//   { keys: [[keys, key], ...] }     - a table of keys and what they do;
//                                      `keys` is { hotkey: id } (bound now),
//                                      { button: selector, name } (a button of
//                                      the interface, by its icon and a word),
//                                      the two together (the button, and its
//                                      key if one is bound) or a key of the
//                                      catalogs (fixed keys).
// A page's `icon` is the button of its tool (a selector): its icon is shown
// with the page's name, the very one on the button - never one of its own.
import { guideText, languages, locale } from './i18n.js';
import { comboLabel } from './hotkeys.js';

// The guide's language: the interface's, until another is picked in the
// guide itself - remembered then. (A convenience: lost, it is the interface's.)
const LANGUAGE_KEY = 'vertex.guideLanguage';

const PAGES = [
  {
    id: 'basics',
    icon: '[data-tool="select"]',
    blocks: [
      { p: 'guide.basics.p0' },
      {
        keys: [
          [{ hotkey: 'mode.object' }, 'guide.basics.keys0.0.text'],
          [{ hotkey: 'mode.face' }, 'guide.basics.keys0.1.text'],
          [{ hotkey: 'mode.edge' }, 'guide.basics.keys0.2.text'],
          [{ hotkey: 'mode.vertex' }, 'guide.basics.keys0.3.text'],
          ['guide.basics.keys0.4.keys', 'guide.basics.keys0.4.text'],
        ],
      },
      { p: 'guide.basics.p1' },
      {
        keys: [
          [{ hotkey: 'edit.select-all' }, 'guide.basics.keys1.0.text'],
          ['guide.basics.keys1.1.keys', 'guide.basics.keys1.1.text'],
          [{ hotkey: 'edit.undo' }, 'guide.basics.keys1.2.text'],
          [{ hotkey: 'edit.redo' }, 'guide.basics.keys1.3.text'],
        ],
      },
      { p: 'guide.basics.p2' },
      {
        keys: [
          [{ hotkey: 'view.frame' }, 'guide.basics.keys2.0.text'],
        ],
      },
    ],
  },
  {
    id: 'view',
    icon: '[data-action="toggle-views"]',
    blocks: [
      { p: 'guide.view.p0' },
      {
        keys: [
          [{ button: '[data-action="toggle-views"]', name: 'guide.view.keys0.0.name', hotkey: 'view.views' }, 'guide.view.keys0.0.text'],
          [{ button: '[data-action="views-window"]', name: 'guide.view.keys0.1.name' }, 'guide.view.keys0.1.text'],
          [{ button: '#focus-button', name: 'guide.view.keys0.2.name', hotkey: 'view.focus' }, 'guide.view.keys0.2.text'],
          [{ button: '#preview-button', name: 'guide.view.keys0.3.name', hotkey: 'view.preview' }, 'guide.view.keys0.3.text'],
          [{ button: '#light-button', name: 'guide.view.keys0.4.name', hotkey: 'view.light' }, 'guide.view.keys0.4.text'],
          [{ button: '#shading-button', name: 'guide.view.keys0.5.name' }, 'guide.view.keys0.5.text'],
          [{ hotkey: 'view.orientation' }, 'guide.view.keys0.6.text'],
          [{ button: '#local-toggle', name: 'guide.view.keys0.7.name', hotkey: 'view.local' }, 'guide.view.keys0.7.text'],
        ],
      },
    ],
  },
  {
    id: 'transform',
    icon: '[data-tool="move"]',
    blocks: [
      { p: 'guide.transform.p0' },
      {
        keys: [
          [{ button: '[data-tool="select"]', name: 'guide.transform.keys0.0.name', hotkey: 'tool.select' }, 'guide.transform.keys0.0.text'],
          [{ button: '[data-tool="move"]', name: 'guide.transform.keys0.1.name', hotkey: 'tool.move' }, 'guide.transform.keys0.1.text'],
          [{ button: '[data-tool="rotate"]', name: 'guide.transform.keys0.2.name', hotkey: 'tool.rotate' }, 'guide.transform.keys0.2.text'],
          [{ button: '[data-tool="scale"]', name: 'guide.transform.keys0.3.name', hotkey: 'tool.scale' }, 'guide.transform.keys0.3.text'],
          [{ button: '[data-tool="pivot"]', name: 'guide.transform.keys0.4.name', hotkey: 'tool.pivot' }, 'guide.transform.keys0.4.text'],
        ],
      },
      {
        keys: [
          ['guide.transform.keys1.0.keys', 'guide.transform.keys1.0.text'],
          ['guide.transform.keys1.1.keys', 'guide.transform.keys1.1.text'],
          ['guide.transform.keys1.2.keys', 'guide.transform.keys1.2.text'],
          [{ hotkey: 'axis.free' }, 'guide.transform.keys1.3.text'],
          [{ hotkey: 'axis.x' }, 'guide.transform.keys1.4.text'],
          [{ hotkey: 'axis.y' }, 'guide.transform.keys1.5.text'],
          [{ hotkey: 'axis.z' }, 'guide.transform.keys1.6.text'],
        ],
      },
      { p: 'guide.transform.p1' },
    ],
  },
  {
    id: 'snapping',
    icon: '#snap-toggle',
    blocks: [
      { p: 'guide.snapping.intro' },
      {
        keys: [
          [{ button: '#snap-toggle', name: 'guide.keys.magnet' }, 'guide.snapping.key.toggle'],
          ['guide.keys.ctrl', 'guide.snapping.key.ctrl-on'],
          ['guide.keys.ctrl', 'guide.snapping.key.ctrl-off'],
          ['guide.keys.alt', 'guide.snapping.key.alt'],
        ],
      },
      { p: 'guide.snapping.merge' },
    ],
  },
  {
    id: 'editing',
    icon: '[data-action="make-face"]',
    blocks: [
      { p: 'guide.editing.p0' },
      {
        keys: [
          [{ button: '[data-action="make-face"]', name: 'guide.editing.keys0.0.name', hotkey: 'edit.make-face' }, 'guide.editing.keys0.0.text'],
          [{ button: '[data-action="flip-faces"]', name: 'guide.editing.keys0.1.name', hotkey: 'edit.flip-faces' }, 'guide.editing.keys0.1.text'],
          [{ button: '[data-action="delete"]', name: 'guide.editing.keys0.2.name', hotkey: 'edit.delete' }, 'guide.editing.keys0.2.text'],
          [{ hotkey: 'edit.copy' }, 'guide.editing.keys0.3.text'],
          [{ hotkey: 'edit.cut' }, 'guide.editing.keys0.4.text'],
          [{ hotkey: 'edit.paste' }, 'guide.editing.keys0.5.text'],
        ],
      },
      { p: 'guide.editing.p1' },
    ],
  },
  {
    id: 'cut',
    icon: '#cut-toggle',
    blocks: [
      { p: 'guide.cut.p0' },
      { steps: ['guide.cut.steps0.0', 'guide.cut.steps0.1', 'guide.cut.steps0.2'] },
      {
        keys: [
          [{ button: '#cut-toggle', name: 'guide.cut.keys0.0.name', hotkey: 'op.cut' }, 'guide.cut.keys0.0.text'],
          ['guide.cut.keys0.1.keys', 'guide.cut.keys0.1.text'],
          ['guide.cut.keys0.2.keys', 'guide.cut.keys0.2.text'],
          ['guide.cut.keys0.3.keys', 'guide.cut.keys0.3.text'],
          ['guide.cut.keys0.4.keys', 'guide.cut.keys0.4.text'],
        ],
      },
    ],
  },
  {
    id: 'knife',
    icon: '#knife-toggle',
    blocks: [
      { p: 'guide.knife.intro' },
      { steps: ['guide.knife.step.start', 'guide.knife.step.aim', 'guide.knife.step.cut'] },
      {
        keys: [
          [{ button: '#knife-toggle', name: 'guide.knife.title', hotkey: 'op.knife' }, 'guide.knife.key.toggle'],
          ['guide.keys.shift', 'guide.knife.key.shift'],
          ['guide.keys.ctrl', 'guide.knife.key.ctrl'],
          ['guide.keys.escape-rmb', 'guide.knife.key.escape'],
        ],
      },
      { p: 'guide.knife.ring' },
      { p: 'guide.knife.shared' },
    ],
  },
  {
    id: 'extrude',
    icon: '#extrude-toggle',
    blocks: [
      { p: 'guide.extrude.p0' },
      { steps: ['guide.extrude.steps0.0', 'guide.extrude.steps0.1', 'guide.extrude.steps0.2'] },
      {
        keys: [
          [{ button: '#extrude-toggle', name: 'guide.extrude.keys0.0.name', hotkey: 'op.extrude' }, 'guide.extrude.keys0.0.text'],
          ['guide.extrude.keys0.1.keys', 'guide.extrude.keys0.1.text'],
          ['guide.extrude.keys0.2.keys', 'guide.extrude.keys0.2.text'],
          ['guide.extrude.keys0.3.keys', 'guide.extrude.keys0.3.text'],
          ['guide.extrude.keys0.4.keys', 'guide.extrude.keys0.4.text'],
        ],
      },
      { p: 'guide.extrude.p1' },
    ],
  },
  {
    id: 'inset',
    icon: '#inset-toggle',
    blocks: [
      { p: 'guide.inset.intro' },
      { steps: ['guide.inset.step.start', 'guide.inset.step.move', 'guide.inset.step.fix'] },
      {
        keys: [
          [{ button: '#inset-toggle', name: 'guide.inset.title', hotkey: 'op.inset' }, 'guide.inset.key.toggle'],
          ['guide.keys.alt', 'guide.inset.key.alt'],
          ['guide.keys.ctrl', 'guide.inset.key.ctrl'],
          ['guide.keys.escape', 'guide.inset.key.escape'],
        ],
      },
      { p: 'guide.inset.limit' },
    ],
  },
  {
    id: 'polygon',
    icon: '#polygon-toggle',
    blocks: [
      { p: 'guide.polygon.p0' },
      { steps: ['guide.polygon.steps0.0', 'guide.polygon.steps0.1', 'guide.polygon.steps0.2'] },
      {
        keys: [
          [{ button: '#polygon-toggle', name: 'guide.polygon.keys0.0.name', hotkey: 'op.polygon' }, 'guide.polygon.keys0.0.text'],
          ['guide.polygon.keys0.1.keys', 'guide.polygon.keys0.1.text'],
          ['guide.polygon.keys0.2.keys', 'guide.polygon.keys0.2.text'],
          ['guide.polygon.keys0.3.keys', 'guide.polygon.keys0.3.text'],
          ['guide.polygon.keys0.4.keys', 'guide.polygon.keys0.4.text'],
        ],
      },
    ],
  },
  {
    id: 'pencil',
    icon: '#pencil-toggle',
    blocks: [
      { p: 'guide.pencil.p0' },
      { steps: ['guide.pencil.steps0.0', 'guide.pencil.steps0.1'] },
      {
        keys: [
          [{ button: '#pencil-toggle', name: 'guide.pencil.keys0.0.name', hotkey: 'op.pencil' }, 'guide.pencil.keys0.0.text'],
        ],
      },
    ],
  },
  {
    id: 'place',
    icon: '#place-toggle',
    blocks: [
      { p: 'guide.place.p0' },
      { steps: ['guide.place.steps0.0', 'guide.place.steps0.1', 'guide.place.steps0.2'] },
      {
        keys: [
          [{ button: '#place-toggle', name: 'guide.place.keys0.0.name', hotkey: 'op.place' }, 'guide.place.keys0.0.text'],
        ],
      },
    ],
  },
  {
    id: 'mirror',
    icon: '#mirror-toggle',
    blocks: [
      { p: 'guide.mirror.p0' },
      {
        keys: [
          [{ button: '#mirror-toggle', name: 'guide.mirror.keys0.0.name' }, 'guide.mirror.keys0.0.text'],
        ],
      },
      { p: 'guide.mirror.p1' },
    ],
  },
  {
    id: 'objects',
    icon: '#add-object',
    blocks: [
      { p: 'guide.objects.p0' },
      { p: 'guide.objects.p1' },
      { p: 'guide.objects.p2' },
      {
        keys: [
          [{ hotkey: 'edit.copy' }, 'guide.objects.keys0.0.text'],
          [{ hotkey: 'edit.paste' }, 'guide.objects.keys0.1.text'],
        ],
      },
    ],
  },
  {
    id: 'textures',
    icon: '[data-action="toggle-uv"]',
    blocks: [
      { p: 'guide.textures.p0' },
      { steps: ['guide.textures.steps0.0', 'guide.textures.steps0.1', 'guide.textures.steps0.2'] },
      {
        keys: [
          [{ button: '[data-action="toggle-uv"]', name: 'guide.textures.keys0.0.name', hotkey: 'view.uv' }, 'guide.textures.keys0.0.text'],
          ['guide.textures.keys0.1.keys', 'guide.textures.keys0.1.text'],
        ],
      },
      { p: 'guide.textures.p1' },
    ],
  },
  {
    id: 'painting',
    icon: '[data-tool="paint"]',
    blocks: [
      { p: 'guide.painting.p0' },
      {
        keys: [
          [{ button: '[data-tool="paint"]', name: 'guide.painting.keys0.0.name', hotkey: 'tool.paint' }, 'guide.painting.keys0.0.text'],
          [{ button: '[data-tool="pipette"]', name: 'guide.painting.keys0.1.name', hotkey: 'tool.pipette' }, 'guide.painting.keys0.1.text'],
          [{ button: '[data-tool="fill"]', name: 'guide.painting.keys0.2.name', hotkey: 'tool.fill' }, 'guide.painting.keys0.2.text'],
          [{ button: '[data-tool="fillObject"]', name: 'guide.painting.fill-object.name', hotkey: 'tool.fill-object' }, 'guide.painting.fill-object.text'],
          [{ hotkey: 'tool.rect' }, 'guide.painting.keys0.3.text'],
          [{ hotkey: 'tool.ellipse' }, 'guide.painting.keys0.4.text'],
          [{ button: '[data-tool="marquee"]', name: 'guide.painting.keys0.5.name', hotkey: 'tool.marquee' }, 'guide.painting.keys0.5.text'],
        ],
      },
      {
        keys: [
          ['guide.painting.keys1.0.keys', 'guide.painting.keys1.0.text'],
          ['guide.painting.keys1.1.keys', 'guide.painting.keys1.1.text'],
          ['guide.painting.keys1.2.keys', 'guide.painting.keys1.2.text'],
        ],
      },
    ],
  },
  {
    id: 'errors',
    icon: '#errors-button',
    blocks: [
      { p: 'guide.errors.p0' },
      { p: 'guide.errors.p1' },
      { p: 'guide.errors.p2' },
    ],
  },
  {
    id: 'more',
    icon: '#collision-button',
    blocks: [
      {
        keys: [
          [{ button: '#collision-button', name: 'guide.more.keys0.0.name', hotkey: 'op.collisions' }, 'guide.more.keys0.0.text'],
          [{ button: '#animation-button', name: 'guide.more.keys0.1.name', hotkey: 'op.animation' }, 'guide.more.keys0.1.text'],
          [{ hotkey: 'anim.key' }, 'guide.more.keys0.2.text'],
          [{ button: '#render-button', name: 'guide.more.keys0.3.name' }, 'guide.more.keys0.3.text'],
        ],
      },
      { p: 'guide.more.p0' },
    ],
  },
];

// A copy of the icon of an interface's button (a selector), or null.
function iconOf(selector) {
  const icon = selector && document.querySelector(selector)?.querySelector('i, svg');
  if (!icon) return null;
  const copy = icon.cloneNode(true);
  copy.classList.add('guide-icon');
  return copy;
}

export class Guide {
  // `element`: the dialog (see index.html); `hotkeys`: the editor's (see hotkeys.js).
  constructor(element, hotkeys) {
    this.element = element;
    this.hotkeys = hotkeys;
    this.nav = element.querySelector('#guide-nav');
    this.page = element.querySelector('.guide-page');
    this.counter = element.querySelector('.guide-counter');
    this.previous = element.querySelector('[data-guide="previous"]');
    this.next = element.querySelector('[data-guide="next"]');
    this.index = 0;
    this.language = locale;
    try {
      const saved = localStorage.getItem(LANGUAGE_KEY);
      if (languages.some((language) => language.id === saved)) this.language = saved;
    } catch {
      // No storage: the interface's language.
    }
    this.picker = element.querySelector('[data-guide="language"]');
    this.picker.replaceChildren(...languages.map(({ id, name }) => new Option(name, id)));
    this.picker.value = this.language;
    this.picker.addEventListener('change', () => {
      this.language = this.picker.value;
      try {
        localStorage.setItem(LANGUAGE_KEY, this.language);
      } catch {
        // Not remembered: it holds for now.
      }
      this.show(this.index);
    });
    this.nav.replaceChildren(...PAGES.map((_, index) => {
      const button = document.createElement('button');
      button.addEventListener('click', () => this.show(index));
      return button;
    }));
    this.previous.addEventListener('click', () => this.show(this.index - 1));
    this.next.addEventListener('click', () => this.show(this.index + 1));
    element.querySelector('[data-guide="close"]').addEventListener('click', () => this.close());
    element.addEventListener('mousedown', (event) => {
      if (event.target === element) this.close(); // a click on the backdrop
    });
    // The dialog owns the keyboard while it is open: Esc closes it, PgUp and
    // PgDn (or the arrows) turn its pages; the editor hears nothing.
    window.addEventListener('keydown', (event) => {
      if (element.hidden) return;
      event.stopImmediatePropagation();
      const turn = { PageUp: -1, ArrowLeft: -1, PageDown: 1, ArrowRight: 1 }[event.code];
      if (event.code === 'Escape') this.close();
      else if (turn) this.show(this.index + turn);
      else return;
      event.preventDefault();
    }, true);
    // A key rebound while the page is shown: shown as it is now.
    hotkeys.addEventListener('change', () => {
      if (!element.hidden) this.show(this.index);
    });
  }

  open(id = null) {
    const index = PAGES.findIndex((page) => page.id === id);
    this.element.hidden = false;
    this.show(index >= 0 ? index : this.index);
  }

  close() {
    this.element.hidden = true;
  }

  show(index) {
    const t = (key, params) => guideText(this.language, key, params);
    this.index = Math.max(0, Math.min(PAGES.length - 1, index));
    const page = PAGES[this.index];
    // The dialog's own words, in the guide's language.
    this.element.querySelector('[data-guide="title"]').textContent = t('guide.title');
    const close = this.element.querySelector('[data-guide="close"]');
    close.textContent = t('guide.close');
    close.title = t('guide.close.title');
    this.previous.textContent = t('guide.previous');
    this.next.textContent = t('guide.next');
    this.picker.title = t('guide.language');
    [...this.nav.children].forEach((button, k) => {
      button.replaceChildren(...[iconOf(PAGES[k].icon)].filter(Boolean), t(`guide.${PAGES[k].id}.title`));
      button.classList.toggle('active', k === this.index);
    });
    const make = (tag, text = null, className = null) => {
      const node = document.createElement(tag);
      if (text !== null) node.textContent = text;
      if (className) node.className = className;
      return node;
    };
    const title = make('h3');
    title.append(...[iconOf(page.icon)].filter(Boolean), t(`guide.${page.id}.title`));
    const blocks = page.blocks.map((block) => {
      if (block.p) return make('p', t(block.p));
      if (block.steps) {
        const list = make('ol');
        list.append(...block.steps.map((key) => make('li', t(key))));
        return list;
      }
      const table = make('table', null, 'guide-keys');
      for (const [keys, text] of block.keys) {
        const row = table.insertRow();
        const bound = keys.hotkey ? this.hotkeys.keysOf(keys.hotkey) : null;
        const cell = row.insertCell();
        if (keys.button) {
          const label = make('kbd', null, 'button');
          label.append(...[iconOf(keys.button)].filter(Boolean), t(keys.name));
          cell.append(label);
          // With its key, if it has one (one that has none is left unsaid: the button is there).
          if (bound) cell.append(' ', make('span', t('guide.keys.or'), 'guide-or'), ' ', make('kbd', comboLabel(bound)));
        } else {
          cell.append(make('kbd', keys.hotkey ? (bound ? comboLabel(bound) : t('guide.keys.unset')) : t(keys), keys.hotkey && !bound ? 'unset' : null));
        }
        row.insertCell().textContent = t(text);
      }
      return table;
    });
    this.page.replaceChildren(title, ...blocks);
    this.page.scrollTop = 0;
    this.counter.textContent = t('guide.counter', { page: this.index + 1, pages: PAGES.length });
    this.previous.disabled = this.index === 0;
    this.next.disabled = this.index === PAGES.length - 1;
  }
}
