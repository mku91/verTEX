// Marker colours: a colour from a fixed palette given to an entry of the
// scene tree, to tell the parts of a model apart. It tints the entry's icon
// in the tree, and an object's surface in the view. An entry holds the id
// (`color`); nothing set means the theme's own surface colour.
import { t } from './i18n.js';

export const MARKER_COLORS = [
  { id: 'light-blue', label: t('marker.color.light-blue'), color: '#8be9fd' },
  { id: 'yellow', label: t('marker.color.yellow'), color: '#f1fa8c' },
  { id: 'orange', label: t('marker.color.orange'), color: '#ffb86c' },
  { id: 'red', label: t('marker.color.red'), color: '#ff6e6e' },
  { id: 'purple', label: t('marker.color.purple'), color: '#bd93f9' },
  { id: 'blue', label: t('marker.color.blue'), color: '#6f9cff' },
  { id: 'green', label: t('marker.color.green'), color: '#50fa7b' },
  { id: 'lime', label: t('marker.color.lime'), color: '#b8f56a' },
  { id: 'pink', label: t('marker.color.pink'), color: '#ff79c6' },
  { id: 'silver', label: t('marker.color.silver'), color: '#d6def5' },
];

const BY_ID = new Map(MARKER_COLORS.map((marker) => [marker.id, marker]));

// The '#rrggbb' of a marker colour id, or null for none (or one not known).
export function markerColor(id) {
  return BY_ID.get(id)?.color ?? null;
}
