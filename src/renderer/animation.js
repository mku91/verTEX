// The animations: the model's objects and groups moved, turned and scaled
// over time, by keyframes - the way glTF has it, and Godot after it (an
// AnimationPlayer with a clip for each).
//
// A clip:
//   { name,          Latin letters, as names in the scene tree (see names.js)
//     fps,           frames a second: time is counted in whole frames
//     length,        in frames
//     loop,          played over and over (Godot gets it as "-loop" on the name)
//     tracks: [{ object,    an entry's id
//                property,  'position' | 'rotation' | 'scale'
//                keys: [{ frame, value: [x, y, z], interpolation }] }] }
// A value is the entry's place in its parent, as pose.js has it: the
// position in the parent's frame; the turn as angles in degrees (XYZ), which
// may go past 180 - a wheel turned through 720 turns twice; the scale as
// times its size. A key's interpolation is how it goes on to the next:
// 'linear', 'step' (it holds, then jumps) or 'smooth' (eases in and out).
//
// What a clip does not move stays in the rest pose: the model as it is.

export const PROPERTIES = ['position', 'rotation', 'scale'];
export const INTERPOLATIONS = ['linear', 'step', 'smooth'];
export const MAX_FPS = 120;

const NAME = /^[A-Za-z0-9 _.\-]+$/;
const isTriple = (value) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const isFrame = (value) => Number.isInteger(value) && value >= 0;

// Whether a clip, as read from a file, is one; `ids` the entries there are.
export function soundAnimation(clip, ids) {
  if (!clip || typeof clip !== 'object') return false;
  if (typeof clip.name !== 'string' || !NAME.test(clip.name)) return false;
  if (!(Number.isInteger(clip.fps) && clip.fps >= 1 && clip.fps <= MAX_FPS)) return false;
  if (!(Number.isInteger(clip.length) && clip.length >= 1)) return false;
  if (typeof clip.loop !== 'boolean' || !Array.isArray(clip.tracks)) return false;
  return clip.tracks.every((track) =>
    track && ids.has(track.object) && PROPERTIES.includes(track.property) &&
    Array.isArray(track.keys) && track.keys.length > 0 &&
    track.keys.every((key) => key && isFrame(key.frame) && isTriple(key.value) && INTERPOLATIONS.includes(key.interpolation)));
}
