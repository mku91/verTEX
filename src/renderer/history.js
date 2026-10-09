const LIMIT = 200;

// Undo/redo stacks of document snapshots. A snapshot of the state *before*
// an edit is pushed once the edit is finished.
//
// `id` names the state the document is in: every edit gives it a new one, and
// undo and redo bring the old ones back - so the document is as it was saved
// exactly when `id` is what it was then.
export class History {
  constructor() {
    this.undoStack = [];
    this.redoStack = [];
    this.id = 0;
    this.lastId = 0;
    this.undoIds = []; // the ids of the states in undoStack
    this.redoIds = [];
  }

  push(before) {
    this.undoStack.push(before);
    this.undoIds.push(this.id);
    if (this.undoStack.length > LIMIT) {
      this.undoStack.shift();
      this.undoIds.shift();
    }
    this.redoStack.length = 0; // a new edit invalidates the redo branch
    this.redoIds.length = 0;
    this.id = ++this.lastId;
  }

  // Both take the current state and return the one to restore, or null.
  undo(current) {
    if (this.undoStack.length === 0) return null;
    this.redoStack.push(current);
    this.redoIds.push(this.id);
    this.id = this.undoIds.pop();
    return this.undoStack.pop();
  }

  redo(current) {
    if (this.redoStack.length === 0) return null;
    this.undoStack.push(current);
    this.undoIds.push(this.id);
    this.id = this.redoIds.pop();
    return this.redoStack.pop();
  }
}
