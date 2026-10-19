const DEAD_ZONE = 4; // px of pointer travel that is still a plain click into the field
const PIXELS_PER_STEP = 8;
const STEP = 1;
const FINE_STEP = 0.1; // with Ctrl held
const FINEST_STEP = 0.01; // with Alt held

// Makes a number field adjustable by dragging. The field gets a handle at its
// right end - a divider and a dot: press LMB on that and move up to raise the
// value, down to lower it, by 1 per step (0.1 with Ctrl, 0.01 with Alt). The
// rest of the field is an ordinary text box, which a drag does not change.
//
// The field is put into a wrapper together with the handle; the wrapper is
// returned, and takes the field's place if the field is in the document.
//   read()        -> the field's current number
//   write(value)  -> apply a new one
//   begin / end   -> called around a drag, e.g. to make it one undo step
//   whole         -> the value is an integer: Ctrl and Alt make no difference
//   min, max      -> limits
//   step          -> a step, if not 1 (Ctrl and Alt make it a tenth, a hundredth)
export function scrubbable(input, { read, write, begin, end, whole = false, min = -Infinity, max = Infinity, step: unit = STEP }) {
  const field = document.createElement('div');
  field.className = 'scrub-field';
  const handle = document.createElement('i');
  handle.className = 'scrub-handle';
  input.replaceWith(field);
  field.append(input, handle);
  input.classList.add('scrubbable');
  let press = null;

  // The handle is not a way into the field: no focus, no text cursor (and
  // inside a <label> a click on it would otherwise go to the field).
  handle.addEventListener('mousedown', (event) => event.preventDefault());
  handle.addEventListener('click', (event) => event.preventDefault());

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || input.disabled) return;
    press = { y: event.clientY, steps: 0, value: null, pointer: event.pointerId };
  });
  handle.addEventListener('pointermove', (event) => {
    if (!press || !(event.buttons & 1)) return;
    if (press.value === null) {
      if (Math.abs(event.clientY - press.y) < DEAD_ZONE) return;
      // The drag starts: from here on the field is a slider, not a text box.
      const value = read();
      if (!Number.isFinite(value)) return;
      press.value = value;
      press.y = event.clientY;
      handle.setPointerCapture(press.pointer);
      input.blur();
      field.classList.add('scrubbing');
      begin?.();
    }
    // Steps since the last event are added with the step in force right now,
    // so pressing Ctrl or Alt mid-drag doesn't make the value jump.
    const steps = Math.round((press.y - event.clientY) / PIXELS_PER_STEP);
    if (steps === press.steps) return;
    const step = unit * (whole ? 1 : event.altKey ? FINEST_STEP : event.ctrlKey ? FINE_STEP : 1);
    const next = press.value + (steps - press.steps) * step;
    press.steps = steps;
    press.value = Math.min(Math.max(+next.toFixed(5), min), max);
    write(press.value);
  });
  const release = () => {
    const scrubbed = press?.value !== null;
    if (press && scrubbed) {
      field.classList.remove('scrubbing');
      end?.();
    }
    press = null;
  };
  handle.addEventListener('pointerup', release);
  handle.addEventListener('pointercancel', release);
  return field;
}
