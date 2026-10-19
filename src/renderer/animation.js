// The animations: the model's objects and nodes moved, turned and scaled
// over time, by keyframes - the way glTF has it, and Godot after it (an
// AnimationPlayer with a clip for each).
//
// A clip:
//   { name,          Latin letters, as names in the scene tree (see names.js)
//     fps,           frames a second: time is counted in frames (a key may
//                    stand between two, to a hundredth of one)
//     length,        in frames
//     loop,          played over and over (Godot gets it as "-loop" on the name)
//     tracks: [{ object,    an entry's id
//                property,  'position' | 'rotation' | 'scale'
//                keys: [{ frame, value: [x, y, z], interpolation }] }] }
// A value is the entry's place in its parent, as pose.js has it: the
// position in the parent's frame; the turn as angles in degrees (XYZ), which
// may go past 180 - a wheel turned through 720 turns twice - or, for an
// entry turned by quaternions (its `rotationMode`, see
// Editor.setRotationMode()), a quaternion [x, y, z, w]; the scale as times
// its size. A key's interpolation is how it goes on to the next:
// 'linear', 'step' (it holds, then jumps) or 'smooth' (eases in and out).
//
// What a clip does not move stays in the rest pose: the model as it is.

export const PROPERTIES = ['position', 'rotation', 'scale'];
export const INTERPOLATIONS = ['linear', 'step', 'smooth'];
export const MAX_FPS = 120;

const NAME = /^[A-Za-z0-9 _.\-]+$/;
const isTriple = (value) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
// (A key may stand between frames - dragged there with Ctrl - to a hundredth.)
const isFrame = (value) => Number.isFinite(value) && value >= 0;
// A turn may be a quaternion: four numbers, not all nought.
const soundValue = (property, value) => isTriple(value) ||
  (property === 'rotation' && Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) && value.some(Boolean));

// --- quaternions, as [x, y, z, w] ----------------------------------------------------

export const normalized = (q) => {
  const length = Math.hypot(...q) || 1;
  return q.map((value) => value / length);
};

// The way from one quaternion to another along the sphere - the short way:
// a turn and its opposite quaternion are one turn.
export function slerp(a, b, t) {
  a = normalized(a);
  b = normalized(b);
  let cos = a.reduce((sum, value, i) => sum + value * b[i], 0);
  if (cos < 0) {
    b = b.map((value) => -value);
    cos = -cos;
  }
  if (cos > 0.9995) return normalized(a.map((value, i) => value + (b[i] - value) * t));
  const angle = Math.acos(cos);
  const sa = Math.sin((1 - t) * angle) / Math.sin(angle);
  const sb = Math.sin(t * angle) / Math.sin(angle);
  return a.map((value, i) => value * sa + b[i] * sb);
}

// Angles as near as can be to `near`: each axis put 360 this way or that, so
// that a turn taken further does not jump back across 180.
export function unwrap(angles, near) {
  return angles.map((angle, i) => angle + 360 * Math.round(((near?.[i] ?? 0) - angle) / 360));
}
export const frameOf = (value) => Math.max(0, Math.round(value * 100) / 100);

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
    track.keys.every((key) => key && isFrame(key.frame) && soundValue(track.property, key.value) && INTERPOLATIONS.includes(key.interpolation) && soundEase(key.ease)));
}

// --- easing: how a smooth key goes on to the next ------------------------------------
//
// A 'smooth' key may say how (`ease`): by one of Penner's easing equations
// (a name: 'sineOut', 'backInOut', ...), or by a curve of its own - a cubic
// Bezier from (0, 0) to (1, 1) with two handles, [x1, y1, x2, y2], as CSS's
// cubic-bezier(). Without one it eases in and out as a smoothstep does.

