import type { EditCommand, StackEntry } from "./command";

export interface DocumentEditStackOptions {
  maxEntries: number;
  maxBytes: number;
}

export interface ApplyResult<TDoc> {
  doc: TDoc;
  command: EditCommand<TDoc>;
}

/**
 * Per-document undo/redo stack with entry + byte budgets and merge-key
 * coalescing. Closing a document drops the stack (owned by EditSession).
 */
export class DocumentEditStack<TDoc> {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private undoStack: StackEntry<TDoc>[] = [];
  private redoStack: StackEntry<TDoc>[] = [];

  constructor(options: DocumentEditStackOptions) {
    this.maxEntries = Math.max(1, options.maxEntries);
    this.maxBytes = Math.max(1, options.maxBytes);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  get undoBytes(): number {
    return this.undoStack.reduce(
      (sum, entry) => sum + (entry.command.byteSize ?? 0),
      0,
    );
  }

  apply(doc: TDoc, command: EditCommand<TDoc>): ApplyResult<TDoc> {
    const next = command.apply(doc);
    const inverse = command.invert();
    const top = this.undoStack[this.undoStack.length - 1];
    if (
      command.mergeKey !== undefined &&
      top &&
      top.command.mergeKey === command.mergeKey
    ) {
      // Keep the inverse from the first gesture event; update the forward cmd.
      top.command = command;
    } else {
      this.undoStack.push({ command, inverse });
    }
    this.redoStack = [];
    this.trim();
    return { doc: next, command };
  }

  undo(doc: TDoc): ApplyResult<TDoc> | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    const next = entry.inverse.apply(doc);
    // Redo should re-apply the forward command; its invert restores again.
    this.redoStack.push({
      command: entry.command,
      inverse: entry.command.invert(),
    });
    return { doc: next, command: entry.inverse };
  }

  redo(doc: TDoc): ApplyResult<TDoc> | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    const next = entry.command.apply(doc);
    this.undoStack.push({
      command: entry.command,
      inverse: entry.command.invert(),
    });
    this.trim();
    return { doc: next, command: entry.command };
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  private trim(): void {
    while (
      this.undoStack.length > this.maxEntries ||
      (this.undoBytes > this.maxBytes && this.undoStack.length > 0)
    ) {
      this.undoStack.shift();
    }
  }
}
