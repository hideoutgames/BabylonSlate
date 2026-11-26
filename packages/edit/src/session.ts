import type { EditCommand } from "./command";
import {
  DocumentEditStack,
  type ApplyResult,
  type DocumentEditStackOptions,
  type EditApplyResult,
  type HistoryAdmissionResult,
} from "./stack";

/** Default per-document Undo memory limit (16 MB). */
export const DEFAULT_EDIT_BYTE_BUDGET = 16 * 1024 * 1024;

/**
 * Append-only part storage that the batches of one gesture share.
 * `inverses[i]` is `items[i].invert()`, filled as batches are inverted.
 * `exposed` is set once a caller holds `items` itself
 * (`CommandBatch.commands`); later appends then copy, so an array handed
 * out never changes.
 */
interface BatchParts<TDoc> {
  items: EditCommand<TDoc>[];
  inverses: EditCommand<TDoc>[];
  exposed: boolean;
}

/** One editor operation may contain several journalled deltas. */
export class CommandBatch<TDoc> implements EditCommand<TDoc> {
  readonly type = "edit.batch";
  /** A keyed batch folds the next batch of its gesture into one Undo step. */
  readonly mergeKey?: string;
  /** This batch runs the first `#length` parts; a coalesced batch extends the same storage. */
  #parts: BatchParts<TDoc>;
  #length: number;
  /** Set on an inverse: it runs `#parts.inverses` last to first, and costs what `#forward` costs. */
  #forward?: CommandBatch<TDoc>;
  #sliced?: readonly EditCommand<TDoc>[];
  /** Measured size of the first `#measuredLength` parts. */
  #measuredBytes = 0;
  #measuredLength = 0;

  constructor(commands: readonly EditCommand<TDoc>[], mergeKey?: string) {
    this.#parts = { items: [...commands], inverses: [], exposed: false };
    this.#length = commands.length;
    this.mergeKey = mergeKey;
  }

