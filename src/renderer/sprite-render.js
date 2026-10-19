import * as THREE from 'three';
import { keepToFaces } from './mesh.js';
import { clipValues, posedMatrices, localTransforms, worldFrames } from './pose.js';
import { spriteFrames } from './animation.js';

// The model drawn into a sprite sheet: one frame for every direction it is
// looked at from, side by side in a PNG - what a 2D game shows instead of
// the model itself.
//
//   - The camera is orthographic: the model is the same size in every frame
//     whatever its distance, and the pixels lie in a grid. It looks down by
//     `elevation` degrees (0: from the side; about 26.57: the 2:1 "isometric"
//     of pixel art; 90: from above).
//   - The directions are `directions` equal turns about the vertical, the
//     first at `start` degrees. Frame k shows the model turned by
//     start + k * 360 / directions, counter-clockwise seen from above.
//   - The scale is `scale` pixels of the sprite to a pixel of the atlas: at 1
//     the model's pixels come out the sprite's own, as far as the view lets
//     them. Every frame is `width` x `height`; the middle of the model's
//     bounds is the middle of every frame, so that it does not shift from
//     one direction to the next.
//   - Nothing is smoothed: no multisampling, and a pixel either is or is not
//     (alpha 0 or 255) - pixel art's edges. The background is clear.
//   - `light`: 'none' - the atlas' colours as they are; 'camera' - lit as in
//     the editor, from the viewer's side, the same in every frame; 'custom' -
//     a light from a direction of the user's, that stays where it is in the
//     world, so that the model's sides are lit and shaded as it turns - with
//     a sky's light all round, so that no shade is black. Its direction:
//     `lightAzimuth` degrees round the vertical (0: from the front - the
//     side the first frame is seen from; 90: from its right; 180: from
//     behind), `lightElevation` degrees up from the horizon (90: from
//     straight above); `lightStrength`, how bright.
//   - `blend`, how the light goes over into shade: 'smooth' - evenly, as it
//     is; 'steps' - in `steps` steps of brightness, light to shade with no
//     shades between (cel shading): the look of drawn pixel art. It is the
//     light a face takes - from none, turned away from it, to all of it,
//     turned straight at it - that is rounded down to the steps, in equal
//     bands; the sky's light, all round, stays as it is. On a flat-shaded
//     object every face is lit evenly anyway: its faces come out in so many
//     shades only; on a smooth one the light lies in bands.
//     With `dither` the bounds between the steps - where light gives way to
//     shade - are made of both steps, pixel by pixel, as pixel art does it
//     (ordered dithering, by a 4 x 4 Bayer matrix), a few pixels either
//     side of the line the light crosses a bound on; inside a step its
//     colour is whole, and a flat face, lit evenly, is never dithered.
//     Every pixel is one of the steps, and the pattern keeps to the
//     sprite's pixels. With `ditherFaces` all light between two steps is
//     dithered, as much of each as it is near it - a flat face as well, all
//     over, if its light is between them.
// The model is lit as a matte surface (Lambert's), with no shine.
//   - The sheet's grid (`layout`): all the frames in one row ('row'), or
//     `count` columns and as many rows as it takes ('columns'), or `count`
//     rows and as many columns as it takes ('rows') - the frames in order,
//     row by row, `padding` pixels between them. With `pot` the sheet is made
//     a power of two each way (64, 128, 256 ...), as many engines want their
//     textures: clear room is left to the right and below, and the frames
//     stay where they are.
// What is drawn is what the editor shows: the visible objects' faces - no
// grid, edges, points or selection.
//
// The model may be drawn in its animation clips' poses too (render()):
// every clip at `spriteFps` frames a second of its own (see spriteFrames()
// in animation.js), and every frame from every direction - a strip of the
// clip's frames for each direction, laid out as the sheet's grid says. All
// the frames of all the clips are drawn about one and the same point - the
// middle of all the poses' bounds - so that the model does not shift from
// one frame to the next, nor from one clip to another.

export const SPRITE_DEFAULTS = {
  directions: 8,
  start: 0,
  elevation: 30,
  scale: 1,
  width: 64,
  height: 64,
  layout: 'row', // 'row' | 'columns' | 'rows'
  count: 4, // columns or rows, as `layout` says
  pot: false, // the sheet a power of two each way
  padding: 0,
  light: 'camera',
  lightAzimuth: 320,
  lightElevation: 45,
  lightStrength: 2.6,
  blend: 'smooth', // 'smooth' | 'steps'
  steps: 3,
  dither: false,
  ditherFaces: false,
};

