import { Viewport } from './viewport.js';
import { Editor, MODES, OPERATION_MODES } from './editor.js';
import { AxisGizmo } from './axis-gizmo.js';
import { OrthoViews } from './ortho-views.js';
import { ExtrudePopup } from './extrude-popup.js';
import { PolygonPopup } from './polygon-popup.js';
import { Outliner } from './outliner.js';
import { scrubbable } from './scrub.js';
import { THEMES, theme, setTheme, savedTheme } from './theme.js';
import { Hotkeys, comboOf, comboLabel } from './hotkeys.js';
import { Project, projectFiles } from './project.js';

setTheme(savedTheme()); // before the views are built, so they start in the right colours

const viewport = new Viewport(document.getElementById('viewport'));
const editor = new Editor(viewport);
new AxisGizmo(document.getElementById('axis-gizmo'), viewport, editor);
const orthoViews = new OrthoViews(document.getElementById('ortho-views'), editor);
new ExtrudePopup(document.getElementById('extrude-popup'), viewport, editor);
new PolygonPopup(document.getElementById('polygon-popup'), viewport, editor);
new Outliner(document.getElementById('outliner-section'), editor);

const HINTS = {
  select: 'ЛКМ — тянуть элемент под курсором · Клик — выбрать · Shift+клик — добавить/убрать · Shift+тянуть — рамка · Tab — режим · 1–4 — фиксация оси · Ctrl — мелкая сетка · ПКМ — камера · Пробел+ПКМ — панорама',
  move: 'Тяните стрелки гизмо, чтобы переместить выделение',
  rotate: 'Тяните кольца гизмо, чтобы повернуть выделение вокруг его центра; целый объект или группу — вокруг опорной точки',
  scale: 'Тяните маркеры гизмо, чтобы масштабировать выделение от его центра; целый объект или группу — от опорной точки',
  pivot: 'Опорная точка: выберите объект или группу и тяните стрелки гизмо или саму точку в нижних видах — двигается только точка, вокруг которой объект вращается и масштабируется · Точно — в полях X Y Z · Сброс — ПКМ по строке в списке',
  extrude: 'Экструд: кликните грань (режим «Грань») или ребро (режим «Ребро») и ведите мышью · Клик — зафиксировать и выйти · Esc или {op.extrude} — выйти',
  pencil: 'Карандаш: зажмите ЛКМ на вершине и тяните — из неё вырастет новая, соединённая ребром · Отпустите на другой вершине, чтобы соединить их; замкнутый контур станет гранью · Esc или {op.pencil} — выйти',
  cut: 'Разрез: кликните грань · ведите линию мышью · 2–4 — ось, 1 — авто · Ctrl — мелкий шаг · Клик — разрезать объект и выйти · Esc или {op.cut} — выйти без разреза',
};

const ACTIONS = {
  delete: () => editor.deleteSelection(),
  'make-face': () => editor.makeFace(),
  'flip-faces': () => editor.flipFaces(),
  frame: () => {
    editor.frame();
    orthoViews.frame();
  },
  'toggle-views': () => setViewsOpen(!orthoViews.open),
  // N: face orientation on and off.
  'toggle-orientation': () => setShading(editor.shading === 'orientation' ? 'solid' : 'orientation'),
  settings: () => openSettings(),
  'toggle-snapping': () => setSnapping(!editor.snapGrid.enabled),
  'toggle-focus': () => setFocus(!editor.focus),
  'toggle-cut': () => editor.setOperation(editor.operation === 'cut' ? null : 'cut'),
  'toggle-extrude': () => editor.setOperation(editor.operation === 'extrude' ? null : 'extrude'),
  'toggle-pencil': () => editor.setOperation(editor.operation === 'pencil' ? null : 'pencil'),
  'toggle-polygon': () => editor.setOperation(editor.operation === 'polygon' ? null : 'polygon'),
  // The File menu: the project and its file.
  'project-new': () => project.newProject(),
  'project-open': () => project.open(),
  'project-save': () => project.save(),
  'project-save-as': () => project.saveAs(),
  'project-close': () => project.close(), // the window wants to close
  new: () => project.newProject(), // the menu of a program not yet restarted
  undo: () => editor.undo(),
  redo: () => editor.redo(),
};

