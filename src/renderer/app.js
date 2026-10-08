import { Viewport } from './viewport.js';
import { Editor, MODES, OPERATION_MODES } from './editor.js';
import { AxisGizmo } from './axis-gizmo.js';
import { OrthoViews } from './ortho-views.js';
import { ExtrudePopup } from './extrude-popup.js';
import { PolygonPopup } from './polygon-popup.js';
import { Outliner } from './outliner.js';
import { scrubbable } from './scrub.js';
import { THEMES, theme, setTheme, savedTheme } from './theme.js';

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
  rotate: 'Тяните кольца гизмо, чтобы повернуть выделение вокруг его центра',
  scale: 'Тяните маркеры гизмо, чтобы масштабировать выделение от его центра',
  extrude: 'Экструд: кликните грань (режим «Грань») или ребро (режим «Ребро») и ведите мышью · Клик — зафиксировать и выйти · Esc или X — выйти',
  pencil: 'Карандаш: зажмите ЛКМ на вершине и тяните — из неё вырастет новая, соединённая ребром · Отпустите на другой вершине, чтобы соединить их; замкнутый контур станет гранью · Esc или P — выйти',
  cut: 'Разрез: кликните грань · ведите линию мышью · 2–4 — ось, 1 — авто · Ctrl — мелкий шаг · Клик — разрезать объект и выйти · Esc или K — выйти без разреза',
};

const ACTIONS = {
  delete: () => editor.deleteSelection(),
  frame: () => {
    editor.frame();
    orthoViews.frame();
  },
  'toggle-views': () => setViewsOpen(!orthoViews.open),
  // N: face orientation on and off.
  'toggle-orientation': () => setShading(editor.shading === 'orientation' ? 'solid' : 'orientation'),
  settings: () => openSettings(),
  'toggle-cut': () => editor.setOperation(editor.operation === 'cut' ? null : 'cut'),
  'toggle-extrude': () => editor.setOperation(editor.operation === 'extrude' ? null : 'extrude'),
  'toggle-pencil': () => editor.setOperation(editor.operation === 'pencil' ? null : 'pencil'),
  'toggle-polygon': () => editor.setOperation(editor.operation === 'polygon' ? null : 'polygon'),
  new: () => editor.newScene(),
  undo: () => editor.undo(),
  redo: () => editor.redo(),
};

// Physical key codes, so shortcuts work regardless of keyboard layout.
const KEYS = {
  KeyQ: () => editor.setTool('select'),
  KeyW: () => editor.setTool('move'),
  KeyE: () => editor.setTool('rotate'),
  KeyS: () => editor.setTool('scale'),
  KeyK: () => ACTIONS['toggle-cut'](),
  KeyX: () => ACTIONS['toggle-extrude'](),
  KeyP: () => ACTIONS['toggle-pencil'](),
  KeyG: () => ACTIONS['toggle-polygon'](),
  // The polygon tool's own keys; they do nothing outside it.
  Enter: () => editor.closePolygon(),
  Backspace: () => editor.undoPolygonPoint(),
  PageUp: () => editor.shiftPolygonPlane(1),
  PageDown: () => editor.shiftPolygonPlane(-1),
  Digit1: () => editor.setAxisLock('free'),
  Digit2: () => editor.setAxisLock('x'),
  Digit3: () => editor.setAxisLock('y'),
  Digit4: () => editor.setAxisLock('z'),
  KeyA: () => editor.selectAll(),
  KeyF: () => ACTIONS.frame(),
  KeyV: () => ACTIONS['toggle-views'](),
  KeyN: () => ACTIONS['toggle-orientation'](),
  Escape: () =>
    orthoViews.cancelBox() ||
    editor.cancelBox() ||
    editor.escapeOperation() ||
    editor.cancelDrag() ||
    editor.clearSelection(),
  Delete: () => editor.deleteSelection(),
};

// Genitive plural for "Выбрано ...: N".
const ELEMENT_NAMES = { object: 'объектов', face: 'граней', edge: 'рёбер', vertex: 'вершин' };

