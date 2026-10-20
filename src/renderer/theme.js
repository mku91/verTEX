import * as THREE from 'three';
import { GizmoDial } from './gizmo-dial.js';
import { t } from './i18n.js';

// Colour themes. Every colour in the app comes from the current theme, by role:
// the interface reads them as CSS variables, the views read `theme` directly.

export const THEMES = {
  dracula: {
    label: 'Dracula',
    // Interface
    bg: '#282a36',
    bgRaised: '#21222c',
    border: '#191a21',
    hover: '#44475a',
    text: '#f8f8f2',
    textDim: '#6272a4',
    accent: '#bd93f9',
    accentText: '#282a36', // text and icons on an accent background
    // Shared by the interface and the views
    axisX: '#ff5555',
    axisY: '#50fa7b',
    axisZ: '#8be9fd',
    selected: '#ff79c6',
    box: '#50fa7b', // the selection box
    // Views
    viewBg: '#282a36',
    viewBgFocus: '#15161c', // modal operations (cut, extrude, pencil)
    grid: '#343746',
    gridCenter: '#44475a',
    surface: '#6272a4',
    wire: '#f8f8f2',
    wireFocus: '#f8f8f2',
    vertex: '#ffb86c',
    vertexFocus: '#c9cbd6',
    hovered: '#f8f8f2',
    hoveredFocus: '#f1fa8c',
    cut: '#50fa7b',
    pivot: '#f1fa8c', // pivot point markers outside the pivot tool
    around: '#44475a', // the rest of the node, in the three views
    snapDot: '#f8f8f2',
    faceFront: '#8be9fd', // face orientation display: the side a face looks to
    faceBack: '#ff5555', // ...and its reverse
    // An animation's keys, by what they key (see timeline.js).
    keyPosition: '#ff79c6',
    keyRotation: '#8be9fd',
    keyScale: '#f1fa8c',
  },
  graphite: {
    label: t('theme.graphite'),
    bg: '#1b1d23',
    bgRaised: '#23262d',
    border: '#14161a',
    hover: '#2e323b',
    text: '#c9ced8',
    textDim: '#7d8594',
    accent: '#1fd6c4',
    accentText: '#1b1d23',
    axisX: '#e0606a',
    axisY: '#7fc46a',
    axisZ: '#5f96dc',
    selected: '#1fd6c4',
    box: '#50fa7b',
    viewBg: '#24272e',
    viewBgFocus: '#0e0f12',
    grid: '#30343e',
    gridCenter: '#3a3f4b',
    surface: '#8fa3b8',
    wire: '#11141a',
    wireFocus: '#ffffff',
    vertex: '#11141a',
    vertexFocus: '#c4c9d2',
    hovered: '#ffffff',
    hoveredFocus: '#ffd23f',
    cut: '#50fa7b',
    pivot: '#f1fa8c',
    around: '#3a3f4b',
    snapDot: '#ffffff',
    faceFront: '#5f96dc',
    faceBack: '#e0606a',
    // (Dracula's, as in that theme)
    keyPosition: '#ff79c6',
    keyRotation: '#8be9fd',
    keyScale: '#f1fa8c',
  },
};

export const DEFAULT_THEME = 'dracula';
const STORAGE_KEY = 'vertex.theme';

// Theme colours that the stylesheet uses, by CSS variable.
const CSS_VARIABLES = {
  '--bg': 'bg',
  '--bg-raised': 'bgRaised',
  '--border': 'border',
  '--hover': 'hover',
  '--text': 'text',
  '--text-dim': 'textDim',
  '--accent': 'accent',
  '--accent-text': 'accentText',
  '--selection': 'selected',
  '--box': 'box',
  '--axis-x': 'axisX',
  '--axis-y': 'axisY',
  '--axis-z': 'axisZ',
  '--key-position': 'keyPosition',
  '--key-rotation': 'keyRotation',
  '--key-scale': 'keyScale',
};

// The current theme's colours. One object for the app's lifetime: setTheme()
// refills it, so modules may keep a reference and read from it when they draw.
export const theme = { id: DEFAULT_THEME, ...THEMES[DEFAULT_THEME] };

const listeners = new Set();

// Calls `listener` after every theme change; for those who cache colours.
export function onThemeChange(listener) {
  listeners.add(listener);
}

