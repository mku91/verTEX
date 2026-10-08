import { AxisGizmo } from './axis-gizmo.js';

// The chosen axis is the one the work plane is perpendicular to.
const CAPTIONS = {
  free: 'Выберите плоскость',
  x: 'Плоскость YZ',
  y: 'Плоскость XZ',
  z: 'Плоскость XY',
};

// Popup at the bottom of the viewport, shown while the polygon tool is on:
// its gizmo picks the plane the polygon is drawn in.
export class PolygonPopup {
  constructor(element, viewport, editor) {
    this.element = element;
    this.editor = editor;

    new AxisGizmo(element, viewport, editor, {
      value: () => editor.polygon?.axis ?? 'free',
      choose: (axis) => editor.setPolygonPlane(axis),
      captions: CAPTIONS,
    });
    // Clicks must not take the keyboard focus away from the editor.
    element.addEventListener('mousedown', (event) => event.preventDefault());
    editor.addEventListener('change', () => this.update());
    this.update();
  }

  update() {
    this.element.hidden = !this.editor.polygon;
  }
}