// The direction the custom light comes from (towards it), by its angles (see the top).
export function lightDirection(azimuth, elevation) {
  const around = THREE.MathUtils.degToRad(azimuth);
  const up = THREE.MathUtils.degToRad(elevation);
  return new THREE.Vector3(Math.sin(around) * Math.cos(up), Math.sin(up), Math.cos(around) * Math.cos(up));
}

export class SpriteRenderer {
  constructor(editor) {
    this.editor = editor;
    this.atlasSize = new THREE.Vector2(1, 1);
    this.materials = new Map(); // light -> the four parts' materials (see MeshView.rebuild())
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera();
    this.scene.add(this.camera);
    // The lights, of which those of the setting in force are switched on.
    this.lights = {
      ambient: new THREE.AmbientLight(0xffffff, 1.2),
      head: new THREE.DirectionalLight(0xffffff, 2),
      sun: new THREE.DirectionalLight(0xfff4e0, 2.6),
      sky: new THREE.HemisphereLight(0xdde6ff, 0x4a3f33, 1.1),
    };
    this.lights.head.position.set(-1, 2, 3); // from the viewer's upper left, as the editor's headlight
    this.camera.add(this.lights.head);
    this.scene.add(this.lights.ambient, this.lights.sun, this.lights.sun.target, this.lights.sky);
    this.mesh = new THREE.Mesh();
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  // The materials for the settings' light and blend, in the order of the
  // surface's parts: on the atlas from both sides, off it from both sides,
  // on it from the front only, off it from the front only.
  materialsFor(settings) {
    const stepped = settings.light !== 'none' && settings.blend === 'steps';
    const dither = settings.dither ? (settings.ditherFaces ? 'faces' : 'bounds') : null;
    const key = settings.light === 'none' ? 'none' : stepped ? `steps ${settings.steps} ${dither}` : 'smooth';
    if (!this.materials.has(key)) {
      this.materials.set(key, [0, 1, 2, 3].map((part) => {
        const onAtlas = part % 2 === 0;
        const Kind = settings.light === 'none' ? THREE.MeshBasicMaterial : THREE.MeshLambertMaterial;
        const material = new Kind({ vertexColors: true, side: part >= 2 ? THREE.FrontSide : THREE.DoubleSide });
        if (onAtlas) {
          material.map = this.editor.atlas.texture;
          material.alphaTest = 0.5;
          keepToFaces(material, this.atlasSize);
        }
        if (stepped) inSteps(material, settings.steps, dither);
        return material;
      }));
    }
    return this.materials.get(key);
  }

  // Runs `draw` with the surface coloured as in the preview look - the faces
  // on the atlas white, for the picture to be their colour - and puts the
  // editor's look back after. (Nothing is drawn on the screen in between.)
  withBareSurface(draw) {
    const { view } = this.editor;
    const bare = Boolean(view.bare);
    if (!bare) view.setBare(true);
    try {
      return draw(view.solid.geometry);
    } finally {
      if (!bare) view.setBare(false);
    }
  }

  // The pixels of the sprite to a unit of length.
  pixelsPerUnit(settings) {
    return this.editor.ppu * settings.scale;
  }

  // Points the camera at the model for direction k (see the top), a frame
  // of the settings' size. `center` is the middle of the model's bounds,
  // `radius` how far it reaches from there.
  aim(settings, k, center, radius) {
    const { camera } = this;
    const turn = THREE.MathUtils.degToRad(settings.start + (k * 360) / settings.directions);
    const down = THREE.MathUtils.degToRad(settings.elevation);
    // The camera goes round the other way: the model is seen turned by `turn`.
    const from = new THREE.Vector3(-Math.sin(turn) * Math.cos(down), Math.sin(down), Math.cos(turn) * Math.cos(down));
    camera.position.copy(center).addScaledVector(from, radius * 4 + 1);
    // Straight down the up of the picture is the side the camera came from.
    camera.up.set(0, 1, 0);
    if (settings.elevation > 89.99) camera.up.set(Math.sin(turn), 0, -Math.cos(turn));
    camera.lookAt(center);
    const unit = this.pixelsPerUnit(settings);
    camera.left = -settings.width / 2 / unit;
    camera.right = settings.width / 2 / unit;
    camera.top = settings.height / 2 / unit;
    camera.bottom = -settings.height / 2 / unit;
    camera.near = 0.01;
    camera.far = radius * 8 + 2;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

  // The middle of the model's bounds and how far it reaches from there; null
  // with nothing to draw.
  bounds(geometry) {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (!box || box.isEmpty() || !geometry.getAttribute('position')?.count) return null;
    return { center: box.getCenter(new THREE.Vector3()), radius: Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3) };
  }

  // The smallest frame size the model fits in, in every direction of the
  // settings, with a pixel to spare all round: { width, height }; null with
  // nothing to draw.
  fit(settings) {
    return this.withBareSurface((geometry) => {
      const reach = this.bounds(geometry);
      if (!reach) return null;
      const positions = geometry.getAttribute('position');
      const point = new THREE.Vector3();
      const unit = this.pixelsPerUnit(settings);
      let x = 0;
      let y = 0;
      for (let k = 0; k < settings.directions; k++) {
        this.aim(settings, k, reach.center, reach.radius);
        const view = this.camera.matrixWorldInverse;
        for (let i = 0; i < positions.count; i++) {
          point.fromBufferAttribute(positions, i).applyMatrix4(view);
          x = Math.max(x, Math.abs(point.x));
          y = Math.max(y, Math.abs(point.y));
        }
      }
      return { width: 2 * Math.ceil(x * unit) + 2, height: 2 * Math.ceil(y * unit) + 2 };
    });
  }

  // --- the render, bit by bit ------------------------------------------------------
  //
  // render() makes the sheets without holding the page up, however many
  // frames there are:
  //   - the surface drawn is a copy of the view's, posed here for every pose
  //     of a clip - the model on the screen is left as it is;
  //   - the frames are drawn side by side, each in a cell of one large
  //     picture, and read back from the graphics card a whole batch at a
  //     time, without waiting for it (readRenderTargetPixelsAsync);
  //   - what is read back is cut into frames and laid out on the sheets in a
  //     worker, on a thread of its own (see sprite-worker.js) - and made PNG
  //     there, for export;
  //   - the drawing goes on in slices of a few milliseconds, the page
  //     breathing between them; a render that is no longer wanted
  //     (`cancelled()`) stops at the next slice.
  // One render at a time: the next waits for the one before to stop.
  // (The cells start on multiples of 4 px, the dithering's pattern - laid
  // by the picture's pixels, see inSteps() - lies on every frame as it
  // would on a picture of its own.)

  // The worker the frames are laid out in.
  worker() {
    this.layoutWorker ??= new Worker(new URL('./sprite-worker.js', import.meta.url));
    return this.layoutWorker;
  }

  // The surface to draw - the view's, coloured as in the preview look - a
  // copy of its own: as it is shown, or (`rest`) as the model has it at
  // rest, the animation mode's pose put aside meanwhile.
  surface(rest) {
    const { view } = this.editor;
    const before = rest ? view.posed : null;
    if (before) {
      view.posed = null;
      view.updatePositions();
    }
    try {
      return this.withBareSurface((geometry) => geometry.clone());
    } finally {
      if (before) {
        view.posed = before;
        view.updatePositions();
      }
    }
  }

  // Points of the model at rest, in the frames of their objects: for
  // `vertices` (indices) { objects (ids), places (x, y, z each) } - and, with
  // `geometry` (the surface, a corner a vertex of `vertices`), the corners'
  // normals too, for posing it (see posed()). A point in the skin (see
  // skin.js) is bent by its nodes, not moved by its object: its place and
  // normal are in the world, and `weights[i]` its weights ([[node id,
  // weight]]; null for the others), `rests` every such node's frame at rest,
  // undone (Bᵢ⁻¹, see ModelPose).
  restPoints(vertices, geometry = null) {
    const { mesh } = this.editor;
    const frames = worldFrames(this.editor);
    const back = new Map(); // id -> its frame's turn, undone
    const objects = new Array(vertices.length);
    const places = new Float32Array(vertices.length * 3);
    const normals = geometry ? new Float32Array(vertices.length * 3) : null;
    const normal = geometry?.getAttribute('normal');
    const weights = mesh.weights.size ? new Array(vertices.length).fill(null) : null;
    const rests = new Map();
    const point = new THREE.Vector3();
    vertices.forEach((vertex, i) => {
      const id = mesh.vertexObject[vertex];
      const frame = frames.get(id);
      const skin = weights ? mesh.weights.get(vertex) : null;
      objects[i] = id;
      if (skin) {
        weights[i] = skin;
        for (const [node] of skin) {
          const at = frames.get(node);
          if (at && !rests.has(node)) rests.set(node, new THREE.Matrix4().compose(at.origin, at.quaternion, new THREE.Vector3(1, 1, 1)).invert());
        }
        point.copy(mesh.vertices[vertex]).toArray(places, i * 3);
        if (normals) point.fromBufferAttribute(normal, i).toArray(normals, i * 3);
        return;
      }
      if (!back.has(id)) back.set(id, frame.quaternion.clone().invert());
      point.copy(mesh.vertices[vertex]).sub(frame.origin).applyQuaternion(back.get(id)).toArray(places, i * 3);
      if (normals) point.fromBufferAttribute(normal, i).applyQuaternion(back.get(id)).toArray(normals, i * 3);
    });
    return { objects, places, normals, weights, rests };
  }

  // Every point of `points` (see restPoints()) where the pose `matrices`
  // (Map id -> Matrix4, see posedMatrices()) puts it: `visit(x, y, z, i, e)`
  // - `e` the elements of the matrix that put it there: its object's, or for
  // a point in the skin its nodes' bends mixed by its weights (Σ wᵢ·Mᵢ·Bᵢ⁻¹;
  // a node not posed bends nothing).
  eachPosed(points, matrices, visit) {
    const { objects, places, weights, rests } = points;
    const bends = new Map(); // node id -> the elements of Mᵢ·Bᵢ⁻¹
    for (const [node, back] of rests ?? []) {
      const matrix = matrices.get(node);
      if (matrix) bends.set(node, matrix.clone().multiply(back).elements);
    }
    const mixed = new Float32Array(16);
    for (let i = 0; i < objects.length; i++) {
      let e;
      const skin = weights?.[i];
      if (skin) {
        mixed.fill(0);
        for (const [node, weight] of skin) {
          const bend = bends.get(node);
          if (bend) for (let k = 0; k < 16; k++) mixed[k] += bend[k] * weight;
          else for (let k = 0; k < 16; k += 5) mixed[k] += weight;
        }
        e = mixed;
      } else {
        e = matrices.get(objects[i])?.elements;
      }
      const x = places[i * 3];
      const y = places[i * 3 + 1];
      const z = places[i * 3 + 2];
      if (e) visit(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14], i, e);
    }
  }

