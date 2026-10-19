import * as THREE from 'three';

// The skin: vertices that bend with nodes (the nodes being the bones, their
// pivot points the joints) - linear blend skinning, as glTF and Godot have
// it. Each vertex in it is weighted to up to four nodes, the weights adding
// up to 1 (mesh.weights); where it is posed is worked out in ModelPose (see
// pose.js). A vertex not in it goes with its own object, as a whole - which,
// for an object in a node, is as if it were weighted to that node alone.
//
// Here, what is done to the weights of the vertices selected (in the model
// workspace), each one undo step:
//   bind    - to one node, whole (weight 1);
//   unbind  - out of the skin;
//   smooth  - each vertex's weights made more like its neighbours' (along
//             the edges), so that a joint bends smoothly, not at one edge.
// The nodes weighted to have their pivot points fixed (see Editor.pinPivots()):
// what a vertex bends about must not wander as the model is edited.

const SMOOTH_PASSES = 2; // a press of "Сгладить"
const SMOOTH_SHARE = 0.5; // how much of a vertex's weights its neighbours' take, a pass

// The vertices the skin tools work on: those selected.
export function skinVertices(editor) {
  return [...editor.selection];
}

// A vertex's weights as it bends now: its own in the skin, or else - going
// with its object - its object's node's, whole; none for an object in no node.
export function weightsOf(mesh, vertex) {
  const own = mesh.weights.get(vertex);
  if (own) return own;
  const object = mesh.objects.find((entry) => entry.id === mesh.vertexObject[vertex]);
  return object?.parent !== null && object?.parent !== undefined ? [[object.parent, 1]] : [];
}

function change(editor, work) {
  const vertices = skinVertices(editor);
  if (vertices.length === 0 || editor.busy()) return false;
  const before = editor.snapshot();
  work(vertices);
  // (the nodes bent with: their pivot points fixed)
  const nodes = new Set([...editor.mesh.weights.values()].flatMap((weights) => weights.map(([node]) => node)));
  editor.pinPivots(editor.mesh.objects.flatMap((object, index) => (nodes.has(object.id) ? [index] : [])));
  editor.history.push(before);
  editor.emitChange();
  return true;
}

// The selected vertices bend with the node `id` alone.
export function bindToNode(editor, id) {
  return change(editor, (vertices) => {
    for (const vertex of vertices) editor.mesh.setWeights(vertex, [[id, 1]]);
  });
}

// The selected vertices out of the skin: they go with their object again.
export function unbind(editor) {
  return change(editor, (vertices) => {
    for (const vertex of vertices) editor.mesh.weights.delete(vertex);
  });
}

// The selected vertices' weights, a few times over, half their own and half
// the mean of their neighbours' (along the edges and wires) - as they bend
// now, those not in the skin with their object's node (see weightsOf()).
// Every pass works from the weights as the pass before left them.
export function smoothWeights(editor, passes = SMOOTH_PASSES) {
  return change(editor, (vertices) => smooth(editor.mesh, vertices, passes));
}

// smoothWeights()'s work, on its own (no undo step of its own).
function smooth(mesh, vertices, passes) {
  {
    const neighbours = new Map();
    for (const [a, b] of mesh.edges()) {
      if (!neighbours.has(a)) neighbours.set(a, []);
      if (!neighbours.has(b)) neighbours.set(b, []);
      neighbours.get(a).push(b);
      neighbours.get(b).push(a);
    }
    for (let pass = 0; pass < passes; pass++) {
      const next = new Map();
      for (const vertex of vertices) {
        const around = neighbours.get(vertex) ?? [];
        if (around.length === 0) continue;
        const sum = new Map();
        const add = (weights, share) => {
          for (const [node, weight] of weights) sum.set(node, (sum.get(node) ?? 0) + weight * share);
        };
        add(weightsOf(mesh, vertex), 1 - SMOOTH_SHARE);
        for (const other of around) add(weightsOf(mesh, other), SMOOTH_SHARE / around.length);
        if (sum.size) next.set(vertex, [...sum]);
      }
      for (const [vertex, weights] of next) mesh.setWeights(vertex, weights);
    }
  }
}

// Weights by the bones (Blender's "with envelope weights", near enough):
// a bone runs from every node's pivot point to each node's inside it; a
// node with none inside, as far on again as the bone that comes to it (a
// node has no length of its own: its tail is guessed so), or else it is a
// point; each selected vertex is weighted to the
// nodes whose bones are nearest it - by 1/d^4, the four nearest, adding up
// to 1 - and the weights are then smoothed. As the crow flies: a vertex
// near another part's bone (one leg by the other) may take its weight, to
// be bound by hand after. Every node of the scene is a bone; none, nothing.
// Returns how many vertices got weights, or null.
const AUTO_POWER = 4;
export function autoWeights(editor) {
  const { mesh } = editor;
  const { islands } = editor.topology;
  const bones = []; // [{ id, from, to }]
  mesh.objects.forEach((object, index) => {
    if (object.kind !== 'node') return;
    const from = editor.pivotPoint(index);
    const inner = islands[index]?.children.filter((child) => mesh.objects[child]?.kind === 'node') ?? [];
    if (inner.length === 0) {
      const outer = islands[index]?.parentIndex;
      const head = outer !== null && outer !== undefined && mesh.objects[outer]?.kind === 'node' ? editor.pivotPoint(outer) : null;
      bones.push({ id: object.id, from, to: head ? from.clone().multiplyScalar(2).sub(head) : from });
    }
    for (const child of inner) bones.push({ id: object.id, from, to: editor.pivotPoint(child) });
  });
  if (bones.length === 0) return null;
  let count = 0;
  const done = change(editor, (vertices) => {
    const along = new THREE.Vector3();
    const near = new THREE.Vector3();
    for (const vertex of vertices) {
      const point = mesh.vertices[vertex];
      const nearest = new Map(); // node id -> the nearest of its bones, how far
      for (const { id, from, to } of bones) {
        along.subVectors(to, from);
        const length = along.lengthSq();
        const t = length > 1e-12 ? Math.min(1, Math.max(0, near.subVectors(point, from).dot(along) / length)) : 0;
        const distance = point.distanceTo(near.copy(from).addScaledVector(along, t));
        if (!nearest.has(id) || distance < nearest.get(id)) nearest.set(id, distance);
      }
      mesh.setWeights(vertex, [...nearest].map(([id, distance]) => [id, 1 / Math.max(distance, 1e-4) ** AUTO_POWER]));
      count++;
    }
    smooth(mesh, vertices, 1);
  });
  return done ? count : null;
}

