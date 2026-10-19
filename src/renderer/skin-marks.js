import * as THREE from 'three';

// What the skin binds to a node, shown (see skin.js): with a node picked,
// a green dot on every vertex weighted to it - brighter the more it is -
// seen through the model, where the vertex is shown (posed, too). As
// Blender shows a vertex node's vertices when it is picked.

const COLOR = 0x50fa7b;
const SIZE = 9; // px

const VERTEX = /* glsl */ `
attribute float strength;
uniform float size;
varying float vStrength;
void main() {
  vStrength = strength;
  gl_PointSize = size;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 color;
varying float vStrength;
void main() {
  vec2 at = gl_PointCoord - 0.5;
  float d = length( at );
  if ( d > 0.5 ) discard;
  // a round dot with a dark rim, so that it reads on any colour
  vec3 shade = d > 0.36 ? color * 0.35 : color;
  gl_FragColor = vec4( shade, 0.35 + 0.65 * vStrength );
  #include <colorspace_fragment>
}
`;

export class SkinMarks {
  constructor(editor) {
    this.editor = editor;
    const { viewport } = editor;
    this.material = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(COLOR) }, size: { value: SIZE } },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.points = new THREE.Points(new THREE.BufferGeometry(), this.material);
    this.points.renderOrder = 9;
    this.points.frustumCulled = false;
    this.points.visible = false;
    viewport.scene.add(this.points);
    viewport.beforeRender = [...(viewport.beforeRender ?? []), () => this.update()];
  }

  // The nodes shown: in object mode, those picked whole; in vertex mode,
  // the one the skin panel works with, picked by its row (see selectBound()).
  pickedNodes() {
    const { editor } = this;
    if (editor.preview || editor.painting || editor.simulating) return new Set();
    if (editor.mode === 'vertex') return new Set(editor.skinFocus ? [editor.skinFocus.node] : []);
    if (editor.mode !== 'object') return new Set();
    const { objects } = editor.mesh;
    return new Set([...editor.picked].filter((index) => objects[index]?.kind === 'node').map((index) => objects[index].id));
  }

  // Drawn every time the view is: the dots where the vertices are shown now.
  update() {
    const { editor } = this;
    const nodes = editor.mesh.weights.size ? this.pickedNodes() : new Set();
    const points = [];
    const strengths = [];
    if (nodes.size) {
      const shown = editor.view.shown;
      for (const [vertex, weights] of editor.mesh.weights) {
        const weight = weights.reduce((sum, [node, w]) => sum + (nodes.has(node) ? w : 0), 0);
        if (weight <= 0 || !shown[vertex]) continue;
        points.push(shown[vertex].x, shown[vertex].y, shown[vertex].z);
        strengths.push(weight);
      }
    }
    this.points.visible = points.length > 0;
    if (!this.points.visible) return;
    this.points.geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    this.points.geometry.setAttribute('strength', new THREE.Float32BufferAttribute(strengths, 1));
    this.material.uniforms.size.value = SIZE * (window.devicePixelRatio || 1);
  }
}