  // The copy of the surface put in the pose `matrices`: its corners' places
  // and normals (`corners`: restPoints() of its corners, with the normals).
  posed(geometry, corners, matrices) {
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const p = position.array;
    const n = normal.array;
    const { objects, normals, weights } = corners;
    const turns = new Map(); // id -> its normal matrix's elements
    const bent = new THREE.Matrix3();
    const whole = new THREE.Matrix4();
    this.eachPosed(corners, matrices, (x, y, z, at, e) => {
      const i = at * 3;
      p[i] = x;
      p[i + 1] = y;
      p[i + 2] = z;
      const id = objects[at];
      let m;
      if (weights?.[at]) {
        m = bent.getNormalMatrix(whole.fromArray(e)).elements;
      } else {
        m = turns.get(id);
        if (!m) {
          m = new THREE.Matrix3().getNormalMatrix(matrices.get(id)).elements;
          turns.set(id, m);
        }
      }
      const a = normals[i];
      const b = normals[i + 1];
      const c = normals[i + 2];
      const nx = m[0] * a + m[3] * b + m[6] * c;
      const ny = m[1] * a + m[4] * b + m[7] * c;
      const nz = m[2] * a + m[5] * b + m[8] * c;
      const length = Math.hypot(nx, ny, nz) || 1;
      n[i] = nx / length;
      n[i + 1] = ny / length;
      n[i + 2] = nz / length;
    });
    position.needsUpdate = true;
    normal.needsUpdate = true;
  }