const back = 1.70158;
const elastic = (2 * Math.PI) / 3;
const elasticInOut = (2 * Math.PI) / 4.5;
function bounceOut(t) {
  const n = 7.5625;
  const d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
}
const power = (n) => ({
  In: (t) => t ** n,
  Out: (t) => 1 - (1 - t) ** n,
  InOut: (t) => (t < 0.5 ? 2 ** (n - 1) * t ** n : 1 - (-2 * t + 2) ** n / 2),
});
// Each family's In, Out and InOut; and the Bezier each is drawn as when its
// handles are taken (Elastic and Bounce are no Bezier: an ease-in-out then).
export const EASE_FAMILIES = {
  sine: {
    label: 'Sine',
    In: (t) => 1 - Math.cos((t * Math.PI) / 2),
    Out: (t) => Math.sin((t * Math.PI) / 2),
    InOut: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
    bezier: { In: [0.12, 0, 0.39, 0], Out: [0.61, 1, 0.88, 1], InOut: [0.37, 0, 0.63, 1] },
  },
  quad: { label: 'Quad', ...power(2), bezier: { In: [0.11, 0, 0.5, 0], Out: [0.5, 1, 0.89, 1], InOut: [0.45, 0, 0.55, 1] } },
  cubic: { label: 'Cubic', ...power(3), bezier: { In: [0.32, 0, 0.67, 0], Out: [0.33, 1, 0.68, 1], InOut: [0.65, 0, 0.35, 1] } },
  quart: { label: 'Quart', ...power(4), bezier: { In: [0.5, 0, 0.75, 0], Out: [0.25, 1, 0.5, 1], InOut: [0.76, 0, 0.24, 1] } },
  quint: { label: 'Quint', ...power(5), bezier: { In: [0.64, 0, 0.78, 0], Out: [0.22, 1, 0.36, 1], InOut: [0.83, 0, 0.17, 1] } },
  expo: {
    label: 'Expo',
    In: (t) => (t === 0 ? 0 : 2 ** (10 * t - 10)),
    Out: (t) => (t === 1 ? 1 : 1 - 2 ** (-10 * t)),
    InOut: (t) => (t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2),
    bezier: { In: [0.7, 0, 0.84, 0], Out: [0.16, 1, 0.3, 1], InOut: [0.87, 0, 0.13, 1] },
  },
  circ: {
    label: 'Circ',
    In: (t) => 1 - Math.sqrt(1 - t * t),
    Out: (t) => Math.sqrt(1 - (t - 1) ** 2),
    InOut: (t) => (t < 0.5 ? (1 - Math.sqrt(1 - (2 * t) ** 2)) / 2 : (Math.sqrt(1 - (-2 * t + 2) ** 2) + 1) / 2),
    bezier: { In: [0.55, 0, 1, 0.45], Out: [0, 0.55, 0.45, 1], InOut: [0.85, 0, 0.15, 1] },
  },
  back: {
    label: 'Back',
    In: (t) => (back + 1) * t ** 3 - back * t * t,
    Out: (t) => 1 + (back + 1) * (t - 1) ** 3 + back * (t - 1) ** 2,
    InOut: (t) => {
      const c = back * 1.525;
      return t < 0.5 ? ((2 * t) ** 2 * ((c + 1) * 2 * t - c)) / 2 : ((2 * t - 2) ** 2 * ((c + 1) * (t * 2 - 2) + c) + 2) / 2;
    },
    bezier: { In: [0.36, 0, 0.66, -0.56], Out: [0.34, 1.56, 0.64, 1], InOut: [0.68, -0.6, 0.32, 1.6] },
  },
  elastic: {
    label: 'Elastic',
    In: (t) => (t === 0 ? 0 : t === 1 ? 1 : -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * elastic)),
    Out: (t) => (t === 0 ? 0 : t === 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * elastic) + 1),
    InOut: (t) => (t === 0 ? 0 : t === 1 ? 1 : t < 0.5
      ? -(2 ** (20 * t - 10) * Math.sin((20 * t - 11.125) * elasticInOut)) / 2
      : (2 ** (-20 * t + 10) * Math.sin((20 * t - 11.125) * elasticInOut)) / 2 + 1),
  },
  bounce: {
    label: 'Bounce',
    In: (t) => 1 - bounceOut(1 - t),
    Out: bounceOut,
    InOut: (t) => (t < 0.5 ? (1 - bounceOut(1 - 2 * t)) / 2 : (1 + bounceOut(2 * t - 1)) / 2),
  },
};
export const EASE_DIRECTIONS = ['In', 'Out', 'InOut'];
const SMOOTHSTEP = (t) => t * t * (3 - 2 * t);
export const DEFAULT_BEZIER = [0.42, 0, 0.58, 1]; // a smoothstep, near enough, for its handles

// A preset's name as a family and a direction: 'backInOut' -> ['back', 'InOut'].
export function easeParts(name) {
  const match = /^([a-z]+)(InOut|In|Out)$/.exec(name ?? '');
  return match && EASE_FAMILIES[match[1]] ? [match[1], match[2]] : null;
}

