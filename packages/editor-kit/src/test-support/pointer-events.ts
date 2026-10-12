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
  isPrimary?: boolean;
  clientX?: number;
  clientY?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  button?: number;
  buttons?: number;
}

export function dispatchPointerEvent(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  init: PointerInit = {},
): void {
  const {
    pointerId = 1,
    pointerType = "touch",
    isPrimary = true,
    clientX = 0,
    clientY = 0,
    ctrlKey = false,
    metaKey = false,
    shiftKey = false,
    button = 0,
    buttons = 0,
  } = init;

  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    ctrlKey,
    metaKey,
    shiftKey,
    button,
    buttons,
  });

  Object.defineProperty(event, "pointerId", { value: pointerId });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  Object.defineProperty(event, "isPrimary", { value: isPrimary });

  target.dispatchEvent(event);
}

export interface TouchInit {
  identifier?: number;
  clientX?: number;
  clientY?: number;
}

/**
 * Dispatches a single-finger TouchEvent. Browsers fire these after the
 * matching pointer event, and some widgets (Base UI Slider) act on them.
 */
export function dispatchTouchEvent(
  target: Element,
  type: "touchstart" | "touchmove" | "touchend",
  init: TouchInit = {},
): void {
  const { identifier = 1, clientX = 0, clientY = 0 } = init;
  const touch = { identifier, clientX, clientY, target } as unknown as Touch;
  const active = type === "touchend" ? [] : [touch];
  target.dispatchEvent(
    new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      touches: active,
      targetTouches: active,
      changedTouches: [touch],
    }),
  );
}

/**
 * jsdom implements no pointer capture, which Base UI Slider calls on press.
 * Installs no-op capture methods and returns a function that removes them.
 */
export function stubPointerCapture(): () => void {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (typeof proto.setPointerCapture === "function") return () => {};
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  proto.hasPointerCapture = () => false;
  return () => {
    delete proto.setPointerCapture;
    delete proto.releasePointerCapture;
    delete proto.hasPointerCapture;
  };
}
