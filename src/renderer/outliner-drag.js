// What is seen of a drag in the list of the scene: the rows fly to the pointer
// and go along with it as a stack, and on the drop fly out of it to their
// places, one by one, evenly (FLIP: each is drawn where it was and animated by
// `transform` to where it is). Only a picture over the list: what the drag
// does is done at once, see Outliner.finishDrag().

const POINTER_OFFSET = { x: 14, y: 12 }; // px; the row under the pointer stays seen
const STACK_WIDTH = 170; // px
const STACK_STEP = 3; // px between the rows seen in the stack
const STACK_SEEN = 3; // how many are seen in it
export const MAX_FLYING = 12; // the rest are only counted: hundreds of animations would hold the list up
const GATHER_TIME = 220; // ms
const LAND_TIME = 260; // ms
const EVEN_DELAY = 22; // ms from one row's flight to the next one's
const EASE = 'cubic-bezier(0.2, 0.8, 0.3, 1)';

// The row's left edge, where its icon begins: the copies have no indent of their own.
const rowPlace = (row) => {
  const rect = row.getBoundingClientRect();
  return { x: rect.left + parseFloat(row.style.paddingLeft || '0') - 6, y: rect.top };
};

// Kept to the height of the list: what is scrolled away is not flown to over the rest of the window.
const within = (place, bounds) => {
  const y = Math.min(Math.max(place.y, bounds.top), bounds.bottom - 20);
  return { x: place.x, y, clipped: y !== place.y };
};

export class DragStack {
  // `rows`: the rows of the list that are dragged, in the order it shows them;
  // `count`: how many entries are dragged, these and the ones not shown.
  constructor(rows, count, x, y, bounds) {
    this.element = document.createElement('div');
    this.element.className = 'outliner-stack';
    this.origin = { x: 0, y: 0 };
    this.move(x, y);
    this.flyers = rows.slice(0, MAX_FLYING).map((row, k) => this.addFlyer(row, k, bounds));
    if (count > 1) {
      this.badge = document.createElement('span');
      this.badge.className = 'outliner-stack-count';
      this.badge.textContent = count;
      this.element.append(this.badge);
    }
    document.body.append(this.element);
    for (const flyer of this.flyers) this.gather(flyer);
  }

  // A copy of the row, its name and icon only.
  addFlyer(row, k, bounds) {
    const element = row.cloneNode(true);
    element.querySelectorAll('.outliner-eye, .outliner-lock, .outliner-add, .outliner-arrow').forEach((part) => part.remove());
    element.className = 'outliner-row outliner-flyer';
    element.removeAttribute('title');
    element.removeAttribute('data-object');
    element.style.paddingLeft = '';
    element.style.zIndex = MAX_FLYING - k;
    element.style.width = `${Math.min(STACK_WIDTH, row.getBoundingClientRect().width)}px`;
    const slot = Math.min(k, STACK_SEEN - 1) * STACK_STEP;
    this.element.append(element);
    return { element, k, slot, seen: k < STACK_SEEN, from: within(rowPlace(row), bounds), id: row.dataset.object };
  }

  gather(flyer) {
    const { element, slot, seen, from, k } = flyer;
    const start = `translate(${from.x - this.origin.x}px, ${from.y - this.origin.y}px)`;
    const end = `translate(${slot}px, ${slot}px)`;
    element.style.transform = end;
    element.style.opacity = seen ? 1 : 0;
    flyer.flight = element.animate(
      [{ transform: start, opacity: 1 }, { transform: end, opacity: seen ? 1 : 0 }],
      { duration: GATHER_TIME, delay: k * EVEN_DELAY, easing: EASE, fill: 'backwards' },
    );
  }

  // The stack follows the pointer, and whatever is on its way to it with the stack.
  move(x, y) {
    this.origin = { x: x + POINTER_OFFSET.x, y: y + POINTER_OFFSET.y };
    this.element.style.transform = `translate(${this.origin.x}px, ${this.origin.y}px)`;
  }

  // The drop: each flies from where it is now to `place(flyer)` - a row (with
  // `fade`: it goes out there, its own row not being seen), or null: it goes
  // out where it is - evenly, one after another. `arrived(flyer)` when it is
  // there. Over once all are.
  land(place, bounds, arrived) {
    this.badge?.remove();
    const flights = this.flyers.map((flyer, order) => {
      const { element } = flyer;
      // (Its place this moment, and from there on by hand: it may be on its way still.)
      const now = element.getBoundingClientRect();
      const opacity = getComputedStyle(element).opacity;
      flyer.flight?.cancel();
      const from = `translate(${now.left - this.origin.x}px, ${now.top - this.origin.y}px)`;
      const target = place(flyer);
      const to = target ? within(rowPlace(target.row), bounds) : null;
      const end = to ? `translate(${to.x - this.origin.x}px, ${to.y - this.origin.y}px)` : from;
      const fade = !to || to.clipped || target.fade;
      element.style.transform = end;
      element.style.opacity = fade ? 0 : 1;
      const animation = element.animate(
        [{ transform: from, opacity: flyer.seen ? 1 : opacity }, { transform: end, opacity: fade ? 0 : 1 }],
        { duration: LAND_TIME, delay: order * EVEN_DELAY, easing: EASE, fill: 'backwards' },
      );
      const over = () => {
        arrived(flyer);
        element.remove();
      };
      return animation.finished.then(over, over);
    });
    Promise.all(flights).then(() => this.element.remove());
  }
}