// Physical key codes, so shortcuts work regardless of keyboard layout.
// The shortcuts the user can rebind (Settings -> Hotkeys): what each is
// called, its group there, its default keys and what it does.
const hotkeys = new Hotkeys(
  [
    { id: 'file.new', group: 'Файл', label: 'Новый проект', keys: 'Ctrl+KeyN', run: () => ACTIONS['project-new']() },
    { id: 'file.open', group: 'Файл', label: 'Открыть…', keys: 'Ctrl+KeyO', run: () => ACTIONS['project-open']() },
    { id: 'file.save', group: 'Файл', label: 'Сохранить', keys: 'Ctrl+KeyS', run: () => ACTIONS['project-save']() },
    { id: 'file.save-as', group: 'Файл', label: 'Сохранить как…', keys: 'Ctrl+Shift+KeyS', run: () => ACTIONS['project-save-as']() },

    { id: 'tool.select', group: 'Инструменты', label: 'Выделение', keys: 'KeyQ', run: () => editor.setTool('select') },
    { id: 'tool.move', group: 'Инструменты', label: 'Перемещение', keys: 'KeyW', run: () => editor.setTool('move') },
    { id: 'tool.rotate', group: 'Инструменты', label: 'Вращение', keys: 'KeyE', run: () => editor.setTool('rotate') },
    { id: 'tool.scale', group: 'Инструменты', label: 'Масштаб', keys: 'KeyS', run: () => editor.setTool('scale') },
    { id: 'tool.pivot', group: 'Инструменты', label: 'Опорная точка', keys: 'KeyD', run: () => editor.setTool('pivot') },

    { id: 'op.cut', group: 'Режимы', label: 'Разрез', keys: 'KeyK', run: () => ACTIONS['toggle-cut']() },
    { id: 'op.extrude', group: 'Режимы', label: 'Экструд', keys: 'Ctrl+KeyE', run: () => ACTIONS['toggle-extrude']() },
    { id: 'op.polygon', group: 'Режимы', label: 'Полигон', keys: 'KeyG', run: () => ACTIONS['toggle-polygon']() },
    { id: 'op.pencil', group: 'Режимы', label: 'Карандаш', keys: 'KeyP', run: () => ACTIONS['toggle-pencil']() },

    { id: 'edit.select-all', group: 'Правка', label: 'Выделить всё', keys: 'KeyA', run: () => editor.selectAll() },
    { id: 'edit.make-face', group: 'Правка', label: 'Создать грань', keys: 'Ctrl+KeyD', run: () => editor.makeFace() },
    { id: 'edit.flip-faces', group: 'Правка', label: 'Инвертировать грань', keys: 'Ctrl+KeyI', run: () => editor.flipFaces() },
    { id: 'edit.delete', group: 'Правка', label: 'Удалить выделенное', keys: 'Delete', run: () => editor.deleteSelection() },
    // Copying and pasting leave the keys to the system where they have nothing to do.
    { id: 'edit.copy', group: 'Правка', label: 'Копировать объекты', keys: 'Ctrl+KeyC', run: () => editor.copyObjects() },
    { id: 'edit.paste', group: 'Правка', label: 'Вставить объекты', keys: 'Ctrl+KeyV', run: () => editor.pasteObjects() },
    { id: 'edit.undo', group: 'Правка', label: 'Отменить', keys: 'Ctrl+KeyZ', run: () => editor.undo() },
    { id: 'edit.redo', group: 'Правка', label: 'Повторить', keys: 'Ctrl+KeyY', run: () => editor.redo() },

    { id: 'axis.free', group: 'Фиксация оси', label: 'Свободно', keys: 'Digit1', run: () => editor.setAxisLock('free') },
    { id: 'axis.x', group: 'Фиксация оси', label: 'Ось X', keys: 'Digit2', run: () => editor.setAxisLock('x') },
    { id: 'axis.y', group: 'Фиксация оси', label: 'Ось Y', keys: 'Digit3', run: () => editor.setAxisLock('y') },
    { id: 'axis.z', group: 'Фиксация оси', label: 'Ось Z', keys: 'Digit4', run: () => editor.setAxisLock('z') },

    { id: 'view.frame', group: 'Вид', label: 'Показать выделение', keys: 'KeyF', run: () => ACTIONS.frame() },
    { id: 'view.views', group: 'Вид', label: 'Три вида', keys: 'KeyV', run: () => ACTIONS['toggle-views']() },
    { id: 'view.focus', group: 'Вид', label: 'Фокус', keys: 'KeyC', run: () => ACTIONS['toggle-focus']() },
    { id: 'view.orientation', group: 'Вид', label: 'Ориентация граней', keys: 'KeyN', run: () => ACTIONS['toggle-orientation']() },
    { id: 'view.settings', group: 'Вид', label: 'Настройки', keys: 'Ctrl+Comma', run: () => openSettings() },
  ],
  // The fixed keys below can't be given to anything else.
  ['Escape', 'Tab', 'Shift+Tab', 'Space', 'Enter', 'NumpadEnter', 'Backspace', 'PageUp', 'PageDown', 'Ctrl+Shift+KeyZ'],
);