const toolButtons = [...document.querySelectorAll('[data-tool]')];
const modeButtons = [...document.querySelectorAll('#modes [data-mode]')]; // not the gizmos' own data-mode
const coordInputs = [...document.querySelectorAll('[data-axis]')];
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
    if (control.kind === 'coarse') editor.snapGrid.step = COARSE_STEPS[value];
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
  if (divisor >= 2 && divisor <= 10) editor.snapGrid.fineDivisor = divisor;
  showGrid();
}

// --- settings dialog (File -> Settings) ---------------------------------

function openSettings() {
  $('settings-dialog').hidden = false;
  $('theme').focus();
}
function closeSettings() {
  $('settings-dialog').hidden = true;
  document.activeElement?.blur(); // give the keyboard back to the editor shortcuts
}
$('settings-close').addEventListener('click', closeSettings);
$('settings-dialog').addEventListener('mousedown', (event) => {
  if (event.target === $('settings-dialog')) closeSettings(); // a click on the backdrop
});

// --- shading menu (the eye next to the axis gizmo) ----------------------

const shadingItems = [...document.querySelectorAll('[data-shading]')];
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
    if (event.code === 'Escape') closeSettings();
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
  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    // Ctrl+Z undoes; Ctrl+Y and Ctrl+Shift+Z redo.
    if (event.code === 'KeyZ' || event.code === 'KeyY') {
      event.preventDefault();
      if (event.code === 'KeyY' || event.shiftKey) editor.redo();
      else editor.undo();
    }
    // Ctrl+, opens the settings; the menu item shows the same shortcut.
    if (event.code === 'Comma') openSettings();
    return;
  }
  if (event.altKey) return;
  const handler = KEYS[event.code];
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
for (const id of ['toolbar', 'modes', 'top-actions', 'shading']) {
  $(id).addEventListener('mousedown', (event) => event.preventDefault());
}
for (const control of gridControls) {
  control.button.addEventListener('mousedown', (event) => event.preventDefault());
}

window.vertex?.onMenu((action) => ACTIONS[action]?.());

// For debugging a running window from outside (see the debugging port in
// main.js): `vertexDebug.text()` returns the whole project as text, and
// `vertexDebug.editor` is the editor itself.
window.vertexDebug = { text: () => editor.toText(), editor };

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

  const center = editor.selectionCenter();
  for (const input of coordInputs) {
    input.disabled = selection.size === 0;
    if (document.activeElement === input) continue;
    input.value = selection.size ? +center[input.dataset.axis].toFixed(5) : '';
  }

  $('properties').hidden = picked.size === 0; // only while something is selected
  $('selection-count').textContent = picked.size
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
  $('app').classList.toggle('pencil-mode', editor.operation === 'pencil'); // pencil cursor, see styles.css
  for (const name of ['cut', 'extrude', 'pencil', 'polygon']) {
    $(`${name}-toggle`).classList.toggle('active', editor.operation === name);
  }
  let hint = HINTS[editor.operation ?? tool];
  if (editor.polygon) {
    const { axis, offset, points, problem } = editor.polygon;
    const plane = { x: 'YZ', y: 'XZ', z: 'XY' }[axis];
    if (!axis) {
      hint = 'Полигон: выберите плоскость на гизмо внизу (или клавишами 2/3/4) · Esc или G — выйти';
    } else if (problem) {
      hint = `Полигон не создан: ${problem} · Backspace — убрать последнюю точку · Esc — начать контур заново`;
    } else if (points.length === 0) {
      hint = `Полигон: плоскость ${plane}, ${axis.toUpperCase()} = ${+offset.toFixed(5)} · Клик — первая точка · PgUp/PgDn — сдвинуть плоскость · Esc или G — выйти`;
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
  $('status-hint').textContent = hint;

  viewport.requestRender();
}

editor.addEventListener('change', refresh);
refresh();
