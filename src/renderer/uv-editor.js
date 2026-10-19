import { theme, onThemeChange } from './theme.js';
import { facePixels } from './atlas.js';

// The UV editor: the atlas, flat, with the faces drawn on it.
//
// It is where a face is given a picture other than the one the unwrap gave
// it: a chart (the faces that lie on the atlas as one piece) is picked and
// dragged to another place - on top of another chart, if they are to share a
// picture - turned by quarter turns, or turned over. Nothing is stretched and
// no pixel is painted or moved here; only where the faces look changes. A
// chart placed so is pinned (see unwrap.js); "regenerate" makes it anew.
//
// With the shape lock open the picked charts have a marker at every corner,
// and a marker can be dragged, by whole pixels: that changes the shape the
// faces have on the atlas - stretches them, which nothing else does - so
// that their edges can be made to lie along the pixels' edges.
//
// With a painting tool in hand (see Editor.paintPress()) it is the picture
// that is worked on here, not the charts: the brush paints the pixel under
// it, any pixel of the atlas, and a drag paints a line of them; the fill and
// the shapes have the whole picture to themselves; Alt takes the colour.
// With the marquee a drag picks a rectangle of pixels, and a drag inside it
// moves them (Alt: a copy of them) - see Editor.setMarquee().
//
// F1 held: the picture is dimmed and the outlines are gone, all but the
// pixels and the outline of the face under the pointer - here, or on the
// model - to see which are that face's.
//
//   LMB on a chart       pick it (Shift adds); the faces are selected in the scene too
//   LMB drag             move the picked charts, by whole pixels
//   wheel                zoom at the pointer
//   RMB / MMB drag       pan
const MIN_ZOOM = 1;
const MAX_ZOOM = 64;
const GRID_FROM = 8; // px per pixel from which the pixel grid is drawn
const CLICK = 4; // px of pointer travel that is still a click
const SNAP = 3; // atlas px within which a dragged chart jumps onto another's room
const MARKER = 4.5; // px, the radius of a corner's marker
const MARKER_REACH = 8; // px within which a marker is taken
const SHAPED = '#ffb86c'; // the outline of a chart whose shape was changed by hand
const DIMMED = 0.15; // how much of the picture shows with F1 held, but for the face under the pointer

export class UVEditor {
  constructor(container, editor) {
    this.container = container;
    this.editor = editor;
    this.open = false;
    this.zoom = 6;
    this.origin = { x: 20, y: 20 }; // where the atlas' top left is on the canvas, px
    this.hovered = null; // a chart of editor.atlas.charts
    this.drag = null;
    this.fitted = ''; // the atlas size the view was last fitted to
    this.moved = false; // panned or zoomed by hand since: a new size of the panel then leaves it be
    this.shaping = false; // the shape lock is open: corners can be dragged
    this.hoveredMarker = null;
    this.ants = 0; // how far the marquee's dashes have crawled
    // F1 held (see isolate()): the face shown alone, and where the pointer was last.
    this.isolating = false;
    this.isolated = null; // a face's number
    this.pointer = null; // { view: 'uv' | 'model', x, y }

    this.canvas = container.querySelector('canvas');
    this.context = this.canvas.getContext('2d');
    this.status = container.querySelector('.uv-status');
    for (const button of container.querySelectorAll('[data-uv]')) {
      button.addEventListener('mousedown', (event) => event.preventDefault()); // keep the keyboard focus
      button.addEventListener('click', () => this.command(button.dataset.uv));
    }

    // A view not panned or zoomed by hand stays fitted as the panel changes
    // size - as the window opens maximized, after the first fit was made.
    new ResizeObserver(() => {
      if (!this.moved && this.open) this.fit();
      this.draw();
    }).observe(this.canvas);
    editor.addEventListener('change', () => this.update());
    editor.addEventListener('painthover', () => this.draw());
    editor.atlas.addEventListener('change', () => this.draw());
    editor.atlas.addEventListener('layout', () => this.update());
    onThemeChange(() => this.draw());
    this.bindPointer();
    // F1 is held, and let go; a window left while it is held lets it go too.
    window.addEventListener('keydown', (event) => {
      if (event.code !== 'F1' || !this.open) return;
      event.preventDefault();
      this.isolate(true);
    });
    window.addEventListener('keyup', (event) => {
      if (event.code === 'F1') this.isolate(false);
    });
    window.addEventListener('blur', () => this.isolate(false));
    // The face under the pointer on the model counts as well.
    editor.viewport.renderer.domElement.addEventListener('pointermove', (event) => {
      this.pointer = { view: 'model', x: event.clientX, y: event.clientY };
      if (this.isolating) this.isolate(true);
    });
  }

