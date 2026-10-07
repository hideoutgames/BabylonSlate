import type { EditCommand, StackEntry } from "./command";

export interface DocumentEditStackOptions {
  maxEntries: number;
  maxBytes: number;
}

export interface ApplyResult<TDoc> {
  doc: TDoc;
  command: EditCommand<TDoc>;
}

export type HistoryAdmissionResult<TDoc> =
  | (ApplyResult<TDoc> & { ok: true; status: "applied" | "unchanged" })
  | {
      ok: false;
      reason: "history-budget" | "invalid-byte-size";
      requiredBytes: number | null;
      maxBytes: number;
    };

interface BudgetedEntry<TDoc> extends StackEntry<TDoc> {
  bytes: number;
}

/**
 * Per-document undo/redo stack with entry + byte budgets and merge-key
 * coalescing. EditSession owns its lifetime, including retention after the
 * document closes.
 */
export class DocumentEditStack<TDoc> {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private undoStack: BudgetedEntry<TDoc>[] = [];
  private redoStack: BudgetedEntry<TDoc>[] = [];
  private mergeOpen = false;

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
      (sum, entry) => sum + entry.bytes,
      0,
    );
  }

  /** Recorded bytes held by both the Undo and the Redo entries. */
  get historyBytes(): number {
    return this.redoStack.reduce(
      (sum, entry) => sum + entry.bytes,
      this.undoBytes,
    );
  }

  apply(doc: TDoc, command: EditCommand<TDoc>): ApplyResult<TDoc> {
    const next = command.apply(doc);
    const inverse = command.invert();
    const top = this.undoStack[this.undoStack.length - 1];
    if (
      this.mergeOpen && command.mergeKey !== undefined &&
      top &&
      top.command.mergeKey === command.mergeKey
    ) {
      // Keep the inverse from the first gesture event; update the forward cmd.
      top.command = command;
      // A merged group retains the first inverse as well as the last forward
      // snapshots. A small final value must not hide a large original payload.
      top.bytes = (top.inverse.byteSize ?? 0) + (command.byteSize ?? 0);
    } else {
      this.undoStack.push({ command, inverse, bytes: Math.max(command.byteSize ?? 0, inverse.byteSize ?? 0) });
    }
    this.redoStack = [];
    this.mergeOpen = true;
    this.trim();
    return { doc: next, command };
  }

  /**
   * Apply one separate undo step only when its complete forward and inverse
   * costs fit. Rejection (or a throwing pure command) changes neither stack.
   * Unlike ordinary edits, both commands must explicitly account for bytes.
   */
  applyWithHistoryAdmission(
    doc: TDoc,
    command: EditCommand<TDoc>,
  ): HistoryAdmissionResult<TDoc> {
    const inverse = command.invert();
    const forwardBytes = command.byteSize;
    const inverseBytes = inverse.byteSize;
    if (
      forwardBytes === undefined || inverseBytes === undefined ||
      !Number.isSafeInteger(forwardBytes) || forwardBytes < 0 ||
      !Number.isSafeInteger(inverseBytes) || inverseBytes < 0 ||
      !Number.isSafeInteger(forwardBytes + inverseBytes)
    ) {
      return { ok: false, reason: "invalid-byte-size", requiredBytes: null, maxBytes: this.maxBytes };
    }
    const bytes = forwardBytes + inverseBytes;
    if (bytes > this.maxBytes) {
      return { ok: false, reason: "history-budget", requiredBytes: bytes, maxBytes: this.maxBytes };
    }
    const next = command.apply(doc);
    if (next === doc) return { ok: true, status: "unchanged", doc, command };
    this.undoStack.push({ command, inverse, bytes });
    this.redoStack = [];
    // A later ordinary gesture must not merge into this discrete transaction.
    this.endGesture();
    this.trim();
    return { ok: true, status: "applied", doc: next, command };
  }

  undo(doc: TDoc): ApplyResult<TDoc> | null {
    this.endGesture();
    const entry = this.undoStack.pop();
    if (!entry) return null;
    const next = entry.inverse.apply(doc);
    this.redoStack.push(entry);
    return { doc: next, command: entry.inverse };
  }

  redo(doc: TDoc): ApplyResult<TDoc> | null {
    this.endGesture();
    const entry = this.redoStack.pop();
    if (!entry) return null;
    const next = entry.command.apply(doc);
    this.undoStack.push(entry);
    this.trim();
    return { doc: next, command: entry.command };
  }

  clear(): void {
    this.endGesture();
    this.undoStack = [];
    this.redoStack = [];
  }

  /** Prevent the next edit from coalescing with a completed gesture. */
  endGesture(): void {
    this.mergeOpen = false;
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
