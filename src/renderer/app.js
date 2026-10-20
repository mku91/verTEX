import { t, locale, languages, localize } from './i18n.js'; // first: the markup gets its words before anything reads them
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
import { Project, projectFiles, modelOf, scaledModel } from './project.js';
import { gltfOf } from './gltf.js';
import { ColorPopup } from './color-popup.js';
import { AtlasLink, EXTERNAL_EDITOR_KEY } from './atlas-link.js';
import { UVEditor } from './uv-editor.js';
import { PipetteLoupe } from './pipette-loupe.js';
import { MirrorDisplay } from './mirror-display.js';
import { Warnings } from './warnings.js';
import { Welcome } from './welcome.js';
import { RenderMode } from './render-mode.js';
import { ModeIndicator } from './mode-indicator.js';
import { CollisionMode } from './collisions.js';
import { Simulation } from './simulation.js';
import { Timeline } from './timeline.js';
import { AnimationMode } from './animate.js';
import { ViewsWindow } from './views-window.js';
import { tell, confirmIt, askSave } from './ask-dialog.js';
import { toast } from './toast.js';
import { bindToNode, unbind, smoothWeights, skinSummary, setWeight, autoWeights } from './skin.js';
import { SkinMarks } from './skin-marks.js';
import { PosePreview } from './pose-preview.js';
import { SkinHeat } from './skin-heat.js';
import { NodeMarks } from './node-marks.js';
import { NodeBones } from './node-bones.js';
import { latinOnly, freeName } from './names.js';
import { RETRO_DEFAULTS, DITHERS, PALETTES } from './retro.js';

setTheme(savedTheme()); // before the views are built, so they start in the right colours

const viewport = new Viewport(document.getElementById('viewport'));
const editor = new Editor(viewport);
new AxisGizmo(document.getElementById('axis-gizmo'), viewport, editor);
new ModeIndicator(document.getElementById('mode-indicator'), viewport, editor);
const orthoViews = new OrthoViews(document.getElementById('ortho-views'), editor);
const uvEditor = new UVEditor(document.getElementById('uv-editor'), editor);
const timeline = new Timeline(document.getElementById('timeline'), editor);
const animationMode = new AnimationMode(document.getElementById('pose-panel'), viewport, editor, timeline);
// The three views pose too, in the animation mode, and show the pose.
orthoViews.animation = animationMode;
new NodeMarks(editor, animationMode); // (every node, a hollow square on its pivot point)
new NodeBones(editor, animationMode); // (and a bone from it to each node inside it)
// The views in a window of their own (see views-window.js).
const viewsWindow = new ViewsWindow(editor, viewport);
viewsWindow.animation = animationMode;
viewsWindow.addEventListener('change', () => {
  if (viewsWindow.ortho) viewsWindow.ortho.animation = animationMode;
  document.querySelector('[data-action="views-window"]').classList.toggle('active', viewsWindow.open);
});
animationMode.onShow = () => {
  orthoViews.draw();
  viewsWindow.draw();
};
timeline.addEventListener('addkey', (event) => animationMode.writeKeys([event.detail.index], [event.detail.property]));
timeline.addEventListener('insertkey', () => animationMode.keyPicked()); // (as K)
timeline.addEventListener('keyall', () => animationMode.keyAll());
new PipetteLoupe(editor);
new SkinMarks(editor); // (what the skin binds to a node picked: its vertices, in green)
// A pose to try the skin by, in the model workspace (see pose-preview.js).
const posePreview = new PosePreview(editor);
posePreview.addEventListener('change', () => {
  $('skin-pose').classList.toggle('active', posePreview.on);
  if (posePreview.on) toast(t('app.skin.toast.pose'), { icon: 'fa-person-walking' });
});
new SkinHeat(editor); // (and how much: the surface painted by the weight, in the model workspace)
new ExtrudePopup(document.getElementById('extrude-popup'), viewport, editor);
new PolygonPopup(document.getElementById('polygon-popup'), viewport, editor);
const outliner = new Outliner(document.getElementById('outliner-section'), editor);
const collisionMode = new CollisionMode(document.getElementById('collision-panel'), document.getElementById('collision-button'), viewport, editor);
outliner.shapes = collisionMode;
collisionMode.onRefresh = () => outliner.update();
const simulation = new Simulation(document.getElementById('sim-controls'), viewport, editor, collisionMode);


const ACTIONS = {
  delete: () => deleteSelection(),
  'make-face': () => editor.makeFace(),
  'flip-faces': () => editor.flipFaces(),
  frame: () => {
    editor.frame();
    orthoViews.frame();
  },
  // (In the animation mode the timeline is what is there when they are closed.)
  'toggle-views': () => setBottomPanel(orthoViews.open ? restingPanel() : 'views'),
  'views-window': () => viewsWindow.toggle(),
  // (The UV editor is not the animation mode's: the model is not edited there.)
  'toggle-uv': () => editor.workspace !== 'animation' && setBottomPanel(uvEditor.open ? restingPanel() : 'uv'),
  'toggle-animation': () => editor.setWorkspace(editor.workspace === 'animation' ? 'model' : 'animation'),
  // N: face orientation on and off.
  'toggle-orientation': () => setShading(editor.shading === 'orientation' ? 'solid' : 'orientation'),
  settings: () => openSettings(),
  'toggle-snapping': () => setSnapping(!editor.snapGrid.enabled),
  'toggle-local': () => setLocalAxes(!editor.localAxes),
  'toggle-focus': () => setFocus(!editor.focus),
  'toggle-preview': () => editor.setPreview(!editor.preview),
  'toggle-light': () => setLit(!editor.viewport.lit),
  'toggle-cut': () => editor.setOperation(editor.operation === 'cut' ? null : 'cut'),
  'toggle-place': () => editor.setOperation(editor.operation === 'place' ? null : 'place'),
  'toggle-extrude': () => editor.setOperation(editor.operation === 'extrude' ? null : 'extrude'),
  'toggle-pencil': () => editor.setOperation(editor.operation === 'pencil' ? null : 'pencil'),
  'toggle-polygon': () => editor.setOperation(editor.operation === 'polygon' ? null : 'polygon'),
  'toggle-collisions': () => editor.setCollisions(!editor.collisions),
  // The File menu: the project and its file.
  'project-new': () => project.newProject(),
  'project-open': () => project.open(),
  'project-save': () => project.save(),
  'project-save-as': () => project.saveAs(),
  'project-close': () => project.close(), // the window wants to close
  'project-close-file': () => project.closeProject(), // back to the welcome screen
  'export-gltf': () => exportModel('gltf'),
  'render-sprites': () => renderMode.show(),
  new: () => project.newProject(), // the menu of a program not yet restarted
  undo: () => editor.undo(),
  redo: () => editor.redo(),
};

