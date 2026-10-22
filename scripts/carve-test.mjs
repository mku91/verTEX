// node scripts/carve-test.mjs: the carving (src/renderer/carve.js) on a few
// shapes - each must come out closed (every edge in two faces, once each
// way), facing out (a positive volume) and with the count of holes it should
// have (Euler's V - E + F).
import { newCarve, buildCarve } from '../src/renderer/carve.js';

const box = { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] };
const circle = (r, n = 8) => Array.from({ length: n }, (_, i) => [r * Math.cos((i / n) * 2 * Math.PI), r * Math.sin((i / n) * 2 * Math.PI)]);
const square = (h) => [[-h, -h], [h, -h], [h, h], [-h, h]];
const triangle = [[-0.5, 0], [0.5, 0], [0, 1]];

function check(name, shape, { euler = 2, volume = null, vertices = null, faces = null } = {}) {
  if (!shape) {
    console.log(`FAIL ${name}: nothing`);
    return false;
  }
  const edges = new Map();
  for (const face of shape.faces) face.forEach((a, k) => {
    const key = `${a}>${face[(k + 1) % face.length]}`;
    edges.set(key, (edges.get(key) ?? 0) + 1);
  });
  let open = 0;
  for (const [key, n] of edges) {
    const [a, b] = key.split('>');
    if (n !== 1 || edges.get(`${b}>${a}`) !== 1) open++;
  }
  // Volume by the divergence theorem, each face as a fan from its first corner.
  let v = 0;
  for (const face of shape.faces) {
    const p = face.map((i) => shape.vertices[i]);
    for (let k = 1; k < p.length - 1; k++) {
      const [a, b, c] = [p[0], p[k], p[k + 1]];
      v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
  }
  const E = edges.size / 2;
  const chi = shape.vertices.length - E + shape.faces.length;
  const ok = open === 0 && v > 0 && chi === euler && (volume === null || Math.abs(v - volume) < 1e-3) &&
    (vertices === null || shape.vertices.length === vertices) && (faces === null || shape.faces.length === faces);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${shape.vertices.length} vertices, ${shape.faces.length} faces, open edges ${open}, volume ${v.toFixed(4)}, V-E+F ${chi}`);
  return ok;
}

// The widths of a shape at some heights: how far along x its edges reach there.
function widths(shape, heights) {
  return heights.map((y) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const face of shape.faces) face.forEach((a, k) => {
      const p = shape.vertices[a];
      const q = shape.vertices[face[(k + 1) % face.length]];
      if ((p[1] - y) * (q[1] - y) > 0 || p[1] === q[1]) return;
      const t = (y - p[1]) / (q[1] - p[1]);
      const x = p[0] + t * (q[0] - p[0]);
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    });
    return +(hi - lo).toFixed(3);
  });
}

let all = true;

// Every level whole: the box itself.
all &= check('whole', await buildCarve(newCarve(box, 4)), { volume: 1, vertices: 8, faces: 6 });

// A circle from above at every level, triangles from the front and the side: a cone, smooth.
{
  const carve = newCarve(box, 4);
  carve.stacks.y.slices = carve.stacks.y.slices.map(() => [{ points: circle(0.5) }]);
  carve.stacks.z.slices = carve.stacks.z.slices.map(() => [{ points: triangle }]);
  carve.stacks.x.slices = carve.stacks.x.slices.map(() => [{ points: triangle }]);
  all &= check('cone', await buildCarve(carve));
}

// The user's vase: narrow, wide, narrow, narrow squares from above; a vase's outline from the front and the side.
{
  const outline = [[-0.25, 0], [-0.5, 0.25], [-0.5, 0.5], [-0.25, 1], [0.25, 1], [0.5, 0.5], [0.5, 0.25], [0.25, 0]];
  const carve = newCarve(box, 4);
  carve.stacks.y.slices = [[{ points: square(0.25) }], [{ points: square(0.5) }], [{ points: square(0.25) }], [{ points: square(0.25) }]];
  carve.stacks.z.slices = carve.stacks.z.slices.map(() => [{ points: outline }]);
  carve.stacks.x.slices = carve.stacks.x.slices.map(() => [{ points: outline.map(([u, v]) => [-u, v]) }]);
  const shape = await buildCarve(carve);
  all &= check('vase', shape);
  // Its width through the middle: from 0.5 at the bottom out to 1 at a third, back to 0.5 at two thirds - no steps.
  const at = widths(shape, [0.01, 1 / 6, 1 / 3, 0.5, 2 / 3, 0.99]);
  const smooth = Math.abs(at[0] - 0.5) < 0.03 && at[1] > at[0] && Math.abs(at[2] - 1) < 0.03 && at[3] < at[2] && Math.abs(at[4] - 0.5) < 0.03;
  console.log(`${smooth ? 'ok  ' : 'FAIL'} vase widths at y = 0, 1/6, 1/3, 1/2, 2/3, 1: ${at.join(', ')}`);
  all &= smooth;
}

// An empty level: the solid stops there (the depth levels 0, 1 whole, 2 empty, 3 whole: only the first third is left).
{
  const carve = newCarve(box, 4);
  carve.stacks.z.slices[2] = [];
  all &= check('empty level', await buildCarve(carve), { volume: 1 / 3 });
}

// One level alone: its section through the whole box.
{
  const carve = newCarve(box, { y: 1, z: 4, x: 4 });
  carve.stacks.y.slices = [[{ points: square(0.25) }]];
  all &= check('one level', await buildCarve(carve), { volume: 0.25, vertices: 8 });
}

// Nothing at all left.
{
  const carve = newCarve(box, 2);
  carve.stacks.x.slices = [[], []];
  console.log(`${(await buildCarve(carve)) === null ? 'ok  ' : 'FAIL'} empty: nothing`);
}

console.log(all ? 'all good' : 'SOMETHING FAILED');
process.exit(all ? 0 : 1);
