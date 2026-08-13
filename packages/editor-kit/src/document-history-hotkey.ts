import { keepsNativeEditing } from "./ios-editing-gestures";

export type DocumentHistoryHotkeyEvent = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "target"
>;

/**
 * Desktop undo/redo chords for the active document. Text fields and
 * SelectableText keep native typing undo; three-pointer viewport pans
 * must not fire document history.
 */
export function documentHistoryHotkey(
  event: DocumentHistoryHotkeyEvent,
  options?: { activePointerCount?: number },
): "undo" | "redo" | null {
  if ((options?.activePointerCount ?? 0) >= 3) {
    return null;
  }
  if (!(event.metaKey || event.ctrlKey) || event.altKey) {
    return null;
  }
  if (keepsNativeEditing(event.target)) {
    return null;
  }
  const key = event.key.toLowerCase();
  if (key === "y") {
    return "redo";
  }
  if (key !== "z") {
    return null;
  }
  return event.shiftKey ? "redo" : "undo";
}
