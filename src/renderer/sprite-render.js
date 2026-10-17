import * as THREE from 'three';
import { keepToFaces } from './mesh.js';

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

const ALPHA_CUT = 128; // a pixel is there from this alpha on

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

  // The frames: an ImageData for every direction, in order; [] with nothing to draw.
  frames(settings) {
    const { renderer } = this.editor.viewport;
    const { atlas } = this.editor;
    this.atlasSize.set(atlas.width, atlas.height);
    return this.withBareSurface((geometry) => {
      const reach = this.bounds(geometry);
      if (!reach) return [];
      this.mesh.geometry = geometry;
      this.mesh.material = this.materialsFor(settings);
      const { ambient, head, sun, sky } = this.lights;
      ambient.visible = head.visible = settings.light === 'camera';
      sun.visible = sky.visible = settings.light === 'custom';
      sun.intensity = settings.lightStrength;
      sun.target.position.copy(reach.center);
      sun.position.copy(reach.center).addScaledVector(lightDirection(settings.lightAzimuth, settings.lightElevation), reach.radius * 4 + 1);
      const target = new THREE.WebGLRenderTarget(settings.width, settings.height, { samples: 0 });
      target.texture.colorSpace = THREE.SRGBColorSpace; // the colours as the screen has them
      const before = { target: renderer.getRenderTarget(), color: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha() };
      const bytes = new Uint8Array(settings.width * settings.height * 4);
      const frames = [];
      try {
        renderer.setRenderTarget(target);
        renderer.setClearColor(0x000000, 0);
        for (let k = 0; k < settings.directions; k++) {
          this.aim(settings, k, reach.center, reach.radius);
          renderer.clear();
          renderer.render(this.scene, this.camera);
          renderer.readRenderTargetPixels(target, 0, 0, settings.width, settings.height, bytes);
          frames.push(this.toImage(bytes, settings.width, settings.height));
        }
      } finally {
        renderer.setRenderTarget(before.target);
        renderer.setClearColor(before.color, before.alpha);
        target.dispose();
        this.editor.viewport.requestRender();
      }
      return frames;
    });
  }

  // The pixels read back (rows from the bottom) as an ImageData (rows from the
  // top), every pixel there or not.
  toImage(bytes, width, height) {
    const image = new ImageData(width, height);
    for (let row = 0; row < height; row++) {
      image.data.set(bytes.subarray((height - 1 - row) * width * 4, (height - row) * width * 4), row * width * 4);
    }
    for (let i = 3; i < image.data.length; i += 4) {
      if (image.data[i] < ALPHA_CUT) image.data.fill(0, i - 3, i + 1);
      else image.data[i] = 255;
    }
    return image;
  }

  // The sheet: { canvas, frames: [{ x, y, w, h, angle }], columns, rows } -
  // the frames laid out in the grid of the settings (see the top); null
  // with nothing to draw.
  sheet(settings) {
    const images = this.frames(settings);
    if (images.length === 0) return null;
    const { columns, rows } = sheetGrid(images.length, settings);
    const canvas = document.createElement('canvas');
    const pot = (size) => (settings.pot ? 2 ** Math.ceil(Math.log2(size)) : size);
    canvas.width = pot(columns * settings.width + (columns - 1) * settings.padding);
    canvas.height = pot(rows * settings.height + (rows - 1) * settings.padding);
    const context = canvas.getContext('2d');
    const frames = images.map((image, k) => {
      const x = (k % columns) * (settings.width + settings.padding);
      const y = Math.floor(k / columns) * (settings.height + settings.padding);
      context.putImageData(image, x, y);
      return { x, y, w: settings.width, h: settings.height, angle: (settings.start + (k * 360) / settings.directions) % 360 };
    });
    return { canvas, frames, columns, rows };
  }
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
      size: { w: sheet.canvas.width, h: sheet.canvas.height },
      scale: '1',
      directions: settings.directions,
      elevation: settings.elevation,
    },
  }, null, 1);
}
