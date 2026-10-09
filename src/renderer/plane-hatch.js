import * as THREE from 'three';

const OPACITY = 0.6; // of the stripes, when fully shown
const FADE = 12; // 1/s: how fast the hatching appears and goes
const FLOW = 0.9; // stripe periods per second
const STRIPES = 84; // across the sheet
const STRIPE_WIDTH = 0.3; // the share of a period that is drawn
const MIN_SIZE = 4; // world units

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  uniform float time;
  varying vec2 vUv;

  void main() {
    // Thin diagonal stripes with soft edges.
    float wave = abs(fract((vUv.x + vUv.y) * ${(STRIPES / 2).toFixed(1)} - time) - 0.5) * 2.0;
    float edge = fwidth(wave);
    float stripe = smoothstep(${(1 - STRIPE_WIDTH).toFixed(2)} - edge, ${(1 - STRIPE_WIDTH).toFixed(2)} + edge, wave);
    // The sheet has no border: it fades out towards its rim.
    float rim = 1.0 - smoothstep(0.25, 1.0, length(vUv - 0.5) * 2.0);
    float alpha = (0.1 + 0.9 * stripe) * rim * opacity;
    if (alpha <= 0.002) discard;
    gl_FragColor = vec4(color, alpha);
    #include <colorspace_fragment>
  }
`;

// Marks an axis-aligned plane in the scene with animated diagonal hatching: a
// large sheet around what the camera looks at, fading in when shown, with its
// stripes flowing for as long as it is.
export class PlaneHatch {
  constructor(viewport) {
    this.viewport = viewport;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        uniforms: { color: { value: new THREE.Color() }, opacity: { value: 0 }, time: { value: 0 } },
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
    viewport.scene.add(this.mesh);
    this.target = 0; // the opacity it is heading for
    this.running = false;
  }

  // Shows the plane perpendicular to `axis` ('x' | 'y' | 'z') at `offset` along it.
  show(axis, offset, color) {
    const { camera, orbit } = this.viewport;
    const { mesh } = this;
    const uniforms = mesh.material.uniforms;
    // Another plane starts from nothing rather than jumping there fully drawn.
    if (this.axis !== axis) uniforms.opacity.value = 0;
    this.axis = axis;
    uniforms.color.value.set(color);

    const size = Math.max(camera.position.distanceTo(orbit.target) * 2.4, MIN_SIZE);
    mesh.scale.set(size, size, 1);
    mesh.position.copy(orbit.target);
    mesh.position[axis] = offset;
    // The sheet is made facing +Z.
    mesh.rotation.set(axis === 'y' ? -Math.PI / 2 : 0, axis === 'x' ? Math.PI / 2 : 0, 0);
    mesh.visible = true;
    this.target = OPACITY;
    this.run();
  }

  hide() {
    this.target = 0;
    this.run();
  }

  // Animates until the hatching is gone.
  run() {
    if (this.running || !this.mesh.visible) return;
    this.running = true;
    let last = performance.now();
    const frame = (now) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const uniforms = this.mesh.material.uniforms;
      uniforms.time.value = (uniforms.time.value + dt * FLOW) % 1;
      uniforms.opacity.value += (this.target - uniforms.opacity.value) * (1 - Math.exp(-FADE * dt));
      if (this.target === 0 && uniforms.opacity.value < 0.01) {
        uniforms.opacity.value = 0;
        this.mesh.visible = false;
        this.axis = null;
        this.running = false;
        this.viewport.requestRender();
        return;
      }
      this.viewport.requestRender();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
}