// Keys with a fixed meaning; they are listed in the settings, not rebound.
const FIXED_KEYS = {
  // The polygon tool's own keys; they do nothing outside it.
  Enter: () => editor.closePolygon(),
  NumpadEnter: () => editor.closePolygon(),
  Backspace: () => editor.undoPolygonPoint(),
  PageUp: () => editor.shiftPolygonPlane(1),
  PageDown: () => editor.shiftPolygonPlane(-1),
  Escape: () =>
    orthoViews.cancelBox() ||
    editor.cancelBox() ||
    editor.escapeOperation() ||
    editor.cancelDrag() ||
    editor.clearSelection(),
  'Ctrl+Shift+KeyZ': () => editor.redo(),
};
const FIXED_KEY_NOTES = [
  ['Esc', 'Отменить действие, выйти из режима, снять выделение'],
  ['Tab / Shift+Tab', 'Следующий / предыдущий режим выделения'],
  ['Пробел + ПКМ', 'Панорама камеры'],
  ['Enter', 'Полигон: замкнуть контур'],
  ['Backspace', 'Полигон: убрать последнюю точку'],
  ['PgUp / PgDn', 'Полигон: сдвинуть плоскость'],
  ['Ctrl+Shift+Z', 'Повторить'],
  ['Ctrl (зажат)', 'Мелкая сетка'],
  ['Shift (зажат)', 'Добавить к выделению, рамка'],
  ['Alt (зажат)', 'Масштаб с одной стороны'],
];

// Genitive plural for "Выбрано ...: N".
const ELEMENT_NAMES = { object: 'объектов', face: 'граней', edge: 'рёбер', vertex: 'вершин' };

const toolButtons = [...document.querySelectorAll('[data-tool]')];
const modeButtons = [...document.querySelectorAll('#modes [data-mode]')]; // not the gizmos' own data-mode
const coordInputs = [...document.querySelectorAll('[data-axis]')];
const sizeInputs = [...document.querySelectorAll('[data-size]')];
const $ = (id) => document.getElementById(id);

for (const button of toolButtons) {
  button.addEventListener('click', () => editor.setTool(button.dataset.tool));
}
for (const button of modeButtons) {
  button.addEventListener('click', () => editor.setMode(button.dataset.mode));
}
for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('click', () => ACTIONS[button.dataset.action]());
}
// The size panel: an object's extent along the axes; a new value stretches it.
for (const input of sizeInputs) {
  const axis = input.dataset.size;
  const parse = () => parseFloat(input.value.replace(',', '.'));
  input.addEventListener('change', () => {
    editor.setObjectSize(axis, parse());
    refresh(); // a value that was refused goes back to what the size is
  });
  let beforeScrub = null;
  scrubbable(input, {
    read: parse,
    write: (value) => editor.setObjectSize(axis, value, false),
    begin: () => { beforeScrub = editor.snapshot(); },
    end: () => editor.commit(beforeScrub),
    min: 0.01,
  });
  // Arrow keys step the size by the grid step.
  input.addEventListener('keydown', (event) => {
    if (event.code !== 'ArrowUp' && event.code !== 'ArrowDown') return;
    event.preventDefault();
    const step = editor.snapGrid.activeStep * (event.code === 'ArrowUp' ? 1 : -1);
    const value = +(parse() + step).toFixed(5);
    if (!(value > 0)) return;
    editor.setObjectSize(axis, value);
    input.value = value;
  });
}

for (const input of coordInputs) {
  // Plain text fields: number inputs format with the system locale (decimal comma).
  const apply = (value) => editor.setSelectionCenter(input.dataset.axis, value);
  const parse = () => parseFloat(input.value.replace(',', '.'));
  input.addEventListener('change', () => apply(parse()));
  // Dragging the field up or down moves the selection; the whole drag is one undo step.
  let beforeScrub = null;
  scrubbable(input, {
    read: parse,
    write: (value) => editor.setSelectionCenter(input.dataset.axis, value, false),
    begin: () => { beforeScrub = editor.snapshot(); },
    end: () => editor.commit(beforeScrub),
  });
  // Arrow keys step the value by the grid step, like a number field's spinner.
  input.addEventListener('keydown', (event) => {
    if (event.code !== 'ArrowUp' && event.code !== 'ArrowDown') return;
    event.preventDefault();
    const step = editor.snapGrid.activeStep * (event.code === 'ArrowUp' ? 1 : -1);
    const value = +(parse() + step).toFixed(5);
    apply(value);
    if (Number.isFinite(value)) input.value = value;
  });
}

for (const [id, { label }] of Object.entries(THEMES)) $('theme').add(new Option(label, id));
$('theme').value = theme.id;
$('theme').addEventListener('change', (event) => setTheme(event.target.value));

// --- grid controls (top bar): the snap step and its fine division -------

const COARSE_STEPS = [1, 0.5, 0.25, 0.125, 0.0625];
const COARSE_LABELS = ['1', '1/2', '1/4', '1/8', '1/16'];
const GRID_KEYS = { coarse: 'vertex.gridStep', fine: 'vertex.gridFineDivisor' };
const gridControls = [...document.querySelectorAll('.grid-control')].map((element) => ({
  kind: element.dataset.grid,
  button: element.querySelector('button'),
  value: element.querySelector('.grid-value'),
  popup: element.querySelector('.grid-popup'),
  slider: element.querySelector('input'),
  output: element.querySelector('output'),
}));