  // The vertices drawn: those of the faces shown, each once.
  shownVertices() {
    return [...new Set(this.editor.view.triangleIndices ?? [])];
  }

  // Every pose of the clips a sprite takes, worked out as it is asked for:
  // [{ clip, frames, matrices(i) }] - the matrices of its i-th frame.
  clipPoses(clips, spriteFps) {
    const locals = localTransforms(this.editor);
    return clips.map((clip) => {
      const frames = spriteFrames(clip, spriteFps);
      const matrices = (i) => posedMatrices(this.editor, clipValues(this.editor, clip, frames[i], new Map(), locals), locals);
      return { clip, frames, matrices };
    });
  }

  // The point all the clips' frames are drawn about - the middle of the
  // bounds of all their poses - and how far the model reaches from it (as
  // bounds() has it); null with nothing to draw. `poses`: clipPoses(); every
  // pose's matrices kept on it (`matrices.all`) for the drawing.
  async reachOf(points, poses, breathe = async () => {}) {
    const box = new THREE.Box3();
    const point = new THREE.Vector3();
    for (const pose of poses) {
      pose.all = [];
      for (let i = 0; i < pose.frames.length; i++) {
        const matrices = pose.matrices(i);
        pose.all.push(matrices);
        this.eachPosed(points, matrices, (x, y, z) => box.expandByPoint(point.set(x, y, z)));
        await breathe();
      }
    }
    if (box.isEmpty()) return null;
    return { center: box.getCenter(new THREE.Vector3()), radius: Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3) };
  }

  // The smallest frame size every pose of the clips fits in, from every
  // direction of the settings, a pixel to spare all round; null with nothing
  // to draw. (fit(), for the clips.)
  async fitClips(settings, clips) {
    const points = this.restPoints(this.shownVertices());
    const poses = this.clipPoses(clips, settings.spriteFps);
    const reach = await this.reachOf(points, poses);
    if (!reach) return null;
    const unit = this.pixelsPerUnit(settings);
    let x = 0;
    let y = 0;
    for (let k = 0; k < settings.directions; k++) {
      this.aim(settings, k, reach.center, reach.radius);
      const e = this.camera.matrixWorldInverse.elements;
      for (const pose of poses) {
        for (const matrices of pose.all) {
          this.eachPosed(points, matrices, (px, py, pz) => {
            x = Math.max(x, Math.abs(e[0] * px + e[4] * py + e[8] * pz + e[12]));
            y = Math.max(y, Math.abs(e[1] * px + e[5] * py + e[9] * pz + e[13]));
          });
        }
      }
    }
    return { width: 2 * Math.ceil(x * unit) + 2, height: 2 * Math.ceil(y * unit) + 2 };
  }

  // The sheets, bit by bit (see above): the model as it is shown - one sheet,
  // a frame for every direction - or, with `clips`, those of them `drawn` in
  // their poses (drawn about the point of all of them): a sheet for every
  // clip's direction. Each sheet { canvas (an ImageBitmap) - or, with `png`,
  // png (its bytes) - width, height, frames: [{ x, y, w, h, angle }], columns,
  // rows }:
  //   - as it is shown: that sheet;
  //   - the clips: [{ name, loop, fps, frames (how many), directions:
  //     [{ angle, ...a sheet }] }].
  // { empty: true } with nothing to draw; null if cancelled. `progress(part)`
  // is told how far it has got, 0 to 1.
  async render(settings, { clips = null, drawn = clips, png = false } = {}, { cancelled = () => false, progress = () => {} } = {}) {
    const before = this.running;
    let finished;
    this.running = new Promise((resolve) => {
      finished = resolve;
    });
    await before;
    try {
      return cancelled() ? null : await this.draw(settings, { clips, drawn, png }, cancelled, progress);
    } finally {
      finished();
    }
  }

  async draw(settings, { clips, drawn, png }, cancelled, progress) {
    const { renderer } = this.editor.viewport;
    const { atlas } = this.editor;
    this.atlasSize.set(atlas.width, atlas.height);
    const geometry = this.surface(Boolean(clips));
    const job = (this.jobs = (this.jobs ?? 0) + 1);
    const worker = this.worker();
    let target = null;
    let drawing = null; // the renderer's state before a slice of drawing, while one goes on
    const leave = () => {
      if (!drawing) return;
      renderer.setRenderTarget(drawing.target);
      renderer.setClearColor(drawing.color, drawing.alpha);
      drawing = null;
    };
    const enter = () => {
      if (drawing) return;
      drawing = { target: renderer.getRenderTarget(), color: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha() };
      renderer.setClearColor(0x000000, 0);
    };
    // A breath between slices: the page goes on, then the render - unless it is no longer wanted.
    let slice = performance.now();
    const breathe = async (now = false) => {
      if (!now && performance.now() - slice < SLICE) return;
      leave();
      await (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0)));
      if (cancelled()) throw CANCELLED;
      slice = performance.now();
    };
    try {
      // What is drawn: the poses (none: as shown), each from every direction, and the sheets they go on.
      const { directions, width, height } = settings;
      let reach;
      let samples; // [{ matrices, sheet(k), frame(k) }]
      let sheets; // [{ layout, angle }]
      let corners = null;
      let shown = null;
      if (!clips) {
        reach = this.bounds(geometry);
        if (!reach) return { empty: true };
        sheets = [{ layout: sheetLayout(directions, settings), angle: null }];
        samples = [{ matrices: null, sheet: () => 0, frame: (k) => k }];
      } else {
        const vertices = this.shownVertices();
        corners = this.restPoints(this.editor.view.triangleIndices ?? [], geometry);
        const poses = this.clipPoses(clips, settings.spriteFps);
        reach = await this.reachOf(this.restPoints(vertices), poses, breathe);
        if (!reach) return { empty: true };
        shown = poses.filter(({ clip }) => drawn.includes(clip));
        sheets = [];
        samples = [];
        shown.forEach((pose) => {
          const base = sheets.length;
          for (let k = 0; k < directions; k++) sheets.push({ layout: sheetLayout(pose.frames.length, settings), angle: directionAngle(settings, k) });
          pose.all.forEach((matrices, i) => samples.push({ matrices, sheet: (k) => base + k, frame: () => i }));
        });
      }
      worker.postMessage({ type: 'begin', job, sheets: sheets.map(({ layout }) => ({ w: layout.w, h: layout.h })) });

      // The batch picture: cells a frame each, as many as fit (or are wanted).
      const total = samples.length * directions;
      const cellW = Math.ceil(width / 4) * 4;
      const cellH = Math.ceil(height / 4) * 4;
      const largest = Math.min(BATCH_SIZE, renderer.capabilities.maxTextureSize);
      const columns = Math.max(1, Math.min(total, Math.floor(largest / cellW)));
      const rows = Math.max(1, Math.min(Math.ceil(total / columns), Math.floor(largest / cellH)));
      target = new THREE.WebGLRenderTarget(columns * cellW, rows * cellH, { samples: 0 });
      target.texture.colorSpace = THREE.SRGBColorSpace; // the colours as the screen has them
      target.scissorTest = true;

      this.mesh.geometry = geometry;
      this.mesh.material = this.materialsFor(settings);
      const { ambient, head, sun, sky } = this.lights;
      ambient.visible = head.visible = settings.light === 'camera';
      sun.visible = sky.visible = settings.light === 'custom';
      sun.intensity = settings.lightStrength;
      sun.target.position.copy(reach.center);
      sun.position.copy(reach.center).addScaledVector(lightDirection(settings.lightAzimuth, settings.lightElevation), reach.radius * 4 + 1);

      let tiles = [];
      // The cells drawn so far, read back and sent to the worker.
      const flush = async () => {
        if (tiles.length === 0) return;
        leave();
        const used = Math.ceil(tiles.length / columns) * cellH;
        const buffer = new Uint8Array(target.width * used * 4);
        await renderer.readRenderTargetPixelsAsync(target, 0, 0, target.width, used, buffer);
        if (cancelled()) throw CANCELLED;
        worker.postMessage({ type: 'tiles', job, buffer: buffer.buffer, width: target.width, tiles }, [buffer.buffer]);
        tiles = [];
      };
      let done = 0;
      for (const sample of samples) {
        if (sample.matrices) this.posed(geometry, corners, sample.matrices);
        for (let k = 0; k < directions; k++) {
          enter();
          const cell = tiles.length;
          const gx = (cell % columns) * cellW;
          const gy = Math.floor(cell / columns) * cellH;
          target.viewport.set(gx, gy, width, height);
          target.scissor.set(gx, gy, width, height);
          renderer.setRenderTarget(target);
          this.aim(settings, k, reach.center, reach.radius);
          renderer.render(this.scene, this.camera); // (cleared first: the cell, by the scissor)
          const sheet = sample.sheet(k);
          const place = sheets[sheet].layout.places[sample.frame(k)];
          tiles.push({ gx, gy, w: width, h: height, sheet, x: place.x, y: place.y });
          done++;
          if (tiles.length === columns * rows) await flush();
          if (performance.now() - slice >= SLICE) {
            progress(done / total);
            await breathe(true);
          }
        }
      }
      await flush();
      progress(1);

      // The sheets, from the worker.
      const results = await new Promise((resolve) => {
        const listen = ({ data }) => {
          if (data.job !== job) return;
          worker.removeEventListener('message', listen);
          resolve(data.results);
        };
        worker.addEventListener('message', listen);
        worker.postMessage({ type: 'end', job, png });
      });
      if (cancelled()) return null;
      const made = sheets.map(({ layout, angle }, i) => ({
        [png ? 'png' : 'canvas']: results[i],
        width: layout.w,
        height: layout.h,
        columns: layout.columns,
        rows: layout.rows,
        frames: layout.places.map(({ x, y }, k) => ({ x, y, w: width, h: height, angle: angle ?? directionAngle(settings, k) })),
      }));
      if (!clips) return made[0];
      return shown.map(({ clip, frames }, c) => ({
        name: clip.name,
        loop: clip.loop,
        fps: settings.spriteFps,
        frames: frames.length,
        directions: made.slice(c * directions, (c + 1) * directions).map((sheet, k) => ({ angle: directionAngle(settings, k), ...sheet })),
      }));
    } catch (error) {
      if (error !== CANCELLED) throw error;
      worker.postMessage({ type: 'cancel', job });
      return null;
    } finally {
      leave();
      target?.dispose();
      this.mesh.geometry = EMPTY;
      geometry.dispose();
      this.editor.viewport.requestRender();
    }
  }
}

