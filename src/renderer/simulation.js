import * as THREE from 'three';
import { ModelPose } from './pose.js';

// The simulation: in the collision mode (see collisions.js), the objects
// come alive as the bodies their shapes make - the dynamic ones fall, roll
// and knock into each other, the static ones hold - and can be taken with
// the mouse and dragged, pushed, thrown. A plaything, to see the shapes at
// work; it is not Godot's physics, only one much like it.
//
// It is the usual rigid-body loop (Rapier, a physics engine in WebAssembly,
// does the work): every 1/60 s forces move the bodies, their contacts are
// found and solved. A body is dragged by a spring: from the point it was
// taken by to the pointer, on the plane facing the camera, with damping -
// so it swings and tumbles on the way, and flies on when let go. A
// kinematic body follows the pointer as it is, pushing what is in its way.
//
// The model is moved for the time it runs (its vertices, nothing else) and
// put back as it was when it stops: nothing of it is an edit, nothing goes
// into the undo history.

const STEP = 1 / 60;
const MAX_STEPS = 4; // per frame: a slow frame does not make it catch up forever
const GRAVITY = -9.81;
const SPRING = 80; // 1/s²: how hard a dragged body is pulled to the pointer, per its mass
const DAMPING = 2 * Math.sqrt(SPRING); // critically damped: it comes, it does not bounce about
const HELD_ANGULAR_DAMPING = 3;
const FLOOR = 200; // half the floor's width, in units
const MIN_HALF = 0.005;

let rapier = null; // the engine, loaded the first time it is needed
async function loadRapier() {
  if (!rapier) {
    const module = await import('@dimforge/rapier3d-compat');
    rapier = module.default ?? module;
    await rapier.init();
  }
  return rapier;
}