  toggle(open = !this.open) {
    this.open = open;
    if (!open) this.editor.commitFloating();
    this.container.hidden = !open;
    if (open) this.update();
    return open;
  }

  // The faces picked in the scene, when it is faces that are picked there.
  pickedFaces() {
    return this.editor.mode === 'face' ? [...this.editor.picked] : [];
  }

  pickedCharts() {
    return this.editor.chartsOfFaces(this.pickedFaces());
  }

  update() {
    if (!this.open) return;
    const { atlas } = this.editor;
    // A new size of atlas is looked at whole again.
    const size = `${atlas.width}x${atlas.height}`;
    if (size !== this.fitted && this.canvas.clientWidth > 0) this.fit();
    // The brush's pointer, while the brush is in hand.
    const { painting } = this.editor;
    if (painting !== (this.canvas.style.cursor === 'crosshair')) this.canvas.style.cursor = painting ? 'crosshair' : '';
    const charts = this.pickedCharts();
    const pixels = this.editor.tool === 'marquee' && Boolean(this.editor.marquee); // the turns are for the pixels picked then
    for (const button of this.container.querySelectorAll('[data-uv]')) {
      if (!['fit', 'add', 'remove', 'shape', 'regenerate', 'clean'].includes(button.dataset.uv)) button.disabled = charts.length === 0 && !pixels;
    }
    // Regenerate: the picked charts, or with none picked the whole atlas - if there is anything on it.
    this.container.querySelector('[data-uv="regenerate"]').disabled = this.editor.atlas.charts.length === 0;
    const lock = this.container.querySelector('[data-uv="shape"]');
    lock.classList.toggle('active', this.shaping);
    lock.firstElementChild.className = `fa-solid ${this.shaping ? 'fa-lock-open' : 'fa-lock'}`;
    // Nothing is on the atlas unasked: the objects in hand are put there, or taken off.
    const { objects } = this.editor.mesh;
    const hand = this.editor.objectsInHand().map((index) => objects[index]);
    const add = this.container.querySelector('[data-uv="add"]');
    const started = objects.some((object) => object.atlas);
    add.querySelector('span').textContent = started ? 'Добавить в атлас' : 'Создать атлас';
    add.disabled = !hand.some((object) => !object.atlas);
    this.container.querySelector('[data-uv="remove"]').disabled = !hand.some((object) => object.atlas);
    const { marquee, tool } = this.editor;
    this.status.textContent = tool === 'marquee'
      ? marquee
        ? `Выделено ${marquee.w} × ${marquee.h} px, место ${marquee.x}, ${marquee.y}${this.editor.floating ? ' · плавает: Enter — положить, Esc — вернуть' : ''}`
        : 'Протяните, чтобы выделить пиксели'
      : charts.length === 0
      ? started
        ? 'Клик по грани на атласе выбирает её лоскут'
        : 'Атлас пуст: выберите объект и нажмите «Создать атлас»'
      : charts.length === 1
        ? `${charts[0].rect.w} × ${charts[0].rect.h} px, место ${charts[0].rect.x}, ${charts[0].rect.y}${charts[0].shaped ? ' · форма изменена' : charts[0].pinned ? ' · закреплён' : ''}`
        : `Лоскутов: ${charts.length}`;
    this.draw();
  }

