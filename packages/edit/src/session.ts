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

/**
 * Owns per-document stacks. Document payloads live in the editor; this only
 * tracks undo/redo history keyed by open document id.
 */
export class EditSession {
  private readonly stacks = new Map<string, DocumentEditStack<unknown>>();
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
    return this.getStack<TDoc>(documentId).apply(doc, command);
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

  dropDocument(documentId: string): void {
    this.stacks.delete(documentId);
  }

  clear(): void {
    this.stacks.clear();
  }
}
