// Questions and messages in the program's own look - a dialog as its others
// are (see .modal and .dialog in the stylesheet) - instead of the system's
// boxes: whether to save the changes, what went wrong, are you sure.
//
// ask() shows one and resolves to the value of the button pressed - or to
// `cancel`'s on Esc. The keyboard is the dialog's while it is open: Enter
// presses the button in focus (the primary one, at first), Tab goes round
// them. One at a time: a second waits for the first to be answered.

import { t } from './i18n.js';

let queue = Promise.resolve();
let element = null;

function build() {
  element = document.createElement('div');
  element.className = 'modal ask-dialog';
  element.hidden = true;
  element.innerHTML = '<form class="dialog"><h2></h2><p class="ask-detail"></p><div class="form-buttons"></div></form>';
  document.body.append(element);
}

// `buttons`: [{ label, value, primary?, aside?, tone? }] - primary: the one
// in focus at first, in the accent; aside: set apart on the left (the one
// that throws something away); tone: 'keep' (green) or 'lose' (red) - what
// it does to the work, in the colour of it.
export function ask({ title, detail = '', buttons, cancel = null }) {
  const answer = queue.then(() => show({ title, detail, buttons, cancel }));
  queue = answer.catch(() => {});
  return answer;
}

function show({ title, detail, buttons, cancel }) {
  if (!element) build();
  const form = element.querySelector('form');
  form.querySelector('h2').textContent = title;
  const text = form.querySelector('.ask-detail');
  text.textContent = detail;
  text.hidden = !detail;
  const row = form.querySelector('.form-buttons');
  row.replaceChildren(...buttons.map(({ label, primary, aside, tone }, i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.index = i;
    button.classList.toggle('primary', Boolean(primary));
    button.classList.toggle('aside', Boolean(aside));
    if (tone) button.dataset.tone = tone;
    return button;
  }));
  element.hidden = false;
  (row.querySelector('.primary') ?? row.lastElementChild)?.focus();
  return new Promise((resolve) => {
    const done = (value) => {
      element.hidden = true;
      row.removeEventListener('click', click);
      window.removeEventListener('keydown', keys, true);
      form.removeEventListener('submit', submit);
      resolve(value);
    };
    const click = (event) => {
      const button = event.target.closest('button');
      if (button) done(buttons[Number(button.dataset.index)].value);
    };
    const submit = (event) => event.preventDefault();
    const keys = (event) => {
      // The editor's shortcuts do not hear it; the buttons do (Enter, Space, Tab).
      event.stopImmediatePropagation();
      if (event.code === 'Enter' || event.code === 'NumpadEnter') {
        // (the button in focus, or the primary one: pressed here, not twice by the browser)
        event.preventDefault();
        (row.contains(document.activeElement) ? document.activeElement : row.querySelector('.primary'))?.click();
        return;
      }
      if (event.code === 'Tab') {
        // (round the dialog's buttons only: nothing behind it is reached)
        event.preventDefault();
        const all = [...row.children];
        const at = all.indexOf(document.activeElement);
        all[(at + (event.shiftKey ? -1 : 1) + all.length) % all.length].focus();
        return;
      }
      if (event.code !== 'Escape') return;
      event.preventDefault();
      done(cancel);
    };
    row.addEventListener('click', click);
    form.addEventListener('submit', submit);
    window.addEventListener('keydown', keys, true);
  });
}

// A message, and "Понятно".
export function tell(title, detail = '') {
  return ask({ title, detail, buttons: [{ label: t('ask.ok'), value: true, primary: true }], cancel: true });
}

// Whether to go on with something: true for `yes`, false for "Отмена".
export function confirmIt(title, detail, yes) {
  return ask({ title, detail, buttons: [{ label: t('ask.cancel'), value: false }, { label: yes, value: true, primary: true }], cancel: false });
}

// The unsaved changes of the project `name`: 'save', 'discard' or 'cancel'
// (asked when the window is to close too, see src-tauri/src/main.rs).
export function askSave(name) {
  return ask({
    title: t('ask.save.title', { name }),
    detail: t('ask.save.detail'),
    buttons: [
      { label: t('ask.save.discard'), value: 'discard', aside: true, tone: 'lose' },
      { label: t('ask.cancel'), value: 'cancel' },
      { label: t('ask.save.save'), value: 'save', primary: true, tone: 'keep' },
    ],
    cancel: 'cancel',
  });
}
