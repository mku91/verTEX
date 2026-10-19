import * as THREE from 'three';

// The ghost of the keyed pose (see animate.js): what was posed by hand and
// not keyed goes back where the clip has it as soon as the frame changes -
// the objects it would go back, drawn there, see-through purple and untextured,
// a faint surface with its edges over it.

const COLOR = 0xbd93f9; // Dracula's purple
const SURFACE_OPACITY = 0.12;
const EDGE_OPACITY = 0.4;
const SAME = 1e-6; // matrices this near are the same place

const differ = (a, b) => a.elements.some((value, i) => Math.abs(value - b.elements[i]) > SAME);

export class PoseGhost {
  constructor(editor) {
    this.editor = editor;
    const material = (opacity, Kind) => new Kind({ color: COLOR, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
    this.surface = new THREE.Mesh(new THREE.BufferGeometry(), material(SURFACE_OPACITY, THREE.MeshBasicMaterial));
    this.edges = new THREE.LineSegments(new THREE.BufferGeometry(), material(EDGE_OPACITY, THREE.LineBasicMaterial));
    for (const part of [this.surface, this.edges]) {
      part.renderOrder = 5; // over the model, which it is in part inside of
      part.frustumCulled = false;
      part.visible = false;
      editor.viewport.scene.add(part);
    }
  }

  // `pose`: the ModelPose (its objects' vertices in their frames); `shown`
  // and `keyed`: Map id -> Matrix4, where the objects are shown and where the
  // keys alone would have them. Shown: those that are not where keyed.
  update(pose, shown, keyed) {
    const moved = new Set();
    if (pose?.on && keyed) {
      for (const [id, matrix] of keyed) if (shown.has(id) && differ(matrix, shown.get(id))) moved.add(id);
    }
    const { mesh, view, viewport } = this.editor;
    const at = new Map(); // vertex -> where the keys have it
    for (const id of moved) {
      const object = pose.objects.get(id);
      if (!object) continue;
      object.vertices.forEach((vertex, k) => at.set(vertex, object.local[k].clone().applyMatrix4(keyed.get(id))));
    }
    const triangles = [];
    const drawn = new Set(); // (the vertices of the faces drawn: not those hidden)
    const indices = view.triangleIndices ?? [];
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const corners = [indices[i], indices[i + 1], indices[i + 2]];
      if (!corners.every((vertex) => at.has(vertex))) continue;
      for (const vertex of corners) {
        triangles.push(...at.get(vertex).toArray());
        drawn.add(vertex);
      }
    }
    const lines = [];
    for (const [a, b] of mesh.edges()) if (drawn.has(a) && drawn.has(b)) lines.push(...at.get(a).toArray(), ...at.get(b).toArray());
    this.surface.geometry.setAttribute('position', new THREE.Float32BufferAttribute(triangles, 3));
    this.edges.geometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    const wasShown = this.surface.visible;
    this.surface.visible = triangles.length > 0;
    this.edges.visible = lines.length > 0;
    if (wasShown || this.surface.visible || this.edges.visible) viewport.requestRender();
  }

  hide() {
    this.update(null, null, null);
  }
}