  command(name) {
    const faces = this.pickedFaces();
    if (name === 'fit') {
      this.fit();
      this.draw();
    } else if (name === 'shape') {
      this.shaping = !this.shaping;
      this.hoveredMarker = null;
      this.update();
    } else if (name === 'add') this.editor.setOnAtlas(this.editor.objectsInHand(), true);
    else if (name === 'remove') this.editor.setOnAtlas(this.editor.objectsInHand(), false);
    else if (['turn-left', 'turn-right', 'flip-h', 'flip-v'].includes(name)) {
      const how = { 'turn-left': { turn: -1 }, 'turn-right': { turn: 1 }, 'flip-h': { flip: 'h' }, 'flip-v': { flip: 'v' } }[name];
      // With the marquee in hand it is the pixels picked that are turned, not the charts.
      if (this.editor.tool === 'marquee' && this.editor.marquee) this.editor.turnPixels(how);
      else this.editor.placeCharts(faces, how);
    }
    else if (name === 'clean') this.editor.cleanAtlas();
    else if (name === 'regenerate') {
      // With nothing picked it is the whole atlas, and everything painted: asked first.
      const all = this.pickedCharts().length === 0;
      if (all && !window.confirm('Перегенерировать весь атлас?\n\nВсё нарисованное на текстуре будет потеряно. Действие можно отменить.')) return;
      this.editor.regenerateCharts(faces);
    }
  }

  // F1 held or let go: the picture dimmed but for the face under the
  // pointer (on whichever view it was last), or as it is.
  isolate(on) {
    const face = on ? this.faceUnderPointer() : null;
    if (on === this.isolating && face === this.isolated) return;
    this.isolating = on;
    this.isolated = face;
    this.draw();
  }