// Physical key codes, so shortcuts work regardless of keyboard layout.
// The shortcuts the user can rebind (Settings -> Hotkeys): what each is
// called, its node there, its default keys and what it does.
const hotkeys = new Hotkeys(
  [
    { id: 'file.new', group: t('app.hotkeys.group.file'), label: t('app.hotkeys.file.new'), keys: 'Ctrl+KeyN', run: () => ACTIONS['project-new']() },
    { id: 'file.open', group: t('app.hotkeys.group.file'), label: t('app.hotkeys.file.open'), keys: 'Ctrl+KeyO', run: () => ACTIONS['project-open']() },
    { id: 'file.save', group: t('app.hotkeys.group.file'), label: t('app.hotkeys.file.save'), keys: 'Ctrl+KeyS', run: () => ACTIONS['project-save']() },
    { id: 'file.save-as', group: t('app.hotkeys.group.file'), label: t('app.hotkeys.file.save-as'), keys: 'Ctrl+Shift+KeyS', run: () => ACTIONS['project-save-as']() },
    { id: 'file.close', group: t('app.hotkeys.group.file'), label: t('app.hotkeys.file.close'), keys: 'Ctrl+Shift+KeyQ', run: () => ACTIONS['project-close-file']() },

    { id: 'tool.select', group: t('app.hotkeys.group.tools'), label: t('app.hotkeys.tool.select'), keys: 'KeyQ', run: () => editor.setTool('select') },
    { id: 'tool.move', group: t('app.hotkeys.group.tools'), label: t('app.hotkeys.tool.move'), keys: 'KeyW', run: () => editor.setTool('move') },
    { id: 'tool.rotate', group: t('app.hotkeys.group.tools'), label: t('app.hotkeys.tool.rotate'), keys: 'KeyR', run: () => editor.setTool('rotate') },
    { id: 'tool.scale', group: t('app.hotkeys.group.tools'), label: t('app.hotkeys.tool.scale'), keys: 'KeyS', run: () => editor.setTool('scale') },
    { id: 'tool.pivot', group: t('app.hotkeys.group.tools'), label: t('app.hotkeys.tool.pivot'), keys: 'KeyD', run: () => editor.setTool('pivot') },
    { id: 'tool.paint', group: t('app.hotkeys.group.painting'), label: t('app.hotkeys.tool.paint'), keys: 'KeyV', run: () => editor.setTool('paint') },
    { id: 'tool.pipette', group: t('app.hotkeys.group.painting'), label: t('app.hotkeys.tool.pipette'), keys: 'KeyI', run: () => editor.setTool('pipette') },
    { id: 'tool.fill', group: t('app.hotkeys.group.painting'), label: t('app.hotkeys.tool.fill'), keys: 'KeyE', run: () => editor.setTool('fill') },
    { id: 'tool.rect', group: t('app.hotkeys.group.painting'), label: t('app.hotkeys.tool.rect'), keys: 'KeyM', run: () => editor.setTool('rect') },
    { id: 'tool.ellipse', group: t('app.hotkeys.group.painting'), label: t('app.hotkeys.tool.ellipse'), keys: 'KeyO', run: () => editor.setTool('ellipse') },
    { id: 'tool.marquee', group: t('app.hotkeys.group.painting'), label: t('app.hotkeys.tool.marquee'), keys: '', run: () => editor.setTool('marquee') },

    { id: 'op.place', group: t('app.hotkeys.group.modes'), label: t('app.hotkeys.op.place'), keys: 'KeyJ', run: () => ACTIONS['toggle-place']() },
    { id: 'op.cut', group: t('app.hotkeys.group.modes'), label: t('app.hotkeys.op.cut'), keys: 'Ctrl+KeyQ', run: () => ACTIONS['toggle-cut']() },
    { id: 'op.extrude', group: t('app.hotkeys.group.modes'), label: t('app.hotkeys.op.extrude'), keys: 'Ctrl+KeyE', run: () => ACTIONS['toggle-extrude']() },
    { id: 'op.polygon', group: t('app.hotkeys.group.modes'), label: t('app.hotkeys.op.polygon'), keys: 'KeyG', run: () => ACTIONS['toggle-polygon']() },
    { id: 'op.pencil', group: t('app.hotkeys.group.modes'), label: t('app.hotkeys.op.pencil'), keys: 'KeyP', run: () => ACTIONS['toggle-pencil']() },
    { id: 'op.collisions', group: t('app.hotkeys.group.modes'), label: t('app.hotkeys.op.collisions'), keys: '', run: () => ACTIONS['toggle-collisions']() },
    { id: 'op.animation', group: t('app.hotkeys.group.modes'), label: t('app.hotkeys.op.animation'), keys: '', run: () => ACTIONS['toggle-animation']() },
    { id: 'anim.key', group: t('app.hotkeys.group.animation'), label: t('app.hotkeys.anim.key'), keys: 'KeyK', run: () => animationMode.keyPicked() },

    { id: 'edit.select-all', group: t('app.hotkeys.group.edit'), label: t('app.hotkeys.edit.select-all'), keys: 'KeyA', run: () => editor.selectAll() },
    { id: 'edit.make-face', group: t('app.hotkeys.group.edit'), label: t('app.hotkeys.edit.make-face'), keys: 'Ctrl+KeyD', run: () => editor.makeFace() },
    { id: 'edit.flip-faces', group: t('app.hotkeys.group.edit'), label: t('app.hotkeys.edit.flip-faces'), keys: 'Ctrl+KeyI', run: () => editor.flipFaces() },
    { id: 'edit.delete', group: t('app.hotkeys.group.edit'), label: t('app.hotkeys.edit.delete'), keys: 'Delete', run: () => pixelsInHand() ? editor.deletePixels() : deleteSelection() },
    // Copying and pasting leave the keys to the system where they have nothing to do.
    // (In the animation mode copying and pasting are the timeline's keys'.)
    { id: 'edit.copy', group: t('app.hotkeys.group.edit'), label: t('app.hotkeys.edit.copy'), keys: 'Ctrl+KeyC', run: () => editor.workspace === 'animation' ? timeline.copyKeys() : pixelsInHand() ? editor.copyPixels() : editor.copyObjects() },
    { id: 'edit.cut', group: t('app.hotkeys.group.edit'), label: t('app.hotkeys.edit.cut'), keys: 'Ctrl+KeyX', run: () => pixelsInHand() && editor.cutPixels() },
    { id: 'edit.paste', group: t('app.hotkeys.group.edit'), label: t('app.hotkeys.edit.paste'), keys: 'Ctrl+KeyV', run: () => editor.workspace === 'animation' ? timeline.pasteKeys() : pixelsInHand() ? editor.pastePixels() : editor.pasteObjects() },
    { id: 'edit.undo', group: t('app.hotkeys.group.edit'), label: t('app.hotkeys.edit.undo'), keys: 'Ctrl+KeyZ', run: () => editor.undo() },
    { id: 'edit.redo', group: t('app.hotkeys.group.edit'), label: t('app.hotkeys.edit.redo'), keys: 'Ctrl+KeyY', run: () => editor.redo() },

    // The selection modes, in the order of their buttons. (An operation that
    // cannot work in a mode has its button off, and its key does nothing.)
    { id: 'mode.object', group: t('app.hotkeys.group.selection-mode'), label: t('app.hotkeys.mode.object'), keys: 'Digit1', run: () => pickMode('object') },
    { id: 'mode.face', group: t('app.hotkeys.group.selection-mode'), label: t('app.hotkeys.mode.face'), keys: 'Digit2', run: () => pickMode('face') },
    { id: 'mode.edge', group: t('app.hotkeys.group.selection-mode'), label: t('app.hotkeys.mode.edge'), keys: 'Digit3', run: () => pickMode('edge') },
    { id: 'mode.vertex', group: t('app.hotkeys.group.selection-mode'), label: t('app.hotkeys.mode.vertex'), keys: 'Digit4', run: () => pickMode('vertex') },
    { id: 'axis.free', group: t('app.hotkeys.group.axis-lock'), label: t('app.hotkeys.axis.free'), keys: 'Shift+Digit1', run: () => editor.setAxisLock('free') },
    { id: 'axis.x', group: t('app.hotkeys.group.axis-lock'), label: t('app.hotkeys.axis.x'), keys: 'Shift+Digit2', run: () => editor.setAxisLock('x') },
    { id: 'axis.y', group: t('app.hotkeys.group.axis-lock'), label: t('app.hotkeys.axis.y'), keys: 'Shift+Digit3', run: () => editor.setAxisLock('y') },
    { id: 'axis.z', group: t('app.hotkeys.group.axis-lock'), label: t('app.hotkeys.axis.z'), keys: 'Shift+Digit4', run: () => editor.setAxisLock('z') },

    { id: 'view.frame', group: t('app.hotkeys.group.view'), label: t('app.hotkeys.view.frame'), keys: 'KeyF', run: () => ACTIONS.frame() },
    { id: 'view.views', group: t('app.hotkeys.group.view'), label: t('app.hotkeys.view.views'), keys: 'KeyB', run: () => ACTIONS['toggle-views']() },
    { id: 'view.uv', group: t('app.hotkeys.group.view'), label: t('app.hotkeys.view.uv'), keys: 'KeyU', run: () => ACTIONS['toggle-uv']() },
    { id: 'view.local', group: t('app.hotkeys.group.view'), label: t('app.hotkeys.view.local'), keys: 'KeyL', run: () => ACTIONS['toggle-local']() },
    { id: 'view.preview', group: t('app.hotkeys.group.view'), label: t('app.hotkeys.view.preview'), keys: 'KeyH', run: () => ACTIONS['toggle-preview']() },
    { id: 'view.focus', group: t('app.hotkeys.group.view'), label: t('app.hotkeys.view.focus'), keys: 'KeyT', run: () => ACTIONS['toggle-focus']() },
    { id: 'view.light', group: t('app.hotkeys.group.view'), label: t('app.hotkeys.view.light'), keys: '', run: () => ACTIONS['toggle-light']() },
    { id: 'view.orientation', group: t('app.hotkeys.group.view'), label: t('app.hotkeys.view.orientation'), keys: 'KeyN', run: () => ACTIONS['toggle-orientation']() },
    { id: 'view.settings', group: t('app.hotkeys.group.view'), label: t('app.hotkeys.view.settings'), keys: 'Ctrl+Comma', run: () => openSettings() },
  ],
  // The fixed keys below can't be given to anything else.
  ['Escape', 'Tab', 'Shift+Tab', 'Space', 'Enter', 'NumpadEnter', 'Backspace', 'PageUp', 'PageDown', 'Ctrl+Shift+KeyZ', 'F1'],
);

// Keys with a fixed meaning; they are listed in the settings, not rebound.
// The marquee in hand (see Editor.setMarquee()): Delete, copy, cut and
// paste are the atlas' pixels', not the model's.
const pixelsInHand = () => editor.tool === 'marquee';
// In the collision mode Delete takes the picked shape away; the model is not changed there.
// In the animation mode it takes the picked keys away.
const deleteSelection = () => (editor.collisions ? collisionMode.deleteKey() : editor.workspace === 'animation' ? timeline.deleteKeys() : editor.deleteSelection());