// Shows the grid settings on the buttons and in the popups.
function showGrid() {
  const { step, fineDivisor } = editor.snapGrid;
  for (const control of gridControls) {
    if (control.kind === 'coarse') {
      const index = COARSE_STEPS.indexOf(step);
      control.slider.value = index;
      control.value.textContent = COARSE_LABELS[index];
      control.output.textContent = `Шаг ${COARSE_LABELS[index]}`;
    } else {
      control.slider.value = fineDivisor;
      control.value.textContent = `÷${fineDivisor}`;
      control.output.textContent = `Клетка делится на ${fineDivisor} — шаг ${+(step / fineDivisor).toFixed(5)}`;
    }
  }
}
function closeGridPopups(except = null) {
  let closed = false;
  for (const control of gridControls) {
    if (control === except) continue;
    closed ||= !control.popup.hidden;
    control.popup.hidden = true;
    control.button.classList.remove('active');
  }
  return closed;
}
for (const control of gridControls) {
  control.button.addEventListener('click', () => {
    closeGridPopups(control);
    control.popup.hidden = !control.popup.hidden;
    control.button.classList.toggle('active', !control.popup.hidden);
  });
  control.slider.addEventListener('input', () => {
    const value = Number(control.slider.value);
    if (control.kind === 'coarse') {
      editor.snapGrid.step = COARSE_STEPS[value];
      viewport.setGridStep(editor.snapGrid.step); // the floor shows the same grid
    }
    else editor.snapGrid.fineDivisor = value;
    localStorage.setItem(GRID_KEYS[control.kind], control.kind === 'coarse' ? COARSE_STEPS[value] : value);
    showGrid();
  });
  // Released: give the keyboard back to the editor shortcuts.
  control.slider.addEventListener('change', () => control.slider.blur());
}
// A press anywhere else closes the popups.
window.addEventListener('pointerdown', (event) => {
  if (!event.target.closest?.('.grid-control')) closeGridPopups();
}, true);
{
  const step = parseFloat(localStorage.getItem(GRID_KEYS.coarse));
  const divisor = parseInt(localStorage.getItem(GRID_KEYS.fine), 10);
  if (COARSE_STEPS.includes(step)) editor.snapGrid.step = step;
  viewport.setGridStep(editor.snapGrid.step);
  if (divisor >= 2 && divisor <= 10) editor.snapGrid.fineDivisor = divisor;
  showGrid();
}

// --- settings dialog (File -> Settings) ---------------------------------

function openSettings() {
  $('settings-dialog').hidden = false;
}
// The sections on the left; one page of properties on the right at a time.
function showSettingsPage(page) {
  for (const button of document.querySelectorAll('#settings-nav [data-page]')) {
    button.classList.toggle('active', button.dataset.page === page);
  }
  for (const section of document.querySelectorAll('.settings-pages [data-page]')) {
    section.hidden = section.dataset.page !== page;
  }
}
for (const button of document.querySelectorAll('#settings-nav [data-page]')) {
  button.addEventListener('click', () => showSettingsPage(button.dataset.page));
}
function closeSettings() {
  $('settings-dialog').hidden = true;
  document.activeElement?.blur(); // give the keyboard back to the editor shortcuts
}
$('settings-close').addEventListener('click', closeSettings);

// Controls: how the wheel zooms the main view. Kept between runs.
const ZOOM_SETTINGS = [
  {
    id: 'zoom-strength', key: 'vertex.zoomStrength', property: 'zoomStrength',
    label: (value) => `${value}%`,
  },
  {
    id: 'zoom-smoothness', key: 'vertex.zoomSmoothness', property: 'zoomSmoothness',
    label: (value) => (value === 0 ? 'мгновенно' : String(value)),
  },
];
for (const { id, key, property, label } of ZOOM_SETTINGS) {
  const slider = $(id);
  const saved = parseFloat(localStorage.getItem(key));
  if (saved >= Number(slider.min) && saved <= Number(slider.max)) viewport[property] = saved;
  const show = () => {
    slider.value = viewport[property];
    $(`${id}-value`).textContent = label(viewport[property]);
  };
  slider.addEventListener('input', () => {
    viewport[property] = Number(slider.value);
    localStorage.setItem(key, slider.value);
    show();
  });
  show();
}
$('settings-dialog').addEventListener('mousedown', (event) => {
  if (event.target === $('settings-dialog')) closeSettings(); // a click on the backdrop
});