// A slice of drawing, ms, before the page has its turn (see render()).
const SLICE = 8;
// The largest batch picture, px each way.
const BATCH_SIZE = 4096;
const CANCELLED = Symbol('cancelled');
const EMPTY = new THREE.BufferGeometry();

// Where `count` frames of the settings' size lie on a sheet in the settings'
// grid (see the top): { w, h (the sheet's size), columns, rows, places:
// [{ x, y }] }.
export function sheetLayout(count, settings) {
  const { columns, rows } = sheetGrid(count, settings);
  const pot = (size) => (settings.pot ? 2 ** Math.ceil(Math.log2(size)) : size);
  return {
    w: pot(columns * settings.width + (columns - 1) * settings.padding),
    h: pot(rows * settings.height + (rows - 1) * settings.padding),
    columns,
    rows,
    places: Array.from({ length: count }, (_, k) => ({
      x: (k % columns) * (settings.width + settings.padding),
      y: Math.floor(k / columns) * (settings.height + settings.padding),
    })),
  };
}

// The turn direction k is seen at (see the top), in degrees, 0 to 360.
export function directionAngle(settings, k) {
  return (((settings.start + (k * 360) / settings.directions) % 360) + 360) % 360;
}

// The name of a clip's direction's animation in Godot - <clip>_<angle> -
// and the PNG it is drawn in: <stem>_<clip>_<angle>.png.
export const clipAnimationName = (clip, direction) => `${clip.name}_${Math.round(direction.angle) % 360}`;
export const clipImageName = (stem, clip, direction) => `${stem}_${clipAnimationName(clip, direction)}.png`;

