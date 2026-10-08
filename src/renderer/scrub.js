const DEAD_ZONE = 4; // px of pointer travel that is still a plain click into the field
const PIXELS_PER_STEP = 8;
const STEP = 1;
const FINE_STEP = 0.1; // with Ctrl held

// Makes a number field adjustable by dragging: press LMB on it and move up to
// raise the value, down to lower it, by 1 per step (0.1 with Ctrl). A press
// without movement stays an ordinary click for typing.
//   read()        -> the field's current number
//   write(value)  -> apply a new one
//   begin / end   -> called around a drag, e.g. to make it one undo step
//   whole         -> the value is an integer: Ctrl makes no difference
//   min, max      -> limits
export function scrubbable(input, { read, write, begin, end, whole = false, min = -Infinity, max = Infinity }) {
  input.classList.add('scrubbable');
  let press = null;

  // A press on selected text would start dragging that text away, and the
  // browser would then take the pointer from us.
  input.addEventListener('dragstart', (event) => event.preventDefault());

  input.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    press = { y: event.clientY, steps: 0, value: null, pointer: event.pointerId };
  });
  input.addEventListener('pointermove', (event) => {
    if (!press || !(event.buttons & 1)) return;
    if (press.value === null) {
      if (Math.abs(event.clientY - press.y) < DEAD_ZONE) return;
      // The drag starts: from here on the field is a slider, not a text box.
      const value = read();
      if (!Number.isFinite(value)) return;
      press.value = value;
      press.y = event.clientY;
      input.setPointerCapture(press.pointer);
      input.blur();
      input.classList.add('scrubbing');
      begin?.();
    }
    // Steps since the last event are added with the step in force right now,
    // so pressing Ctrl mid-drag doesn't make the value jump.
    const steps = Math.round((press.y - event.clientY) / PIXELS_PER_STEP);
    if (steps === press.steps) return;
    const step = event.ctrlKey && !whole ? FINE_STEP : STEP;
    const next = press.value + (steps - press.steps) * step;
    press.steps = steps;
    press.value = Math.min(Math.max(+next.toFixed(5), min), max);
    write(press.value);
  });
  const release = () => {
    const scrubbed = press?.value !== null;
    if (press && scrubbed) {
      input.classList.remove('scrubbing');
      end?.();
    }
    press = null;
  };
  input.addEventListener('pointerup', release);
  input.addEventListener('pointercancel', release);
}