// Hotkeys: every shortcut with the keys it answers to. A click on the keys
// waits for a new combination; Esc leaves them as they are.
let capturingHotkey = null; // the id of the binding waiting for its keys
function showHotkeyList(note = '') {
  const list = $('hotkey-list');
  list.replaceChildren();
  const heading = (text) => {
    const element = document.createElement('h3');
    element.textContent = text;
    list.append(element);
  };
  let group = null;
  for (const binding of hotkeys.bindings) {
    if (binding.group !== group) heading((group = binding.group));
    const row = document.createElement('div');
    row.className = 'hotkey-row';
    const label = document.createElement('span');
    label.textContent = binding.label;
    const keys = document.createElement('button');
    keys.className = 'hotkey-keys';
    keys.dataset.hotkey = binding.id;
    keys.textContent = capturingHotkey === binding.id ? 'Нажмите клавиши…' : hotkeys.label(binding.id);
    keys.classList.toggle('capturing', capturingHotkey === binding.id);
    keys.classList.toggle('unset', !hotkeys.keysOf(binding.id));
    keys.title = 'Нажмите, затем нажмите новое сочетание клавиш · Esc — оставить как есть';
    keys.addEventListener('click', () => {
      capturingHotkey = capturingHotkey === binding.id ? null : binding.id;
      showHotkeyList();
    });
    const reset = document.createElement('button');
    reset.className = 'hotkey-reset';
    reset.textContent = '↺';
    reset.title = `Вернуть по умолчанию: ${comboLabel(binding.keys)}`;
    reset.disabled = !hotkeys.isCustom(binding.id);
    reset.addEventListener('click', () => {
      capturingHotkey = null;
      hotkeys.reset(binding.id);
    });
    row.append(label, keys, reset);
    list.append(row);
  }
  heading('Не настраиваются');
  for (const [keys, meaning] of FIXED_KEY_NOTES) {
    const row = document.createElement('div');
    row.className = 'hotkey-row fixed';
    const label = document.createElement('span');
    label.textContent = meaning;
    const key = document.createElement('span');
    key.className = 'hotkey-keys';
    key.textContent = keys;
    row.append(label, key);
    list.append(row);
  }
  $('hotkey-note').textContent = note;
}
// The combination pressed while a binding waits for its keys.
window.addEventListener('keydown', (event) => {
  if (!capturingHotkey || $('settings-dialog').hidden) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const id = capturingHotkey;
  if (event.code === 'Escape') {
    capturingHotkey = null;
    showHotkeyList();
    return;
  }
  const combo = comboOf(event);
  if (!combo) return; // a modifier on its own: the combination is still coming
  capturingHotkey = null;
  const loser = hotkeys.set(id, combo);
  if (loser === false) {
    showHotkeyList(`${comboLabel(combo)} — фиксированная клавиша, её нельзя назначить`);
  } else if (loser) {
    showHotkeyList(`${comboLabel(combo)} было у действия «${loser.label}» — оно осталось без клавиши`);
  }
}, true);
$('hotkeys-reset').addEventListener('click', () => {
  capturingHotkey = null;
  hotkeys.resetAll();
});

// Buttons name their keys in their tooltips; the keys there follow the settings.
const HOTKEY_TITLES = {
  '[data-tool="select"]': 'tool.select', '[data-tool="move"]': 'tool.move', '[data-tool="rotate"]': 'tool.rotate',
  '[data-tool="scale"]': 'tool.scale', '[data-tool="pivot"]': 'tool.pivot',
  '#cut-toggle': 'op.cut', '#extrude-toggle': 'op.extrude', '#polygon-toggle': 'op.polygon', '#pencil-toggle': 'op.pencil',
  '[data-action="make-face"]': 'edit.make-face', '[data-action="flip-faces"]': 'edit.flip-faces', '[data-action="delete"]': 'edit.delete',
  '[data-action="frame"]': 'view.frame', '[data-action="toggle-views"]': 'view.views', '#focus-button': 'view.focus',
  '[data-shading="orientation"]': 'view.orientation',
};
for (const selector of Object.keys(HOTKEY_TITLES)) {
  const element = document.querySelector(selector);
  element.dataset.title = element.title.replace(/\s*\([^()]*\)$/, ''); // without the key it was written with
}
function showHotkeys() {
  for (const [selector, id] of Object.entries(HOTKEY_TITLES)) {
    const element = document.querySelector(selector);
    const keys = hotkeys.keysOf(id);
    element.title = keys ? `${element.dataset.title} (${comboLabel(keys)})` : element.dataset.title;
  }
  showHotkeyList();
  refresh(); // the hints name keys too
}
hotkeys.addEventListener('change', showHotkeys);

// --- shading menu (the eye next to the axis gizmo) ----------------------

const shadingItems = [...document.querySelectorAll('[data-shading]')];
// --- copying and pasting the three coordinates as one vector -------------

