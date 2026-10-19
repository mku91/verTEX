import * as THREE from 'three';

// The sign of a move by inverse kinematics (see ik.js, animate.js): while
// Shift is held in the animation mode - and while such a move goes on - a
// ring on the pivot point of the entry picked beats like a pulse, and waves
// run out of it and fade, as a ripple on water does. Drawn over the model,
// the same size on the screen however far it is.

const COLOR = 0x50fa7b; // Dracula's green: not the selection's, a group's or the preview's
const CORE_SIZE = 40; // px across, the ring at rest
const WAVE_SIZE = 130; // px across, a wave as it is gone
const BEAT = 0.9; // s, one beat of the ring
const WAVE = 1.5; // s, one wave from the ring out
const WAVES = 3; // at a time, evenly apart

// A ring, white, for the material to colour; `width` of the canvas's 128.
function ringTexture(width) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d');
  context.strokeStyle = '#fff';
  context.lineWidth = width;
  context.beginPath();
  context.arc(64, 64, 62 - width / 2, 0, Math.PI * 2);
  context.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// A soft glow, brightest in the middle.
function glowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(255,255,255,0.9)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const material = (map) => new THREE.SpriteMaterial({ map, color: COLOR, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true });

export class IKSign {
  // `where()`: the point (in the world) the sign is on now, or null - none shown.
  constructor(viewport, where) {
    this.viewport = viewport;
    this.where = where;
    this.group = new THREE.Group();
    this.group.visible = false;
    this.glow = new THREE.Sprite(material(glowTexture()));
    this.core = new THREE.Sprite(material(ringTexture(16)));
    this.waves = Array.from({ length: WAVES }, () => new THREE.Sprite(material(ringTexture(8))));
    for (const sprite of [this.glow, ...this.waves, this.core]) {
      sprite.renderOrder = 9;
      sprite.frustumCulled = false;
      this.group.add(sprite);
    }
    viewport.scene.add(this.group);
    viewport.beforeRender = [...(viewport.beforeRender ?? []), () => this.place()];
    this.running = false;
  }

  // Looked at again (Shift pressed or let go, the pick changed): drawn on
  // every frame while there is somewhere to show it, and hidden after.
  update() {
    if (this.running || !this.where()) {
      this.viewport.requestRender();
      return;
    }
    this.running = true;
    const tick = () => {
      this.viewport.requestRender();
      if (this.where()) requestAnimationFrame(tick);
      else this.running = false;
    };
    requestAnimationFrame(tick);
  }

  place() {
    const at = this.where();
    this.group.visible = Boolean(at);
    if (!at) return;
    this.group.position.copy(at);
    const { camera, container } = this.viewport;
    const pixel = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / container.clientHeight; // a px, at sizeAttenuation off
    const seconds = performance.now() / 1000;
    // The ring: beating, a little larger and brighter at the top of a beat.
    const beat = 0.5 - 0.5 * Math.cos((seconds / BEAT) * Math.PI * 2);
    const core = CORE_SIZE * (0.88 + 0.2 * beat) * pixel;
    this.core.scale.set(core, core, 1);
    this.core.material.opacity = 0.85 + 0.15 * beat;
    const glow = CORE_SIZE * (1.4 + 0.5 * beat) * pixel;
    this.glow.scale.set(glow, glow, 1);
    this.glow.material.opacity = 0.25 + 0.35 * beat;
    // The waves: out from the ring, slowing and fading as they go.
    this.waves.forEach((wave, i) => {
      const t = (seconds / WAVE + i / WAVES) % 1;
      const out = 1 - (1 - t) ** 2; // fast at first, then slower
      const size = (CORE_SIZE + (WAVE_SIZE - CORE_SIZE) * out) * pixel;
      wave.scale.set(size, size, 1);
      wave.material.opacity = (1 - t) ** 1.5;
    });
  }
}