// A cubic Bezier's y at a given x (the curve from (0,0) to (1,1)).
export function bezierAt([x1, y1, x2, y2], x) {
  const at = (a, b, s) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  const slope = (a, b, s) => 3 * a * (1 - s) ** 2 + 6 * (b - a) * s * (1 - s) + 3 * (1 - b) * s * s;
  let s = x;
  for (let i = 0; i < 8; i++) {
    const d = slope(x1, x2, s);
    if (Math.abs(d) < 1e-6) break;
    s -= (at(x1, x2, s) - x) / d;
  }
  if (!(s >= 0 && s <= 1) || Math.abs(at(x1, x2, s) - x) > 1e-5) {
    // Newton went astray: halving, which always gets there.
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      s = (lo + hi) / 2;
      if (at(x1, x2, s) < x) lo = s;
      else hi = s;
    }
  }
  return at(y1, y2, s);
}

// The easing a key's `ease` stands for: t (0..1) -> how far (0..1, or past).
export function easing(ease) {
  if (Array.isArray(ease)) return (t) => bezierAt(ease, t);
  const parts = easeParts(ease);
  return parts ? EASE_FAMILIES[parts[0]][parts[1]] : SMOOTHSTEP;
}

// The Bezier a key's ease is shown and dragged by.
export function bezierOf(ease) {
  if (Array.isArray(ease)) return [...ease];
  const parts = easeParts(ease);
  return parts && EASE_FAMILIES[parts[0]].bezier ? [...EASE_FAMILIES[parts[0]].bezier[parts[1]]] : [...DEFAULT_BEZIER];
}

export const soundEase = (ease) => ease === undefined || Boolean(easeParts(ease)) ||
  (Array.isArray(ease) && ease.length === 4 && ease.every(Number.isFinite) && ease[0] >= 0 && ease[0] <= 1 && ease[2] >= 0 && ease[2] <= 1);

// --- what a clip does at a frame ---------------------------------------------------

// The keys of a track are kept in the order of their frames, one a frame.
const sorted = (keys) => [...keys].sort((a, b) => a.frame - b.frame);
const lerp = (a, b, t) => a.map((value, i) => value + (b[i] - value) * t);

// A track's value at a frame (a fraction between frames too). Before its
// first key and after its last it holds them. Between two keys it goes as
// the first of them says: 'linear' straight on, 'step' holding until the
// next, 'smooth' easing as its `ease` says (see easing()) - a smoothstep
// without one. Angles go as numbers do - from 0 to 720 is two turns.
export function sampleTrack(track, frame) {
  const { keys } = track;
  if (frame <= keys[0].frame) return [...keys[0].value];
  const last = keys[keys.length - 1];
  if (frame >= last.frame) return [...last.value];
  let k = 0;
  while (keys[k + 1].frame <= frame) k++;
  const a = keys[k];
  const b = keys[k + 1];
  const t = (frame - a.frame) / (b.frame - a.frame);
  if (a.interpolation === 'step') return [...a.value];
  const eased = a.interpolation === 'smooth' ? easing(a.ease)(t) : t;
  // (A quaternion's turn goes along the sphere, the short way.)
  return a.value.length === 4 ? slerp(a.value, b.value, eased) : lerp(a.value, b.value, eased);
}

// The frames of a clip a sprite takes (see sprite-render.js), at `fps` of
// its own: as many as the clip's time makes at that rate, evenly over it -
// (fractional) frames of the clip, from 0. A looping clip leaves out its
// end, which is its start again; one that does not loop ends on it.
export function spriteFrames(clip, fps) {
  const count = Math.max(1, Math.round((clip.length / clip.fps) * fps));
  const frames = Array.from({ length: clip.loop ? count : count + 1 }, (_, i) => (i * clip.length) / count);
  return clip.length > 0 ? frames : [0];
}

// The pose a clip puts the entries in at a frame: Map id -> { position?,
// rotation?, scale? } (see pose.js); what it has no track of stays as it is.
export function poseAt(clip, frame) {
  const pose = new Map();
  for (const track of clip.tracks) {
    if (!track.keys.length) continue;
    if (!pose.has(track.object)) pose.set(track.object, {});
    pose.get(track.object)[track.property] = sampleTrack(track, frame);
  }
  return pose;
}

