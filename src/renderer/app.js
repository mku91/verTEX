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
import { AtlasLink } from './atlas-link.js';
import { UVEditor } from './uv-editor.js';
import { MirrorDisplay } from './mirror-display.js';
import { Warnings } from './warnings.js';

setTheme(savedTheme()); // before the views are built, so they start in the right colours

const viewport = new Viewport(document.getElementById('viewport'));
const editor = new Editor(viewport);
new AxisGizmo(document.getElementById('axis-gizmo'), viewport, editor);
const orthoViews = new OrthoViews(document.getElementById('ortho-views'), editor);
const uvEditor = new UVEditor(document.getElementById('uv-editor'), editor);
new ExtrudePopup(document.getElementById('extrude-popup'), viewport, editor);
new PolygonPopup(document.getElementById('polygon-popup'), viewport, editor);
new Outliner(document.getElementById('outliner-section'), editor);


const ACTIONS = {
  delete: () => editor.deleteSelection(),
  'make-face': () => editor.makeFace(),
  'flip-faces': () => editor.flipFaces(),
  frame: () => {
    editor.frame();
    orthoViews.frame();
  },
  'toggle-views': () => setBottomPanel(orthoViews.open ? null : 'views'),
  'toggle-uv': () => setBottomPanel(uvEditor.open ? null : 'uv'),
  // N: face orientation on and off.
  'toggle-orientation': () => setShading(editor.shading === 'orientation' ? 'solid' : 'orientation'),
  settings: () => openSettings(),
  'toggle-snapping': () => setSnapping(!editor.snapGrid.enabled),
  'toggle-local': () => setLocalAxes(!editor.localAxes),
  'toggle-focus': () => setFocus(!editor.focus),
  'toggle-cut': () => editor.setOperation(editor.operation === 'cut' ? null : 'cut'),
  'toggle-place': () => editor.setOperation(editor.operation === 'place' ? null : 'place'),
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

    { id: 'tool.select', group: 'Инструменты', label: 'Выделение', keys: 'KeyV', run: () => editor.setTool('select') },
    { id: 'tool.move', group: 'Инструменты', label: 'Перемещение', keys: 'KeyW', run: () => editor.setTool('move') },
    { id: 'tool.rotate', group: 'Инструменты', label: 'Вращение', keys: 'KeyR', run: () => editor.setTool('rotate') },
    { id: 'tool.scale', group: 'Инструменты', label: 'Масштаб', keys: 'KeyS', run: () => editor.setTool('scale') },
    { id: 'tool.pivot', group: 'Инструменты', label: 'Опорная точка', keys: 'KeyD', run: () => editor.setTool('pivot') },

    { id: 'op.place', group: 'Режимы', label: 'Разместить', keys: 'KeyJ', run: () => ACTIONS['toggle-place']() },
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
    { id: 'view.views', group: 'Вид', label: 'Три вида', keys: 'KeyB', run: () => ACTIONS['toggle-views']() },
    { id: 'view.uv', group: 'Вид', label: 'Редактор UV', keys: 'KeyU', run: () => ACTIONS['toggle-uv']() },
    { id: 'view.local', group: 'Вид', label: 'Локальные оси', keys: 'KeyL', run: () => ACTIONS['toggle-local']() },
    { id: 'view.focus', group: 'Вид', label: 'Фокус', keys: 'KeyT', run: () => ACTIONS['toggle-focus']() },
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
  ['Ctrl / Alt (зажаты)', 'Перетаскивание числового поля: шаг 0.1 / 0.01'],
  ['X / C / Z (зажаты)', 'При перетаскивании: только по оси X / Y / Z'],
];


const toolButtons = [...document.querySelectorAll('[data-tool]')];
const modeButtons = [...document.querySelectorAll('#modes [data-mode]')]; // not the gizmos' own data-mode