export class Simulation {
  constructor(controls, viewport, editor, collisions) {
    this.controls = controls;
    this.startButton = controls.querySelector('#sim-start');
    this.restartButton = controls.querySelector('#sim-restart');
    this.viewport = viewport;
    this.editor = editor;
    this.collisions = collisions;
    this.running = false;
    this.starting = false;
    this.world = null;
    this.held = null; // what the pointer drags: { body, local, plane, target, kinematic }
    this.pose = new ModelPose(editor, { skin: false }); // the model where the bodies are - each as a whole, the skin left out

    // The dragged body's line to the pointer.
    this.line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0xffe066, depthTest: false, transparent: true }),
    );
    this.line.renderOrder = 10;
    this.line.visible = false;
    viewport.scene.add(this.line);

    for (const button of [this.startButton, this.restartButton]) button.addEventListener('mousedown', (event) => event.preventDefault());
    this.startButton.addEventListener('click', () => (this.running ? this.stop() : this.start()));
    this.restartButton.addEventListener('click', async () => {
      this.stop();
      await this.start();
    });
    editor.addEventListener('change', () => this.show());
    this.bindPointer();
    this.show();
  }

  show() {
    const on = this.editor.collisions || this.running;
    this.controls.classList.toggle('shown', on);
    this.controls.classList.toggle('running', this.running);
    this.startButton.querySelector('i').className = `fa-solid ${this.running ? 'fa-stop' : 'fa-play'}`;
    this.startButton.querySelector('span').textContent = this.running ? 'Стоп' : 'Симуляция';
    this.startButton.title = this.running
      ? 'Остановить и вернуть всё на места (Esc)'
      : 'Симуляция: тела оживают — динамические падают и сталкиваются, их можно хватать мышью и бросать. Модель не меняется';
  }

  // --- running ----------------------------------------------------------------

  async start() {
    const { editor } = this;
    if (this.running || this.starting || !editor.collisions || editor.busy()) return;
    this.starting = true;
    try {
      await loadRapier();
    } catch (error) {
      this.starting = false;
      console.error(error);
      return;
    }
    this.starting = false;
    if (!editor.collisions || editor.busy()) return;
    this.before = editor.snapshot();
    editor.clearSelection();
    this.buildWorld();
    this.pose.begin();
    this.running = true;
    editor.simulating = true;
    this.collisions.refresh(); // its shapes and gizmo are put away while it runs
    this.last = performance.now();
    this.left = 0;
    this.frame = requestAnimationFrame((time) => this.tick(time));
    this.show();
  }

  stop() {
    if (!this.running) return;
    cancelAnimationFrame(this.frame);
    this.release();
    this.running = false;
    this.world.free();
    this.world = null;
    this.bodies = [];
    this.pose.end();
    this.editor.simulating = false;
    this.editor.restore(this.before); // the selection as it was too; the history is as it was
    this.before = null;
    this.show();
  }

  // The world: a floor, and a body for every object shown that has shapes.
  buildWorld() {
    const R = rapier;
    const { editor } = this;
    const { mesh } = editor;
    this.world = new R.World({ x: 0, y: GRAVITY, z: 0 });
    this.world.timestep = STEP;
    const floor = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    this.world.createCollider(R.ColliderDesc.cuboid(FLOOR, 0.5, FLOOR), floor);

    const byId = new Map(mesh.objects.map((object) => [object.id, object]));
    const hidden = (object) => Boolean(object) && (Boolean(object.hidden) || hidden(byId.get(object.parent)));
    this.bodies = [];
    mesh.objects.forEach((object, index) => {
      if (!object.colliders?.length || hidden(object)) return;
      const frame = editor.objectFrame(index);
      const kind = object.body ?? 'static';
      const desc = kind === 'dynamic' ? R.RigidBodyDesc.dynamic().setCcdEnabled(true)
        : kind === 'kinematic' ? R.RigidBodyDesc.kinematicPositionBased()
        : R.RigidBodyDesc.fixed();
      desc.setTranslation(frame.origin.x, frame.origin.y, frame.origin.z);
      desc.setRotation({ x: frame.quaternion.x, y: frame.quaternion.y, z: frame.quaternion.z, w: frame.quaternion.w });
      const body = this.world.createRigidBody(desc);
      // Its vertices, in its frame (for a trimesh shape).
      const vertices = [];
      const local = [];
      mesh.vertices.forEach((vertex, i) => {
        if (mesh.vertexObject[i] !== object.id) return;
        vertices.push(i);
        local.push(vertex.clone().sub(frame.origin).applyQuaternion(frame.quaternion.clone().invert()));
      });
      for (const shape of object.colliders) {
        const collider = this.colliderOf(shape, object, local, vertices);
        if (!collider) continue;
        if (kind === 'trigger') collider.setSensor(true);
        this.world.createCollider(collider, body);
      }
      // A node's body carries what it holds (but what has a body of its own):
      // each where it is from the node, as it was at the start.
      const carried = [];
      if (object.kind === 'node') {
        const start = new THREE.Matrix4().compose(frame.origin, frame.quaternion, new THREE.Vector3(1, 1, 1)).invert();
        const own = (entry) => Boolean(mesh.objects[entry].colliders?.length);
        const carry = (entry) => {
          for (const child of editor.topology.islands[entry].children) {
            if (own(child)) continue;
            const f = editor.objectFrame(child);
            carried.push({ id: mesh.objects[child].id, offset: start.clone().multiply(new THREE.Matrix4().compose(f.origin, f.quaternion, new THREE.Vector3(1, 1, 1))) });
            carry(child);
          }
        };
        carry(index);
      }
      this.bodies.push({ body, id: object.id, carried });
    });
  }

  // A shape (see collision-fit.js) as the engine has it, placed in its body.
  colliderOf(shape, object, local, vertices) {
    const R = rapier;
    let desc = null;
    switch (shape.type) {
      case 'box': desc = R.ColliderDesc.cuboid(...shape.size.map((value) => Math.max(MIN_HALF, value / 2))); break;
      case 'sphere': desc = R.ColliderDesc.ball(shape.radius); break;
      case 'capsule': desc = R.ColliderDesc.capsule(Math.max(0, shape.height / 2 - shape.radius), shape.radius); break;
      case 'cylinder': desc = R.ColliderDesc.cylinder(shape.height / 2, shape.radius); break;
      case 'convex': desc = R.ColliderDesc.convexHull(new Float32Array(shape.points.flat())); break;
      case 'trimesh': {
        // The object's own faces, in triangles, in its frame.
        const { mesh } = this.editor;
        const place = new Map(vertices.map((vertex, k) => [vertex, k]));
        const indices = [];
        mesh.faces.forEach((face, i) => {
          if (mesh.vertexObject[face[0]] !== object.id) return;
          for (const triangle of mesh.triangulate(i)) indices.push(...triangle.map((vertex) => place.get(vertex)));
        });
        if (indices.length) desc = R.ColliderDesc.trimesh(new Float32Array(local.flatMap((point) => point.toArray())), new Uint32Array(indices));
        break;
      }
    }
    if (!desc) return null;
    if (shape.center) desc.setTranslation(...shape.center);
    if (shape.rotation?.some(Boolean)) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...shape.rotation.map((angle) => THREE.MathUtils.degToRad(angle)), 'XYZ'));
      desc.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    }
    return desc.setFriction(0.7).setRestitution(0.2);
  }

  tick(time) {
    if (!this.running) return;
    this.left = Math.min(this.left + (time - this.last) / 1000, STEP * MAX_STEPS);
    this.last = time;
    while (this.left >= STEP) {
      this.pull();
      this.world.step();
      this.left -= STEP;
    }
    this.draw();
    this.frame = requestAnimationFrame((next) => this.tick(next));
  }

  // The model where the bodies are now.
  draw() {
    const matrices = new Map();
    const one = new THREE.Vector3(1, 1, 1);
    for (const { body, id, carried } of this.bodies) {
      const t = body.translation();
      const r = body.rotation();
      const matrix = new THREE.Matrix4().compose(new THREE.Vector3(t.x, t.y, t.z), new THREE.Quaternion(r.x, r.y, r.z, r.w), one);
      matrices.set(id, matrix);
      for (const { id: inside, offset } of carried) matrices.set(inside, matrix.clone().multiply(offset));
    }
    this.pose.apply(matrices);
    if (this.held) {
      const ends = [this.anchor(), this.held.target];
      this.line.geometry.setFromPoints(ends);
      this.line.visible = true;
    }
    this.viewport.requestRender();
  }

  // --- the pointer ------------------------------------------------------------

  // Where the held body was taken by, in the world now.
  anchor() {
    const { body, local } = this.held;
    const r = body.rotation();
    const t = body.translation();
    return local.clone().applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w)).add(new THREE.Vector3(t.x, t.y, t.z));
  }

  // The spring of the dragged body, for one step: a push towards the pointer.
  pull() {
    const held = this.held;
    if (!held) return;
    const { body } = held;
    if (held.kinematic) {
      // A kinematic body goes where it is led, at once.
      const t = body.translation();
      const to = new THREE.Vector3(t.x, t.y, t.z).add(held.target).sub(this.anchor());
      body.setNextKinematicTranslation({ x: to.x, y: to.y, z: to.z });
      return;
    }
    const anchor = this.anchor();
    const v = body.velocityAtPoint({ x: anchor.x, y: anchor.y, z: anchor.z });
    const mass = body.mass();
    const force = held.target.clone().sub(anchor).multiplyScalar(SPRING)
      .sub(new THREE.Vector3(v.x, v.y, v.z).multiplyScalar(DAMPING))
      .multiplyScalar(mass * STEP);
    body.applyImpulseAtPoint({ x: force.x, y: force.y, z: force.z }, { x: anchor.x, y: anchor.y, z: anchor.z }, true);
  }

  release() {
    if (!this.held) return;
    if (!this.held.kinematic) this.held.body.setAngularDamping(this.held.damping);
    this.held = null;
    this.line.visible = false;
    this.viewport.orbit.enabled = true;
    this.viewport.renderer.domElement.style.cursor = '';
  }

  bindPointer() {
    const dom = this.viewport.renderer.domElement;
    // Capture: before the camera's own handler, which would turn the view.
    dom.addEventListener('pointerdown', (event) => {
      if (!this.running || event.button !== 0) return;
      const ray = this.editor.mainViewer.ray(event.clientX, event.clientY);
      const hit = this.world.castRay(new rapier.Ray(ray.origin, ray.direction), 1000, true);
      const body = hit?.collider.parent();
      if (!body || body.isFixed()) return; // the floor, or what does not move: the camera's
      event.stopImmediatePropagation();
      dom.setPointerCapture(event.pointerId);
      const point = ray.at(hit.timeOfImpact, new THREE.Vector3());
      const r = body.rotation();
      const t = body.translation();
      const local = point.clone().sub(new THREE.Vector3(t.x, t.y, t.z)).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w).invert());
      const normal = this.viewport.camera.getWorldDirection(new THREE.Vector3());
      const kinematic = body.isKinematic();
      this.held = {
        body, local, kinematic,
        plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point),
        target: point.clone(),
        damping: kinematic ? 0 : body.angularDamping(),
      };
      if (!kinematic) body.setAngularDamping(HELD_ANGULAR_DAMPING);
      this.viewport.orbit.enabled = false;
      dom.style.cursor = 'grabbing';
    }, { capture: true });
    dom.addEventListener('pointermove', (event) => {
      if (!this.held) return;
      const ray = this.editor.mainViewer.ray(event.clientX, event.clientY);
      ray.intersectPlane(this.held.plane, this.held.target);
    });
    // The wheel, while a body is held: nearer and farther along the view.
    dom.addEventListener('wheel', (event) => {
      if (!this.held) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const toward = this.viewport.camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(-Math.sign(event.deltaY) * 0.25);
      this.held.plane.translate(toward);
      this.held.target.add(toward);
    }, { capture: true, passive: false });
    const up = (event) => {
      if (!this.held || event.button !== 0) return;
      this.release();
    };
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointercancel', () => this.release());
  }
}
