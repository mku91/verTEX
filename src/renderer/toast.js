// A word to the user that asks nothing of them - "the project is saved" - at
// the top of the window, under its bar: it slides in, stays a moment and
// fades, never in the way of the pointer. A second one while the first is
// up takes its place and its time starts again.

const SHOWN = 2000; // ms

let element = null;
let timer = 0;

export function toast(text, { icon = 'fa-circle-check', tone = 'good' } = {}) {
  if (!element) {
    element = document.createElement('div');
    element.className = 'toast';
    element.setAttribute('role', 'status');
    element.innerHTML = '<i></i><span></span>';
    document.body.append(element);
  }
  element.querySelector('i').className = `fa-solid ${icon}`;
  element.querySelector('span').textContent = text;
  element.dataset.tone = tone;
  // (shown afresh: its coming in runs again)
  element.classList.remove('shown');
  void element.offsetWidth;
  element.classList.add('shown');
  clearTimeout(timer);
  timer = setTimeout(() => element.classList.remove('shown'), SHOWN);
}
