import * as THREE from 'three';

// Every node shown by a mark of its own - a hollow square, so many px across
// whatever the zoom, on its pivot point (where it is posed, in the
// animation mode) - seen through the model and anything else: a node has
// no faces to be seen by, as Blender shows an empty. The picked ones'
// thicker and brighter. Hidden nodes have none. In the main view here
// (NodeMarks), in the three views by nodePlaces() (see ortho-views.js).

export const NODE_MARK = {
  color: '#ffb86c', // the nodes' colour (a picked node's bounds, the scene tree's lock)
  size: 11, // px across
  line: 1.5, // px, the square's line; a picked node's twice that
  faint: 0.75, // how much of it is drawn, not picked
  picked: 2, // a picked node's square, so many times as large - grown into, and back
  glide: 45, // ms: how quickly it grows or shrinks (see sizeOf())
};

// How large each node's square is now, as a share of NODE_MARK.size: going
// to `picked` times when picked, back to 1 when not - every frame a share of
// what is left, by the time since (1 - e^(-dt/glide)): the same on any screen.
// One for every view that draws them, so that they grow together.
const sizes = new Map(); // node id -> { value, last }
let growing = false; // some square is on its way, as last worked out

function sizeOf(id, picked, now) {
  const target = picked ? NODE_MARK.picked : 1;
  const entry = sizes.get(id) ?? { value: target, last: now };
  // (the view is drawn when something changes: from a still frame long ago, one frame's step)
  const t = 1 - Math.exp(-Math.min(Math.max(0, now - entry.last), 34) / NODE_MARK.glide);
  entry.value += (target - entry.value) * t;
  if (Math.abs(target - entry.value) < 0.005) entry.value = target;
  else growing = true;
  entry.last = now;
  sizes.set(id, entry);
  return entry.value;
}

// Where the nodes are now: [{ index, at (Vector3), picked, size (px) }] -
// their pivot points, posed if the animation mode (`animation`) is posing
// the model. `growing` on the result: some square is still on its way, to
// be drawn again on the next frame.
export function nodePlaces(editor, animation = null) {
  growing = false;
  const now = performance.now();
  const { islands } = editor.topology;
  const posed = animation?.on && animation.pose?.on ? animation.matrices : null;
  const picked = editor.mode === 'object' ? editor.picked : new Set();
  const out = [];
  editor.mesh.objects.forEach((object, index) => {
    if (object.kind !== 'node' || islands[index]?.hidden) return;
    const matrix = posed?.get(object.id);
    const chosen = picked.has(index);
    out.push({ index, at: matrix ? new THREE.Vector3().setFromMatrixPosition(matrix) : editor.pivotPoint(index), picked: chosen, size: NODE_MARK.size * sizeOf(object.id, chosen, now) });
  });
  out.growing = growing;
  return out;
}

const VERTEX = /* glsl */ `
attribute float picked;
attribute float size;
uniform float ratio;
varying float vPicked;
varying float vSize;
void main() {
  vPicked = picked;
  vSize = size * ratio;
  gl_PointSize = vSize;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 color;
uniform float line;
uniform float faint;
varying float vPicked;
varying float vSize;
void main() {
  // a square's outline: the pixels within so many of the point's edge
  vec2 px = gl_PointCoord * vSize;
  float width = line * ( 1.0 + vPicked );
  float edge = min( min( px.x, px.y ), min( vSize - px.x, vSize - px.y ) );
  if ( edge > width ) discard;
  gl_FragColor = vec4( color, vPicked > 0.5 ? 1.0 : faint );
  #include <colorspace_fragment>
}
`;

export class NodeMarks {
  constructor(editor, animation) {
    this.editor = editor;
    this.animation = animation;
    const ratio = () => window.devicePixelRatio || 1;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        color: { value: new THREE.Color(NODE_MARK.color) },
        ratio: { value: ratio() },
        line: { value: NODE_MARK.line * ratio() },
        faint: { value: NODE_MARK.faint },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.points = new THREE.Points(new THREE.BufferGeometry(), this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 8;
    editor.viewport.scene.add(this.points);
    editor.viewport.beforeRender = [...(editor.viewport.beforeRender ?? []), () => this.update()];
  }

  update() {
    const { editor } = this;
    const places = editor.preview || editor.simulating ? [] : nodePlaces(editor, this.animation);
    this.points.visible = places.length > 0;
    if (!this.points.visible) return;
    const geometry = this.points.geometry;
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(places.flatMap(({ at }) => at.toArray()), 3));
    geometry.setAttribute('picked', new THREE.Float32BufferAttribute(places.map(({ picked }) => (picked ? 1 : 0)), 1));
    geometry.setAttribute('size', new THREE.Float32BufferAttribute(places.map(({ size }) => size), 1));
    const ratio = window.devicePixelRatio || 1;
    this.material.uniforms.ratio.value = ratio;
    this.material.uniforms.line.value = NODE_MARK.line * ratio;
    // (a square on its way: drawn again on the next frame)
    if (places.growing) requestAnimationFrame(() => editor.viewport.requestRender());
  }
}