// "x, y, z" as text. The system clipboard is used when the window may; the
// last copied vector is also kept here, so that pasting works regardless.
let copiedVector = null;
const flash = (button, state) => {
  button.classList.add(state);
  setTimeout(() => button.classList.remove(state), 700);
};
// Three numbers out of any text: "1, 2, 3", "(1; 2; 3)", "vec3(1 2 3)", ...
function parseVector(text) {
  // (A digit glued to letters, like the 3 of "vec3", is part of a name.)
  const numbers = (text ?? '').match(/(?<![\w.])-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(?!\w)/gi);
  return numbers?.length === 3 ? numbers.map(Number) : null;
}
// A pair of buttons that copy three numbers as one vector and paste one:
// read() gives { x, y, z } or null, write(axis, value) sets one of them
// without an undo step of its own.
function vectorButtons(copyButton, pasteButton, read, write) {
  copyButton.addEventListener('click', async () => {
    const vector = read();
    if (!vector) return;
    copiedVector = ['x', 'y', 'z'].map((axis) => +vector[axis].toFixed(5)).join(', ');
    try {
      await navigator.clipboard.writeText(copiedVector);
    } catch {
      // No access to the system clipboard: the vector can still be pasted here.
    }
    flash(copyButton, 'done');
  });
  pasteButton.addEventListener('click', async () => {
    if (!read()) return;
    let text = copiedVector;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      // No access to the system clipboard: what was copied here is used.
    }
    const vector = parseVector(text);
    if (!vector) {
      flash(pasteButton, 'failed');
      return;
    }
    // All three numbers are one undo step.
    const before = editor.snapshot();
    ['x', 'y', 'z'].forEach((axis, k) => write(axis, vector[k]));
    editor.commit(before);
    flash(pasteButton, 'done');
  });
  for (const button of [copyButton, pasteButton]) {
    button.addEventListener('mousedown', (event) => event.preventDefault()); // keep the keyboard focus
  }
}
vectorButtons($('copy-vector'), $('paste-vector'),
  () => editor.panelPoint(), (axis, value) => editor.setSelectionCenter(axis, value, false));
vectorButtons($('copy-size'), $('paste-size'),
  () => editor.objectSize(), (axis, value) => editor.setObjectSize(axis, value, false));

// --- the banner of the modal operation that is on ------------------------

const OPERATION_NAMES = { cut: 'Разрез', extrude: 'Экструд', polygon: 'Полигон', pencil: 'Карандаш' };
$('operation-close').addEventListener('click', () => editor.setOperation(null));
$('operation-banner').addEventListener('mousedown', (event) => event.preventDefault()); // keep the keyboard focus

// Grid snapping: a switch in the top bar, remembered between runs.
const SNAPPING_KEY = 'vertex.snapping';
function setSnapping(on) {
  editor.setSnapping(on);
  localStorage.setItem(SNAPPING_KEY, on ? '1' : '0');
}
editor.setSnapping(localStorage.getItem(SNAPPING_KEY) !== '0');
$('snap-toggle').addEventListener('mousedown', (event) => event.preventDefault()); // keep the keyboard focus

// The focus look: a switch of its own, remembered between runs.
const FOCUS_KEY = 'vertex.focus';
function setFocus(on) {
  editor.setFocus(on);
  localStorage.setItem(FOCUS_KEY, on ? '1' : '0');
}
editor.setFocus(localStorage.getItem(FOCUS_KEY) === '1');

const SHADING_KEY = 'vertex.shading';
function setShading(mode) {
  editor.setShading(mode);
  for (const item of shadingItems) item.classList.toggle('active', item.dataset.shading === mode);
  localStorage.setItem(SHADING_KEY, mode);
}
function closeShadingMenu() {
  $('shading-menu').hidden = true;
  $('shading-button').classList.remove('active');
}
$('shading-button').addEventListener('click', () => {
  $('shading-menu').hidden = !$('shading-menu').hidden;
  $('shading-button').classList.toggle('active', !$('shading-menu').hidden);
});
for (const item of shadingItems) {
  item.addEventListener('click', () => {
    setShading(item.dataset.shading);
    closeShadingMenu();
  });
}
// A press anywhere else closes the menu.
window.addEventListener('pointerdown', (event) => {
  if (!$('shading').contains(event.target)) closeShadingMenu();
}, true);
{
  const saved = localStorage.getItem(SHADING_KEY);
  setShading(shadingItems.some((item) => item.dataset.shading === saved) ? saved : 'solid');
}

window.addEventListener('keydown', (event) => {
  // The settings dialog owns the keyboard while it is open.
  if (!$('settings-dialog').hidden) {
    if (event.code === 'Escape' && !capturingHotkey) closeSettings();
    return;
  }
  if (event.code === 'Escape' && !$('shading-menu').hidden) {
    closeShadingMenu();
    return;
  }
  if (event.code === 'Escape' && closeGridPopups()) return;
  if (event.target instanceof HTMLSelectElement) return;
  if (event.target instanceof HTMLInputElement) {
    if (event.code === 'Enter' || event.code === 'Escape') event.target.blur();
    return;
  }
  if (event.code === 'Space') {
    event.preventDefault();
    viewport.setPanMode(true);
    return;
  }
  if (event.code === 'Tab') {
    // Tab / Shift+Tab cycle the selection mode; inside an operation, only
    // through the modes it works in.
    event.preventDefault();
    const modes = editor.operation ? MODES.filter((mode) => OPERATION_MODES[editor.operation].includes(mode)) : MODES;
    const next = modes.indexOf(editor.mode) + (event.shiftKey ? -1 : 1);
    editor.setMode(modes[(next + modes.length) % modes.length]);
    return;
  }
  // The user's shortcuts first, then the keys with a fixed meaning.
  if (hotkeys.handle(event)) return;
  const handler = FIXED_KEYS[comboOf(event)];
  if (!handler) return;
  event.preventDefault();
  handler();
});
window.addEventListener('keyup', (event) => {
  if (event.code === 'Space') viewport.setPanMode(false);
});
// A key released while the window is unfocused never reports keyup.
window.addEventListener('blur', () => {
  viewport.setPanMode(false);
  editor.setFineSnap(false);
});

