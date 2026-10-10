import { theme, onThemeChange } from './theme.js';

// The UV editor: the atlas, flat, with the faces drawn on it.
//
// It is where a face is given a picture other than the one the unwrap gave
// it: a chart (the faces that lie on the atlas as one piece) is picked and
// dragged to another place - on top of another chart, if they are to share a
// picture - turned by quarter turns, or turned over. Nothing is stretched and
// no pixel is painted or moved here; only where the faces look changes. A
// chart placed so is pinned (see unwrap.js), and "auto" gives it back.
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

    this.canvas = container.querySelector('canvas');
    this.context = this.canvas.getContext('2d');
    this.status = container.querySelector('.uv-status');
    for (const button of container.querySelectorAll('[data-uv]')) {
      button.addEventListener('mousedown', (event) => event.preventDefault()); // keep the keyboard focus
      button.addEventListener('click', () => this.command(button.dataset.uv));
    }

    new ResizeObserver(() => this.draw()).observe(this.canvas);
    editor.addEventListener('change', () => this.update());
    editor.atlas.addEventListener('change', () => this.draw());
    editor.atlas.addEventListener('layout', () => this.update());
    onThemeChange(() => this.draw());
    this.bindPointer();
  }

  toggle(open = !this.open) {
    this.open = open;
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
    const charts = this.pickedCharts();
    for (const button of this.container.querySelectorAll('[data-uv]')) {
      if (button.dataset.uv !== 'fit') button.disabled = charts.length === 0;
    }
    this.container.querySelector('[data-uv="auto"]').disabled = !charts.some((chart) => chart.pinned);
    this.status.textContent = charts.length === 0
      ? 'Клик по грани на атласе выбирает её лоскут'
      : charts.length === 1
        ? `${charts[0].rect.w} × ${charts[0].rect.h} px, место ${charts[0].rect.x}, ${charts[0].rect.y}${charts[0].pinned ? ' · закреплён' : ''}`
        : `Лоскутов: ${charts.length}`;
    this.draw();
  }

  command(name) {
    const faces = this.pickedFaces();
    if (name === 'fit') {
      this.fit();
      this.draw();
    } else if (name === 'turn-left') this.editor.placeCharts(faces, { turn: -1 });
    else if (name === 'turn-right') this.editor.placeCharts(faces, { turn: 1 });
    else if (name === 'flip-h') this.editor.placeCharts(faces, { flip: 'h' });
    else if (name === 'flip-v') this.editor.placeCharts(faces, { flip: 'v' });
    else if (name === 'auto') this.editor.placeCharts(faces, { auto: true });
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
  }

  // A point of the canvas (client coordinates) as a place on the atlas, in pixels.
  toAtlas(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (clientX - rect.left - this.origin.x) / this.zoom, y: (clientY - rect.top - this.origin.y) / this.zoom };
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
    const hit = this.editor.atlas.charts.filter((chart) => chart.polygons.some(inside));
    hit.sort((a, b) => a.rect.w * a.rect.h - b.rect.w * b.rect.h);
    return hit[0] ?? null;
  }

  bindPointer() {
    const { canvas, editor } = this;
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      const before = this.toAtlas(event.clientX, event.clientY);
      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(this.zoom * (event.deltaY < 0 ? 1.25 : 0.8)) || MIN_ZOOM));
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
      if (editor.busy()) return;
      const chart = this.chartAt(this.toAtlas(event.clientX, event.clientY));
      this.drag = { chart, x: event.clientX, y: event.clientY, additive: event.shiftKey, moved: false, shift: [0, 0] };
    });
    canvas.addEventListener('pointermove', (event) => {
      const { drag } = this;
      if (!drag) {
        const chart = this.chartAt(this.toAtlas(event.clientX, event.clientY));
        if (chart !== this.hovered) {
          this.hovered = chart;
          canvas.style.cursor = chart ? 'grab' : '';
          this.draw();
        }
        return;
      }
      if (drag.pan) {
        this.origin = { x: drag.origin.x + event.clientX - drag.x, y: drag.origin.y + event.clientY - drag.y };
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
        canvas.style.cursor = 'grabbing';
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
      if (!drag || drag.pan) return;
      canvas.style.cursor = this.hovered ? 'grab' : '';
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
    context.drawImage(atlas.canvas, origin.x, origin.y, w, h);
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
    const picked = new Set(this.pickedCharts());
    const outline = (chart, shift = [0, 0]) => {
      context.beginPath();
      for (const polygon of chart.polygons) {
        polygon.forEach(([x, y], k) => {
          const px = origin.x + (x + shift[0]) * zoom;
          const py = origin.y + (y + shift[1]) * zoom;
          if (k === 0) context.moveTo(px, py);
          else context.lineTo(px, py);
        });
        context.closePath();
      }
    };
    for (const chart of atlas.charts) {
      if (picked.has(chart)) continue;
      outline(chart);
      context.lineWidth = chart === this.hovered ? 2 : 1;
      context.strokeStyle = chart === this.hovered ? theme.hovered : chart.pinned ? theme.pivot : 'rgba(255, 255, 255, 0.55)';
      context.stroke();
    }
    const shift = this.drag?.moved ? this.drag.shift : [0, 0];
    for (const chart of picked) {
      outline(chart, shift[0] || shift[1] ? editor.chartShift(chart, shift[0], shift[1]) : shift);
      context.fillStyle = 'rgba(80, 250, 123, 0.18)';
      context.fill();
      context.lineWidth = 2;
      context.strokeStyle = theme.box;
      context.stroke();
    }
  }
}