// The clips' sheets as Godot's SpriteFrames, for an AnimatedSprite2D (or
// 3D): a .tres beside the PNGs, which names them by their paths relative to
// it. An animation for every clip's direction, its frames regions of its
// PNG, at the sprite's rate, looping as the clip does.
export function clipsTres(stem, sheets) {
  const external = [];
  const regions = [];
  const animations = [];
  for (const clip of sheets) {
    for (const direction of clip.directions) {
      const texture = `${external.length + 1}_png`;
      external.push(`[ext_resource type="Texture2D" path="${clipImageName(stem, clip, direction)}" id="${texture}"]`);
      const frames = direction.frames.map((frame) => {
        const region = `AtlasTexture_${regions.length + 1}`;
        regions.push(`[sub_resource type="AtlasTexture" id="${region}"]\natlas = ExtResource("${texture}")\nregion = Rect2(${frame.x}, ${frame.y}, ${frame.w}, ${frame.h})`);
        return `{\n"duration": 1.0,\n"texture": SubResource("${region}")\n}`;
      });
      animations.push(`{\n"frames": [${frames.join(', ')}],\n"loop": ${clip.loop},\n"name": &"${clipAnimationName(clip, direction)}",\n"speed": ${clip.fps.toFixed(1)}\n}`);
    }
  }
  return [
    `[gd_resource type="SpriteFrames" load_steps=${external.length + regions.length + 1} format=3]`,
    ...external,
    ...regions,
    `[resource]\nanimations = [${animations.join(', ')}]`,
  ].join('\n\n') + '\n';
}

