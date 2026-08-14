/** Close-tab and leave-page prompts for dirty editor documents. */

export type TabCloseDecision = "prompt" | "close";

export function tabCloseDecision(dirty: boolean): TabCloseDecision {
  return dirty ? "prompt" : "close";
}

export function shouldPromptBeforeUnload(dirtyDocumentCount: number): boolean {
  return dirtyDocumentCount > 0;
}
