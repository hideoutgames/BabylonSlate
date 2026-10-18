import { isCoarsePointerEnvironment } from "@babylonslate/editor-kit";

/**
 * Whether a touch screen is attached. Dialogs skip focusing a text field then,
 * because the on-screen keyboard would cover the dialog.
 */
export function hasTouchInput(): boolean {
  return (
    isCoarsePointerEnvironment() ||
    Boolean(window.matchMedia?.("(any-pointer: coarse)").matches)
  );
}