// The clips' sheets as JSON: for every clip's direction its PNG, its
// frames' places, its rate and whether it loops.
export function clipsJSON(stem, sheets, settings) {
  return JSON.stringify({
    meta: {
      app: 'verTEX',
      directions: settings.directions,
      elevation: settings.elevation,
      fps: settings.spriteFps,
      size: { w: settings.width, h: settings.height },
    },
    animations: sheets.flatMap((clip) => clip.directions.map((direction) => ({
      name: clipAnimationName(clip, direction),
      clip: clip.name,
      angle: +direction.angle.toFixed(4),
      image: clipImageName(stem, clip, direction),
      size: { w: direction.width, h: direction.height },
      loop: clip.loop,
      fps: clip.fps,
      frames: direction.frames.map(({ x, y, w, h }) => ({ x, y, w, h })),
    }))),
  }, null, 1);
}

// How many columns and rows `frames` frames take in the grid of the settings.
export function sheetGrid(frames, settings) {
  const count = Math.max(1, Math.min(frames, settings.count));
  if (settings.layout === 'columns') return { columns: count, rows: Math.ceil(frames / count) };
  if (settings.layout === 'rows') {
    const columns = Math.ceil(frames / count);
    return { columns, rows: Math.ceil(frames / columns) };
  }
  return { columns: frames, rows: 1 };
}

