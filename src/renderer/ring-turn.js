import * as THREE from 'three';

// A rotation gizmo's ring turns as the pointer goes round it - as Blender's
// dial does: the pointer is found on the ring's own plane (where the line of
// sight through it meets that plane), and the angle it has gone round the
// gizmo's middle there since the ring was taken is the turn. So the point
// taken stays under the pointer, all the way round and round again.
// (TransformControls' own measures the pointer's way along the ring's tangent
// where it was taken: gone on round the ring, the turn came back.) Its
// rotation snap rounds that angle.
//
// A ring seen nearly edge on has no angle to speak of - its plane runs along
// the line of sight: there TransformControls' own way is left to it.
//
// `gizmo` is a TransformControls; it is changed in place.

const EDGE_ON = 0.15; // |cos| between the axis and the line of sight below which a ring is "edge on"
const AXES = { X: new THREE.Vector3(1, 0, 0), Y: new THREE.Vector3(0, 1, 0), Z: new THREE.Vector3(0, 0, 1) };

const axis = new THREE.Vector3();
const across = new THREE.Vector3(); // two directions in the ring's plane, at right angles
const along = new THREE.Vector3();
const hit = new THREE.Vector3();
const plane = new THREE.Plane();
const raycaster = new THREE.Raycaster();
const turn = new THREE.Quaternion();

export function ringTurn(gizmo) {
  const pointerDown = gizmo.pointerDown.bind(gizmo);
  const pointerMove = gizmo.pointerMove.bind(gizmo);
  let ring = null; // { last, total } - the pointer's angle last seen, and the turn so far

  // The ring's axis (`name`) in the world, as the drag began.
  const axisOf = (name) => {
    axis.copy(AXES[name]);
    if (gizmo.space === 'local') axis.applyQuaternion(gizmo.worldQuaternionStart);
    return axis;
  };

  // The pointer's angle round the ring `name` about the gizmo's middle, on
  // the ring's plane, forwards as a turn about the axis goes; null if the
  // line of sight misses the plane (the pointer's place is in the camera's
  // -1..1 coordinates).
  const angleOf = (pointer, name) => {
    const normal = axisOf(name);
    plane.setFromNormalAndCoplanarPoint(normal, gizmo.worldPositionStart);
    raycaster.setFromCamera(pointer, gizmo.camera);
    if (!raycaster.ray.intersectPlane(plane, hit)) return null;
    hit.sub(gizmo.worldPositionStart);
    across.set(1, 0, 0);
    if (Math.abs(normal.x) > 0.9) across.set(0, 1, 0);
    across.cross(normal).normalize(); // (across, along, normal) right-handed
    along.crossVectors(normal, across);
    return Math.atan2(hit.dot(along), hit.dot(across));
  };

  gizmo.pointerDown = (pointer) => {
    pointerDown(pointer);
    const name = gizmo.axis;
    // (A ring edge on is TransformControls' for the whole drag: the camera does not move meanwhile.)
    const taken = gizmo.dragging && pointer && gizmo.mode === 'rotate' && AXES[name] && Math.abs(axisOf(name).dot(gizmo.eye)) >= EDGE_ON;
    const last = taken ? angleOf(pointer, name) : null;
    ring = last === null ? null : { last, total: 0 };
  };

  gizmo.pointerMove = (pointer) => {
    const name = gizmo.axis;
    if (gizmo.mode !== 'rotate' || !AXES[name] || !ring || !pointer || !gizmo.dragging || gizmo.object === undefined || pointer.button !== -1) {
      pointerMove(pointer);
      return;
    }
    const local = gizmo.space === 'local';
    const now = angleOf(pointer, name);
    if (now === null) return; // (the line of sight past the plane: the pointer gone over the horizon)
    // The way round since the last move, the short way: added up, it can go
    // past half a turn, and round again.
    let step = now - ring.last;
    if (step > Math.PI) step -= 2 * Math.PI;
    if (step < -Math.PI) step += 2 * Math.PI;
    ring.last = now;
    ring.total += step;
    let angle = ring.total;
    if (gizmo.rotationSnap) angle = Math.round(angle / gizmo.rotationSnap) * gizmo.rotationSnap;

    // Applied as TransformControls applies its own.
    const { object } = gizmo;
    gizmo.rotationAxis.copy(AXES[name]);
    gizmo.rotationAngle = angle;
    if (local) {
      object.quaternion.copy(gizmo._quaternionStart).multiply(turn.setFromAxisAngle(gizmo.rotationAxis, angle)).normalize();
    } else {
      gizmo.rotationAxis.applyQuaternion(gizmo._parentQuaternionInv);
      object.quaternion.copy(turn.setFromAxisAngle(gizmo.rotationAxis, angle)).multiply(gizmo._quaternionStart).normalize();
    }
    gizmo.dispatchEvent({ type: 'change' });
    gizmo.dispatchEvent({ type: 'objectChange' });
  };
}
