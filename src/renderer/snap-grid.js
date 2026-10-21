import * as THREE from 'three';
import { axisColor } from './theme.js';

const AXES = ['x', 'y', 'z'];
const PLANE_CELLS = 64; // free mode: dots shown this many cells around the vertex
const AXIS_CELLS = 256; // axis lock: dots shown this many cells along the axis
const WORLD_ORIGIN = new THREE.Vector3();
const VIEW_CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => new THREE.Vector2(x, y));

// Dots are largest and most opaque at the dragged vertex and fade with distance.
const DOT_SIZE = 7; // px at the vertex
const DOT_OPACITY = 0.26; // at the vertex
const FALLOFF_RADIUS = 0.4; // in viewport heights
const FAR_SIZE = 0.4; // fraction of DOT_SIZE at and beyond the radius
const FAR_OPACITY = 0.15; // fraction of DOT_OPACITY at and beyond the radius

const DOT_VERTEX_SHADER = /* glsl */ `
  uniform vec3 focus;
  uniform float radius;
  uniform float reach;
  uniform float size;
  attribute vec3 color;
  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    vColor = color;
    float distanceToFocus = distance(position, focus);
    float weight = 1.0 - smoothstep(0.0, radius, distanceToFocus);
    vAlpha = mix(${FAR_OPACITY.toFixed(3)}, 1.0, weight);
    // Dots vanish before the edge of the dot window, so the edge is never seen.
    vAlpha *= 1.0 - smoothstep(0.6 * reach, reach, distanceToFocus);
    gl_PointSize = size * mix(${FAR_SIZE.toFixed(3)}, 1.0, weight);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const DOT_FRAGMENT_SHADER = /* glsl */ `
  uniform float opacity;
  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    float disc = 1.0 - smoothstep(0.35, 0.5, length(gl_PointCoord - 0.5));
    gl_FragColor = vec4(vColor, opacity * vAlpha * disc);
    #include <colorspace_fragment>
  }
