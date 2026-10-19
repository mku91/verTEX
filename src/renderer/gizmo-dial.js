import * as THREE from 'three';

// A rotation gizmo's ring, while it is held: a dial. The ring taken (an
// axis' or the outer one, about the line of sight) gives way at once to a
// ring of dots in its colour that turns with what is turned - the dot where
// it was taken larger, a hand to read the turn by - by the angle and about
// the axis
// TransformControls turns it by (see its pointerMove). Let go, the dots
// shrink away and the ring comes back. (The free ring, XYZE, turns about no
// one axis: it has none.)

const DOTS = 36;
const DOT_SIZE = 7; // px
const HAND = 1.9; // the dot where the ring was taken, larger: the dial's hand
const LEAVE = 160; // ms the dots take to go
const FADE = 150; // ms the ring takes to fade, or come back
const RADIUS = { X: 0.5, Y: 0.5, Z: 0.5, E: 0.75 }; // the rings' own (see TransformControls' gizmoRotate)
const UNIT = { X: new THREE.Vector3(1, 0, 0), Y: new THREE.Vector3(0, 1, 0), Z: new THREE.Vector3(0, 0, 1) };

const VERTEX = /* glsl */ `
attribute float grow;
uniform float size;
varying float vGrow;
void main() {
  vGrow = grow;
  gl_PointSize = size * grow;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 color;
varying float vGrow;
void main() {
  if ( vGrow <= 0.0 || length( gl_PointCoord - 0.5 ) > 0.5 ) discard;
  gl_FragColor = vec4( color, min( 1.0, vGrow ) );
  #include <colorspace_fragment>
}
`;

const easeOut = (t) => 1 - (1 - t) ** 3;
const clamp = (t) => Math.min(1, Math.max(0, t));

export class GizmoDial {
  constructor(gizmo, viewport) {
    this.gizmo = gizmo;
    this.viewport = viewport;
    this.state = null; // { axis, phase: 'in' | 'out', since, normal, u, v, first }
    this.material = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color() }, size: { value: DOT_SIZE } },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(DOTS * 3), 3));
    geometry.setAttribute('grow', new THREE.Float32BufferAttribute(new Float32Array(DOTS), 1));
    this.dots = new THREE.Points(geometry, this.material);
    this.dots.frustumCulled = false;
    this.dots.renderOrder = 1000;
    this.dots.visible = false;
    viewport.scene.add(this.dots);
    viewport.beforeRender = [...(viewport.beforeRender ?? []), () => this.update()];

    // The ring taken fades for as long as the dial is up: its material is
    // TransformControls' (shared with other handles, and set anew on every
    // frame), so only while it itself is drawn.
    for (const handle of this.rings()) {
      handle.onBeforeRender = () => {
        const fade = this.ringFade(handle.name);
        if (fade === 1) return;
        handle.userData.opacity = handle.material.opacity;
        handle.material.opacity *= fade;
      };
      handle.onAfterRender = () => {
        if (handle.userData.opacity === undefined) return;
        handle.material.opacity = handle.userData.opacity;
        delete handle.userData.opacity;
      };
    }
    gizmo.addEventListener('mouseDown', () => this.take());
    gizmo.addEventListener('mouseUp', () => this.letGo());
  }

  rings() {
    return (this.gizmo._gizmo?.gizmo?.rotate?.children ?? []).filter((handle) => RADIUS[handle.name] !== undefined);
  }

  // How much of the ring `name` is drawn now: 1, or less while it is a dial.
  ringFade(name) {
    const { state } = this;
    if (!state || state.axis !== name) return 1;
    if (state.phase === 'in') return 0; // (held: gone at once)
    return easeOut(clamp((performance.now() - state.since) / FADE));
  }

  // A ring taken: the dial, its dots from the point taken.
  take() {
    const { gizmo } = this;
    const axis = gizmo.axis;
    if (gizmo.mode !== 'rotate' || RADIUS[axis] === undefined) return;
    const normal = axis === 'E'
      ? gizmo.eye.clone()
      : UNIT[axis].clone().applyQuaternion(gizmo.space === 'local' ? gizmo.worldQuaternionStart : new THREE.Quaternion());
    normal.normalize();
    // The first dot where the ring was taken; the plane's other way at right angles.
    const u = gizmo.pointStart.clone().projectOnPlane(normal);
    if (u.lengthSq() < 1e-10) u.copy(Math.abs(normal.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).projectOnPlane(normal);
    u.normalize();
    const v = normal.clone().cross(u).normalize();
    const color = gizmo._gizmo.gizmo.rotate.children.find((handle) => handle.name === axis)?.material._color
      ?? gizmo._gizmo.gizmo.rotate.children.find((handle) => handle.name === axis)?.material.color;
    this.material.uniforms.color.value.copy(color ?? new THREE.Color(1, 1, 1));
    this.state = { axis, phase: 'in', since: performance.now(), normal, u, v };
    this.dots.visible = true;
    this.run();
  }

  letGo() {
    if (!this.state || this.state.phase === 'out') return;
    this.state = { ...this.state, phase: 'out', since: performance.now(), angle: this.gizmo.rotationAngle };
    this.run();
  }

  // The view drawn every frame while the dial moves.
  run() {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      this.viewport.requestRender();
      if (this.state) requestAnimationFrame(tick);
      else this.running = false;
    };
    requestAnimationFrame(tick);
  }

  // Where the dots are now (every time the view is drawn).
  update() {
    const { state, gizmo } = this;
    if (!state) return;
    const now = performance.now() - state.since;
    if (state.phase === 'out' && now > Math.max(LEAVE, FADE)) {
      this.state = null;
      this.dots.visible = false;
      return;
    }
    const handle = this.rings().find((ring) => ring.name === state.axis);
    const radius = RADIUS[state.axis] * (handle ? handle.getWorldScale(new THREE.Vector3()).x : 1);
    const angle = state.phase === 'out' ? state.angle : gizmo.rotationAngle;
    // The dots' frame turned as what is turned: about the axis, by the angle.
    const turn = new THREE.Quaternion().setFromAxisAngle(state.normal, angle);
    const u = state.u.clone().applyQuaternion(turn);
    const v = state.v.clone().applyQuaternion(turn);
    const centre = gizmo.worldPosition;
    const position = this.dots.geometry.getAttribute('position');
    const grow = this.dots.geometry.getAttribute('grow');
    for (let k = 0; k < DOTS; k++) {
      const a = (k / DOTS) * Math.PI * 2;
      position.setXYZ(k,
        centre.x + radius * (Math.cos(a) * u.x + Math.sin(a) * v.x),
        centre.y + radius * (Math.cos(a) * u.y + Math.sin(a) * v.y),
        centre.z + radius * (Math.cos(a) * u.z + Math.sin(a) * v.z));
      // (there at once; going all together, as the ring comes back)
      const size = state.phase === 'in' ? 1 : 1 - easeOut(clamp(now / LEAVE));
      grow.setX(k, k === 0 ? size * HAND : size);
    }
    position.needsUpdate = true;
    grow.needsUpdate = true;
    this.material.uniforms.size.value = DOT_SIZE * (window.devicePixelRatio || 1);
  }
}
