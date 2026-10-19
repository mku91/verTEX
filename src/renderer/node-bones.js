import * as THREE from 'three';
import { NODE_MARK, nodePlaces } from './node-marks.js';

// The skeleton shown: a bone from every node to each node inside it - from
// one pivot point (the joint) to the other - drawn as Blender draws its
// octahedral bones, side on: a narrow kite, widest a little way from the
// head and pointed at the tail. Seen through the model, in the nodes'
// colour; a picked node's bones brighter. A node with no node inside it has
// none (its square says where it is, see node-marks.js). In the main view
// here (NodeBones), in the three views by boneKites() (see ortho-views.js).

const WIDEST = 0.15; // of the bone's length from the head, where it is widest
const WIDTH = 0.08; // of its length, half the width there
const FAINT = 0.55; // how much of a bone is drawn, its node not picked

// The bones as kites: [{ head, waist, tail, picked }] - the points of each
// (Vector3, in the world: head, the widest place's middle, tail), the
// node it comes from picked or not; for `places` (nodePlaces()).
export function bones(editor, places) {
  const { islands } = editor.topology;
  const byIndex = new Map(places.map((place) => [place.index, place]));
  const out = [];
  for (const place of places) {
    const parent = islands[place.index]?.parentIndex;
    const head = byIndex.get(parent);
    if (!head || head.at.distanceToSquared(place.at) < 1e-10) continue;
    const waist = head.at.clone().lerp(place.at, WIDEST);
    out.push({ head: head.at, waist, tail: place.at, picked: head.picked, length: head.at.distanceTo(place.at) });
  }
  return out;
}

// A bone's kite as four points seen along `look` (where the eye looks, in
// the world): head, one side, tail, the other side.
export function kite({ head, waist, tail, length }, look) {
  const along = tail.clone().sub(head);
  const side = along.clone().cross(look);
  if (side.lengthSq() < 1e-12) side.copy(along).cross(Math.abs(along.y) < 0.9 * along.length() ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0));
  side.setLength(length * WIDTH);
  return [head, waist.clone().add(side), tail, waist.clone().sub(side)];
}

const VERTEX = /* glsl */ `
attribute float picked;
varying float vPicked;
void main() {
  vPicked = picked;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 color;
uniform float faint;
varying float vPicked;
void main() {
  gl_FragColor = vec4( color, vPicked > 0.5 ? 1.0 : faint );
  #include <colorspace_fragment>
}
`;

export class NodeBones {
  constructor(editor, animation) {
    this.editor = editor;
    this.animation = animation;
    this.material = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(NODE_MARK.color) }, faint: { value: FAINT } },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), this.material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 8;
    editor.viewport.scene.add(this.lines);
    editor.viewport.beforeRender = [...(editor.viewport.beforeRender ?? []), () => this.update()];
  }

  update() {
    const { editor } = this;
    const list = editor.preview || editor.simulating ? [] : bones(editor, nodePlaces(editor, this.animation));
    this.lines.visible = list.length > 0;
    if (!this.lines.visible) return;
    const camera = editor.viewport.camera;
    const look = new THREE.Vector3();
    const points = [];
    const picked = [];
    for (const bone of list) {
      // (seen from the camera: the kite faces it)
      look.copy(bone.waist).sub(camera.position).normalize();
      const [a, b, c, d] = kite(bone, look);
      for (const [p, q] of [[a, b], [b, c], [c, d], [d, a]]) {
        points.push(p.x, p.y, p.z, q.x, q.y, q.z);
        picked.push(bone.picked ? 1 : 0, bone.picked ? 1 : 0);
      }
    }
    this.lines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    this.lines.geometry.setAttribute('picked', new THREE.Float32BufferAttribute(picked, 1));
  }
}