`;

// World-space lattice that dragged vertices snap to, and the dots that show
// which lattice points the current drag can reach.
//
// A drag along the axes of a turned object has a lattice turned the same way
// (`turn` of begin()): everything below is then worked out in the coordinates
// of those axes, and the dots are turned into place as a whole.
//
// A lattice point gets a dot for every axis the drag can move along, in that
// axis' colour (the gizmo's), and the dots add up like lights: along one axis
// they are of its colour, in a plane of the mix of two, in a free drag of all three.
// A turn by a gizmo on the grid, or with Shift held, goes by this step (from
// where it began).
export const ROTATION_STEP = Math.PI / 12; // 15°

export class SnapGrid {
  constructor(viewport) {
    this.viewport = viewport;
    this.step = 0.25;
    this.fine = false; // precision modifier held
    this.fineDivisor = 3; // fine mode splits every grid cell into this many
    this.enabled = true; // the user's switch: off, drags go free of the lattice
    this.idle = false; // the current drag is one of those
    this.turn = null; // the current drag's lattice is turned by this, see begin()
    this.back = null;
    this.raycaster = new THREE.Raycaster();

    this.dots = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.ShaderMaterial({
        uniforms: {
          opacity: { value: DOT_OPACITY },
          size: { value: DOT_SIZE * viewport.renderer.getPixelRatio() },
          focus: { value: new THREE.Vector3() }, // the dragged vertex
          radius: { value: 1 }, // world distance at which dots reach their minimum
          reach: { value: 1 }, // world distance at which dots vanish
        },
        vertexShader: DOT_VERTEX_SHADER,
        fragmentShader: DOT_FRAGMENT_SHADER,
        transparent: true,
        blending: THREE.AdditiveBlending, // dots that coincide mix their colours
        // Drawn over the model: targets behind or inside it stay visible.
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.dots.frustumCulled = false;
    this.dots.renderOrder = 1;
    this.dots.visible = false;
    viewport.scene.add(this.dots);
  }

  // Lattice step in effect: the base step, or a tenth of it in fine mode.
  get activeStep() {
    return this.fine ? this.step / this.fineDivisor : this.step;
  }

  // Starts a drag of a point at `start`.
  // `lock`: 'free' (one layer of lattice points along `plane`, which passes
  // through `start`), or the axes the point may move along: 'x', 'xy', ...
  // `origin`: a point the lattice passes through. The world origin snaps to
  // absolute grid positions; `start` itself snaps the travel to whole steps.
  // `required`: this drag is on the lattice whatever the user's switch says
  // (a tool that works by the grid's points).
  // `turn`: a quaternion - the lattice, and the axes of `lock`, are turned by it.
  begin(start, lock, plane, origin = WORLD_ORIGIN, required = false, turn = null) {
    this.idle = !this.enabled && !required;
    if (this.idle) {
      this.dots.visible = false;
      return;
    }
    this.turn = turn?.clone() ?? null;
    this.back = turn?.clone().invert() ?? null;
    this.dots.quaternion.copy(turn ?? new THREE.Quaternion());
    const world = start; // for the depth below
    start = this.inward(start.clone());
    origin = this.inward(origin.clone());
    if (plane && turn) {
      plane = new THREE.Plane().setFromNormalAndCoplanarPoint(plane.normal.clone().applyQuaternion(this.back), start);
    }
    this.start = start.clone();
    this.origin = origin.clone();
    this.plane = plane;
    this.axes = lock === 'free' ? null : [...lock];
    this.active = this.activeStep;
    // Dots are built in a window of this many cells around the point.
    this.cells = this.axes?.length === 1 ? AXIS_CELLS : PLANE_CELLS;

    if (!this.axes) {
      // The plane is tilted against the lattice, so the reachable points form
      // one layer: a lattice point per column along the plane's dominant axis.
      this.normal = plane.normal;
      this.k = AXES.reduce((best, axis) =>
        Math.abs(this.normal[axis]) > Math.abs(this.normal[best]) ? axis : best);
      [this.a, this.b] = AXES.filter((axis) => axis !== this.k);
    }

    // The falloff radius is fixed on screen: a share of the view height at the point's depth.
    const { camera } = this.viewport;
    const depth = world.clone().sub(camera.position).dot(camera.getWorldDirection(new THREE.Vector3()));
    const viewHeight = 2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const { uniforms } = this.dots.material;
    // The window follows the point with a lag of up to half its size, so the
    // other half is the distance at which dots are guaranteed to exist.
    uniforms.reach.value = (this.cells / 2) * this.active;
    uniforms.radius.value = Math.min(FALLOFF_RADIUS * viewHeight, uniforms.reach.value);

    this.buildDots(start);
    this.focus(world);
    this.dots.visible = true;
  }

  // A point of the world taken into the lattice's own coordinates (in place),
  // and back. Without a turn they are the world's.
  inward(point) {
    return this.back ? point.applyQuaternion(this.back) : point;
  }

  outward(point) {
    return this.turn ? point.applyQuaternion(this.turn) : point;
  }

  // Lattice index of a coordinate, and back.
  index(value, axis) {
    return Math.round((value - this.origin[axis]) / this.active);
  }

  coordinate(index, axis) {
    return this.origin[axis] + index * this.active;
  }

  // Fills the dot window centered on `center`.
  buildDots(center) {
    this.windowCenter = center.clone();
    const points = [];

    if (this.axes) {
      // A line or a flat grid through the start point.
      const [a, b] = this.axes;
      const middleA = this.index(center[a], a);
      const middleB = b ? this.index(center[b], b) : 0;
      const spanB = b ? this.cells : 0;
      for (let ia = -this.cells; ia <= this.cells; ia++) {
        for (let ib = -spanB; ib <= spanB; ib++) {
          const point = this.start.clone();
          point[a] = this.coordinate(middleA + ia, a);
          if (b) point[b] = this.coordinate(middleB + ib, b);
          points.push(point);
        }
      }
    } else {
      const [a0, a1] = this.visibleRange(this.a, center);
      const [b0, b1] = this.visibleRange(this.b, center);
      for (let ia = a0; ia <= a1; ia++) {
        for (let ib = b0; ib <= b1; ib++) {
          const point = new THREE.Vector3();
          point[this.a] = this.coordinate(ia, this.a);
          point[this.b] = this.coordinate(ib, this.b);
          this.solveLayer(point);
          points.push(point);
        }
      }
    }

    // One dot per point for each axis of the drag, in the axis' colour.
    const tints = this.dotAxes().map((axis) => new THREE.Color(axisColor(axis)));
    const layered = tints.flatMap(() => points);
    const colors = tints.flatMap((tint) => points.flatMap(() => [tint.r, tint.g, tint.b]));
    this.dots.geometry.dispose();
    this.dots.geometry = new THREE.BufferGeometry().setFromPoints(layered);
    this.dots.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  }

  // The axes the current drag can move along: those of its lock, or all three.
  dotAxes() {
    return this.axes ?? AXES;
  }

  // Centers the dot falloff on the dragged point.
  focus(position) {
    if (this.idle) return;
    position = this.inward(position.clone());
    this.dots.material.uniforms.focus.value.copy(position);
    // The point drifted halfway to the window's edge: move the window to it.
    const limit = (this.cells / 2) * this.active;
    const drifted = AXES.some((axis) => Math.abs(position[axis] - this.windowCenter[axis]) > limit);
    if (drifted) this.buildDots(position);
  }

  end() {
    this.dots.visible = false;
  }

  // Moves `position` to the nearest snap point of the current drag.
  snap(position) {
    if (this.idle) return; // snapping is switched off: the point stays where it is
    const round = (axis) => {
      position[axis] = this.coordinate(this.index(position[axis], axis), axis);
    };
    this.inward(position);
    if (this.axes) {
      this.axes.forEach(round);
    } else {
      round(this.a);
      round(this.b);
      this.solveLayer(position);
    }
    this.outward(position);
  }

  // Sets the dominant-axis coordinate to the lattice value closest to the drag plane.
  solveLayer(point) {
    const { a, b, k, normal, start } = this;
    const offset = normal[a] * (point[a] - start[a]) + normal[b] * (point[b] - start[b]);
    point[k] = this.coordinate(this.index(start[k] - offset / normal[k], k), k);
  }

  // Lattice index range along `axis`: the visible part of the drag plane,
  // clipped to the dot window around `center`.
  visibleRange(axis, center) {
    let min = Infinity;
    let max = -Infinity;
    const hit = new THREE.Vector3();
    for (const corner of VIEW_CORNERS) {
      this.raycaster.setFromCamera(corner, this.viewport.camera);
      this.inward(this.raycaster.ray.origin);
      this.inward(this.raycaster.ray.direction);
      if (!this.raycaster.ray.intersectPlane(this.plane, hit)) continue;
      min = Math.min(min, hit[axis]);
      max = Math.max(max, hit[axis]);
    }
    const middle = this.index(center[axis], axis);
    const toIndex = (value) => (value - this.origin[axis]) / this.active;
    return [
      Math.max(Math.floor(toIndex(min)), middle - this.cells),
      Math.min(Math.ceil(toIndex(max)), middle + this.cells),
    ];
  }
}