// Ctrl held: vertices snap to a grid ten times finer.
for (const type of ['keydown', 'keyup']) {
  window.addEventListener(type, (event) => editor.setFineSnap(event.ctrlKey));
}

// Buttons must not take focus, or Space would press the last clicked one.
for (const id of ['toolbar', 'modes', 'top-actions', 'shading', 'focus-button']) {
  $(id).addEventListener('mousedown', (event) => event.preventDefault());
}
for (const control of gridControls) {
  control.button.addEventListener('mousedown', (event) => event.preventDefault());
}

window.vertex?.onMenu((action) => ACTIONS[action]?.());

// For debugging a running window from outside (see the debugging port in
// main.js): `vertexDebug.text()` returns the whole project as text, and
// `vertexDebug.editor` is the editor itself.
showHotkeys();

// The project: its file and its unsaved changes, named in the window's title.
const project = new Project(editor, window.vertex?.project);
const showProject = () => {
  document.title = `${project.dirty ? '● ' : ''}${project.name} — verTEX`;
};
project.addEventListener('change', showProject);
showProject();

window.vertexDebug = { text: () => editor.toText(), views: orthoViews, project, files: () => projectFiles(editor), editor };

// The three-view panel; whether it is open is remembered between launches.
const VIEWS_OPEN_KEY = 'vertex.orthoViewsOpen';
function setViewsOpen(open) {
  orthoViews.toggle(open);
  $('views-splitter').hidden = !open;
  document.querySelector('[data-action="toggle-views"]').classList.toggle('active', open);
  localStorage.setItem(VIEWS_OPEN_KEY, open ? '1' : '0');
}
setViewsOpen(localStorage.getItem(VIEWS_OPEN_KEY) === '1');

// The panel's height is changed by dragging its top edge. It is kept as a
// share of the workspace, so it scales with the window.
const VIEWS_SIZE_KEY = 'vertex.orthoViewsSize';
const VIEWS_SIZE_DEFAULT = 0.4;
const VIEWS_MIN_HEIGHT = 120; // px
const MAIN_VIEW_MIN_HEIGHT = 150; // px left to the main view
function setViewsSize(share) {
  const height = $('workspace').clientHeight;
  const min = VIEWS_MIN_HEIGHT / height;
  const max = Math.max(min, 1 - MAIN_VIEW_MIN_HEIGHT / height);
  share = Math.min(Math.max(share, min), max);
  $('ortho-views').style.flexBasis = `${share * 100}%`;
  localStorage.setItem(VIEWS_SIZE_KEY, share);
}
{
  const splitter = $('views-splitter');
  const follow = (event) => {
    const rect = $('workspace').getBoundingClientRect();
    setViewsSize((rect.bottom - event.clientY) / rect.height);
  };
  splitter.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    splitter.setPointerCapture(event.pointerId);
    splitter.classList.add('dragging');
    splitter.addEventListener('pointermove', follow);
  });
  const stop = () => {
    splitter.classList.remove('dragging');
    splitter.removeEventListener('pointermove', follow);
  };
  splitter.addEventListener('pointerup', stop);
  splitter.addEventListener('pointercancel', stop);
  splitter.addEventListener('dblclick', () => setViewsSize(VIEWS_SIZE_DEFAULT));
  setViewsSize(parseFloat(localStorage.getItem(VIEWS_SIZE_KEY)) || VIEWS_SIZE_DEFAULT);
}

// 532 -> "532 Б", 20480 -> "20 КБ", 1572864 -> "1.5 МБ".
function formatBytes(bytes) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) {
    bytes /= 1024;
    unit++;
  }
  return `${unit === 0 || bytes >= 100 ? Math.round(bytes) : +bytes.toFixed(1)} ${units[unit]}`;
}