// How far from the line where light crosses from one step to the next the
// dithering reaches, on either side, in the sprite's pixels (see inSteps()).
const DITHER_PIXELS = 2;

// The threshold of ordered dithering at a pixel of the picture: the 4 x 4
// Bayer matrix, by the pixel's place in it - each threshold once in every 4 x 4.
const BAYER = /* glsl */ `
float stepThreshold( vec2 pixel ) {
	const int matrix[ 16 ] = int[ 16 ]( 0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5 );
	ivec2 at = ivec2( mod( floor( pixel ), 4.0 ) );
	return ( float( matrix[ at.y * 4 + at.x ] ) + 0.5 ) / 16.0;
}
`;

// Makes a Lambert material light in `steps` steps (see `blend` at the top):
// the light a face takes from a light of its own - 0 turned away, 1 turned
// straight at it - rounded down to the steps' bands, 0 to 1, in equal parts;
// `dither`: null, none; 'bounds', where the light crosses from step to
// step; 'faces', all light between two steps (see `ditherFaces` at the
// top). Added to whatever the material's shader has had done to it already.
function inSteps(material, steps, dither = null) {
  const before = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    before?.call(material, shader, renderer);
    const line = 'float dotNL = saturate( dot( geometryNormal, directLight.direction ) );';
    const chunk = THREE.ShaderChunk.lights_lambert_pars_fragment;
    if (!chunk.includes(line)) throw new Error('three.js: the Lambert light is worked out otherwise now (see inSteps())');
    // Where the light is in the steps: their bounds are the whole numbers.
    // Dithered, only where the light crosses a bound - DITHER_PIXELS of the
    // sprite's pixels on either side of the line it crosses it on, measured
    // by how fast it changes from one pixel to the next: the nearer the step
    // above, the more of its pixels. Elsewhere a step is whole; and a flat
    // face, lit evenly all over, crosses no bound, and is never dithered.
    const stepped = dither === 'faces'
      // Down or up as the Bayer matrix's threshold at the pixel says (a
      // threshold of a half would be the rounding down).
      ? `dotNL = clamp( floor( dotNL * ${steps}.0 + stepThreshold( gl_FragCoord.xy ) - 0.5 ), 0.0, ${steps - 1}.0 ) / ${steps - 1}.0;`
      : dither === 'bounds'
      ? `{
	float place = dotNL * ${steps}.0;
	float bound = clamp( floor( place + 0.5 ), 1.0, ${steps - 1}.0 );
	float pixels = ( place - bound ) / max( fwidth( place ), 1e-6 );
	float above = clamp( pixels / ${DITHER_PIXELS * 2}.0 + 0.5, 0.0, 1.0 );
	float level = abs( pixels ) < ${DITHER_PIXELS}.0 ? bound - 1.0 + step( stepThreshold( gl_FragCoord.xy ), above ) : floor( place );
	dotNL = clamp( level, 0.0, ${steps - 1}.0 ) / ${steps - 1}.0;
}`
      : `dotNL = clamp( floor( dotNL * ${steps}.0 ), 0.0, ${steps - 1}.0 ) / ${steps - 1}.0;`;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_lambert_pars_fragment>',
      BAYER + chunk.replace(line, `${line}\n\t${stepped}`),
    );
  };
  // (A program for every number of steps, with and without dithering:
  // three.js would otherwise take the one made for another, the function's
  // text being the same.)
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${key()} steps ${steps} ${dither}`;
  return material;
}

// The sheet's frames as a JSON a game engine reads (the "hash" kind that
// TexturePacker and Aseprite write): every frame by name, where it is on
// the sheet, and the turn it shows.
export function sheetJSON(name, image, sheet, settings) {
  const frames = {};
  sheet.frames.forEach((frame, k) => {
    frames[`${name}_${k}`] = {
      frame: { x: frame.x, y: frame.y, w: frame.w, h: frame.h },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: frame.w, h: frame.h },
      sourceSize: { w: frame.w, h: frame.h },
      pivot: { x: 0.5, y: 0.5 },
      angle: +frame.angle.toFixed(4),
    };
  });
  return JSON.stringify({
    frames,
    meta: {
      app: 'verTEX',
      image,
      format: 'RGBA8888',
      size: { w: sheet.width, h: sheet.height },
      scale: '1',
      directions: settings.directions,
      elevation: settings.elevation,
    },
  }, null, 1);
}
