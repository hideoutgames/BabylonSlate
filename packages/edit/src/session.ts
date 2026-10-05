import type { EditCommand } from "./command";
import {
  DocumentEditStack,
  type ApplyResult,
  type DocumentEditStackOptions,
} from "./stack";

export const DEFAULT_EDIT_BYTE_BUDGET = 2_000_000;

/** One editor operation may contain several journalled deltas. */
export class CommandBatch<TDoc> implements EditCommand<TDoc> {
  readonly type = "edit.batch";
  readonly byteSize: number;
  readonly commands: readonly EditCommand<TDoc>[];

  constructor(commands: readonly EditCommand<TDoc>[]) {
    this.commands = [...commands];
    this.byteSize = commands.reduce(
      (sum, command) => sum + (command.byteSize ?? 0),
      0,
    );
  }

  apply(doc: TDoc): TDoc {
    return this.commands.reduce(
      (current, command) => command.apply(current),
      doc,
    );
  }

  invert(): EditCommand<TDoc> {
    return new CommandBatch(
      [...this.commands].reverse().map((command) => command.invert()),
    );
  }
}

/** History kept for a closed document, waiting for a reopen. */
interface ClosedHistory {
  /** Identity of the content the history was built on. */
  contentIdentity: string;
  /** Close order: eviction removes the lowest first. */
  closedAt: number;
}

/**
 * Owns per-document undo/redo stacks keyed by document id. Document payloads
 * live in the editor; this only tracks history.
 *
 * A closed document's history is kept for the session (`closeDocument`) and
 * returns only when the document reopens with the content it was built on
 * (`reopenDocument`): inverse commands carry no identity guard, so replaying
 * them on any other content could corrupt it. While closed history exists,
 * all history together stays within `maxBytes`; closed documents' history is
 * evicted first, oldest close first. Open documents keep their own budgets.
 */
export class EditSession {
  private readonly stacks = new Map<string, DocumentEditStack<unknown>>();
  private readonly closed = new Map<string, ClosedHistory>();
  private closeSequence = 0;
  private readonly defaults: DocumentEditStackOptions;

  constructor(options: Partial<DocumentEditStackOptions> = {}) {
    this.defaults = {
      maxEntries: options.maxEntries ?? 50,
      maxBytes: options.maxBytes ?? DEFAULT_EDIT_BYTE_BUDGET,
    };
  }

  configure(options: Partial<DocumentEditStackOptions>): void {
    if (options.maxEntries !== undefined) {
      this.defaults.maxEntries = Math.max(1, options.maxEntries);
    }
    if (options.maxBytes !== undefined) {
      this.defaults.maxBytes = Math.max(1, options.maxBytes);
      this.evictClosedOverBudget();
    }
  }

  getStack<TDoc>(documentId: string): DocumentEditStack<TDoc> {
    let stack = this.stacks.get(documentId);
    if (!stack) {
      stack = new DocumentEditStack<unknown>({ ...this.defaults });
      this.stacks.set(documentId, stack);
    }
    return stack as DocumentEditStack<TDoc>;
  }

  apply<TDoc>(
    documentId: string,
    doc: TDoc,
    command: EditCommand<TDoc>,
  ): ApplyResult<TDoc> {
    const result = this.getStack<TDoc>(documentId).apply(doc, command);
    this.evictClosedOverBudget();
    return result;
  }

  undo<TDoc>(documentId: string, doc: TDoc): ApplyResult<TDoc> | null {
    return this.getStack<TDoc>(documentId).undo(doc);
  }

  /** Keep a complete document change together; callers journal its raw deltas. */
  applyBatch<TDoc>(
    documentId: string,
    doc: TDoc,
    commands: readonly EditCommand<TDoc>[],
  ): ApplyResult<TDoc> | null {
    if (commands.length === 0) return null;
    return this.apply(
      documentId,
      doc,
      commands.length === 1 ? commands[0]! : new CommandBatch(commands),
    );
  }

  redo<TDoc>(documentId: string, doc: TDoc): ApplyResult<TDoc> | null {
    return this.getStack<TDoc>(documentId).redo(doc);
  }

  canUndo(documentId: string): boolean {
    return this.stacks.get(documentId)?.canUndo ?? false;
  }

  canRedo(documentId: string): boolean {
    return this.stacks.get(documentId)?.canRedo ?? false;
  }

  /**
   * Keep a closing document's history for a later reopen. `contentIdentity`
   * names the content the history was built on; it is read only when there
   * is history to keep. A document without history keeps nothing.
   */
  closeDocument(documentId: string, contentIdentity: () => string): void {
    const stack = this.stacks.get(documentId);
    this.closed.delete(documentId);
    if (!stack || (!stack.canUndo && !stack.canRedo)) {
      this.stacks.delete(documentId);
      return;
    }
    // A reopened document's next edit never merges into a pre-close gesture.
    stack.endGesture();
    this.closed.set(documentId, {
      contentIdentity: contentIdentity(),
      closedAt: ++this.closeSequence,
    });
    this.evictClosedOverBudget();
  }

  /**
   * Resume a reopened document's history when its content identity matches
   * the one recorded at close, and drop it otherwise. History that was not
   * kept by `closeDocument` is dropped too. Returns whether history resumed.
   */
  reopenDocument(documentId: string, contentIdentity: () => string): boolean {
    const closed = this.closed.get(documentId);
    this.closed.delete(documentId);
    if (
      closed &&
      this.stacks.has(documentId) &&
      closed.contentIdentity === contentIdentity()
    ) {
      return true;
    }
    this.stacks.delete(documentId);
    return false;
  }

  /** Forget a document's history, open or closed. */
  dropDocument(documentId: string): void {
    this.stacks.delete(documentId);
    this.closed.delete(documentId);
  }

  /**
   * Move a renamed or moved document's history, open or closed, to its new
   * id. Nothing stays under `oldId`, so a later document opened at the old
   * path starts empty. Any history already under `newId` is dropped rather
   * than kept: it recorded commands against another document's content, and
   * undoing them on the renamed document could corrupt it.
   */
  rekeyDocument(oldId: string, newId: string): void {
    if (oldId === newId) return;
    const stack = this.stacks.get(oldId);
    const closed = this.closed.get(oldId);
    this.dropDocument(oldId);
    this.dropDocument(newId);
    if (stack) this.stacks.set(newId, stack);
    if (stack && closed) this.closed.set(newId, closed);
  }

  /** Forget every document's history, open or closed. */
  clear(): void {
    this.stacks.clear();
    this.closed.clear();
  }

  private evictClosedOverBudget(): void {
    if (this.closed.size === 0) return;
    let total = 0;
    for (const stack of this.stacks.values()) total += stack.historyBytes;
    if (total <= this.defaults.maxBytes) return;
    const oldestFirst = [...this.closed].sort(
      ([, a], [, b]) => a.closedAt - b.closedAt,
    );
    for (const [documentId] of oldestFirst) {
      if (total <= this.defaults.maxBytes) return;
      total -= this.stacks.get(documentId)?.historyBytes ?? 0;
      this.dropDocument(documentId);
    }
  }
}