// The highlight of the current mode is one block under the buttons, which
// slides to the button of the mode (the styles animate it).
const modeSlider = document.getElementById('mode-slider');
function placeModeSlider() {
  const button = modeButtons.find((item) => item.classList.contains('active'));
  if (!button || button.offsetWidth === 0) return;
  modeSlider.style.width = `${button.offsetWidth}px`;
  modeSlider.style.transform = `translateX(${button.offsetLeft}px)`;
  // The first time it is simply there; after that it travels.
  if (!modeSlider.classList.contains('placed')) {
    void modeSlider.offsetWidth;
    modeSlider.classList.add('placed');
  }
}
// The buttons change width when the font arrives or the window's scale changes.
new ResizeObserver(placeModeSlider).observe(document.getElementById('modes'));
const coordInputs = [...document.querySelectorAll('#properties [data-axis]')];
const sizeInputs = [...document.querySelectorAll('[data-size]')];
const rotationInputs = [...document.querySelectorAll('[data-rotation]')];
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
    min: 0,
  });
  // Arrow keys step the size by the grid step.
  input.addEventListener('keydown', (event) => {
    if (event.code !== 'ArrowUp' && event.code !== 'ArrowDown') return;
    event.preventDefault();
    const step = editor.snapGrid.activeStep * (event.code === 'ArrowUp' ? 1 : -1);
    const value = +(parse() + step).toFixed(5);
    if (!(value >= 0)) return;
    editor.setObjectSize(axis, value);
    input.value = value;
  });
}

