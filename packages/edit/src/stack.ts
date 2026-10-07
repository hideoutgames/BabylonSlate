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
 * What a forward edit left in Undo history. The edit itself always applies.
 * - `recorded`: a new Undo step, or merged into the open gesture's step.
 * - `cleared`: the step alone exceeded the byte budget, so all Undo history
 *   (including this step) was cleared and the edit cannot be undone.
 * - `cleared-gesture`: continues a gesture already `cleared`; nothing more is
 *   recorded, so Undo never stops part-way through that gesture.
 */
export type HistoryOutcome = "recorded" | "cleared" | "cleared-gesture";

export interface EditApplyResult<TDoc> extends ApplyResult<TDoc> {
  history: HistoryOutcome;
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
 * Invert a command and cost the entry by its larger direction. The forward
 * size is measured first so an inverse holding the same snapshots can reuse it.
 */
function invertMeasured<TDoc>(
  command: EditCommand<TDoc>,
): { inverse: EditCommand<TDoc>; bytes: number } {
  const forwardBytes = command.byteSize ?? 0;
  const inverse = command.invert();
  return { inverse, bytes: Math.max(forwardBytes, inverse.byteSize ?? 0) };
}

/**
 * Per-document undo/redo stack with entry + byte budgets and merge-key
 * coalescing. EditSession owns its lifetime, including retention after the
 * document closes.
 */
export class DocumentEditStack<TDoc> {
  private maxEntries: number;
  private maxBytes: number;
  private undoStack: BudgetedEntry<TDoc>[] = [];
  private redoStack: BudgetedEntry<TDoc>[] = [];
  private mergeOpen = false;
  /** Merge key of the open gesture whose history was cleared for size. */
  private clearedMergeKey: string | undefined;

  constructor(options: DocumentEditStackOptions) {
    this.maxEntries = Math.max(1, options.maxEntries);
    this.maxBytes = Math.max(1, options.maxBytes);
  }

  get byteBudget(): number { return this.maxBytes; }

  /** Change the limits; history over the new limits is evicted oldest first. */
  configure(options: Partial<DocumentEditStackOptions>): void {
    if (options.maxEntries !== undefined) this.maxEntries = Math.max(1, options.maxEntries);
    if (options.maxBytes !== undefined) this.maxBytes = Math.max(1, options.maxBytes);
    this.trim();
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

  apply(doc: TDoc, command: EditCommand<TDoc>): EditApplyResult<TDoc> {
    const next = command.apply(doc);
    this.redoStack = [];
    const continuesGesture = this.mergeOpen && command.mergeKey !== undefined;
    if (continuesGesture && command.mergeKey === this.clearedMergeKey) {
      return { doc: next, command, history: "cleared-gesture" };
    }
    this.clearedMergeKey = undefined;
    const top = this.undoStack[this.undoStack.length - 1];
    let entry: BudgetedEntry<TDoc>;
    if (continuesGesture && top && top.command.mergeKey === command.mergeKey) {
      entry = top;
      const coalesced = top.command.coalesce?.(command);
      if (coalesced) {
        // One command from the gesture's start to its latest state.
        top.command = coalesced;
        ({ inverse: top.inverse, bytes: top.bytes } = invertMeasured(coalesced));
      } else {
        // Keep the inverse from the first gesture event; update the forward
        // cmd. The group retains the first inverse as well as the last forward
        // snapshots. A small final value must not hide a large original payload.
        top.command = command;
        top.bytes = (top.inverse.byteSize ?? 0) + (command.byteSize ?? 0);
      }
    } else {
      // Inverting only here: a merged step never needs its own inverse.
      entry = { command, ...invertMeasured(command) };
      this.undoStack.push(entry);
    }
    this.mergeOpen = true;
    this.trim();
    if (this.undoStack[this.undoStack.length - 1] === entry) {
      return { doc: next, command, history: "recorded" };
    }
    this.clearedMergeKey = command.mergeKey;
    return { doc: next, command, history: "cleared" };
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
    this.clearedMergeKey = undefined;
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
