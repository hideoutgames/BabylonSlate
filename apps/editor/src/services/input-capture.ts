import {
  InputRingBuffer,
  type RawInputEvent,
} from "@babylonslate/input";

export interface InputCaptureHandle {
  ring: InputRingBuffer;
  /** Current simulation tick used to stamp events. */
  setTick: (tick: number) => void;
  /** Poll gamepads once per frame (axes have no events). */
  pollGamepads: () => void;
  /** Push a Play overlay joystick sample into the Play ring. */
  pushTouchAxis: (controlId: string, value: number) => void;
  dispose: () => void;
}

/**
 * Raw input capture on the Play canvas: pointer/touch, keyboard, mouse,
 * plus Gamepad API polling. Events are tick-stamped for determinism.
 */
export function attachInputCapture(
  canvas: HTMLCanvasElement,
  options: {
    ring?: InputRingBuffer;
    /** When true, pointer and keyboard stay off the game ring (free cam). */
    skipPointerAndKeyboard?: () => boolean;
  } = {},
): InputCaptureHandle {
  const ring = options.ring ?? new InputRingBuffer(512);
  let tick = 0;
  canvas.style.touchAction = "none";
  canvas.tabIndex = 0;
  canvas.focus({ preventScroll: true });
  const heldKeys = new Set<string>();

  const push = (raw: RawInputEvent) => {
    ring.push(raw);
  };

  const onPointer = (phase: "down" | "move" | "up" | "cancel") =>
    (event: PointerEvent) => {
      event.preventDefault();
      if (phase === "down") {
        canvas.focus({ preventScroll: true });
        canvas.setPointerCapture(event.pointerId);
      }
      const raw: RawInputEvent = {
        kind: "pointer",
        tick,
        pointerId: event.pointerId,
        phase,
        x: event.offsetX,
        y: event.offsetY,
        button: event.button,
      };
      if (options.skipPointerAndKeyboard?.()) return;
      push(raw);
    };

  const down = onPointer("down");
  const move = onPointer("move");
  const up = onPointer("up");
  const cancel = onPointer("cancel");

  const releaseKeys = () => {
    for (const code of heldKeys) push({ kind: "key", tick, code, phase: "up" });
    heldKeys.clear();
  };
  const onKey = (phase: "down" | "up") => (event: KeyboardEvent) => {
    if (phase === "up") {
      if (heldKeys.delete(event.code)) push({ kind: "key", tick, code: event.code, phase });
      return;
    }
    if (options.skipPointerAndKeyboard?.()) {
      releaseKeys();
      return;
    }
    if (canvas.ownerDocument.activeElement !== canvas) return;
    if (event.code === "Space" && !event.ctrlKey && !event.altKey && !event.metaKey) event.preventDefault();
    if (heldKeys.has(event.code)) return;
    heldKeys.add(event.code);
    push({ kind: "key", tick, code: event.code, phase });
  };
  const keyDown = onKey("down");
  const keyUp = onKey("up");

  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", keyDown);
  window.addEventListener("keyup", keyUp);
  canvas.addEventListener("blur", releaseKeys);
  window.addEventListener("blur", releaseKeys);

  return {
    ring,
    setTick: (value) => {
      tick = value;
    },
    pollGamepads: () => {
      if (options.skipPointerAndKeyboard?.()) releaseKeys();
      if (typeof navigator === "undefined" || !navigator.getGamepads) return;
      const pads = navigator.getGamepads();
      for (let i = 0; i < pads.length; i++) {
        const pad = pads[i];
        if (!pad) continue;
        push({
          kind: "gamepad",
          tick,
          gamepadIndex: pad.index,
          axes: [...pad.axes],
          buttons: pad.buttons.map((b) => b.value),
        });
      }
      // Test-mode synthetic pad: e2e injects axes without a real controller.
      const synthetic = (
        globalThis as {
          __babylonslateTestGamepad?: {
            index: number;
            axes: number[];
            buttons: number[];
          };
        }
      ).__babylonslateTestGamepad;
      if (synthetic) {
        push({
          kind: "gamepad",
          tick,
          gamepadIndex: synthetic.index,
          axes: [...synthetic.axes],
          buttons: [...synthetic.buttons],
        });
      }
      const touchAxes = (
        globalThis as {
          __babylonslateTestTouchAxes?: Record<string, number>;
        }
      ).__babylonslateTestTouchAxes;
      if (touchAxes) {
        for (const [controlId, value] of Object.entries(touchAxes)) {
          if (typeof value === "number" && Number.isFinite(value)) {
            push({ kind: "touchAxis", tick, controlId, value });
          }
        }
      }
    },
    pushTouchAxis: (controlId, value) => {
      push({ kind: "touchAxis", tick, controlId, value });
    },
    dispose: () => {
      releaseKeys();
      canvas.removeEventListener("blur", releaseKeys);
      window.removeEventListener("blur", releaseKeys);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
    },
  };
}
