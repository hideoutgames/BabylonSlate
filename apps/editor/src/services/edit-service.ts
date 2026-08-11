import type { SerializedGraph, SerializedScene } from "@babylonslate/core";
import {
  EditSession,
  type EditCommand,
  type DocumentEditStackOptions,
} from "@babylonslate/edit";

export const DEFAULT_EDIT_BYTE_BUDGET = 2_000_000;

export class EditService {
  private readonly session = new EditSession();

  dropDocument(docId: string): void {
    this.session.dropDocument(docId);
  }

  clear(): void {
    this.session.clear();
  }

  applyCommand<TDoc>(
    docId: string,
    doc: TDoc,
    command: EditCommand<TDoc>,
    options?: Partial<DocumentEditStackOptions>,
  ): { doc: TDoc } {
    const result = this.session.apply(docId, doc, command, options);
    return { doc: result.doc };
  }

  undo<TDoc>(docId: string, doc: TDoc): { doc: TDoc } | null {
    const result = this.session.undo(docId, doc);
    return result ? { doc: result.doc } : null;
  }

  redo<TDoc>(docId: string, doc: TDoc): { doc: TDoc } | null {
    const result = this.session.redo(docId, doc);
    return result ? { doc: result.doc } : null;
  }

  canUndo(docId: string): boolean {
    return this.session.canUndo(docId);
  }

  canRedo(docId: string): boolean {
    return this.session.canRedo(docId);
  }

  applyGraphCommands(
    docId: string,
    graph: SerializedGraph,
    commands: EditCommand<SerializedGraph>[],
    options?: Partial<DocumentEditStackOptions>,
  ): SerializedGraph {
    let next = graph;
    for (const command of commands) {
      next = this.applyCommand(docId, next, command, options).doc;
    }
    return next;
  }

  undoDocument(
    docId: string,
    content: SerializedScene | SerializedGraph,
  ): SerializedScene | SerializedGraph | null {
    const result = this.undo(docId, content);
    return result?.doc ?? null;
  }

  redoDocument(
    docId: string,
    content: SerializedScene | SerializedGraph,
  ): SerializedScene | SerializedGraph | null {
    const result = this.redo(docId, content);
    return result?.doc ?? null;
  }
}
