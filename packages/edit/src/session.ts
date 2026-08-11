import type { EditCommand } from "./command";
import {
  DocumentEditStack,
  type ApplyResult,
  type DocumentEditStackOptions,
} from "./stack";

export const DEFAULT_EDIT_BYTE_BUDGET = 2_000_000;

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