function refresh() {
  const { mesh, selection, tool, mode, picked } = editor;

  for (const button of toolButtons) {
    button.classList.toggle('active', button.dataset.tool === tool);
  }
  for (const button of modeButtons) {
    button.classList.toggle('active', button.dataset.mode === mode);
    // An operation switches off the modes it can't work in.
    button.disabled = editor.operation !== null && !OPERATION_MODES[editor.operation].includes(button.dataset.mode);
  }

  // The middle of the selection, or the pivot point with the pivot tool.
  const point = editor.panelPoint();
  for (const input of coordInputs) {
    input.disabled = !point;
    if (document.activeElement === input) continue;
    input.value = point ? +point[input.dataset.axis].toFixed(5) : '';
  }

  $('copy-vector').disabled = $('paste-vector').disabled = !point;
  // The size panel: one object selected, in object mode.
  const size = editor.objectSize();
  $('dimensions').hidden = !size;
  for (const input of sizeInputs) {
    if (!size || document.activeElement === input) continue;
    input.value = +size[input.dataset.size].toFixed(5);
  }
  $('properties').hidden = picked.size === 0; // only while something is selected
  $('selection-count').textContent =
    tool === 'pivot' && point
      ? 'Опорная точка'
      : picked.size
        ? `Выбрано ${ELEMENT_NAMES[mode]}: ${picked.size}`
        : 'Ничего не выбрано';
  // The statistics are those of the objects holding the selection; of the
  // whole scene if nothing is selected.
  const { islands, islandOfVertex, edges } = editor.topology;
  const objects = [...new Set([...selection].map((vertex) => islandOfVertex[vertex]))].map((i) => islands[i]);
  const scope = objects.length ? objects : islands;
  const counted = new Set(scope.flatMap((island) => island.vertices));
  $('stats-title').textContent =
    objects.length === 0 ? 'Сцена' : objects.length === 1 ? 'Объект' : `Объекты (${objects.length})`;
  $('stat-vertices').textContent = counted.size;
  $('stat-edges').textContent = edges.filter(([a]) => counted.has(a)).length;
  $('stat-faces').textContent = scope.reduce((sum, island) => sum + island.faces.length, 0);
  $('stat-size').textContent = formatBytes(mesh.byteSize(objects.length ? objects : null));
  $('focus-button').classList.toggle('active', editor.focus);
  $('snap-toggle').classList.toggle('active', editor.snapGrid.enabled);
  $('snap-toggle').title = editor.snapGrid.enabled
    ? 'Привязка к сетке включена: перемещение и масштаб идут по шагам сетки. Нажмите, чтобы отвязать'
    : 'Привязка к сетке выключена: перемещение и масштаб свободные. Нажмите, чтобы привязать';
  document.querySelector('[data-action="make-face"]').disabled = !editor.canMakeFace();
  document.querySelector('[data-action="flip-faces"]').disabled = editor.facesToFlip().length === 0;
  // The banner keeps its last name while it slides away.
  if (editor.operation) $('operation-name').textContent = OPERATION_NAMES[editor.operation];
  $('operation-banner').classList.toggle('shown', editor.operation !== null);
  $('app').classList.toggle('pencil-mode', editor.operation === 'pencil'); // pencil cursor, see styles.css
  for (const name of ['cut', 'extrude', 'pencil', 'polygon']) {
    $(`${name}-toggle`).classList.toggle('active', editor.operation === name);
  }
  let hint = HINTS[editor.operation ?? tool];
  if (editor.polygon) {
    const { axis, offset, points, problem } = editor.polygon;
    const plane = { x: 'YZ', y: 'XZ', z: 'XY' }[axis];
    if (!axis) {
      hint = 'Полигон: выберите плоскость кнопками X, Y, Z внизу (или клавишами {axis.x}/{axis.y}/{axis.z}) · Esc или {op.polygon} — выйти';
    } else if (problem) {
      hint = `Полигон не создан: ${problem} · Backspace — убрать последнюю точку · Esc — начать контур заново`;
    } else if (points.length === 0) {
      hint = `Полигон: плоскость ${plane}, ${axis.toUpperCase()} = ${+offset.toFixed(5)} · Клик — первая точка · PgUp/PgDn — сдвинуть плоскость · Esc или {op.polygon} — выйти`;
    } else {
      hint = `Полигон: точек ${points.length} · Клик — следующая точка · клик по первой точке или Enter — замкнуть · Backspace — убрать последнюю · Esc — начать заново`;
    }
  }
  if (editor.extrude) {
    hint = `Экструд: ${+editor.extrude.distance.toFixed(5)} · Клик — зафиксировать · Ctrl — мелкий шаг · Esc — отмена`;
  }
  if (editor.cut) {
    const { axis, value } = editor.cut;
    hint = value === null
      ? `По оси ${axis.toUpperCase()} грань не пересекает ни одна линия сетки — смените ось (2–4) или зажмите Ctrl · Esc — отмена`
      : `Разрез: ${axis.toUpperCase()} = ${+value.toFixed(5)} · Клик — разрезать · 2–4 — ось, 1 — авто · Ctrl — мелкий шаг · Esc — отмена`;
  }
  // {id} in a hint stands for the keys of that shortcut, as they are set now.
  $('status-hint').textContent = (hint ?? '').replace(/\{([\w.-]+)\}/g, (_, id) => hotkeys.label(id));

  viewport.requestRender();
}

editor.addEventListener('change', refresh);
refresh();
