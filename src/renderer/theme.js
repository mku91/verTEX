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
    cut: '#ff79c6',
    pivot: '#f1fa8c', // pivot point markers outside the pivot tool
    around: '#44475a', // the rest of the group, in the three views
    snapDot: '#f8f8f2',
    faceFront: '#8be9fd', // face orientation display: the side a face looks to
    faceBack: '#ff5555', // ...and its reverse
  },
  graphite: {
    label: 'Графит',
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
    cut: '#ffd23f',
    pivot: '#f1fa8c',
    around: '#3a3f4b',
    snapDot: '#ffffff',
    faceFront: '#5f96dc',
    faceBack: '#e0606a',
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
