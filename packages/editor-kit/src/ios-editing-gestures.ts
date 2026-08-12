/**
 * Editable fields and opted-in selectable text keep iOS three-finger undo
 * and the system historyUndo/historyRedo path, since that is where typing
 * undo is still wanted.
 */
export function keepsNativeEditing(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      "input, textarea, [contenteditable=''], [contenteditable='true'], .selectable-text",
    ),
  );
}

/** iOS 13+ three-finger swipe/tap is system undo/redo outside text fields. */
export function shouldSuppressIosEditingGesture(
  touchCount: number,
  target: EventTarget | null,
): boolean {
  if (touchCount < 3) return false;
  return !keepsNativeEditing(target);
}

/** Safari may still synthesize historyUndo/historyRedo after a three-finger swipe. */
export function shouldSuppressIosHistoryInput(
  inputType: string,
  target: EventTarget | null,
): boolean {
  if (inputType !== "historyUndo" && inputType !== "historyRedo") return false;
  return !keepsNativeEditing(target);
}
