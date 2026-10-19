import * as THREE from 'three';
import { shownSkinNodes, weightsOf } from './skin.js';

// The skin's weights, as Blender's weight paint shows them - in the view's
// shading "Веса скина" (editor.shading 'weights', drawn as solid otherwise):
// with a node picked (see shownSkinNodes()), the surface of every object it bends painted
// by how much - blue nothing, through green and yellow, to red all of it -
// the colour running smoothly over the faces between their corners. As the
// vertices bend: one in no skin goes with its object's node, wholly (see
// weightsOf()). In the model workspace; drawn over the surface, a shade of
// it kept so that its shape can be read.

const VERTEX = /* glsl */ `
attribute float skinWeight;
varying float vWeight;
varying vec3 vNormal;
void main() {
  vWeight = skinWeight;
  vNormal = normalize( normalMatrix * normal );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const FRAGMENT = /* glsl */ `
varying float vWeight;
varying vec3 vNormal;
// Blender's ramp: blue, cyan, green, yellow, red.
vec3 ramp( float w ) {
  w = clamp( w, 0.0, 1.0 );
  if ( w < 0.25 ) return mix( vec3( 0.0, 0.0, 1.0 ), vec3( 0.0, 1.0, 1.0 ), w / 0.25 );
  if ( w < 0.5 ) return mix( vec3( 0.0, 1.0, 1.0 ), vec3( 0.0, 1.0, 0.0 ), ( w - 0.25 ) / 0.25 );
  if ( w < 0.75 ) return mix( vec3( 0.0, 1.0, 0.0 ), vec3( 1.0, 1.0, 0.0 ), ( w - 0.5 ) / 0.25 );
  return mix( vec3( 1.0, 1.0, 0.0 ), vec3( 1.0, 0.0, 0.0 ), ( w - 0.75 ) / 0.25 );
}
void main() {
  if ( vWeight < -0.5 ) discard; // (an object these nodes do not bend)
  float shade = 0.55 + 0.45 * abs( normalize( vNormal ).z );
  gl_FragColor = vec4( ramp( vWeight ) * shade, 0.88 );
  #include <colorspace_fragment>
}
`;

export class SkinHeat {
  constructor(editor) {
    this.editor = editor;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthFunc: THREE.LessEqualDepth,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.mesh = null; // over the view's surface, sharing its geometry
    this.shown = ''; // what the weights were worked out for, last
    editor.viewport.beforeRender = [...(editor.viewport.beforeRender ?? []), () => this.update()];
  }

  update() {
    const { editor } = this;
    const solid = editor.view.solid;
    if (!this.mesh || this.mesh.geometry !== solid.geometry) {
      if (this.mesh) this.mesh.parent?.remove(this.mesh);
      this.mesh = new THREE.Mesh(solid.geometry, this.material);
      this.mesh.frustumCulled = false;
      this.mesh.renderOrder = 2;
      this.mesh.visible = false;
      editor.viewport.scene.add(this.mesh);
      this.shown = '';
    }
    const nodes = editor.workspace === 'model' && editor.shading === 'weights' ? shownSkinNodes(editor) : new Set();
    if (nodes.size === 0) {
      this.mesh.visible = false;
      return;
    }
    // The weights at the surface's corners - worked out anew only when the
    // nodes shown, the weights or the surface have changed.
    const { mesh } = editor;
    const corners = editor.view.triangleIndices ?? [];
    const key = JSON.stringify([[...nodes], editor.history.id]);
    if (key !== this.shown || corners !== this.corners) {
      this.shown = key;
      this.corners = corners;
      const weight = new Float32Array(mesh.vertices.length);
      const bent = new Set(); // the objects these nodes bend, at all
      mesh.vertices.forEach((_, vertex) => {
        let w = 0;
        for (const [node, share] of weightsOf(mesh, vertex)) if (nodes.has(node)) w += share;
        weight[vertex] = w;
        if (w > 0) bent.add(mesh.vertexObject[vertex]);
      });
      // (a corner of an object not bent by them: not painted - marked below nothing)
      const out = new Float32Array(corners.length);
      corners.forEach((vertex, c) => { out[c] = bent.has(mesh.vertexObject[vertex]) ? weight[vertex] : -1; });
      solid.geometry.setAttribute('skinWeight', new THREE.BufferAttribute(out, 1));
      this.anyBent = bent.size > 0;
    }
    this.mesh.visible = this.anyBent;
  }
}
