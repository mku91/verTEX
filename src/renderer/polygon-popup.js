import { PlaneHatch } from './plane-hatch.js';
import { axisColor } from './theme.js';

// The chosen axis is the one the work plane is perpendicular to.
const CAPTIONS = {
  free: 'Выберите плоскость',
  x: 'Плоскость YZ',
  y: 'Плоскость XZ',
  z: 'Плоскость XY',
};
const AXES = ['x', 'y', 'z'];

// Popup at the bottom of the viewport, shown while the polygon tool is on:
// three round buttons, one per axis, pick the plane the polygon is drawn in.
// Pointing at a button hatches its plane in the scene; a click chooses it.
export class PolygonPopup {
  constructor(element, viewport, editor) {
    this.element = element;
    this.editor = editor;
    this.hatch = new PlaneHatch(viewport);
    this.pointed = null; // the axis of the button under the pointer

    const row = document.createElement('div');
    row.className = 'plane-buttons';
    this.buttons = AXES.map((axis) => {
      const button = document.createElement('button');
      button.className = `plane-button ${axis}`;
      button.dataset.plane = axis;
      button.textContent = axis.toUpperCase();
      button.title = `${CAPTIONS[axis]} — перпендикулярно оси ${axis.toUpperCase()}`;
      button.addEventListener('pointerenter', () => this.point(axis));
      button.addEventListener('pointerleave', () => this.point(null));
      button.addEventListener('click', () => {
        // The plane is chosen: its snap points take the hatching's place.
        // A click on the chosen one lets it go.
        editor.setPolygonPlane(editor.polygon?.axis === axis ? 'free' : axis);
        this.showHatch();
      });
      return button;
    });
    row.append(...this.buttons);
    this.caption = document.createElement('div');
    this.caption.className = 'caption';
    element.replaceChildren(row, this.caption);

    // Clicks must not take the keyboard focus away from the editor.
    element.addEventListener('mousedown', (event) => event.preventDefault());
    editor.addEventListener('change', () => this.update());
    this.update();
  }

  point(axis) {
    this.pointed = axis;
    this.showHatch();
  }

  // Hatches the plane of the button under the pointer, unless it is the one
  // already chosen (its snap points show it).
  showHatch() {
    const polygon = this.editor.polygon;
    const axis = polygon && this.pointed !== polygon.axis ? this.pointed : null;
    if (axis) this.hatch.show(axis, polygon.offset, axisColor(axis));
    else this.hatch.hide();
  }

  update() {
    const polygon = this.editor.polygon;
    this.element.hidden = !polygon;
    if (!polygon) {
      this.pointed = null;
      this.hatch.hide();
      return;
    }
    for (const button of this.buttons) {
      button.classList.toggle('active', button.dataset.plane === polygon.axis);
    }
    this.caption.textContent = CAPTIONS[polygon.axis ?? 'free'];
  }
}