const FIXED_KEYS = {
  // The polygon tool's own keys; they do nothing outside it. (And the
  // marquee's: what floats is put down.)
  // And in the animation mode, play and pause.
  Enter: () => (editor.workspace === 'animation' ? timeline.play() : editor.commitFloating() || editor.closePolygon()),
  NumpadEnter: () => (editor.workspace === 'animation' ? timeline.play() : editor.commitFloating() || editor.closePolygon()),
  Backspace: () => editor.undoPolygonPoint(),
  PageUp: () => editor.shiftPolygonPlane(1),
  PageDown: () => editor.shiftPolygonPlane(-1),
  Escape: () =>
    (simulation.running ? (simulation.stop(), true) : false) ||
    (posePreview.on ? (posePreview.toggle(false), true) : false) ||
    editor.cancelFloating() ||
    (editor.marquee ? (editor.setMarquee(null), true) : false) ||
    orthoViews.cancelBox() ||
    editor.cancelBox() ||
    editor.escapeOperation() ||
    (editor.workspace !== 'model' ? (editor.setWorkspace('model'), true) : false) ||
    editor.cancelDrag() ||
    editor.clearSelection(),
  'Ctrl+Shift+KeyZ': () => editor.redo(),
};
const FIXED_KEY_NOTES = [
  ['Esc', t('app.hotkeys.fixed.esc')],
  ['Tab / Shift+Tab', t('app.hotkeys.fixed.tab')],
  [t('app.hotkeys.fixed.space-rmb.keys'), t('app.hotkeys.fixed.space-rmb')],
  ['Enter', t('app.hotkeys.fixed.enter')],
  ['Backspace', t('app.hotkeys.fixed.backspace')],
  ['PgUp / PgDn', t('app.hotkeys.fixed.page')],
  ['Ctrl+Shift+Z', t('app.hotkeys.fixed.redo')],
  [t('app.hotkeys.fixed.ctrl.keys'), t('app.hotkeys.fixed.ctrl')],
  [t('app.hotkeys.fixed.shift.keys'), t('app.hotkeys.fixed.shift')],
  [t('app.hotkeys.fixed.alt.keys'), t('app.hotkeys.fixed.alt')],
  [t('app.hotkeys.fixed.f1.keys'), t('app.hotkeys.fixed.f1')],
  [t('app.hotkeys.fixed.alt-wheel.keys'), t('app.hotkeys.fixed.alt-wheel')],
  [t('app.hotkeys.fixed.ctrl-alt.keys'), t('app.hotkeys.fixed.ctrl-alt')],
  [t('app.hotkeys.fixed.xcz.keys'), t('app.hotkeys.fixed.xcz')],
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

// The skin (see skin.js): the vertices selected bound to a node, smoothed, let go.
// Each says what it did (a toast): in the model workspace a skin shows
// nothing - it bends only as its nodes are posed, in the animation one.
const vertexCount = (count) => t('app.skin.vertices', { count });
$('skin-bind').addEventListener('click', () => {
  const id = Number($('skin-node').value);
  const count = editor.selection.size;
  const node = editor.mesh.objects.find((object) => object.id === id)?.name;
  if (id && bindToNode(editor, id)) toast(t('app.skin.toast.bound', { count, node }), { icon: 'fa-link' });
});
// The weight of the node chosen, set on the selected vertices.
const skinWeight = () => {
  const value = parseFloat($('skin-weight-value').value.replace(',', '.'));
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
};
const applySkinWeight = () => {
  const id = Number($('skin-node').value);
  const weight = skinWeight();
  const node = editor.mesh.objects.find((object) => object.id === id)?.name;
  const count = editor.selection.size;
  if (!id || weight === null) return;
  const done = setWeight(editor, id, weight);
  if (!done) return;
  const set = count - done.stuck;
  const stuck = t('app.skin.weight.stuck', { count: done.stuck });
  if (!done.stuck) toast(t('app.skin.toast.weight', { weight, node, vertices: vertexCount(count) }), { icon: 'fa-weight-hanging' });
  else if (set === 0) toast(t('app.skin.toast.weight-unchanged', { stuck }), { icon: 'fa-triangle-exclamation', tone: 'warn' });
  else toast(t('app.skin.toast.weight-partial', { weight, node, vertices: vertexCount(set), stuck }), { icon: 'fa-weight-hanging' });
};
$('skin-weight-set').addEventListener('click', applySkinWeight);
$('skin-weight-value').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  applySkinWeight();
  event.target.blur();
});
scrubbable($('skin-weight-value'), {
  read: () => skinWeight() ?? 1,
  write: (value) => { $('skin-weight-value').value = value; },
  min: 0,
  max: 1,
  step: 0.05,
});
$('skin-weight-set').addEventListener('mousedown', (event) => event.preventDefault());
$('skin-auto').addEventListener('click', () => {
  const count = autoWeights(editor);
  if (count) toast(t('app.skin.toast.auto', { vertices: vertexCount(count) }), { icon: 'fa-wand-magic-sparkles' });
});
$('skin-auto').addEventListener('mousedown', (event) => event.preventDefault());
$('skin-pose').addEventListener('click', () => posePreview.toggle());
$('skin-pose').addEventListener('mousedown', (event) => event.preventDefault());
$('skin-smooth').addEventListener('click', () => {
  const count = editor.selection.size;
  if (smoothWeights(editor)) toast(t('app.skin.toast.smoothed', { vertices: vertexCount(count) }), { icon: 'fa-wave-square' });
});
$('skin-unbind').addEventListener('click', () => {
  const count = editor.selection.size;
  if (unbind(editor)) toast(t('app.skin.toast.unbound', { count }), { icon: 'fa-link-slash' });
});
$('skin-node').addEventListener('change', (event) => event.target.blur());
for (const id of ['skin-bind', 'skin-smooth', 'skin-unbind']) $(id).addEventListener('mousedown', (event) => event.preventDefault()); // keep the keyboard focus

// The objects' properties (see refresh()): of every object the selection is in.
$('back-faces').addEventListener('change', (event) => {
  editor.setBackFaces(editor.objectsInHand(), event.target.checked);
  event.target.blur(); // the keyboard back to the shortcuts
});
// Smoothing: on with the angle in the field (or the usual one), off; the
// angle is taken when the field is left or Enter is pressed.
const SMOOTH_ANGLE = 60; // degrees: an eight-sided cylinder comes out round, a cube's corners stay sharp
$('smooth-shading').addEventListener('change', (event) => {
  const angle = parseFloat($('smooth-angle').value);
  editor.setSmoothing(editor.objectsInHand(), event.target.checked ? (angle > 0 ? angle : SMOOTH_ANGLE) : null);
  event.target.blur();
});
$('smooth-angle').addEventListener('change', (event) => {
  const angle = parseFloat(event.target.value.replace(',', '.'));
  if (angle > 0) editor.setSmoothing(editor.objectsInHand(), angle);
  else refresh(); // not an angle: the one there was comes back
});
// Its handle, like every number field's: dragged up and down, a degree a
// step; the whole drag is one undo step.
{
  let beforeScrub = null;
  scrubbable($('smooth-angle'), {
    read: () => parseFloat($('smooth-angle').value.replace(',', '.')),
    write: (angle) => {
      $('smooth-angle').value = angle;
      editor.setSmoothing(editor.objectsInHand(), angle, false);
    },
    begin: () => { beforeScrub = editor.snapshot(); },
    end: () => editor.commitSmoothing(beforeScrub),
    whole: true,
    min: 1,
    max: 180,
  });
}

// The painting tools (see Editor.paintPress()). Their colour, and whether
// shapes are drawn whole, are the user's from one launch to the next.
const PAINT_COLOR_KEY = 'vertex.paintColor';
const hexOf = (color) => `#${color.slice(0, 3).map((value) => value.toString(16).padStart(2, '0')).join('')}`;
const colorOf = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).concat(255);
const SHAPE_FILL_KEY = 'vertex.shapeFilled';
editor.setShapeFilled(localStorage.getItem(SHAPE_FILL_KEY) === '1');

// The shapes are one button: it shows the shape last taken, and a press on
// it takes that shape in hand and opens the row of them all - the rectangle
// and the ellipse, each in outline and filled - to take another from.
const SHAPE_KEY = 'vertex.shape';
let shape = localStorage.getItem(SHAPE_KEY) === 'ellipse' ? 'ellipse' : 'rect'; // the one the button stands for
const shapeFlyout = document.querySelector('#shape-tools .tool-flyout');
const openShapes = (open) => {
  shapeFlyout.hidden = !open;
};
$('shape-tool').addEventListener('mousedown', (event) => event.preventDefault()); // keep the keyboard focus
$('shape-tool').addEventListener('click', () => {
  editor.setTool(shape);
  openShapes(shapeFlyout.hidden);
});
for (const button of shapeFlyout.querySelectorAll('button')) {
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => {
    editor.setShapeFilled(button.dataset.filled === '1');
    editor.setTool(button.dataset.shape);
    openShapes(false);
  });
}
// A press anywhere else closes the row, and so does Esc.
window.addEventListener('pointerdown', (event) => {
  if (!shapeFlyout.hidden && !$('shape-tools').contains(event.target)) openShapes(false);
}, true);
window.addEventListener('keydown', (event) => {
  if (event.code !== 'Escape' || shapeFlyout.hidden) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  openShapes(false);
}, true);
if (/^#[0-9a-f]{6}$/.test(localStorage.getItem(PAINT_COLOR_KEY) ?? '')) editor.setPaintColor(colorOf(localStorage.getItem(PAINT_COLOR_KEY)));
const colorPopup = new ColorPopup({
  button: $('paint-color'),
  popup: $('color-popup'),
  editor,
  alert: tell,
});
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

// The rotation panel: how the object or node has been turned, in degrees; a
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
// The language: kept for the next start (the words are put in as the page starts).
for (const { id, name } of languages) $('language').add(new Option(name, id));
$('language').value = locale;
$('language').addEventListener('change', (event) => {
  window.vertex.locale.set(event.target.value);
  $('language-note').hidden = event.target.value === locale;
});

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
      control.output.textContent = t('app.grid.step', { step: COARSE_LABELS[index] });
    } else {
      control.slider.value = fineDivisor;
      control.value.textContent = `÷${fineDivisor}`;
      control.output.textContent = t('app.grid.fine', { divisor: fineDivisor, step: +(step / fineDivisor).toFixed(5) });
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
    label: (value) => (value === 0 ? t('app.settings.zoom.instant') : String(value)),
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
    keys.textContent = capturingHotkey === binding.id ? t('app.settings.hotkeys.capturing') : hotkeys.label(binding.id);
    keys.classList.toggle('capturing', capturingHotkey === binding.id);
    keys.classList.toggle('unset', !hotkeys.keysOf(binding.id));
    keys.title = t('app.settings.hotkeys.keys-title');
    keys.addEventListener('click', () => {
      capturingHotkey = capturingHotkey === binding.id ? null : binding.id;
      showHotkeyList();
    });
    const reset = document.createElement('button');
    reset.className = 'hotkey-reset';
    reset.innerHTML = '<i class="fa-solid fa-rotate-left"></i>';
    reset.title = t('app.settings.hotkeys.reset-title', { keys: comboLabel(binding.keys) });
    reset.disabled = !hotkeys.isCustom(binding.id);
    reset.addEventListener('click', () => {
      capturingHotkey = null;
      hotkeys.reset(binding.id);
    });
    row.append(label, keys, reset);
    list.append(row);
  }
  heading(t('app.settings.hotkeys.fixed-heading'));
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
    showHotkeyList(t('app.settings.hotkeys.fixed-key', { keys: comboLabel(combo) }));
  } else if (loser) {
    showHotkeyList(t('app.settings.hotkeys.taken', { keys: comboLabel(combo), action: loser.label }));
  }
}, true);
$('hotkeys-reset').addEventListener('click', () => {
  capturingHotkey = null;
  hotkeys.resetAll();
});

