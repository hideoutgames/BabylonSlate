/**
 * jsdom implements no PointerEvent, and testing-library's `fireEvent.pointerX`
 * degrades to a bare Event with clientX, pointerId and pointerType all
 * undefined -- which silently makes pointer-gesture assertions vacuous. These
 * helpers dispatch a MouseEvent (so coordinates are real) with the pointer
 * fields defined on top, so the gesture logic is actually exercised.
 */
export interface PointerInit {
  pointerId?: number;
  pointerType?: "touch" | "mouse" | "pen";
  clientX?: number;
  clientY?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export function dispatchPointerEvent(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  init: PointerInit = {},
): void {
  const {
    pointerId = 1,
    pointerType = "touch",
    clientX = 0,
    clientY = 0,
    ctrlKey = false,
    metaKey = false,
    shiftKey = false,
  } = init;

  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    ctrlKey,
    metaKey,
    shiftKey,
  });

  Object.defineProperty(event, "pointerId", { value: pointerId });
  Object.defineProperty(event, "pointerType", { value: pointerType });

  target.dispatchEvent(event);
}
