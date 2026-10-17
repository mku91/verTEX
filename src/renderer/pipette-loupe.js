// The pipette's loupe: a ring beside the pointer while a press would take
// the colour (Editor.picking) - on the model or in the UV editor alike. Its
// upper half is the colour under the pointer, the one a press would take;
// the lower half is the brush's colour now, to tell the two apart.

const SIZE = 44; // across, in CSS pixels
const GAP = 10; // from the pointer's tip to the ring

export class PipetteLoupe {
  constructor(editor) {
    this.editor = editor;
    this.pointer = null; // { x, y }, in the window
    this.element = document.createElement('div');
    this.element.id = 'pipette-loupe';
    this.element.hidden = true;
    this.under = document.createElement('span');
    this.current = document.createElement('span');
    this.element.append(this.under, this.current);
    document.body.append(this.element);

    // Capture phase: the place is known before the views tell of the pixel.
    window.addEventListener('pointermove', (event) => {
      this.pointer = { x: event.clientX, y: event.clientY };
      this.update();
    }, { capture: true, passive: true });
    editor.addEventListener('change', () => this.update());
    editor.addEventListener('painthover', () => this.update());
    editor.atlas.addEventListener('change', () => this.update());
  }

  update() {
    const { editor, pointer, element } = this;
    const pixel = editor.picking ? editor.paintHover : null;
    element.hidden = !pixel || !pointer;
    if (element.hidden) return;
    // Down and to the right of the tip, where the pipette is not; turned
    // back from the window's edges.
    const x = pointer.x + GAP + SIZE > window.innerWidth ? pointer.x - GAP - SIZE : pointer.x + GAP;
    const y = pointer.y + GAP + SIZE > window.innerHeight ? pointer.y - GAP - SIZE : pointer.y + GAP;
    element.style.transform = `translate(${x}px, ${y}px)`;
    show(this.under, editor.atlas.colorAt(pixel.x, pixel.y));
    show(this.current, editor.paintColor);
  }
}

function show(half, [r, g, b, a]) {
  half.style.setProperty('--color', `rgba(${r}, ${g}, ${b}, ${a / 255})`);
}