// Buttons name their keys in their tooltips; the keys there follow the settings.
const HOTKEY_TITLES = {
  '[data-tool="select"]': 'tool.select', '[data-tool="move"]': 'tool.move', '[data-tool="rotate"]': 'tool.rotate',
  '[data-tool="scale"]': 'tool.scale', '[data-tool="pivot"]': 'tool.pivot', '[data-tool="paint"]': 'tool.paint',
  '[data-tool="pipette"]': 'tool.pipette', '[data-tool="fill"]': 'tool.fill', '[data-tool="marquee"]': 'tool.marquee',
  '[data-shape="rect"][data-filled="0"]': 'tool.rect', '[data-shape="ellipse"][data-filled="0"]': 'tool.ellipse',
  '#undo-button': 'edit.undo', '#redo-button': 'edit.redo',
  '#place-toggle': 'op.place', '#cut-toggle': 'op.cut', '#extrude-toggle': 'op.extrude', '#polygon-toggle': 'op.polygon', '#pencil-toggle': 'op.pencil', '#collision-button': 'op.collisions', '#animation-button': 'op.animation',
  '[data-action="make-face"]': 'edit.make-face', '[data-action="flip-faces"]': 'edit.flip-faces', '[data-action="delete"]': 'edit.delete',
  '[data-action="frame"]': 'view.frame', '[data-action="toggle-views"]': 'view.views', '[data-action="toggle-uv"]': 'view.uv', '#preview-button': 'view.preview', '#focus-button': 'view.focus', '#light-button': 'view.light',
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

const OPERATION_NAMES = { place: t('app.operation.place'), cut: t('app.operation.cut'), extrude: t('app.operation.extrude'), polygon: t('app.operation.polygon'), pencil: t('app.operation.pencil') };
$('operation-close').addEventListener('click', () => editor.setOperation(null));
$('operation-banner').addEventListener('mousedown', (event) => event.preventDefault()); // keep the keyboard focus

// --- the mirror (top bar) ------------------------------------------------------

const mirrorDisplay = new MirrorDisplay(viewport, editor);
const PARTS = { 0: t('app.mirror.off'), 1: t('app.mirror.parts', { count: 2 }), 2: t('app.mirror.parts', { count: 4 }), 3: t('app.mirror.parts', { count: 8 }) };
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
    : t('app.mirror.not-one');
  $('mirror-toggle').classList.toggle('active', editor.mirror.active()); // any mirror, anywhere
  $('mirror-toggle').title = globalAxes.size
    ? t('app.mirror.title.global', { axes: [...globalAxes].map((a) => a.toUpperCase()).join(', ') })
    : localAxes.length
      ? t('app.mirror.title.local', { name: object.name, axes: localAxes.map((a) => a.toUpperCase()).join(', ') })
      : t('app.mirror.title.off');
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

// The light preview (see Viewport.setLit()); kept between runs.
const LIGHT_KEY = 'vertex.light';
function setLit(on) {
  editor.setLit(on);
  localStorage.setItem(LIGHT_KEY, on ? '1' : '0');
}
editor.setLit(localStorage.getItem(LIGHT_KEY) === '1');

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

// A selection mode by its key: as by its button, which is off for a mode the
// operation in progress cannot work in.
function pickMode(mode) {
  if (editor.operation && !OPERATION_MODES[editor.operation].includes(mode)) return false;
  editor.setMode(mode);
  return true;
}

// A new project is asked about first: how it is textured. Resolves to the
// options for Editor.newProject(), or to null if the user thinks better of it.
const NEW_PPU_KEY = 'vertex.newProjectPPU';
// The pixels per unit are the one atlas': with several, each is given its
// own when it is made (see openAtlasPopup()) - the field is off then.
function showNewProjectPPU() {
  const multi = $('new-project-dialog').querySelector('[name="atlases"]:checked').value === 'multi';
  const field = $('new-project-dialog').querySelector('.ppu-label').closest('.field');
  field.classList.toggle('off', multi);
  const input = field.querySelector('input');
  input.disabled = multi;
  if (multi) input.setSelectionRange(0, 0); // (not shown picked while off)
}
for (const radio of $('new-project-dialog').querySelectorAll('[name="atlases"]')) radio.addEventListener('change', showNewProjectPPU);
// A card is chosen by a press anywhere on it - its field too, when that is off.
for (const card of $('new-project-dialog').querySelectorAll('.choice-card')) {
  card.addEventListener('click', (event) => {
    const radio = card.querySelector('[type="radio"]');
    if (radio.checked) return;
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
  });
}
{
  const field = $('new-project-dialog').querySelector('form').elements.ppu;
  scrubbable(field, { read: () => parseInt(field.value, 10), write: (value) => { field.value = value; }, whole: true, min: 1, max: 128 });
}
function askNewProject() {
  const dialog = $('new-project-dialog');
  const form = dialog.querySelector('form');
  form.elements.ppu.value = parseInt(localStorage.getItem(NEW_PPU_KEY), 10) || 16;
  showNewProjectPPU();
  dialog.hidden = false;
  form.elements.ppu.focus();
  form.elements.ppu.select();
  return new Promise((resolve) => {
    const done = (options) => {
      dialog.hidden = true;
      form.removeEventListener('submit', submit);
      form.querySelector('[data-cancel]').removeEventListener('click', cancel);
      window.removeEventListener('keydown', escape, true);
      resolve(options);
    };
    const submit = (event) => {
      event.preventDefault();
      const ppu = parseInt(form.elements.ppu.value, 10);
      if (form.elements.atlases.value === 'multi') {
        done({ multiAtlas: true });
        return;
      }
      if (!(ppu >= 1 && ppu <= 128)) {
        form.elements.ppu.focus();
        form.elements.ppu.select();
        return;
      }
      localStorage.setItem(NEW_PPU_KEY, ppu);
      done({ ppu, multiAtlas: form.elements.atlases.value === 'multi' });
    };
    const cancel = () => done(null);
    const escape = (event) => {
      // The dialog owns the keyboard while it is open: the editor's shortcuts
      // do not hear it, the form itself does (typing, Tab, Enter).
      event.stopImmediatePropagation();
      if (event.code !== 'Escape') return;
      event.preventDefault();
      cancel();
    };
    form.addEventListener('submit', submit);
    form.querySelector('[data-cancel]').addEventListener('click', cancel);
    window.addEventListener('keydown', escape, true);
  });
}

window.addEventListener('keydown', (event) => {
  // The settings dialog owns the keyboard while it is open.
  if (!$('settings-dialog').hidden) {
    if (event.code === 'Escape' && !capturingHotkey) closeSettings();
    return;
  }
  // On the welcome screen there is no project to work on yet: of the
  // shortcuts, only those that get one, and the settings.
  if (welcome.open) {
    hotkeys.handle(event, WELCOME_HOTKEYS);
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
    // through the modes it works in. In the cut, which works in one mode
    // only, Tab turns the cut the other way instead.
    event.preventDefault();
    if (editor.operation === 'cut') {
      editor.setCutDirection(editor.cutDirection === 'vertical' ? 'horizontal' : 'vertical');
      return;
    }
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
for (const id of ['toolbar', 'modes', 'history-actions', 'top-actions', 'shading', 'focus-button', 'preview-button']) {
  $(id).addEventListener('mousedown', (event) => event.preventDefault());
}
for (const control of gridControls) {
  control.button.addEventListener('mousedown', (event) => event.preventDefault());
}

window.vertex?.onMenu((action) => {
  if (welcome.open && !WELCOME_ACTIONS.includes(action)) return;
  ACTIONS[action]?.();
});

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
// (Its questions and messages in the program's own dialogs, see ask-dialog.js.)
const project = new Project(editor, window.vertex?.project && { ...window.vertex.project, confirm: askSave, alert: tell });
// On the welcome screen no project is open yet: the program's name alone.
const showProject = () => {
  document.title = $('welcome').hidden ? `${project.dirty ? '● ' : ''}${project.name} — verTEX` : 'verTEX';
};
project.addEventListener('change', showProject);
project.addEventListener('saved', () => toast(t('app.project.saved', { name: project.name })));
new MutationObserver(showProject).observe($('welcome'), { attributes: true, attributeFilter: ['hidden'] });
showProject();

project.ask = askNewProject;
// The picture of the model kept in the project's file, for the welcome screen.
project.picture = () => {
  const planes = mirrorDisplay.group.visible; // the mirror's planes are the editor's, not the model's
  mirrorDisplay.group.visible = false;
  const canvas = editor.picture(480, 300);
  mirrorDisplay.group.visible = planes;
  return new Promise((resolve) => {
    canvas.toBlob(async (blob) => resolve(blob ? new Uint8Array(await blob.arrayBuffer()) : null), 'image/png');
  });
};

// Asks how the model is to be exported: gives { scale, extrude } - how many
// times its size the model is to be in the file (see scaledModel()), and
// whether the atlas' picture goes out with its pieces carried outwards, see
// Atlas.extruded() - or null if the user thinks better of it. The answers
// are remembered for the next time.
const EXPORT_EXTRUDE_KEY = 'vertex.exportExtrude';
const EXPORT_SCALE_KEY = 'vertex.exportScale';
const EXTRUDE_DEPTH = 4; // pixels
function askExport(title) {
  const dialog = $('export-dialog');
  const form = dialog.querySelector('form');
  dialog.querySelector('h2').textContent = title;
  form.elements.extrude.checked = localStorage.getItem(EXPORT_EXTRUDE_KEY) === '1';
  form.elements.scale.value = Number(localStorage.getItem(EXPORT_SCALE_KEY)) > 0 ? localStorage.getItem(EXPORT_SCALE_KEY) : '1';
  dialog.hidden = false;
  form.querySelector('[type=submit]').focus();
  return new Promise((resolve) => {
    const done = (options) => {
      dialog.hidden = true;
      form.removeEventListener('submit', submit);
      form.querySelector('[data-cancel]').removeEventListener('click', cancel);
      window.removeEventListener('keydown', escape, true);
      resolve(options);
    };
    const submit = (event) => {
      event.preventDefault();
      // (A comma for the point, as it is written here.)
      const scale = Number(form.elements.scale.value.trim().replace(',', '.'));
      if (!(scale >= 0.001 && scale <= 1000)) {
        form.elements.scale.focus();
        form.elements.scale.select();
        return;
      }
      const extrude = form.elements.extrude.checked;
      localStorage.setItem(EXPORT_EXTRUDE_KEY, extrude ? '1' : '0');
      localStorage.setItem(EXPORT_SCALE_KEY, String(scale));
      done({ scale, extrude });
    };
    const cancel = () => done(null);
    const escape = (event) => {
      // As in askNewProject(): the dialog owns the keyboard while it is open.
      event.stopImmediatePropagation();
      if (event.code !== 'Escape') return;
      event.preventDefault();
      cancel();
    };
    form.addEventListener('submit', submit);
    form.querySelector('[data-cancel]').addEventListener('click', cancel);
    window.addEventListener('keydown', escape, true);
  });
}

// File -> Export to glTF: one file with the atlas' picture in it, a .glb
// or - if the user picks that - a .gltf (see gltf.js). (glTF only: it is
// what Godot reads best.)
const EXPORTS = {
  gltf: {
    title: t('app.export.gltf.title'),
    kinds: [{ name: t('app.export.gltf.glb'), extension: 'glb' }, { name: t('app.export.gltf.text'), extension: 'gltf' }],
  },
};
let exporting = false;
async function exportModel(format) {
  const api = window.vertex?.export;
  if (!api) {
    await tell(t('app.export.restart'));
    return;
  }
  if (exporting || editor.busy()) return;
  exporting = true;
  try {
    const model = modelOf(editor);
    const hidden = (object) => Boolean(object) && (Boolean(object.hidden) || hidden(model.objects.find((other) => other.id === object.parent)));
    const meshes = model.objects.filter((object) => object.kind !== 'node' && !hidden(object));
    if (!model.faces.some((face) => meshes.some((object) => object.id === model.vertexObject[face[0]]))) {
      await tell(t('app.export.nothing'), t('app.export.nothing.detail'));
      return;
    }
    const options = await askExport(EXPORTS[format].title);
    if (!options) return;
    const target = await api.pick(project.name, EXPORTS[format].kinds);
    if (!target) return;
    // Every atlas' picture that a visible object is on - its edges grown out
    // past its faces' pieces (`extrude`), each atlas by its own faces.
    const { mesh } = editor;
    const pictures = new Map();
    for (const id of new Set(meshes.map((object) => object.atlas).filter(Boolean))) {
      const atlas = editor.atlasById(id);
      if (!atlas) continue;
      const owners = new Set(mesh.objects.filter((object) => object.atlas === id).map((object) => object.id));
      const places = mesh.faces.filter((face) => face.uv?.every(Boolean) && owners.has(mesh.vertexObject[face[0]])).map((face) => face.uv);
      pictures.set(id, await atlas.png(options.extrude ? atlas.extruded(places, EXTRUDE_DEPTH) : atlas.canvas));
    }
    const sized = options.scale === 1 ? model : scaledModel(model, options.scale);
    const triangles = (face) => mesh.triangulate(face);
    const result = await api.write(target.path, gltfOf(sized, { name: target.name, triangles, pictures, binary: target.extension === 'glb' }));
    if (result.error) await tell(t('app.export.failed'), result.error);
  } finally {
    exporting = false;
  }
}

// The welcome screen, up until a project is made or opened; meanwhile the
// menu and the keyboard do only what makes sense without one.
const WELCOME_ACTIONS = ['project-new', 'project-open', 'project-close', 'new', 'settings'];
const WELCOME_HOTKEYS = ['file.new', 'file.open', 'view.settings'];
const welcome = new Welcome($('welcome'), project, window.vertex?.recent);
project.addEventListener('closed', () => {
  if (renderMode.open) renderMode.close();
});

// The sprite render: the model into a PNG sprite sheet (see render-mode.js),
// written where the user says, as an export is.
const renderMode = new RenderMode($('render-mode'), editor, {
  pick: window.vertex?.export?.pick,
  write: window.vertex?.export?.write,
  name: () => project.name,
  alert: tell,
});

// Texturing: the atlas as a file beside the project, painted in another program.

// The settings' external editor: the program the atlas' picture is opened in.
{
  const input = $('external-editor');
  const set = (program) => {
    program = program.trim().replace(/^"(.*)"$/, '$1'); // a path pasted with its quotes
    input.value = program;
    if (program) localStorage.setItem(EXTERNAL_EDITOR_KEY, program);
    else localStorage.removeItem(EXTERNAL_EDITOR_KEY);
  };
  input.value = localStorage.getItem(EXTERNAL_EDITOR_KEY) ?? '';
  input.addEventListener('change', () => set(input.value));
  $('external-editor-clear').addEventListener('click', () => set(''));
  $('external-editor-pick').addEventListener('click', async () => {
    const program = await window.vertex?.atlas?.pickProgram?.();
    if (program) set(program);
  });
}
const atlasLink = new AtlasLink(editor, project, window.vertex?.atlas);

// --- the atlases (a project made with several, see Editor.atlases) ------------------

// The texture section: one atlas' figures - or, with several, a row for each
// (the one worked on marked: a click on another makes it so; a double click
// on its name renames it), a button for another, and the pixels per unit of
// the one worked on to be set. The UV editor's choice of atlas with them.
function showAtlases() {
  const multi = editor.multiAtlas;
  const { atlas } = editor;
  // (with several, there may be none yet: the list and its button alone)
  const none = atlas === editor.noAtlas;
  $('ppu-line').hidden = multi; // (with several, each row says its own - given when it is made)
  $('atlas-size').closest('.texture-line').hidden = none;
  for (const id of ['atlas-open', 'atlas-reveal', 'atlas-repack']) $(id).disabled = none;
  $('ppu-value').textContent = atlas.ppu;
  $('atlas-size').textContent = `${atlas.width} × ${atlas.height}`;
  const list = $('atlas-list');
  list.hidden = !multi;
  const uv = $('uv-atlas');
  uv.hidden = !multi || none;
  $('uv-atlas-new').hidden = !multi;
  if (!multi) return;
  const shown = JSON.stringify([editor.atlasId, editor.atlases.map((one) => [one.id, one.name, one.ppu, one.width, one.height])]);
  if (list.dataset.shown !== shown && !list.querySelector('input')) {
    list.dataset.shown = shown;
    list.replaceChildren(
      ...editor.atlases.map((one) => {
        const row = document.createElement('div');
        row.className = 'atlas-row';
        row.classList.toggle('current', one.id === editor.atlasId);
        row.dataset.atlas = one.id;
        row.title = t('app.atlas.row.title', { name: one.name, ppu: one.ppu, width: one.width, height: one.height });
        const name = document.createElement('span');
        name.className = 'atlas-name';
        name.textContent = one.name;
        const figures = document.createElement('small');
        figures.textContent = `${one.ppu} · ${one.width}×${one.height}`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.dataset.remove = one.id;
        remove.title = t('app.atlas.remove.title');
        remove.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
        remove.disabled = false; // (with several, the last too: the project may have none)
        row.append(name, figures, remove);
        return row;
      }),
      Object.assign(document.createElement('button'), {
        type: 'button',
        className: 'atlas-add',
        title: t('app.atlas.add.title'),
        innerHTML: `<i class="fa-solid fa-plus"></i><span>${t('app.atlas.add.text')}</span>`,
      }),
    );
  }
  // (a button of its own with the value in it, so that a long name is cut short: see select selectedcontent)
  const face = document.createElement('button');
  face.append(document.createElement('selectedcontent'));
  uv.replaceChildren(face, ...editor.atlases.map((one) => new Option(one.name, one.id, false, one.id === editor.atlasId)));
}

$('atlas-list').addEventListener('click', async (event) => {
  if (event.target.closest('input')) return;
  const remove = event.target.closest('[data-remove]');
  if (remove) {
    const atlas = editor.atlasById(remove.dataset.remove);
    const count = editor.mesh.objects.filter((object) => object.atlas === atlas?.id).length;
    const detail = count
      ? t('app.atlas.remove.detail', { count })
      : t('app.atlas.remove.detail-empty');
    if (atlas && (await confirmIt(t('app.atlas.remove.message', { name: atlas.name }), detail, t('app.atlas.remove.confirm')))) editor.removeAtlas(atlas.id);
    return;
  }
  const add = event.target.closest('.atlas-add');
  if (add) {
    openAtlasPopup(add);
    return;
  }
  const row = event.target.closest('.atlas-row');
  if (row) editor.useAtlas(row.dataset.atlas);
});
// A double click on a name: renamed in place - Enter or leaving the field takes it, Esc not.
$('atlas-list').addEventListener('dblclick', (event) => {
  const name = event.target.closest('.atlas-name');
  const row = name?.closest('.atlas-row');
  if (!row || name.tagName === 'INPUT') return;
  const input = document.createElement('input');
  input.className = 'atlas-name';
  input.value = name.textContent;
  input.spellcheck = false;
  latinOnly(input);
  name.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (take) => {
    if (done) return;
    done = true;
    if (take) editor.renameAtlas(row.dataset.atlas, input.value.trim());
    input.remove();
    $('atlas-list').dataset.shown = '';
    showAtlases();
  };
  input.addEventListener('keydown', (key) => {
    key.stopPropagation();
    if (key.key === 'Enter') finish(true);
    if (key.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
});
$('uv-atlas').addEventListener('change', () => editor.useAtlas($('uv-atlas').value));

// "Искажение" (see retro.js, Editor.beginRetro()): a popup by its button,
// the atlas - or the pixels picked - shown made retro as the settings are
// turned (a moment after, not at every step); «Применить» or Enter keeps
// it, «Отмена» or Esc puts the picture back. The settings are kept for the
// next time. Meanwhile the model may be looked at from all sides: a press
// elsewhere leaves the popup open.
const RETRO_KEY = 'vertex.retro';
const retro = {
  popup: $('retro-popup'),
  settings: (() => {
    try {
      return { ...RETRO_DEFAULTS, ...JSON.parse(localStorage.getItem(RETRO_KEY)) };
    } catch {
      return { ...RETRO_DEFAULTS };
    }
  })(),
  auto: 8,
  timer: 0,
};
{
  const { popup } = retro;
  const field = (name) => popup.elements[name];
  const numbers = {
    brightness: [-100, 100, true], contrast: [-100, 100, true], saturation: [-100, 100, true], gamma: [0.2, 5, false],
    noise: [0, 100, true], grain: [1, 16, true], levels: [0, 32, true], strength: [0, 100, true], auto: [2, 64, true],
  };
  const read = (name) => {
    const [min, max, whole] = numbers[name];
    const value = parseFloat(field(name).value);
    if (!Number.isFinite(value)) return null;
    return Math.min(max, Math.max(min, whole ? Math.round(value) : +value.toFixed(2)));
  };
  // The settings from the fields, then shown (a moment later, as they are being turned).
  const take = () => {
    for (const name of Object.keys(numbers)) {
      const value = read(name);
      if (value === null) continue;
      if (name === 'auto') retro.auto = value;
      else retro.settings[name] = value;
    }
    retro.settings.mono = field('mono').checked;
    retro.settings.palette = field('palette').checked;
    retro.settings.dither = field('dither').value;
    try { localStorage.setItem(RETRO_KEY, JSON.stringify(retro.settings)); } catch { /* not kept: fine */ }
    showRetroPalette();
    clearTimeout(retro.timer);
    retro.timer = setTimeout(() => editor.previewRetro(retro.settings), 40);
  };
  const fill = () => {
    for (const name of Object.keys(numbers)) if (document.activeElement !== field(name)) field(name).value = name === 'auto' ? retro.auto : retro.settings[name];
    field('mono').checked = retro.settings.mono;
    field('palette').checked = retro.settings.palette;
    field('dither').value = retro.settings.dither;
    showRetroPalette();
  };
  field('dither').replaceChildren(...Object.entries(DITHERS).map(([value, label]) => new Option(label, value)));
  for (const name of Object.keys(numbers)) {
    const input = field(name);
    const [min, max, whole] = numbers[name];
    scrubbable(input, { read: () => read(name) ?? 0, write: (value) => { input.value = value; take(); }, whole, min, max, step: whole ? 1 : 0.1 });
    input.addEventListener('input', take);
  }
  for (const name of ['mono', 'palette', 'dither']) field(name).addEventListener('change', take);
  // The palette: a preset's colours, the brush's colour added, a colour taken out, or the picture's own found.
  const presets = () => {
    const brush = colorPopup.palette;
    return { ...PALETTES, ...(brush?.colors?.length ? { [t('app.retro.preset.brush', { name: brush.name })]: brush.colors.map((color) => hexOf(color)) } : {}) };
  };
  field('preset').addEventListener('change', () => {
    const colors = presets()[field('preset').value];
    if (colors) {
      retro.settings.colors = [...colors];
      retro.settings.palette = true;
      fill();
      take();
    }
  });
  popup.querySelector('.retro-swatches').addEventListener('click', (event) => {
    const swatch = event.target.closest('[data-color]');
    if (!swatch) return;
    retro.settings.colors.splice(Number(swatch.dataset.color), 1);
    take();
  });
  popup.addEventListener('click', (event) => {
    const button = event.target.closest('[data-retro]');
    if (!button) return;
    const what = button.dataset.retro;
    if (what === 'seed') retro.settings.seed = 1 + Math.floor(Math.random() * 1e6);
    else if (what === 'add-color') {
      const hex = hexOf(editor.paintColor);
      if (!retro.settings.colors.includes(hex)) retro.settings.colors.push(hex);
      retro.settings.palette = true;
    } else if (what === 'auto') {
      retro.settings.colors = editor.retroPalette(retro.auto);
      retro.settings.palette = true;
    } else if (what === 'reset') retro.settings = { ...RETRO_DEFAULTS, colors: [] };
    else if (what === 'cancel') return closeRetro(false);
    else return;
    fill();
    take();
  });
  popup.addEventListener('submit', (event) => {
    event.preventDefault();
    closeRetro(true);
  });
  popup.addEventListener('keydown', (event) => {
    event.stopPropagation(); // (typed figures are not the editor's shortcuts)
    if (event.key === 'Escape') closeRetro(false);
    if (event.key === 'Enter' && event.target.tagName !== 'BUTTON') {
      event.preventDefault();
      closeRetro(true);
    }
  });
  // (Esc and Enter heard anywhere while it is open: it is what is being done)
  window.addEventListener('keydown', (event) => {
    if (popup.hidden || popup.contains(event.target)) return;
    if (event.key === 'Escape' || event.key === 'Enter') {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeRetro(event.key === 'Enter');
    }
  }, true);
  retro.fill = fill;
  retro.take = take;
  retro.presets = presets;
}

function showRetroPalette() {
  const { popup, settings } = retro;
  popup.querySelector('.retro-palette').hidden = !settings.palette;
  popup.elements.levels.closest('.retro-row').classList.toggle('off', settings.palette);
  const preset = popup.elements.preset;
  const names = Object.keys(retro.presets?.() ?? PALETTES);
  const same = names.find((name) => JSON.stringify((retro.presets?.() ?? PALETTES)[name]) === JSON.stringify(settings.colors));
  preset.replaceChildren(new Option(same ? same : settings.colors.length ? t('app.retro.preset.own', { count: settings.colors.length }) : t('app.retro.preset.pick'), '', true, true), ...names.filter((name) => name !== same).map((name) => new Option(name, name)));
  popup.querySelector('.retro-swatches').replaceChildren(...settings.colors.map((color, k) => {
    const swatch = document.createElement('i');
    swatch.className = 'retro-swatch';
    swatch.style.background = color;
    swatch.dataset.color = k;
    swatch.title = t('app.retro.swatch.title', { color });
    return swatch;
  }));
}

function openRetro(anchor) {
  // (what it works on: the pixels picked, else the charts picked in the UV editor, else the whole atlas)
  if (!retro.popup.hidden || !editor.beginRetro(uvEditor.pickedCharts())) return;
  const { popup } = retro;
  const { rect, atlas, scope, charts } = editor.retro;
  popup.querySelector('.retro-scope').textContent = scope === 'marquee'
    ? t('app.retro.scope.selection', { w: rect.w, h: rect.h })
    : scope === 'charts'
      ? charts === 1 ? t('app.retro.scope.chart', { w: rect.w, h: rect.h }) : t('app.retro.scope.charts', { count: charts })
      : t('app.retro.scope.atlas', { name: atlas.name, w: rect.w, h: rect.h });
  popup.hidden = false;
  retro.fill();
  // In the middle of the window (it may be dragged elsewhere by its title, see below).
  const { width, height } = popup.getBoundingClientRect();
  popup.style.left = `${Math.max(6, (window.innerWidth - width) / 2)}px`;
  popup.style.top = `${Math.max(6, (window.innerHeight - height) / 2)}px`;
  editor.previewRetro(retro.settings);
}

function closeRetro(keep) {
  if (retro.popup.hidden) return;
  clearTimeout(retro.timer);
  retro.popup.hidden = true;
  if (keep) {
    editor.previewRetro(retro.settings); // (what is kept is what the settings are now)
    editor.applyRetro();
  } else editor.cancelRetro();
}

uvEditor.onRetro = () => openRetro(document.querySelector('[data-uv="retro"]'));
// Dragged by its grip (as the key popup is, see timeline.js), kept within the window.
{
  const { popup } = retro;
  const title = popup.querySelector('.kp-grip');
  let grab = null;
  title.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const at = popup.getBoundingClientRect();
    grab = { dx: event.clientX - at.left, dy: event.clientY - at.top, pointer: event.pointerId };
    title.setPointerCapture(event.pointerId);
    popup.classList.add('dragging');
    event.preventDefault();
  });
  title.addEventListener('pointermove', (event) => {
    if (!grab) return;
    const { width, height } = popup.getBoundingClientRect();
    popup.style.left = `${Math.min(Math.max(0, event.clientX - grab.dx), window.innerWidth - width)}px`;
    popup.style.top = `${Math.min(Math.max(0, event.clientY - grab.dy), window.innerHeight - Math.min(height, 40))}px`;
  });
  const drop = () => {
    grab = null;
    popup.classList.remove('dragging');
  };
  title.addEventListener('pointerup', drop);
  title.addEventListener('pointercancel', drop);
}

// A new atlas: a popup by the button pressed asks its pixels per unit first
// (the last given, at first) - Enter or «Создать» makes it, Esc or a press
// elsewhere lets it be. Each atlas' pixels are its own: nothing is taken
// from the others.
const NEW_ATLAS_PPU_KEY = 'vertex.newAtlasPPU';
function openAtlasPopup(anchor) {
  const popup = $('atlas-popup');
  const input = popup.elements.name;
  input.value = '';
  popup.elements.ppu.value = parseInt(localStorage.getItem(NEW_ATLAS_PPU_KEY), 10) || 16;
  // (the name a new one would get, shown greyed while none is typed)
  input.placeholder = freeName('atlas', new Set(editor.atlases.map((atlas) => atlas.name)));
  popup.hidden = false;
  // Under the button, or over it where there is no room below; within the window.
  const at = anchor.getBoundingClientRect();
  const { width, height } = popup.getBoundingClientRect();
  const below = at.bottom + 6 + height <= window.innerHeight;
  popup.style.top = `${below ? at.bottom + 6 : at.top - 6 - height}px`;
  popup.style.left = `${Math.max(6, Math.min(at.left, window.innerWidth - width - 6))}px`;
  input.focus();
  input.select();
}
function closeAtlasPopup() {
  const popup = $('atlas-popup');
  if (popup.hidden) return false;
  popup.hidden = true;
  return true;
}
latinOnly($('atlas-popup').elements.name);
{
  const field = $('atlas-popup').elements.ppu;
  scrubbable(field, { read: () => parseInt(field.value, 10), write: (value) => { field.value = value; }, whole: true, min: 1, max: 256 });
}
$('uv-atlas-new').addEventListener('click', () => ($('atlas-popup').hidden ? openAtlasPopup($('uv-atlas-new')) : closeAtlasPopup()));
$('uv-atlas-new').addEventListener('mousedown', (event) => event.preventDefault());
$('atlas-popup').addEventListener('submit', (event) => {
  event.preventDefault();
  const { name, ppu: field } = $('atlas-popup').elements;
  const ppu = parseInt(field.value, 10);
  if (!(ppu >= 1 && ppu <= 256)) {
    field.focus();
    field.select();
    return;
  }
  localStorage.setItem(NEW_ATLAS_PPU_KEY, ppu);
  closeAtlasPopup();
  editor.createAtlas(name.value.trim() || 'atlas', ppu);
});
$('atlas-popup').addEventListener('keydown', (event) => {
  event.stopPropagation(); // (typed figures are not the editor's shortcuts)
  if (event.key === 'Escape') closeAtlasPopup();
  if (event.key === 'Enter') {
    event.preventDefault();
    $('atlas-popup').requestSubmit();
  }
});
window.addEventListener('pointerdown', (event) => {
  if (!event.target.closest?.('#atlas-popup, #uv-atlas-new, .atlas-add')) closeAtlasPopup();
}, true);
$('object-atlas').addEventListener('change', () => {
  const value = $('object-atlas').value;
  if (value !== '*') editor.setObjectsAtlas(editor.objectsInHand(), value || null);
});
// The atlas worked on follows the objects picked - theirs, when they are on
// one - as they are picked: another chosen meanwhile stays.
let handFollowed = '';
editor.addEventListener('change', () => {
  if (!editor.multiAtlas || editor.painting) return;
  const hand = editor.objectsInHand();
  const key = hand.join();
  if (key === handFollowed) return;
  handFollowed = key;
  const ids = new Set(hand.map((index) => editor.mesh.objects[index]?.atlas).filter(Boolean));
  if (ids.size === 1) editor.useAtlas([...ids][0]);
});
$('atlas-open').addEventListener('click', () => atlasLink.open());
$('atlas-reveal').addEventListener('click', () => atlasLink.reveal());
$('atlas-repack').addEventListener('click', async () => {
  if (await confirmIt(t('app.atlas.repack.message'), t('app.atlas.repack.detail'), t('app.atlas.repack.confirm'))) editor.repackAtlas();
});
for (const id of ['atlas-open', 'atlas-reveal', 'atlas-repack']) {
  $(id).addEventListener('mousedown', (event) => event.preventDefault()); // keep the keyboard focus
}

window.vertexDebug = { uv: uvEditor, atlasLink, warnings, text: () => editor.toText(), views: orthoViews, project, files: () => projectFiles(editor), editor, timeline, animationMode, renderMode };

// The bottom panel's height, as a share of the workspace (see setViewsSize()).
const VIEWS_SIZE_KEY = 'vertex.orthoViewsSize';
const VIEWS_SIZE_DEFAULT = 0.4;
const ANIM_SPLIT_KEY = 'vertex.animViewsShare'; // of the bottom panel's room, the three views'
const VIEWS_MIN_HEIGHT = 120; // px
const MAIN_VIEW_MIN_HEIGHT = 150; // px left to the main view
// The three-view panel; whether it is open is remembered between launches.
// The bottom of the workspace holds one panel at a time: the three views
// ('views'), the UV editor ('uv'), or none (null). Which is remembered
// between launches.
const VIEWS_OPEN_KEY = 'vertex.orthoViewsOpen';
const BOTTOM_PANEL_KEY = 'vertex.bottomPanel';
function setBottomPanel(panel) {
  // In the animation mode the three views come over the timeline, which stays.
  const both = panel === 'views' && editor.workspace === 'animation';
  orthoViews.toggle(panel === 'views');
  uvEditor.toggle(panel === 'uv');
  timeline.toggle(panel === 'animation' || both);
  $('anim-splitter').hidden = !both;
  setViewsSize(parseFloat(localStorage.getItem(VIEWS_SIZE_KEY)) || VIEWS_SIZE_DEFAULT);
  editor.setUVLook(panel === 'uv');
  $('views-splitter').hidden = !panel;
  document.querySelector('[data-action="toggle-views"]').classList.toggle('active', panel === 'views');
  document.querySelector('[data-action="toggle-uv"]').classList.toggle('active', panel === 'uv');
  // The timeline comes and goes with its mode: it is not what the next start opens.
  if (panel === 'animation' || both) return;
  localStorage.setItem(VIEWS_OPEN_KEY, panel === 'views' ? '1' : '0');
  localStorage.setItem(BOTTOM_PANEL_KEY, panel ?? '');
}
// The bottom panel when the views or the UV editor are closed: none, or in
// the animation mode its timeline.
const restingPanel = () => (editor.workspace === 'animation' ? 'animation' : null);
// The animation mode opens its timeline, and gives back the panel that was
// there when it is left.
{
  let workspace = editor.workspace;
  let before = null;
  editor.addEventListener('change', () => {
    if (editor.workspace === workspace) return;
    if (editor.workspace === 'animation') {
      before = orthoViews.open ? 'views' : uvEditor.open ? 'uv' : null;
      setBottomPanel(before === 'views' ? 'views' : 'animation'); // (the views stay, over the timeline)
    } else if (workspace === 'animation') {
      setBottomPanel(before);
    }
    workspace = editor.workspace;
  });
}
{
  const saved = localStorage.getItem(BOTTOM_PANEL_KEY);
  setBottomPanel(saved === 'uv' ? 'uv' : saved === 'views' || (saved === null && localStorage.getItem(VIEWS_OPEN_KEY) === '1') ? 'views' : null);
}

// The panel's height is changed by dragging its top edge. It is kept as a
// share of the workspace, so it scales with the window.
function setViewsSize(share) {
  const height = $('workspace').clientHeight;
  const min = VIEWS_MIN_HEIGHT / height;
  const max = Math.max(min, 1 - MAIN_VIEW_MIN_HEIGHT / height);
  share = Math.min(Math.max(share, min), max);
  // (The three views over the timeline: the room shared between them, see the splitter between.)
  const both = !$('anim-splitter').hidden;
  const part = Math.min(0.85, Math.max(0.15, parseFloat(localStorage.getItem(ANIM_SPLIT_KEY)) || 0.5));
  $('ortho-views').style.flexBasis = `${share * (both ? part : 1) * 100}%`;
  $('uv-editor').style.flexBasis = `${share * 100}%`;
  $('timeline').style.flexBasis = `${share * (both ? 1 - part : 1) * 100}%`;
  localStorage.setItem(VIEWS_SIZE_KEY, share);
}
{
  const splitter = $('anim-splitter');
  const follow = (event) => {
    const top = $('ortho-views').getBoundingClientRect().top;
    const bottom = $('timeline').getBoundingClientRect().bottom;
    localStorage.setItem(ANIM_SPLIT_KEY, Math.min(0.85, Math.max(0.15, (event.clientY - top) / (bottom - top))));
    setViewsSize(parseFloat(localStorage.getItem(VIEWS_SIZE_KEY)) || VIEWS_SIZE_DEFAULT);
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
  splitter.addEventListener('dblclick', () => {
    localStorage.setItem(ANIM_SPLIT_KEY, 0.5);
    setViewsSize(parseFloat(localStorage.getItem(VIEWS_SIZE_KEY)) || VIEWS_SIZE_DEFAULT);
  });
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
  for (const id of ['dimensions', 'properties', 'rotation', 'object-props', 'skin-panel']) {
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
      header.title = folded.includes(id) ? t('app.panel.unfold') : t('app.panel.fold');
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

// The skin panel (see skin.js): with something selected and nodes to bend
// with. The node offered is the one the selection bends with most - or the
// one picked last - and under it what the selection bends with now.
function showSkin() {
  const nodes = editor.mesh.objects.filter((object) => object.kind === 'node');
  const panel = $('skin-panel');
  panel.hidden = (editor.selection.size === 0 && !editor.posePreview) || nodes.length === 0;
  if (panel.hidden) return;
  const summary = skinSummary(editor);
  const select = $('skin-node');
  const chosen = Number(select.value);
  const names = nodes.map((node) => `${node.id}:${node.name}`).join('|');
  if (select.dataset.names !== names) {
    select.dataset.names = names;
    select.replaceChildren(...nodes.map((node) => new Option(node.name, node.id)));
  }
  // (another selection: the node of the skin row it was picked by, or the
  // one it bends with most, offered; the same: the one picked kept)
  const vertices = [...editor.selection];
  const key = `${vertices.length}:${Math.min(...vertices)}:${Math.max(...vertices)}`;
  const kept = select.dataset.selection === key && nodes.some((node) => node.id === chosen);
  const focus = editor.mode === 'vertex' ? editor.skinFocus?.node : null;
  select.value = kept ? chosen : focus ?? summary.nodes[0]?.id ?? nodes[0].id;
  select.dataset.selection = key;
  // The weight field: the selection's mean weight to that node.
  if (document.activeElement !== $('skin-weight-value')) {
    const share = summary.nodes.find((entry) => entry.id === Number(select.value))?.share ?? 0;
    $('skin-weight-value').value = +share.toFixed(2);
  }
  const parts = summary.nodes.slice(0, 3).map(({ name, share }) => `${name} ${Math.round(share * 100)}%`);
  if (summary.nodes.length > 3) parts.push('…');
  const line = summary.bound === 0
    ? parts.length ? t('app.skin.summary.unbound-moves', { parts: parts.join(', ') }) : t('app.skin.summary.unbound')
    : `${parts.join(' · ')}${summary.free ? ` · ${t('app.skin.summary.free', { count: summary.free })}` : ''}`;
  panel.querySelector('.skin-summary').textContent = t('app.skin.summary', { bound: summary.bound, count: summary.count, line });
}

// 532 -> "532 B", 20480 -> "20 KB", 1572864 -> "1.5 MB" (the units in the interface's language).
function formatBytes(bytes) {
  const units = [t('app.units.b'), t('app.units.kb'), t('app.units.mb'), t('app.units.gb')];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) {
    bytes /= 1024;
    unit++;
  }
  return `${unit === 0 || bytes >= 100 ? Math.round(bytes) : +bytes.toFixed(1)} ${units[unit]}`;
}

function refresh() {
  const { mesh, selection, tool, mode, picked } = editor;

  // With Alt held, a painting tool is the pipette for the time: its button is lit.
  for (const button of toolButtons) {
    button.classList.toggle('active', button.dataset.tool === (editor.picking ? 'pipette' : tool));
  }
  // The shapes' button: the picture of the shape it stands for - the one in
  // hand, or the one that last was - and lit while a shape is in hand.
  if (tool === 'rect' || tool === 'ellipse') shape = tool;
  $('shape-tool').classList.toggle('active', tool === shape);
  $('shape-tool').firstElementChild.className = `${editor.shapeFilled ? 'fa-solid' : 'fa-regular'} ${shape === 'rect' ? 'fa-square' : 'fa-circle'}`;
  for (const button of shapeFlyout.querySelectorAll('button')) {
    button.classList.toggle('active', tool === button.dataset.shape && editor.shapeFilled === (button.dataset.filled === '1'));
  }
  localStorage.setItem(SHAPE_KEY, shape);
  localStorage.setItem(SHAPE_FILL_KEY, editor.shapeFilled ? '1' : '0');
  // (No colour at all - the brush rubbing out - is not kept: the next launch starts with a colour.)
  if (editor.paintColor[3]) localStorage.setItem(PAINT_COLOR_KEY, hexOf(editor.paintColor));
  $('viewport').classList.toggle('painting', editor.painting && !editor.preview && tool !== 'marquee'); // (the marquee is the UV editor's)
  $('app').classList.toggle('picking', editor.picking); // pipette cursor, see styles.css
  $('app').classList.toggle('filling', tool === 'fill' && !editor.picking && !editor.preview); // bucket cursor
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
  // The rotation panel: an object or a node picked whole, in object mode.
  const rotation = editor.objectRotation();
  $('rotation').hidden = !rotation;
  for (const input of rotationInputs) {
    if (!rotation || document.activeElement === input) continue;
    input.value = +rotation[input.dataset.rotation].toFixed(4);
  }
  $('selection-count').textContent = tool === 'pivot' && point ? t('app.properties.pivot') : t('app.properties.position');
  // The objects' own properties: of the objects the selection is in. A box
  // half-ticked when they differ.
  const owners = picked.size ? editor.objectsInHand().map((index) => mesh.objects[index]).filter(Boolean) : [];
  $('object-props').hidden = owners.length === 0;
  // Its atlas, in a project with several: one for all, or a blank where they differ.
  $('object-atlas-line').hidden = !editor.multiAtlas || owners.length === 0;
  if (editor.multiAtlas && owners.length) {
    const ids = new Set(owners.map((object) => object.atlas ?? ''));
    const select = $('object-atlas');
    select.replaceChildren(
      ...(ids.size > 1 ? [new Option('—', '*', true, true)] : []),
      new Option(t('app.object.atlas.none'), '', false, ids.size === 1 && ids.has('')),
      ...editor.atlases.map((atlas) => new Option(atlas.name, atlas.id, false, ids.size === 1 && ids.has(atlas.id))),
    );
  }
  const oneSided = owners.filter((object) => object.oneSided).length;
  $('back-faces').checked = oneSided === 0;
  $('back-faces').indeterminate = oneSided > 0 && oneSided < owners.length;
  const smoothed = owners.filter((object) => object.smooth);
  const angles = new Set(smoothed.map((object) => object.smooth));
  $('smooth-shading').checked = owners.length > 0 && smoothed.length === owners.length;
  $('smooth-shading').indeterminate = smoothed.length > 0 && smoothed.length < owners.length;
  $('smooth-angle').disabled = smoothed.length === 0;
  if (document.activeElement !== $('smooth-angle')) {
    $('smooth-angle').value = smoothed.length === 0 ? SMOOTH_ANGLE : angles.size === 1 ? [...angles][0] : '';
  }
  showSkin();
  // A mode over the model (collisions, animation) has its own panels: the object's are put away.
  if (editor.workspace !== 'model') for (const id of ['dimensions', 'properties', 'rotation', 'object-props', 'skin-panel']) $(id).hidden = true;
  // The statistics are those of the objects holding the selection; of the
  // whole scene if nothing is selected.
  const { islands, islandOfVertex, edges } = editor.topology;
  const objects = [...new Set([...selection].map((vertex) => islandOfVertex[vertex]))].map((i) => islands[i]);
  const scope = objects.length ? objects : islands;
  const counted = new Set(scope.flatMap((island) => island.vertices));
  $('stats-title').textContent =
    objects.length === 0 ? t('app.stats.scene') : objects.length === 1 ? t('app.stats.object') : t('app.stats.objects', { count: objects.length });
  $('stat-vertices').textContent = counted.size;
  $('stat-edges').textContent = edges.filter(([a]) => counted.has(a)).length;
  $('stat-faces').textContent = scope.reduce((sum, island) => sum + island.faces.length, 0);
  $('stat-size').textContent = formatBytes(mesh.byteSize(objects.length ? objects : null));
  $('focus-button').classList.toggle('active', editor.focus);
  $('preview-button').classList.toggle('active', editor.preview);
  $('light-button').classList.toggle('active', editor.viewport.lit);
  mirrorDisplay.group.visible = !editor.preview; // the mirror's planes are the editor's too
  showMirror();
  $('snap-toggle').classList.toggle('active', editor.snapGrid.enabled);
  $('local-toggle').classList.toggle('active', editor.localAxes);
  // Texturing.
  showAtlases();
  // Undo and redo: lit while there is a step to take.
  $('undo-button').disabled = editor.history.undoStack.length === 0;
  $('redo-button').disabled = editor.history.redoStack.length === 0;
  // A planet for the world's axes, a pin for the object's own.
  $('local-toggle').firstElementChild.className = `fa-solid ${editor.localAxes ? 'fa-location-dot' : 'fa-globe'}`;
  $('local-toggle').title = editor.localAxes
    ? t('app.local-axes.on', { keys: hotkeys.label('view.local') })
    : t('app.local-axes.off', { keys: hotkeys.label('view.local') });
  $('snap-toggle').title = editor.snapGrid.enabled
    ? t('app.snapping.on')
    : t('app.snapping.off');
  document.querySelector('[data-action="make-face"]').disabled = !editor.canMakeFace();
  document.querySelector('[data-action="flip-faces"]').disabled = editor.facesToFlip().length === 0;
  // The banner keeps its last name while it slides away.
  if (editor.operation) $('operation-name').textContent = OPERATION_NAMES[editor.operation];
  $('operation-banner').classList.toggle('shown', editor.operation !== null);
  $('cut-options').classList.toggle('shown', editor.operation === 'cut');
  $('place-options').classList.toggle('shown', editor.placed());
  for (const button of placeButtons) button.classList.toggle('active', button.dataset.place === editor.placeSide);
  // The place tool takes one object or node picked whole.
  $('place-toggle').disabled = editor.operation !== 'place' && editor.pivotEntry() === null;
  for (const button of cutButtons) button.classList.toggle('active', button.dataset.cut === editor.cutDirection);
  $('app').classList.toggle('pencil-mode', editor.operation === 'pencil'); // pencil cursor, see styles.css
  $('animation-button').classList.toggle('active', editor.workspace === 'animation');
  document.querySelector('[data-action="toggle-uv"]').hidden = editor.workspace === 'animation';
  for (const name of ['place', 'cut', 'extrude', 'pencil', 'polygon']) {
    $(`${name}-toggle`).classList.toggle('active', editor.operation === name);
  }

  viewport.requestRender();
}

editor.addEventListener('change', refresh);
refresh();