  get commands(): readonly EditCommand<TDoc>[] {
    if (this.#forward) {
      return (this.#sliced ??= this.#parts.inverses.slice(0, this.#length).reverse());
    }
    if (this.#length === this.#parts.items.length) {
      this.#parts.exposed = true;
      return this.#parts.items;
    }
    return (this.#sliced ??= this.#parts.items.slice(0, this.#length));
  }

  /**
   * Sum of the parts' sizes. Parts are measured once: a coalesced batch
   * starts from its predecessor's measured total and adds only the new parts.
   * An inverse retains the same snapshots as its forward batch, so it costs
   * the same.
   */
  get byteSize(): number {
    if (this.#forward) return this.#forward.byteSize;
    const items = this.#parts.items;
    for (; this.#measuredLength < this.#length; this.#measuredLength++) {
      this.#measuredBytes += items[this.#measuredLength]!.byteSize;
    }
    return this.#measuredBytes;
  }

  apply(doc: TDoc): TDoc {
    let current = doc;
    if (this.#forward) {
      const inverses = this.#parts.inverses;
      for (let index = this.#length - 1; index >= 0; index--) current = inverses[index]!.apply(current);
      return current;
    }
    const items = this.#parts.items;
    for (let index = 0; index < this.#length; index++) current = items[index]!.apply(current);
    return current;
  }

  /**
   * The parts' inverses, last part first. Each part is inverted once for the
   * shared storage, so inverting a coalesced batch inverts only its new parts.
   */
  invert(): EditCommand<TDoc> {
    if (this.#forward) return this.#forward;
    const { items, inverses } = this.#parts;
    while (inverses.length < this.#length) inverses.push(items[inverses.length]!.invert());
    const inverse = new CommandBatch<TDoc>([]);
    inverse.#parts = this.#parts;
    inverse.#length = this.#length;
    inverse.#forward = this;
    return inverse;
  }

  /** One batch running both, so Undo reverts and Redo replays the whole gesture. */
  coalesce(next: EditCommand<TDoc>): EditCommand<TDoc> | undefined {
    if (
      this.#forward || this.mergeKey === undefined ||
      !(next instanceof CommandBatch) || next.mergeKey !== this.mergeKey
    ) {
      return undefined;
    }
    const added = next.commands;
    // When both batches target the same sequence of mergeable commands (e.g. a
    // multi-selection scrub), fold pairwise so the batch stays O(targets) instead
    // of growing O(frames * targets).
    if (this.#length === added.length && this.#length > 0) {
      const folded: EditCommand<TDoc>[] = [];
      let allFolded = true;
      for (let index = 0; index < this.#length; index++) {
        const earlier = this.#parts.items[index]!;
        const later = added[index]!;
        const combined =
          earlier.mergeKey !== undefined && earlier.mergeKey === later.mergeKey
            ? earlier.coalesce?.(later)
            : undefined;
        if (!combined) {
          allFolded = false;
          break;
        }
        folded.push(combined);
      }
      if (allFolded) {
        return new CommandBatch<TDoc>(folded, this.mergeKey);
      }
    }
    // Extend the shared storage in place unless another batch already
    // extended it past this one or a caller holds the array.
    const parts = this.#length === this.#parts.items.length && !this.#parts.exposed
      ? this.#parts
      : {
          items: this.#parts.items.slice(0, this.#length),
          inverses: this.#parts.inverses.slice(0, this.#length),
          exposed: false,
        };
    for (const command of added) parts.items.push(command);
    const merged = new CommandBatch<TDoc>([], this.mergeKey);
    merged.#parts = parts;
    merged.#length = this.#length + added.length;
    merged.#measuredBytes = this.#measuredBytes;
    merged.#measuredLength = this.#measuredLength;
    return merged;
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

  /**
   * Change the limits for every document, open or closed, and for documents
   * opened later. History over a lowered limit is evicted oldest first.
   */
  configure(options: Partial<DocumentEditStackOptions>): void {
    if (options.maxEntries !== undefined) {
      this.defaults.maxEntries = Math.max(1, options.maxEntries);
    }
    if (options.maxBytes !== undefined) {
      this.defaults.maxBytes = Math.max(1, options.maxBytes);
    }
    for (const stack of this.stacks.values()) stack.configure(this.defaults);
    this.evictClosedOverBudget();
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
    options?: { amend?: boolean },
  ): EditApplyResult<TDoc> {
    const result = this.getStack<TDoc>(documentId).apply(doc, command, options);
    this.evictClosedOverBudget();
    return result;
  }

  applyWithHistoryAdmission<TDoc>(
    documentId: string,
    doc: TDoc,
    command: EditCommand<TDoc>,
  ): HistoryAdmissionResult<TDoc> {
    const result = this.getStack<TDoc>(documentId).applyWithHistoryAdmission(doc, command);
    if (result.ok && result.status === "applied") this.evictClosedOverBudget();
    return result;
  }

  undo<TDoc>(documentId: string, doc: TDoc): ApplyResult<TDoc> | null {
    return this.getStack<TDoc>(documentId).undo(doc);
  }

  /**
   * Keep a complete document change together; callers journal its raw deltas.
   * Changes sharing a `mergeKey` while their gesture is open form one Undo
   * step; with `amend` a keyed change also joins the latest step of its key
   * after that gesture ended.
   */
  applyBatch<TDoc>(
    documentId: string,
    doc: TDoc,
    commands: readonly EditCommand<TDoc>[],
    options?: { mergeKey?: string; amend?: boolean },
  ): EditApplyResult<TDoc> | null {
    if (commands.length === 0) return null;
    const mergeKey = options?.mergeKey;
    return this.apply(
      documentId,
      doc,
      mergeKey !== undefined
        ? new CommandBatch(commands, mergeKey)
        : commands.length === 1 ? commands[0]! : new CommandBatch(commands),
      { amend: options?.amend },
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
