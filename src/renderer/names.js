// Names - of objects, nodes, collision shapes, atlases, animations - are in
// Latin letters only, with no spaces: they go into game engines as nodes'
// and animations' names and into code that looks them up (Godot's
// get_node("Door/Box")), where anything else is trouble. Digits and _ . -
// are let through. (Names given before spaces were barred keep theirs.)
const NOT_ALLOWED = /[^A-Za-z0-9_.\-]/g;

export function latinName(text) {
  return text.replace(NOT_ALLOWED, '');
}

// A name field that takes Latin letters only: whatever else is typed or
// pasted is dropped as it comes, and the field shakes to say so.
export function latinOnly(input) {
  input.title = 'Только латиница, цифры и _ . - (без пробелов)';
  input.addEventListener('input', () => {
    const clean = latinName(input.value);
    if (clean === input.value) return;
    const caret = input.selectionStart - (input.value.length - clean.length);
    input.value = clean;
    input.setSelectionRange(Math.max(0, caret), Math.max(0, caret));
    input.classList.remove('refused');
    void input.offsetWidth; // the shake again, if it is already shaking
    input.classList.add('refused');
  });
  input.addEventListener('animationend', () => input.classList.remove('refused'));
}

// `name`, or - when it is taken - its first free copy's name: "Cube" is
// followed by "Cube_0", "Cube_1", ... A copy of a copy is numbered with the
// rest ("Cube_0" gives "Cube_2"), as long as the name it was made from is
// there; a name of its own that ends in a number ("Level_2") keeps it whole.
export function freeName(name, taken) {
  if (!taken.has(name)) return name;
  const numbered = name.match(/^(.*)_\d+$/);
  const base = numbered && taken.has(numbered[1]) ? numbered[1] : name;
  for (let n = 0; ; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
