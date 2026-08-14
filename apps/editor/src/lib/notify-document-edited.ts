/**
 * Notify chrome (dirty / undo) immediately after a document mutation, then
 * append the crash journal without blocking that UI update.
 */
export async function notifyDocumentEdited(options: {
  bump: () => void;
  scheduleDebouncedSave: () => void;
  journal: () => Promise<void>;
}): Promise<void> {
  options.scheduleDebouncedSave();
  options.bump();
  try {
    await options.journal();
  } catch (error) {
    console.error("[journal] failed to append edit", error);
  }
}