export function setTheme(id) {
  if (!(id in THEMES)) id = DEFAULT_THEME;
  Object.assign(theme, THEMES[id], { id });
  for (const [variable, key] of Object.entries(CSS_VARIABLES)) {
    document.documentElement.style.setProperty(variable, theme[key]);
  }
  localStorage.setItem(STORAGE_KEY, id);
  for (const listener of listeners) listener();
}

// The theme chosen in an earlier session, or the default one.
export function savedTheme() {
  return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_THEME;
}

// Colour of a world axis: 'x' | 'y' | 'z'.
export function axisColor(axis) {
  return theme[`axis${axis.toUpperCase()}`];
}

// A gizmo (TransformControls) in the theme's colours: its axes as the
// world's, the one under the pointer as the hovered vertex in focus - and
// again whenever the theme changes.
// (`viewport`: where its rotation rings become a dial while held, see gizmo-dial.js)
export function themeGizmo(gizmo, viewport = null) {
  const paint = () => gizmo.setColors(theme.axisX, theme.axisY, theme.axisZ, theme.hoveredFocus);
  paint();
  onThemeChange(paint);
  thickenRings(gizmo);
  thickenShafts(gizmo);
  if (viewport) new GizmoDial(gizmo, viewport);
}

// The gizmos' lines, all of one thickness - thicker than TransformControls
// draws them (0.0075, three-sided), and round. (What the pointer takes them
// by is TransformControls' own, wider still.)
const LINE_RADIUS = 0.014;

// The rotation gizmo's rings: rebuilt as it builds them - a torus turned
// into the plane of its axis - with a tube of LINE_RADIUS.
const RING_TUBE = LINE_RADIUS;
// The two rings that are not an axis' - turning freely (XYZE, grey) and
// about the line of sight (E, the outer one) - fainter, so that the axes'
// stand out; lit whole while under the pointer, as every handle is.
const RING_OPACITY = { XYZE: 0.25, E: 0.15 };
const RING_TURNS = { XYZE: [0, Math.PI / 2, 0], X: [0, 0, 0], Y: [0, 0, -Math.PI / 2], Z: [0, Math.PI / 2, 0], E: [0, Math.PI / 2, 0] };
function thickenRings(gizmo) {
  for (const handle of gizmo._gizmo?.gizmo?.rotate?.children ?? []) {
    const { parameters } = handle.geometry ?? {};
    const turn = RING_TURNS[handle.name];
    if (!turn || handle.geometry.type !== 'TorusGeometry' || !parameters) continue;
    const ring = new THREE.TorusGeometry(parameters.radius, RING_TUBE, 6, 96, parameters.arc);
    ring.rotateY(Math.PI / 2);
    ring.rotateX(Math.PI / 2);
    ring.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...turn)));
    handle.geometry.dispose();
    handle.geometry = ring;
    if (RING_OPACITY[handle.name] !== undefined) {
      // (a material of its own: TransformControls shares its grey and its yellow with other handles)
      handle.material = handle.material.clone();
      handle.material.opacity = handle.material._opacity = RING_OPACITY[handle.name];
    }
  }
}

// The move and scale gizmos' shafts (cylinders from the middle out along an
// axis, turned there): rebuilt round and LINE_RADIUS thick, along the axis
// and about the middle they had.
function thickenShafts(gizmo) {
  const { translate, scale } = gizmo._gizmo?.gizmo ?? {};
  for (const handle of [...(translate?.children ?? []), ...(scale?.children ?? [])]) {
    const { type, parameters } = handle.geometry ?? {};
    if (type !== 'CylinderGeometry' || parameters?.radiusTop !== parameters?.radiusBottom || !(parameters?.radiusTop < 0.01)) continue;
    handle.geometry.computeBoundingBox();
    const box = handle.geometry.boundingBox;
    const size = box.getSize(new THREE.Vector3());
    const axis = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z';
    const shaft = new THREE.CylinderGeometry(LINE_RADIUS, LINE_RADIUS, size[axis], 8);
    if (axis === 'x') shaft.rotateZ(-Math.PI / 2);
    if (axis === 'z') shaft.rotateX(Math.PI / 2);
    const middle = box.getCenter(new THREE.Vector3());
    shaft.translate(middle.x, middle.y, middle.z);
    handle.geometry.dispose();
    handle.geometry = shaft;
  }
}
