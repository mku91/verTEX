// Marker colours: a colour from a fixed palette given to an entry of the
// scene tree, to tell the parts of a model apart. It tints the entry's icon
// in the tree, and an object's surface in the view. An entry holds the id
// (`color`); nothing set means the theme's own surface colour.
export const MARKER_COLORS = [
  { id: 'light-blue', label: 'Голубой', color: '#8be9fd' },
  { id: 'yellow', label: 'Жёлтый', color: '#f1fa8c' },
  { id: 'orange', label: 'Оранжевый', color: '#ffb86c' },
  { id: 'red', label: 'Красный', color: '#ff6e6e' },
  { id: 'purple', label: 'Фиолетовый', color: '#bd93f9' },
  { id: 'blue', label: 'Синий', color: '#6f9cff' },
  { id: 'green', label: 'Зелёный', color: '#50fa7b' },
  { id: 'lime', label: 'Лаймовый', color: '#b8f56a' },
  { id: 'pink', label: 'Розовый', color: '#ff79c6' },
  { id: 'silver', label: 'Серебристый', color: '#d6def5' },
];

const BY_ID = new Map(MARKER_COLORS.map((marker) => [marker.id, marker]));

// The '#rrggbb' of a marker colour id, or null for none (or one not known).
export function markerColor(id) {
  return BY_ID.get(id)?.color ?? null;
}
