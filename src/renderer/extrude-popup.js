import { AxisGizmo } from './axis-gizmo.js';
import { t } from './i18n.js';

const CAPTIONS = {
  free: t('extrude-popup.auto'),
  x: t('extrude-popup.axis', { axis: 'X' }),
  y: t('extrude-popup.axis', { axis: 'Y' }),
  z: t('extrude-popup.axis', { axis: 'Z' }),
};

// Small popup at the bottom of the viewport, shown while an edge is being
// extruded, with a gizmo to pick the direction it is pulled in. The choice
// lasts for that one extrusion.
export class ExtrudePopup {
  constructor(element, viewport, editor) {
    this.element = element;
    this.editor = editor;

    new AxisGizmo(element, viewport, editor, {
      value: () => editor.extrude?.axis ?? 'free',
      choose: (axis) => editor.setExtrudeAxis(axis),
      captions: CAPTIONS,
    });
    // Clicks must not take the keyboard focus away from the editor.
    element.addEventListener('mousedown', (event) => event.preventDefault());
    editor.addEventListener('change', () => this.update());
    this.update();
  }

  update() {
    const { extrude, mode } = this.editor;
    this.element.hidden = !extrude || mode !== 'edge';
  }
}
