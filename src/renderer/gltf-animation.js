import { turnOf } from './pose.js';
import { sampleTrack } from './animation.js';

// The animations (see animation.js) as glTF has them, for Godot: a glTF
// animation for every clip, a channel for every track - on the node of its
// entry (a body's node, for an object with collision shapes) - and its keys
// as samples in seconds: frame / fps.
//
// What Godot makes of them was tried on its own import (4.7): STEP and
// LINEAR samplers come through as they are; a CUBICSPLINE one does not (it
// is taken apart into straight pieces), and a turn goes the short way round
// between two samples. So:
//   - a track that only steps is a STEP sampler, its keys as they are;
//   - every other one is LINEAR, with as many samples as it takes to be the
//     same as in the editor: a smooth stretch (any ease) is baked - a sample
//     every 1/BAKE_RATE s at least, more often if the clip's frames are;
//     a turn is cut so that no two samples are more than 90 degrees apart
//     (0 to 720: two turns, not none); a step inside a track that does more
//     holds until a hair before its next key;
//   - a turn is a quaternion, each on the same side as the one before it
//     (one turned by quaternions already, as it is: never cut, it goes
//     the short way as glTF's does).
// A looping clip's name ends in "-loop": Godot loops it, and takes the
// ending away. A clip longer than its keys gets a last sample at its end,
// on its every track, so that Godot's clip is as long as it.

export const BAKE_RATE = 60; // samples a second for smooth stretches, at least (Godot imports at 30 unless told otherwise)
const MAX_TURN = 90; // degrees between two samples of a turn
const HOLD = 1e-4; // s before the next key: where a step inside a linear track still holds

// The frames a track is sampled at (sorted, each once), and whether it only steps.
function samplesOf(track, clip) {
  const keys = track.keys;
  const steps = keys.slice(0, -1).every((key) => key.interpolation === 'step');
  const frames = new Set(keys.map((key) => key.frame));
  if (keys[keys.length - 1].frame < clip.length) frames.add(clip.length); // (holds to the clip's end)
  if (steps) return { steps, frames: [...frames].sort((a, b) => a - b) };
  const every = Math.min(1, clip.fps / BAKE_RATE); // frames between baked samples
  keys.forEach((a, i) => {
    const b = keys[i + 1];
    if (!b) return;
    const span = b.frame - a.frame;
    let parts = 1;
    if (a.interpolation === 'smooth') parts = Math.ceil(span / every);
    if (track.property === 'rotation' && a.interpolation !== 'step' && a.value.length === 3) {
      const turn = Math.max(...a.value.map((value, k) => Math.abs(b.value[k] - value)));
      parts = Math.max(parts, Math.ceil(turn / MAX_TURN));
    }
    for (let k = 1; k < parts; k++) frames.add(a.frame + (span * k) / parts);
    if (a.interpolation === 'step') frames.add(b.frame - HOLD * clip.fps);
  });
  return { steps, frames: [...frames].sort((a, b) => a - b) };
}

// The clips as glTF animations. `nodeOf(id)` is an entry's node (undefined:
// not exported - hidden); `accessor(array, type, count, extra)` puts the
// numbers among the file's bytes.
export function animationsOf(model, nodeOf, accessor) {
  const out = [];
  for (const clip of model.animations ?? []) {
    const samplers = [];
    const channels = [];
    for (const track of clip.tracks) {
      const node = nodeOf(track.object);
      if (node === undefined || !track.keys.length) continue;
      const { steps, frames } = samplesOf(track, clip);
      const times = frames.map((frame) => frame / clip.fps);
      const values = [];
      let last = null;
      for (const frame of frames) {
        const value = sampleTrack(track, frame);
        if (track.property !== 'rotation') {
          values.push(...value);
          continue;
        }
        const q = turnOf(value);
        if (last && last.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w); // (the same turn, on the near side)
        last = q;
        values.push(q.x, q.y, q.z, q.w);
      }
      const input = accessor(new Float32Array(times), 'SCALAR', times.length, { min: [Math.min(...times)], max: [Math.max(...times)] });
      const output = accessor(new Float32Array(values), track.property === 'rotation' ? 'VEC4' : 'VEC3', frames.length);
      channels.push({ sampler: samplers.push({ input, output, interpolation: steps ? 'STEP' : 'LINEAR' }) - 1, target: { node, path: PATHS[track.property] } });
    }
    if (channels.length) out.push({ name: clip.loop ? `${clip.name}-loop` : clip.name, samplers, channels });
  }
  return out;
}

const PATHS = { position: 'translation', rotation: 'rotation', scale: 'scale' };