// The rotation panel: how the object or group has been turned, in degrees; a
// new angle turns it about its pivot point.
for (const input of rotationInputs) {
  const axis = input.dataset.rotation;
  const parse = () => parseFloat(input.value.replace(',', '.'));
  input.addEventListener('change', () => {
    editor.setObjectRotation(axis, parse());
    refresh();
  });
  let beforeScrub = null;
  scrubbable(input, {
    read: parse,
    write: (value) => editor.setObjectRotation(axis, value, false),
    begin: () => { beforeScrub = editor.snapshot(); },
    end: () => editor.commit(beforeScrub),
  });
  // Arrow keys turn by 15 degrees.
  input.addEventListener('keydown', (event) => {
    if (event.code !== 'ArrowUp' && event.code !== 'ArrowDown') return;
    event.preventDefault();
    const value = +(parse() + (event.code === 'ArrowUp' ? 15 : -15)).toFixed(4);
    if (!Number.isFinite(value)) return;
    editor.setObjectRotation(axis, value);
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
    reset.innerHTML = '<i class="fa-solid fa-rotate-left"></i>';
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
  '#undo-button': 'edit.undo', '#redo-button': 'edit.redo',
  '#place-toggle': 'op.place', '#cut-toggle': 'op.cut', '#extrude-toggle': 'op.extrude', '#polygon-toggle': 'op.polygon', '#pencil-toggle': 'op.pencil',
  '[data-action="make-face"]': 'edit.make-face', '[data-action="flip-faces"]': 'edit.flip-faces', '[data-action="delete"]': 'edit.delete',
  '[data-action="frame"]': 'view.frame', '[data-action="toggle-views"]': 'view.views', '[data-action="toggle-uv"]': 'view.uv', '#focus-button': 'view.focus',
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
// With the pivot tool: the pivot point back to the middle of the object.
$('center-pivot').addEventListener('click', () => editor.centerPivot());
$('center-pivot').addEventListener('mousedown', (event) => event.preventDefault()); // keep the keyboard focus
vectorButtons($('copy-vector'), $('paste-vector'),
  () => editor.panelPoint(), (axis, value) => editor.setSelectionCenter(axis, value, false));
vectorButtons($('copy-rotation'), $('paste-rotation'),
  () => editor.objectRotation(), (axis, value) => editor.setObjectRotation(axis, value, false));
vectorButtons($('copy-size'), $('paste-size'),
  () => editor.objectSize(), (axis, value) => editor.setObjectSize(axis, value, false));

// --- the banner of the modal operation that is on ------------------------

// The cut tool's own setting, at the bottom of the view while the tool is on.
const cutButtons = [...document.querySelectorAll('#cut-options [data-cut]')];
for (const button of cutButtons) {
  button.addEventListener('click', () => editor.setCutDirection(button.dataset.cut));
}
document.getElementById('cut-options').addEventListener('mousedown', (event) => event.preventDefault()); // keep the keyboard focus

// The place tool's setting, shown once something has been placed: the side it lies on.
const placeButtons = [...document.querySelectorAll('#place-options [data-place]')];
for (const button of placeButtons) {
  button.addEventListener('click', () => editor.setPlaceSide(button.dataset.place));
}
document.getElementById('place-options').addEventListener('mousedown', (event) => event.preventDefault()); // keep the keyboard focus

const OPERATION_NAMES = { place: 'Размещение', cut: 'Разрез', extrude: 'Экструд', polygon: 'Полигон', pencil: 'Карандаш' };
$('operation-close').addEventListener('click', () => editor.setOperation(null));
$('operation-banner').addEventListener('mousedown', (event) => event.preventDefault()); // keep the keyboard focus

// --- the mirror (top bar) ------------------------------------------------------

const mirrorDisplay = new MirrorDisplay(viewport, editor);
const PARTS = { 0: 'выкл', 1: '2 части', 2: '4 части', 3: '8 частей' };
function closeMirrorPopup() {
  const open = !$('mirror-popup').hidden;
  $('mirror-popup').hidden = true;
  return open;
}
$('mirror-toggle').addEventListener('click', () => {
  closeGridPopups();
  $('mirror-popup').hidden = !$('mirror-popup').hidden;
  showMirror();
});
$('mirror-control').addEventListener('mousedown', (event) => event.preventDefault()); // keep the keyboard focus
window.addEventListener('pointerdown', (event) => {
  if (!$('mirror-control').contains(event.target)) closeMirrorPopup();
}, true);
for (const group of document.querySelectorAll('.mirror-axes')) {
  const scope = group.dataset.mirror;
  for (const button of group.querySelectorAll('[data-mirror-axis]')) {
    button.addEventListener('click', () => {
      const axis = button.dataset.mirrorAxis;
      if (scope === 'global') {
        const axes = [...editor.mirror.globalAxes];
        editor.setGlobalMirror(axes.includes(axis) ? axes.filter((a) => a !== axis) : [...axes, axis]);
      } else {
        const entry = editor.mirrorEntry();
        if (entry === null) return;
        const axes = editor.mesh.objects[entry].mirror ?? [];
        editor.setLocalMirror(entry, axes.includes(axis) ? axes.filter((a) => a !== axis) : [...axes, axis]);
      }
    });
  }
}
// The button and the popup follow the editor.
function showMirror() {
  const globalAxes = editor.mirror.globalAxes;
  const entry = editor.mirrorEntry();
  const object = entry === null ? null : editor.mesh.objects[entry];
  const localAxes = object?.mirror ?? [];
  for (const group of document.querySelectorAll('.mirror-axes')) {
    const scope = group.dataset.mirror;
    for (const button of group.querySelectorAll('[data-mirror-axis]')) {
      const axis = button.dataset.mirrorAxis;
      const on = scope === 'global' ? globalAxes.has(axis) : localAxes.includes(axis);
      button.classList.toggle('active', on);
      button.disabled = scope === 'local' && !object;
    }
  }
  document.querySelector('[data-mirror-note="global"]').textContent = PARTS[globalAxes.size];
  document.querySelector('[data-mirror-note="local"]').textContent = object
    ? `«${object.name}»: ${PARTS[localAxes.length]}`
    : 'редактируемый объект не один';
  $('mirror-toggle').classList.toggle('active', editor.mirror.active()); // any mirror, anywhere
  $('mirror-toggle').title = globalAxes.size
    ? `Зеркало: глобальное по ${[...globalAxes].map((a) => a.toUpperCase()).join(', ')}`
    : localAxes.length
      ? `Зеркало: локальное у «${object.name}» по ${localAxes.map((a) => a.toUpperCase()).join(', ')}`
      : 'Зеркало: выключено. Правки повторяются по другую сторону плоскости';
  mirrorDisplay.update();
}

// Grid snapping: a switch in the top bar, remembered between runs.
const SNAPPING_KEY = 'vertex.snapping';
function setSnapping(on) {
  editor.setSnapping(on);
  localStorage.setItem(SNAPPING_KEY, on ? '1' : '0');
}
editor.setSnapping(localStorage.getItem(SNAPPING_KEY) !== '0');
$('snap-toggle').addEventListener('mousedown', (event) => event.preventDefault()); // keep the keyboard focus

// Local axes for the move and rotate gizmos: a switch in the top bar, remembered too.
const LOCAL_AXES_KEY = 'vertex.localAxes';
function setLocalAxes(on) {
  editor.setLocalAxes(on);
  localStorage.setItem(LOCAL_AXES_KEY, editor.localAxes ? '1' : '0');
}
editor.setLocalAxes(localStorage.getItem(LOCAL_AXES_KEY) === '1');
$('local-toggle').addEventListener('mousedown', (event) => event.preventDefault()); // keep the keyboard focus

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

// Held while an element is pulled, these keep it to one axis (C is Y: it is
// next to X and Z under the left hand).
const HOLD_AXES = { KeyX: 'x', KeyC: 'y', KeyZ: 'z' };
const heldAxisKeys = []; // the codes held now, the last one rules
// A key still down when the pull ends: its repeats are not shortcuts.
const spentAxisKeys = new Set();
function dropAxisHold() {
  for (const code of heldAxisKeys) spentAxisKeys.add(code);
  heldAxisKeys.length = 0;
  editor.holdAxis(null);
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
  if (event.code === 'Escape' && (closeGridPopups() || closeMirrorPopup())) return;
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
  if (spentAxisKeys.has(event.code)) {
    event.preventDefault();
    return;
  }
  // While something is being pulled, X, C and Z are the axis it keeps to.
  if (event.code in HOLD_AXES && !event.altKey && !event.metaKey && editor.pulling()) {
    event.preventDefault();
    if (!heldAxisKeys.includes(event.code)) {
      heldAxisKeys.push(event.code);
      editor.holdAxis(HOLD_AXES[event.code]);
    }
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
  // An axis key let go: the one still held takes over, or the movement is free again.
  spentAxisKeys.delete(event.code);
  const held = heldAxisKeys.indexOf(event.code);
  if (held === -1) return;
  heldAxisKeys.splice(held, 1);
  const rest = heldAxisKeys[heldAxisKeys.length - 1];
  if (!rest || !editor.holdAxis(HOLD_AXES[rest])) dropAxisHold();
});
// The pull is over: so is the hold. (After the release has been handled, so
// that what was pulled stays where the axis kept it.)
for (const type of ['pointerup', 'pointercancel']) {
  window.addEventListener(type, () => setTimeout(() => { if (!editor.pulling()) dropAxisHold(); }), true);
}
// A key released while the window is unfocused never reports keyup.
window.addEventListener('blur', () => {
  dropAxisHold();
  spentAxisKeys.clear();
  viewport.setPanMode(false);
  editor.setFineSnap(false);
});

// Ctrl held: vertices snap to a grid ten times finer.
for (const type of ['keydown', 'keyup']) {
  window.addEventListener(type, (event) => editor.setFineSnap(event.ctrlKey));
}

// Buttons must not take focus, or Space would press the last clicked one.
for (const id of ['toolbar', 'modes', 'history-actions', 'top-actions', 'shading', 'focus-button']) {
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

// Warnings about the model: a card when one comes up, a block in the status bar after.
const warnings = new Warnings(editor, {
  toast: $('overlap-toast'),
  button: $('warnings-button'),
  errorButton: $('errors-button'),
  list: $('warnings-list'),
});

// The project: its file and its unsaved changes, named in the window's title.
const project = new Project(editor, window.vertex?.project);
const showProject = () => {
  document.title = `${project.dirty ? '● ' : ''}${project.name} — verTEX`;
};
project.addEventListener('change', showProject);
showProject();

// Texturing: the atlas as a file beside the project, painted in another program.
const atlasLink = new AtlasLink(editor, project, window.vertex?.atlas);
$('atlas-open').addEventListener('click', () => atlasLink.open());
$('atlas-reveal').addEventListener('click', () => atlasLink.reveal());
$('atlas-repack').addEventListener('click', () => {
  if (window.confirm('Разложить все грани на атласе заново?\n\nВсё нарисованное на текстуре будет потеряно. Действие можно отменить.')) editor.repackAtlas();
});
for (const id of ['atlas-open', 'atlas-reveal', 'atlas-repack']) {
  $(id).addEventListener('mousedown', (event) => event.preventDefault()); // keep the keyboard focus
}
{
  // The project's pixels per unit of length.
  const input = $('ppu-input');
  const parse = () => parseInt(input.value, 10);
  const apply = (value) => {
    if (value === editor.ppu || !(value >= 1 && value <= 128)) return;
    const faces = editor.mesh.faces.length;
    if (faces && !window.confirm(`Изменить плотность на ${value} пикселей на единицу?\n\nВся развёртка будет построена заново, нарисованное на текстуре потеряется. Действие можно отменить.`)) return;
    editor.setPPU(value);
  };
  input.addEventListener('change', () => {
    apply(parse());
    refresh();
  });
  input.addEventListener('keydown', (event) => {
    if (event.code === 'Enter' || event.code === 'Escape') input.blur();
  });
}

window.vertexDebug = { uv: uvEditor, atlasLink, warnings, text: () => editor.toText(), views: orthoViews, project, files: () => projectFiles(editor), editor };

// The three-view panel; whether it is open is remembered between launches.
// The bottom of the workspace holds one panel at a time: the three views
// ('views'), the UV editor ('uv'), or none (null). Which is remembered
// between launches.
const VIEWS_OPEN_KEY = 'vertex.orthoViewsOpen';
const BOTTOM_PANEL_KEY = 'vertex.bottomPanel';
function setBottomPanel(panel) {
  orthoViews.toggle(panel === 'views');
  uvEditor.toggle(panel === 'uv');
  $('views-splitter').hidden = !panel;
  document.querySelector('[data-action="toggle-views"]').classList.toggle('active', panel === 'views');
  document.querySelector('[data-action="toggle-uv"]').classList.toggle('active', panel === 'uv');
  localStorage.setItem(VIEWS_OPEN_KEY, panel === 'views' ? '1' : '0');
  localStorage.setItem(BOTTOM_PANEL_KEY, panel ?? '');
}
{
  const saved = localStorage.getItem(BOTTOM_PANEL_KEY);
  setBottomPanel(saved === 'uv' ? 'uv' : saved === 'views' || (saved === null && localStorage.getItem(VIEWS_OPEN_KEY) === '1') ? 'views' : null);
}

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
  $('uv-editor').style.flexBasis = `${share * 100}%`;
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

// The selection's panels fold: a click on a panel's caption hides its fields,
// another shows them again. Which are folded is remembered between launches.
{
  const FOLDED_KEY = 'vertex.foldedPanels';
  let folded = [];
  try {
    folded = JSON.parse(localStorage.getItem(FOLDED_KEY)) ?? [];
  } catch {
    // Not a list: nothing is folded.
  }
  for (const id of ['dimensions', 'properties', 'rotation']) {
    const panel = $(id);
    const header = panel.querySelector('.properties-header');
    const caret = document.createElement('i');
    caret.className = 'fa-solid fa-caret-down panel-caret';
    header.prepend(caret);
    // The fields go into a body that can slide shut (see the styles).
    const body = document.createElement('div');
    body.className = 'panel-body';
    const inner = document.createElement('div');
    inner.append(...panel.querySelectorAll(':scope > label'));
    body.append(inner);
    panel.append(body);
    const show = () => {
      panel.classList.toggle('folded', folded.includes(id));
      header.title = folded.includes(id) ? 'Развернуть' : 'Свернуть';
      // Folded fields are out of reach of the keyboard too.
      inner.inert = folded.includes(id);
    };
    header.addEventListener('mousedown', (event) => event.preventDefault()); // keep the keyboard focus
    header.addEventListener('click', (event) => {
      if (event.target.closest('button')) return; // its own buttons do their own thing
      folded = folded.includes(id) ? folded.filter((other) => other !== id) : [...folded, id];
      localStorage.setItem(FOLDED_KEY, JSON.stringify(folded));
      show();
    });
    show();
  }
}

// The side panel's width, set by dragging its left edge and remembered between launches.
const PANEL_WIDTH_KEY = 'vertex.panelWidth';
const PANEL_WIDTH_DEFAULT = 240; // px
const PANEL_MIN_WIDTH = 180;
const VIEWPORT_MIN_WIDTH = 320; // px left to the views
function setPanelWidth(width) {
  const room = $('app').clientWidth - $('toolbar').offsetWidth - $('panel-splitter').offsetWidth - VIEWPORT_MIN_WIDTH;
  width = Math.round(Math.min(Math.max(width, PANEL_MIN_WIDTH), Math.max(room, PANEL_MIN_WIDTH)));
  $('app').style.setProperty('--panel-width', `${width}px`);
  return width;
}
{
  const splitter = $('panel-splitter');
  let wanted = parseFloat(localStorage.getItem(PANEL_WIDTH_KEY)) || PANEL_WIDTH_DEFAULT; // what the user set
  const set = (width) => {
    wanted = setPanelWidth(width);
    localStorage.setItem(PANEL_WIDTH_KEY, wanted);
  };
  // The pointer holds the middle of the strip; the panel starts at its right edge.
  const follow = (event) => set($('app').getBoundingClientRect().right - event.clientX - splitter.offsetWidth / 2);
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
  splitter.addEventListener('dblclick', () => set(PANEL_WIDTH_DEFAULT));
  // A narrower window squeezes the panel, a wider one gives it back what was set.
  window.addEventListener('resize', () => setPanelWidth(wanted));
  setPanelWidth(wanted);
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
  placeModeSlider();

  // The middle of the selection, or the pivot point with the pivot tool.
  const point = editor.panelPoint();
  for (const input of coordInputs) {
    input.disabled = !point;
    if (document.activeElement === input) continue;
    input.value = point ? +point[input.dataset.axis].toFixed(5) : '';
  }

  $('copy-vector').disabled = $('paste-vector').disabled = !point;
  $('center-pivot').hidden = !(tool === 'pivot' && point);
  // The size panel: one object selected, in object mode.
  const size = editor.objectSize();
  $('dimensions').hidden = !size;
  for (const input of sizeInputs) {
    if (!size || document.activeElement === input) continue;
    input.value = +size[input.dataset.size].toFixed(5);
  }
  $('properties').hidden = picked.size === 0; // only while something is selected
  // The rotation panel: an object or a group picked whole, in object mode.
  const rotation = editor.objectRotation();
  $('rotation').hidden = !rotation;
  for (const input of rotationInputs) {
    if (!rotation || document.activeElement === input) continue;
    input.value = +rotation[input.dataset.rotation].toFixed(4);
  }
  $('selection-count').textContent = tool === 'pivot' && point ? 'Опорная точка' : 'Позиция';
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
  showMirror();
  $('snap-toggle').classList.toggle('active', editor.snapGrid.enabled);
  $('local-toggle').classList.toggle('active', editor.localAxes);
  // Texturing.
  if (document.activeElement !== $('ppu-input')) $('ppu-input').value = editor.ppu;
  $('atlas-size').textContent = `${editor.atlas.width} × ${editor.atlas.height}`;
  // Undo and redo: lit while there is a step to take.
  $('undo-button').disabled = editor.history.undoStack.length === 0;
  $('redo-button').disabled = editor.history.redoStack.length === 0;
  // A planet for the world's axes, a pin for the object's own.
  $('local-toggle').firstElementChild.className = `fa-solid ${editor.localAxes ? 'fa-location-dot' : 'fa-globe'}`;
  $('local-toggle').title = editor.localAxes
    ? `Локальные оси включены: перемещение и вращение идут вдоль осей самого объекта (${hotkeys.label('view.local')}). Нажмите, чтобы вернуть мировые`
    : `Локальные оси выключены: перемещение и вращение идут вдоль осей мира (${hotkeys.label('view.local')}). Нажмите, чтобы включить`;
  $('snap-toggle').title = editor.snapGrid.enabled
    ? 'Привязка к сетке включена: перемещение и масштаб идут по шагам сетки. Нажмите, чтобы отвязать'
    : 'Привязка к сетке выключена: перемещение и масштаб свободные. Нажмите, чтобы привязать';
  document.querySelector('[data-action="make-face"]').disabled = !editor.canMakeFace();
  document.querySelector('[data-action="flip-faces"]').disabled = editor.facesToFlip().length === 0;
  // The banner keeps its last name while it slides away.
  if (editor.operation) $('operation-name').textContent = OPERATION_NAMES[editor.operation];
  $('operation-banner').classList.toggle('shown', editor.operation !== null);
  $('cut-options').classList.toggle('shown', editor.operation === 'cut');
  $('place-options').classList.toggle('shown', editor.placed());
  for (const button of placeButtons) button.classList.toggle('active', button.dataset.place === editor.placeSide);
  // The place tool takes one object or group picked whole.
  $('place-toggle').disabled = editor.operation !== 'place' && editor.pivotEntry() === null;
  for (const button of cutButtons) button.classList.toggle('active', button.dataset.cut === editor.cutDirection);
  $('app').classList.toggle('pencil-mode', editor.operation === 'pencil'); // pencil cursor, see styles.css
  for (const name of ['place', 'cut', 'extrude', 'pencil', 'polygon']) {
    $(`${name}-toggle`).classList.toggle('active', editor.operation === name);
  }

  viewport.requestRender();
}

editor.addEventListener('change', refresh);
refresh();
