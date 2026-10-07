export type DocumentTransition = {
  kind: "close-project" | "replace-project" | "close-document" | "replace-document";
  documentId?: string;
};
export type BeforeDocumentTransition = (transition: DocumentTransition) => boolean | Promise<boolean>;

/** Parent document ownership stays headless; mounted session owners register holds. */
export class DocumentTransitionGate {
  private readonly handlers = new Set<BeforeDocumentTransition>();
  register(handler: BeforeDocumentTransition): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }
  check(transition: DocumentTransition): boolean | Promise<boolean> {
    const handlers = [...this.handlers];
    const next = (index: number): boolean | Promise<boolean> => {
      for (let cursor = index; cursor < handlers.length; cursor++) {
        const result = handlers[cursor]!(transition);
        if (typeof result === "boolean") {
          if (!result) return false;
        } else return result.then(allowed => allowed ? next(cursor + 1) : false);
      }
      return true;
    };
    return next(0);
  }
}
