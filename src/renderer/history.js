const LIMIT = 200;

// Undo/redo stacks of document snapshots. A snapshot of the state *before*
// an edit is pushed once the edit is finished.
export class History {
  constructor() {
    this.undoStack = [];
    this.redoStack = [];
  }

  push(before) {
    this.undoStack.push(before);
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack.length = 0; // a new edit invalidates the redo branch
  }

  // Both take the current state and return the one to restore, or null.
  undo(current) {
    if (this.undoStack.length === 0) return null;
    this.redoStack.push(current);
    return this.undoStack.pop();
  }

  redo(current) {
    if (this.redoStack.length === 0) return null;
    this.undoStack.push(current);
    return this.redoStack.pop();
  }
}
