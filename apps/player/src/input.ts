import {
  InputRingBuffer,
  shouldPushRawInput,
  type RawInputEvent,
} from "@babylonslate/input";
import {
  DEFAULT_INPUT_MODE,
  parseInputMode,
  type InputMode,
} from "@babylonslate/core";

export interface InputCaptureHandle {
  ring: InputRingBuffer;
  setTick: (tick: number) => void;
  pollGamepads: () => void;
  pushTouchAxis: (controlId: string, value: number) => void;
  setInputMode: (mode: InputMode | string) => void;
  dispose: () => void;
}

/** Tick stamp for canvas events. In-process uses World.clock; worker uses last stats tick. */
export function playInputStampTick(
  inProcessTickIndex: number | undefined,
  lastWorkerTickIndex: number,
): number {
  return inProcessTickIndex ?? lastWorkerTickIndex;
}

/** Raw input capture on the packaged player canvas. */
export function attachInputCapture(
  canvas: HTMLCanvasElement,
  options: {
    ring?: InputRingBuffer;
    skipPointerAndKeyboard?: () => boolean;
  } = {},
): InputCaptureHandle {
  const ring = options.ring ?? new InputRingBuffer(512);
  let tick = 0;
  let mode: InputMode = DEFAULT_INPUT_MODE;
  canvas.style.touchAction = "none";

  const push = (raw: RawInputEvent) => {
    if (shouldPushRawInput(mode, raw.kind)) ring.push(raw);
  };

  const onPointer = (phase: "down" | "move" | "up" | "cancel") =>
    (event: PointerEvent) => {
      event.preventDefault();
      if (phase === "down") {
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

  const onKey = (phase: "down" | "up") => (event: KeyboardEvent) => {
    if (options.skipPointerAndKeyboard?.()) return;
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

  return {
    ring,
    setTick: (value) => {
      tick = value;
    },
    setInputMode: (next) => {
      mode = parseInputMode(next);
    },
    pollGamepads: () => {
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
    },
    pushTouchAxis: (controlId, value) => {
      push({ kind: "touchAxis", tick, controlId, value });
    },
    dispose: () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
    },
  };
}