// The keys of a track that repeat the one before them: the very same value,
// so the way to them stands still. (Holding a pose so may be meant; more
// often a copied key's value was not changed.)
export const sameValue = (a, b) => a.every((value, k) => Math.abs(value - b[k]) < 1e-6);
export function stillKeys(track) {
  const still = new Set();
  track.keys.forEach((key, i) => {
    const before = track.keys[i - 1];
    if (before && sameValue(key.value, before.value)) still.add(key.frame);
  });
  return still;
}

// --- changing a clip (each gives a new clip; the old one is left as it was) ----------

// A key's identity in a clip: its entry, its property, its frame.
export const keyId = (object, property, frame) => `${object}:${property}:${frame}`;

// The clip with a key put on a track - made if there is none - at a frame;
// a key there is replaced, and keeps its interpolation (and ease) unless one is given.
export function setKey(clip, object, property, frame, value, interpolation = null, ease = undefined) {
  const tracks = [...clip.tracks];
  let at = tracks.findIndex((track) => track.object === object && track.property === property);
  if (at < 0) at = tracks.push({ object, property, keys: [] }) - 1;
  const old = tracks[at].keys.find((key) => key.frame === frame);
  const keys = tracks[at].keys.filter((key) => key.frame !== frame);
  // (its ease too, unless another is given)
  const keptEase = ease !== undefined ? ease : interpolation === null ? old?.ease : undefined;
  keys.push({ frame, value: [...value], interpolation: interpolation ?? old?.interpolation ?? 'linear', ...(keptEase ? { ease: structuredClone(keptEase) } : {}) });
  tracks[at] = { ...tracks[at], keys: sorted(keys) };
  return { ...clip, tracks };
}

// The clip with these keys (ids, see keyId) changed by `change(key)` - which
// gives the key anew, or null to take it away. Tracks left with no keys go.
function changeKeys(clip, ids, change) {
  const tracks = clip.tracks.map((track) => {
    const keys = track.keys.flatMap((key) => {
      if (!ids.has(keyId(track.object, track.property, key.frame))) return [key];
      const changed = change(key);
      return changed ? [changed] : [];
    });
    return { ...track, keys: sorted(keys) };
  });
  return { ...clip, tracks: tracks.filter((track) => track.keys.length) };
}

export const removeKeys = (clip, ids) => changeKeys(clip, ids, () => null);

export const setInterpolation = (clip, ids, interpolation) => changeKeys(clip, ids, (key) => ({ ...key, interpolation }));

// How these smooth keys ease (see easing()); null: the plain smoothstep.
export const setEase = (clip, ids, ease) => changeKeys(clip, ids, (key) => {
  const { ease: _, ...rest } = key;
  return ease === null ? rest : { ...rest, ease: Array.isArray(ease) ? [...ease] : ease };
});

// The clip with these keys moved by `by` frames (not before frame 0); what
// was on the frames they come to is replaced by them.
export function moveKeys(clip, ids, by) {
  const tracks = clip.tracks.map((track) => {
    const moving = track.keys.filter((key) => ids.has(keyId(track.object, track.property, key.frame)));
    if (!moving.length) return track;
    // (keys pushed together at frame 0: the later wins)
    const moved = new Map(moving.map((key) => [frameOf(key.frame + by), { ...key, frame: frameOf(key.frame + by) }]));
    const staying = track.keys.filter((key) => !moving.includes(key) && !moved.has(key.frame));
    return { ...track, keys: sorted([...staying, ...moved.values()]) };
  });
  return { ...clip, tracks };
}

// The keys (ids) as they are, to be put down again elsewhere (pasteKeys()):
// frames counted from the first of them.
export function copyKeys(clip, ids) {
  const out = [];
  for (const track of clip.tracks) {
    for (const key of track.keys) {
      if (ids.has(keyId(track.object, track.property, key.frame))) out.push({ object: track.object, property: track.property, ...structuredClone(key) });
    }
  }
  const first = Math.min(...out.map((key) => key.frame));
  return out.map((key) => ({ ...key, frame: key.frame - first }));
}

// The clip with copied keys put down from a frame on; and their ids there.
export function pasteKeys(clip, copied, frame) {
  let out = clip;
  const ids = new Set();
  for (const key of copied) {
    out = setKey(out, key.object, key.property, frame + key.frame, key.value, key.interpolation, key.ease ?? null);
    ids.add(keyId(key.object, key.property, frame + key.frame));
  }
  return { clip: out, ids };
}