// What the selected vertices bend with: [{ id, name, share }] - each node's
// mean weight over them (as they bend now, see weightsOf()), the largest
// first - and how many go with no node at all.
export function skinSummary(editor) {
  const { mesh } = editor;
  const vertices = skinVertices(editor);
  const sum = new Map();
  let free = 0;
  for (const vertex of vertices) {
    const weights = weightsOf(mesh, vertex);
    if (weights.length === 0) free++;
    for (const [node, weight] of weights) sum.set(node, (sum.get(node) ?? 0) + weight);
  }
  const names = new Map(mesh.objects.map((object) => [object.id, object.name]));
  const nodes = [...sum].map(([id, total]) => ({ id, name: names.get(id) ?? '?', share: total / vertices.length })).sort((a, b) => b.share - a.share);
  return { count: vertices.length, nodes, free, bound: vertices.filter((vertex) => mesh.weights.has(vertex)).length };
}

// What each node binds, object by object (the rows under a node in the
// scene tree, see outliner.js): Map node id -> [{ object (id), vertices }],
// the vertices weighted to it at all.
export function boundByNode(mesh) {
  const out = new Map();
  for (const [vertex, weights] of mesh.weights) {
    for (const [node, weight] of weights) {
      if (weight <= 0) continue;
      if (!out.has(node)) out.set(node, new Map());
      const objects = out.get(node);
      const object = mesh.vertexObject[vertex];
      if (!objects.has(object)) objects.set(object, []);
      objects.get(object).push(vertex);
    }
  }
  return new Map([...out].map(([node, objects]) => [node, [...objects].map(([object, vertices]) => ({ object, vertices }))]));
}

// The vertices of object `object` bound to node `node`, selected - in
// vertex mode, the node the one the skin panel works with (`skinFocus`)
// and its vertices marked (see skin-marks.js).
export function selectBound(editor, node, object) {
  const vertices = boundByNode(editor.mesh).get(node)?.find((entry) => entry.object === object)?.vertices ?? [];
  if (vertices.length === 0 || editor.busy()) return;
  if (editor.mode !== 'vertex') editor.setMode('vertex');
  editor.skinFocus = { node, object };
  editor.selectVertices(vertices);
}

// The selected vertices weighted `weight` (0 to 1) to the node `id`; the
// rest of each one's weight shared by what else it bends with, as it did -
// or, for a vertex that bent with this node alone, given back to its
// object's node (as if it went with its object, see weightsOf()). A vertex
// whose object is in no node, or in this one, has nowhere for the rest to
// go: it stays wholly with the node. Returns how many so stayed.
export function setWeight(editor, id, weight) {
  const { mesh } = editor;
  let stuck = 0;
  const done = change(editor, (vertices) => {
    for (const vertex of vertices) {
      let others = weightsOf(mesh, vertex).filter(([node]) => node !== id);
      if (others.length === 0) {
        // (bent with this node alone: the rest to its object's node, if that is another)
        const object = mesh.objects.find((entry) => entry.id === mesh.vertexObject[vertex]);
        if (object?.parent !== null && object?.parent !== undefined && object.parent !== id) others = [[object.parent, 1]];
      }
      const rest = others.reduce((sum, [, w]) => sum + w, 0);
      if (weight >= 1 || rest <= 0) {
        if (weight < 1) stuck++;
        mesh.setWeights(vertex, [[id, 1]]);
        continue;
      }
      mesh.setWeights(vertex, [[id, weight], ...others.map(([node, w]) => [node, (w / rest) * (1 - weight)])]);
    }
  });
  return done ? { stuck } : null;
}

// The nodes whose part of the skin is shown now (the green dots, see
// skin-marks.js, and the heat, skin-heat.js), by id: in object mode, those
// picked whole; in vertex mode, the one the skin panel works with, picked by
// its row (see selectBound()).
export function shownSkinNodes(editor) {
  if (editor.preview || editor.painting || editor.simulating) return new Set();
  if (editor.mode === 'vertex') return new Set(editor.skinFocus ? [editor.skinFocus.node] : []);
  if (editor.mode !== 'object') return new Set();
  const { objects } = editor.mesh;
  return new Set([...editor.picked].filter((index) => objects[index]?.kind === 'node').map((index) => objects[index].id));
}