  // The face under the pointer, wherever it was last: here, the smallest of
  // those whose places hold it (faces may lie on each other); on the model,
  // the one it is on. Null for none, or one that is not on the atlas.
  faceUnderPointer() {
    const { pointer, editor } = this;
    if (!pointer) return null;
    if (pointer.view === 'model') return editor.paintHitAt(pointer.x, pointer.y)?.face ?? null;
    const { x, y } = this.toAtlas(pointer.x, pointer.y);
    let best = null;
    let least = Infinity;
    editor.mesh.faces.forEach((face, index) => {
      const polygon = face.uv;
      if (!polygon?.every(Boolean)) return;
      let within = false;
      let area = 0;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [ax, ay] = polygon[i];
        const [bx, by] = polygon[j];
        if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) within = !within;
        area += (bx - ax) * (by + ay);
      }
      if (within && Math.abs(area) < least) {
        least = Math.abs(area);
        best = index;
      }
    });
    return best;
  }

  // Keeps the marching ants going while there is a rectangle to go round:
  // a step every tenth of a second.
  crawl() {
    if (this.crawling) return;
    this.crawling = true;
    setTimeout(() => {
      this.crawling = false;
      if (!this.open || this.editor.tool !== 'marquee' || !this.editor.marquee) return;
      this.ants = (this.ants + 1) % 8;
      this.draw();
    }, 100);
  }

  // The whole atlas in view, with a margin.
  fit() {
    const { atlas } = this.editor;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width === 0 || height === 0) return;
    const zoom = Math.min((width - 40) / atlas.width, (height - 40) / atlas.height);
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor(zoom) || MIN_ZOOM));
    this.origin = {
      x: Math.round((width - atlas.width * this.zoom) / 2),
      y: Math.round((height - atlas.height * this.zoom) / 2),
    };
    this.fitted = `${atlas.width}x${atlas.height}`;
    this.moved = false;
  }

  // A point of the canvas (client coordinates) as a place on the atlas, in pixels.
  toAtlas(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (clientX - rect.left - this.origin.x) / this.zoom, y: (clientY - rect.top - this.origin.y) / this.zoom };
  }

  // The pixel of the atlas at a point of the canvas, as { x, y }; null off the atlas.
  pixelAt(clientX, clientY) {
    const at = this.toAtlas(clientX, clientY);
    const pixel = { x: Math.floor(at.x), y: Math.floor(at.y) };
    const { atlas } = this.editor;
    return pixel.x >= 0 && pixel.y >= 0 && pixel.x < atlas.width && pixel.y < atlas.height ? pixel : null;
  }

  // A chart's faces on the atlas as they are this moment (a drag in progress changes them).
  polygons(chart) {
    return chart.faces.map((index) => this.editor.mesh.faces[index]?.uv).filter(Boolean);
  }

  // The corners of the picked charts, while the shape lock is open: each
  // { chart, vertex, x, y } - a vertex of the model and its place on the atlas.
  markers() {
    if (!this.shaping) return [];
    const { faces } = this.editor.mesh;
    const found = [];
    for (const chart of this.pickedCharts()) {
      const seen = new Set();
      for (const index of chart.faces) {
        const face = faces[index];
        if (!face?.uv) continue;
        face.forEach((vertex, k) => {
          if (seen.has(vertex) || !face.uv[k]) return;
          seen.add(vertex);
          found.push({ chart, vertex, x: face.uv[k][0], y: face.uv[k][1] });
        });
      }
    }
    return found;
  }

  // The marker at a point of the screen, or null.
  markerAt(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    let best = null;
    let nearest = MARKER_REACH;
    for (const marker of this.markers()) {
      const off = Math.hypot(rect.left + this.origin.x + marker.x * this.zoom - clientX, rect.top + this.origin.y + marker.y * this.zoom - clientY);
      if (off < nearest) {
        nearest = off;
        best = marker;
      }
    }
    return best;
  }

  // The chart under a place on the atlas: the smallest of those whose faces
  // hold it (charts may lie on each other), or null.
  chartAt({ x, y }) {
    const inside = (polygon) => {
      let within = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [ax, ay] = polygon[i];
        const [bx, by] = polygon[j];
        if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) within = !within;
      }
      return within;
    };
    const hit = this.editor.atlas.charts.filter((chart) => this.polygons(chart).some(inside));
    hit.sort((a, b) => a.rect.w * a.rect.h - b.rect.w * b.rect.h);
    return hit[0] ?? null;
  }

  // A press with the marquee: inside the rectangle picked it lifts the
  // pixels (Alt: a copy of them) to be dragged; elsewhere it puts down what
  // floats and starts picking a new rectangle.
  pressMarquee(event) {
    const { editor } = this;
    const at = this.toAtlas(event.clientX, event.clientY);
    const pixel = { x: Math.floor(at.x), y: Math.floor(at.y) };
    const rect = editor.marquee;
    const inside = rect && pixel.x >= rect.x && pixel.y >= rect.y && pixel.x < rect.x + rect.w && pixel.y < rect.y + rect.h;
    if (inside && editor.liftMarquee(event.altKey)) {
      this.drag = { lift: true, x: event.clientX, y: event.clientY, from: { x: editor.floating.x, y: editor.floating.y } };
      return;
    }
    editor.commitFloating();
    const { width, height } = editor.atlas;
    const from = { x: Math.max(0, Math.min(width - 1, pixel.x)), y: Math.max(0, Math.min(height - 1, pixel.y)) };
    this.drag = { select: true, from, x: event.clientX, y: event.clientY, moved: false };
  }

  // The pointer moves with the marquee: the rectangle is drawn out, or what
  // floats goes along, by whole pixels.
  moveMarquee(event) {
    const { editor, drag, canvas } = this;
    const at = this.toAtlas(event.clientX, event.clientY);
    const pixel = { x: Math.floor(at.x), y: Math.floor(at.y) };
    if (drag?.select) {
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) <= CLICK) return;
      drag.moved = true;
      const { width, height } = editor.atlas;
      const to = { x: Math.max(0, Math.min(width - 1, pixel.x)), y: Math.max(0, Math.min(height - 1, pixel.y)) };
      const x = Math.min(drag.from.x, to.x);
      const y = Math.min(drag.from.y, to.y);
      editor.setMarquee({ x, y, w: Math.abs(to.x - drag.from.x) + 1, h: Math.abs(to.y - drag.from.y) + 1 });
      return;
    }
    if (drag?.lift) {
      editor.moveFloating(
        drag.from.x + Math.round((event.clientX - drag.x) / this.zoom),
        drag.from.y + Math.round((event.clientY - drag.y) / this.zoom),
      );
      return;
    }
    // Over the rectangle picked the pointer says it can be moved.
    const rect = editor.marquee;
    const inside = rect && pixel.x >= rect.x && pixel.y >= rect.y && pixel.x < rect.x + rect.w && pixel.y < rect.y + rect.h;
    canvas.style.cursor = inside ? 'move' : 'crosshair';
  }

  bindPointer() {
    const { canvas, editor } = this;
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      const before = this.toAtlas(event.clientX, event.clientY);
      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(this.zoom * (event.deltaY < 0 ? 1.25 : 0.8)) || MIN_ZOOM));
      this.moved = true;
      if (zoom === this.zoom) this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom + (event.deltaY < 0 ? 1 : -1)));
      else this.zoom = zoom;
      // The pixel under the pointer stays under it.
      const rect = canvas.getBoundingClientRect();
      this.origin = {
        x: Math.round(event.clientX - rect.left - before.x * this.zoom),
        y: Math.round(event.clientY - rect.top - before.y * this.zoom),
      };
      this.draw();
    }, { passive: false });

    canvas.addEventListener('pointerdown', (event) => {
      canvas.setPointerCapture(event.pointerId);
      if (event.button !== 0) {
        this.drag = { pan: true, x: event.clientX, y: event.clientY, origin: { ...this.origin } };
        return;
      }
      if (editor.tool === 'marquee') {
        this.pressMarquee(event);
        return;
      }
      if (editor.busy()) return;
      if (editor.painting) {
        // Here the picture is worked on as a picture: a fill or a shape has the whole of it.
        const pixel = this.pixelAt(event.clientX, event.clientY);
        const line = event.shiftKey ? { pixel } : null; // Shift: a straight line to here first
        if (pixel && editor.paintPress(pixel, null, event.altKey, { line })) this.drag = { paint: true, last: pixel };
        return;
      }
      // A corner's marker first: it lies on the chart it belongs to.
      const marker = this.markerAt(event.clientX, event.clientY);
      if (marker) {
        this.drag = { marker, place: [marker.x, marker.y], moved: false };
        canvas.style.cursor = 'grabbing';
        return;
      }
      const chart = this.chartAt(this.toAtlas(event.clientX, event.clientY));
      this.drag = { chart, x: event.clientX, y: event.clientY, additive: event.shiftKey, moved: false, shift: [0, 0] };
    });
    canvas.addEventListener('pointermove', (event) => {
      const { drag } = this;
      this.pointer = { view: 'uv', x: event.clientX, y: event.clientY };
      if (this.isolating) this.isolate(true);
      if (editor.tool === 'marquee' && !drag?.pan) {
        this.moveMarquee(event);
        return;
      }
      if (editor.painting && !drag?.pan) {
        const pixel = this.pixelAt(event.clientX, event.clientY);
        canvas.style.cursor = 'crosshair';
        if (drag?.paint && editor.stroke?.pick) {
          editor.pickColor(pixel);
        } else if (drag?.paint && editor.stroke?.base) {
          editor.paintDrag(pixel); // a shape drawn out
        } else if (drag?.paint && pixel) {
          // Every pixel on the way from the last one: a quick stroke is told of only now and then.
          const steps = Math.max(Math.abs(pixel.x - drag.last.x), Math.abs(pixel.y - drag.last.y));
          for (let step = 1; step <= steps; step++) {
            editor.strokePixel(
              Math.round(drag.last.x + ((pixel.x - drag.last.x) * step) / steps),
              Math.round(drag.last.y + ((pixel.y - drag.last.y) * step) / steps),
            );
          }
          drag.last = pixel;
        }
        editor.setPaintHover(pixel);
        if (!drag) editor.setLineTarget(pixel ? { pixel } : null);
        return;
      }
      if (!drag) {
        const marker = this.markerAt(event.clientX, event.clientY);
        const chart = marker ? null : this.chartAt(this.toAtlas(event.clientX, event.clientY));
        if (chart !== this.hovered || marker?.vertex !== this.hoveredMarker?.vertex || marker?.chart !== this.hoveredMarker?.chart) {
          this.hovered = chart;
          this.hoveredMarker = marker;
          // A hand on a marker, which is there to be dragged; the plain pointer everywhere else.
          canvas.style.cursor = marker ? 'grab' : '';
          this.draw();
        }
        return;
      }
      if (drag.marker) {
        // The corner goes to the pixel corner nearest the pointer, on the atlas.
        const at = this.toAtlas(event.clientX, event.clientY);
        const place = [
          Math.max(0, Math.min(editor.atlas.width, Math.round(at.x))),
          Math.max(0, Math.min(editor.atlas.height, Math.round(at.y))),
        ];
        if (place[0] === drag.place[0] && place[1] === drag.place[1]) return;
        drag.place = place;
        drag.moved = true;
        editor.shapeCorner(drag.marker.chart.faces, drag.marker.vertex, place, false);
        this.draw();
        return;
      }
      if (drag.pan) {
        this.origin = { x: drag.origin.x + event.clientX - drag.x, y: drag.origin.y + event.clientY - drag.y };
        this.moved = true;
        this.draw();
        return;
      }
      if (!drag.chart) return;
      if (!drag.moved) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) <= CLICK) return;
        // The drag starts: the chart under the pointer is picked, if it was not.
        drag.moved = true;
        if (!this.pickedCharts().includes(drag.chart)) this.pick(drag.chart, drag.additive);
        drag.charts = this.pickedCharts();
        drag.lead = drag.charts.find((chart) => chart.faces.includes(drag.chart.faces[0])) ?? drag.charts[0];
      }
      const shift = this.snapped(drag, (event.clientX - drag.x) / this.zoom, (event.clientY - drag.y) / this.zoom);
      if (shift[0] === drag.shift[0] && shift[1] === drag.shift[1]) return;
      drag.shift = shift;
      // The model shows it as it goes.
      editor.previewCharts(this.pickedFaces(), shift);
      this.draw();
    });
    const release = (event) => {
      const { drag } = this;
      this.drag = null;
      if (drag?.paint) editor.endPaint();
      // A click with the marquee, not a drag: nothing picked.
      if (drag?.select && !drag.moved && event.type === 'pointerup') editor.setMarquee(null);
      if (!drag || drag.pan || drag.paint || drag.select || drag.lift) return;
      if (drag.marker) {
        // Let go: the corner stays where it was dragged to, or, if the drag was broken off, goes back.
        const { chart, vertex, x, y } = drag.marker;
        const settled = event.type === 'pointerup' && drag.moved && (drag.place[0] !== x || drag.place[1] !== y);
        if (settled) editor.shapeCorner(chart.faces, vertex, drag.place, true);
        else editor.previewCharts(chart.faces, null);
        canvas.style.cursor = this.markerAt(event.clientX, event.clientY) ? 'grab' : '';
        this.draw();
        return;
      }
      if (!drag.moved) {
        // A click: picks the chart, or with nothing under the pointer picks nothing.
        if (event.type === 'pointerup') this.pick(drag.chart, drag.additive);
        return;
      }
      if (event.type === 'pointerup' && (drag.shift[0] || drag.shift[1])) editor.placeCharts(this.pickedFaces(), { move: drag.shift });
      else editor.previewCharts(this.pickedFaces(), null);
      this.draw();
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('pointerleave', () => {
      if (editor.painting && !this.drag) {
        editor.setPaintHover(null);
        editor.setLineTarget(null);
      }
      if (this.drag || !this.hovered) return;
      this.hovered = null;
      this.draw();
    });
  }

  // How far the dragged charts go, in whole pixels: onto another chart's room
  // if the one that is led comes close to it (so that they share a picture
  // exactly), and not off the atlas.
  snapped(drag, dx, dy) {
    let shift = [Math.round(dx), Math.round(dy)];
    const { rect } = drag.lead;
    let nearest = SNAP + 0.5;
    for (const chart of this.editor.atlas.charts) {
      if (drag.charts.includes(chart)) continue;
      const off = Math.hypot(chart.rect.x - (rect.x + dx), chart.rect.y - (rect.y + dy));
      if (off < nearest) {
        nearest = off;
        shift = [chart.rect.x - rect.x, chart.rect.y - rect.y];
      }
    }
    return shift;
  }

  // Picks a chart: its faces are selected in the scene, in face mode.
  pick(chart, additive) {
    const { editor } = this;
    if (editor.operation) return;
    if (editor.mode !== 'face') editor.setMode('face');
    if (!chart) {
      if (!additive) editor.clearSelection();
      return;
    }
    const picked = new Set(editor.picked);
    const whole = chart.faces.every((face) => picked.has(face));
    if (!additive) {
      chart.faces.forEach((face, k) => editor.select(face, k > 0));
    } else if (whole) {
      for (const face of chart.faces) editor.select(face, true); // Shift on a picked chart lets it go
    } else {
      for (const face of chart.faces) if (!picked.has(face)) editor.select(face, true);
    }
  }

  draw() {
    if (!this.open) return;
    const { canvas, context, editor } = this;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const { atlas } = editor;
    const { zoom, origin } = this;
    const w = atlas.width * zoom;
    const h = atlas.height * zoom;

    // The atlas: a checkerboard where nothing is painted, then the picture, pixel for pixel.
    context.save();
    context.beginPath();
    context.rect(origin.x, origin.y, w, h);
    context.clip();
    const tile = Math.max(4, zoom * 2);
    for (let y = 0; y * tile < h; y++) {
      for (let x = 0; x * tile < w; x++) {
        context.fillStyle = (x + y) % 2 ? theme.bgRaised : theme.bg;
        context.fillRect(origin.x + x * tile, origin.y + y * tile, tile, tile);
      }
    }
    context.imageSmoothingEnabled = false;
    if (this.isolating) {
      // F1 held: all of it faint, and the face under the pointer as it is - to the edges of its pixels.
      context.globalAlpha = DIMMED;
      context.drawImage(atlas.canvas, origin.x, origin.y, w, h);
      context.globalAlpha = 1;
      const uv = this.isolated === null ? null : editor.mesh.faces[this.isolated]?.uv;
      if (uv?.every(Boolean)) {
        context.save();
        context.beginPath();
        for (const key of facePixels(uv)) {
          const [px, py] = key.split(',').map(Number);
          context.rect(origin.x + px * zoom, origin.y + py * zoom, zoom, zoom);
        }
        context.clip();
        context.drawImage(atlas.canvas, origin.x, origin.y, w, h);
        context.restore();
      }
    } else {
      context.drawImage(atlas.canvas, origin.x, origin.y, w, h);
    }
    if (zoom >= GRID_FROM) {
      context.strokeStyle = 'rgba(0, 0, 0, 0.18)';
      context.lineWidth = 1;
      context.beginPath();
      for (let x = 1; x < atlas.width; x++) {
        context.moveTo(origin.x + x * zoom + 0.5, origin.y);
        context.lineTo(origin.x + x * zoom + 0.5, origin.y + h);
      }
      for (let y = 1; y < atlas.height; y++) {
        context.moveTo(origin.x, origin.y + y * zoom + 0.5);
        context.lineTo(origin.x + w, origin.y + y * zoom + 0.5);
      }
      context.stroke();
    }
    context.restore();
    context.strokeStyle = theme.border;
    context.lineWidth = 1;
    context.strokeRect(origin.x - 0.5, origin.y - 0.5, w + 1, h + 1);

    // The faces: every chart's outlines; the pinned ones marked, the picked ones on top.
    // (Under the brush none is shown as picked: its tint would lie over the colours being put on.)
    const { painting } = editor;
    const picked = new Set(painting ? [] : this.pickedCharts());
    // (The faces' places are read as they are this moment: a chart being
    // dragged is already where the drag has taken it, see previewCharts().)
    const outline = (chart) => {
      context.beginPath();
      for (const polygon of this.polygons(chart)) {
        polygon.forEach(([x, y], k) => {
          const px = origin.x + x * zoom;
          const py = origin.y + y * zoom;
          if (k === 0) context.moveTo(px, py);
          else context.lineTo(px, py);
        });
        context.closePath();
      }
    };
    // F1 held: no outlines but the one of the face shown alone (see isolate()).
    const isolatedUV = this.isolating && this.isolated !== null ? editor.mesh.faces[this.isolated]?.uv : null;
    if (isolatedUV?.every(Boolean)) {
      context.beginPath();
      isolatedUV.forEach(([x, y], k) => context[k ? 'lineTo' : 'moveTo'](origin.x + x * zoom, origin.y + y * zoom));
      context.closePath();
      context.lineWidth = 1;
      context.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      context.stroke();
    }
    for (const chart of this.isolating ? [] : atlas.charts) {
      if (picked.has(chart)) continue;
      outline(chart);
      const hovered = chart === this.hovered && !painting;
      context.lineWidth = hovered ? 2 : 1;
      context.strokeStyle = hovered ? theme.hovered : chart.shaped ? SHAPED : chart.pinned ? theme.pivot : 'rgba(255, 255, 255, 0.55)';
      context.stroke();
    }
    for (const chart of this.isolating ? [] : picked) {
      outline(chart);
      context.fillStyle = 'rgba(80, 250, 123, 0.18)';
      context.fill();
      context.lineWidth = 2;
      context.strokeStyle = theme.box;
      context.stroke();
    }
    // The line the brush would paint, Shift held (here or on the model): its
    // pixels in the brush's colour, a little see-through - or, rubbing out,
    // their outlines.
    if (painting && editor.linePreview) {
      const [r, g, b, a] = editor.paintColor;
      context.lineWidth = 1;
      context.fillStyle = `rgba(${r}, ${g}, ${b}, 0.75)`;
      context.strokeStyle = 'rgba(248, 248, 242, 0.8)';
      for (const { pixel } of editor.linePreview) {
        const x = origin.x + pixel.x * zoom;
        const y = origin.y + pixel.y * zoom;
        if (a) context.fillRect(x, y, zoom, zoom);
        else context.strokeRect(x + 0.5, y + 0.5, zoom - 1, zoom - 1);
      }
    }
    // The marquee's rectangle: marching ants - a dashed line, light over dark, that crawls.
    if (editor.tool === 'marquee' && editor.marquee) {
      const { x, y, w: mw, h: mh } = editor.marquee;
      const box = [origin.x + x * zoom + 0.5, origin.y + y * zoom + 0.5, mw * zoom - 1, mh * zoom - 1];
      context.lineWidth = 1;
      context.setLineDash([]);
      context.strokeStyle = '#191a21';
      context.strokeRect(...box);
      context.setLineDash([4, 4]);
      context.lineDashOffset = -this.ants;
      context.strokeStyle = '#f8f8f2';
      context.strokeRect(...box);
      context.setLineDash([]);
      this.crawl();
    }
    // The pixel the brush is on - here or on the model: a frame round it, dark in light.
    if (painting && editor.paintHover && editor.tool !== 'marquee') {
      const x = origin.x + editor.paintHover.x * zoom;
      const y = origin.y + editor.paintHover.y * zoom;
      context.lineWidth = 1;
      context.strokeStyle = '#191a21';
      context.strokeRect(x - 1.5, y - 1.5, zoom + 3, zoom + 3);
      context.strokeStyle = '#f8f8f2';
      context.strokeRect(x - 0.5, y - 0.5, zoom + 1, zoom + 1);
    }
    // The corners, with the shape lock open: a round marker on each.
    for (const marker of painting || this.isolating ? [] : this.markers()) {
      const hot = this.drag?.marker
        ? this.drag.marker.vertex === marker.vertex && this.drag.marker.chart === marker.chart
        : this.hoveredMarker?.vertex === marker.vertex && this.hoveredMarker?.chart === marker.chart;
      context.beginPath();
      context.arc(origin.x + marker.x * zoom, origin.y + marker.y * zoom, hot ? MARKER + 1.5 : MARKER, 0, Math.PI * 2);
      context.fillStyle = hot ? theme.box : '#f8f8f2';
      context.fill();
      context.lineWidth = 1.5;
      context.strokeStyle = '#191a21';
      context.stroke();
    }
    // The atlas' size, over its top right corner - kept in view however the
    // atlas is moved about or zoomed.
    context.font = '12px "Segoe UI", system-ui, sans-serif';
    context.textAlign = 'right';
    context.textBaseline = 'alphabetic';
    const label = `${atlas.width} × ${atlas.height}`;
    const right = Math.max(context.measureText(label).width + 6, Math.min(origin.x + w, width - 6));
    context.fillStyle = theme.textDim;
    context.fillText(label, right, Math.min(Math.max(origin.y - 6, 16), height - 6));
  }
}
