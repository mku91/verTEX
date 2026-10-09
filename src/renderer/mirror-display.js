import * as THREE from 'three';
import { axisColor } from './theme.js';

const GLOBAL_HALF = 3; // world units: the global planes are drawn this far from the origin
const LOCAL_MARGIN = 0.4; // beyond the object's bounds
const FILL_OPACITY = 0.07;
const EDGE_OPACITY = 0.45;

// Shows the mirror planes in the scene: the global ones through the origin,
// and every object's own ones through its pivot point. Each is a faint sheet
// with an outline, in the colour of the axis it is perpendicular to.
export class MirrorDisplay {
  constructor(viewport, editor) {
    this.viewport = viewport;
    this.editor = editor;
    this.group = new THREE.Group();
    this.group.renderOrder = 0.4;
    viewport.scene.add(this.group);
    this.sheets = [];
  }

  // Rebuilds the sheets from the editor's state.
  update() {
    const { editor, group } = this;
    for (const sheet of this.sheets) {
      group.remove(sheet);
      sheet.geometry.dispose();
      sheet.material.dispose();
      sheet.children[0]?.geometry.dispose();
      sheet.children[0]?.material.dispose();
    }
    this.sheets = [];

    const wanted = []; // { axis, value, centre: Vector3, half: Vector2 (in-plane extents) }
    for (const axis of editor.mirror.globalAxes) {
      wanted.push({ axis, value: 0, centre: new THREE.Vector3(), half: GLOBAL_HALF });
    }
    editor.mesh.objects.forEach((object, entry) => {
      const island = editor.topology.islands[entry];
      if (!object.mirror?.length || !island || island.hidden || island.vertices.length === 0) return;
      const box = new THREE.Box3().setFromPoints(island.vertices.map((i) => editor.mesh.vertices[i]));
      const centre = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const half = Math.max(size.x, size.y, size.z) / 2 + LOCAL_MARGIN;
      const pivot = editor.pivotPoint(entry);
      for (const axis of object.mirror) {
        const at = centre.clone();
        at[axis] = pivot[axis];
        wanted.push({ axis, value: pivot[axis], centre: at, half });
      }
    });

    for (const { axis, centre, half } of wanted) {
      const color = new THREE.Color(axisColor(axis));
      const sheet = new THREE.Mesh(
        new THREE.PlaneGeometry(half * 2, half * 2),
        new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: FILL_OPACITY, side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      const outline = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-half, -half, 0), new THREE.Vector3(half, -half, 0),
          new THREE.Vector3(half, half, 0), new THREE.Vector3(-half, half, 0),
        ]),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: EDGE_OPACITY, depthWrite: false }),
      );
      sheet.add(outline);
      // The plane geometry faces +Z; turn it to face the axis.
      if (axis === 'x') sheet.rotation.y = Math.PI / 2;
      if (axis === 'y') sheet.rotation.x = -Math.PI / 2;
      sheet.position.copy(centre);
      sheet.renderOrder = 0.4;
      group.add(sheet);
      this.sheets.push(sheet);
    }
    this.viewport.requestRender();
  }
}
