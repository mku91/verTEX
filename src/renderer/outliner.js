const OBJECT_ICON =
  '<svg viewBox="0 0 24 24"><path d="M12 2l9 5v10l-9 5-9-5V7zm0 2.3L5.8 7.7 12 11.2l6.2-3.5zM5 9.4v6.4l6 3.4v-6.4zm14 0l-6 3.4v6.4l6-3.4z"/></svg>';

// The list of the scene's objects, by name. A click selects an object
// (Shift+click adds it to the selection or takes it out), a double click
// renames it. Rows of objects that hold a selection are highlighted.
export class Outliner {
  constructor(element, editor) {
    this.list = element;
    this.editor = editor;
    this.shown = ''; // what the list was last built from
    this.renaming = false;

    this.list.addEventListener('click', (event) => {
      const row = event.target.closest('[data-object]');
      if (row && !this.renaming) editor.selectObject(Number(row.dataset.object), event.shiftKey);
    });
    this.list.addEventListener('dblclick', (event) => {
      const row = event.target.closest('[data-object]');
      if (row) this.rename(row);
    });
    // Rows must not take the keyboard focus away from the editor.
    this.list.addEventListener('mousedown', (event) => {
      if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
    });
    editor.addEventListener('change', () => this.update());
    this.update();
  }

  update() {
    if (this.renaming) return; // don't pull the text field from under the user
    const { islands, islandOfVertex } = this.editor.topology;
    const selected = new Set([...this.editor.selection].map((vertex) => islandOfVertex[vertex]));
    // Whole objects are selected only in object mode; elsewhere the object is just being worked on.
    const whole = this.editor.mode === 'object';
    const signature = JSON.stringify([islands.map((island) => island.name), [...selected], whole]);
    if (signature === this.shown) return;
    this.shown = signature;

    this.list.replaceChildren(
      ...islands.map((island, index) => {
        const row = document.createElement('div');
        row.className = 'outliner-row';
        row.dataset.object = index;
        if (selected.has(index)) row.classList.add(whole ? 'selected' : 'active');
        row.innerHTML = OBJECT_ICON;
        const name = document.createElement('span');
        name.textContent = island.name;
        row.append(name);
        row.title = `${island.vertices.length} вершин, ${island.faces.length} граней`;
        return row;
      }),
    );
  }

  // Replaces a row's name with a text field; Enter or a click away keeps the
  // new name, Esc drops it.
  rename(row) {
    const index = Number(row.dataset.object);
    const label = row.querySelector('span');
    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.value = label.textContent;
    label.replaceWith(input);
    this.renaming = true;
    input.focus();
    input.select();

    // Ends the renaming once, whichever way it is left.
    const finish = (keep) => {
      if (!this.renaming) return;
      this.renaming = false;
      this.shown = ''; // force a rebuild
      if (keep) this.editor.renameObject(index, input.value);
      this.update();
    };
    input.addEventListener('keydown', (event) => {
      if (event.code === 'Enter' || event.code === 'NumpadEnter') finish(true);
      if (event.code === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }
}
