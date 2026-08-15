import {
  InputRingBuffer,
  type RawInputEvent,
} from "@babylonslate/input";

export interface InputCaptureHandle {
  ring: InputRingBuffer;
  setTick: (tick: number) => void;
  pollGamepads: () => void;
  pushTouchAxis: (controlId: string, value: number) => void;
  dispose: () => void;
}

/** Raw input capture on the packaged player canvas. */
export function attachInputCapture(
  canvas: HTMLCanvasElement,
  options: { ring?: InputRingBuffer } = {},
): InputCaptureHandle {
  const ring = options.ring ?? new InputRingBuffer(512);
  let tick = 0;
  canvas.style.touchAction = "none";

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
      ring.push(raw);
    };

  const down = onPointer("down");
  const move = onPointer("move");
  const up = onPointer("up");
  const cancel = onPointer("cancel");

  const onKey = (phase: "down" | "up") => (event: KeyboardEvent) => {
    ring.push({ kind: "key", tick, code: event.code, phase });
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
    pollGamepads: () => {
      if (typeof navigator === "undefined" || !navigator.getGamepads) return;
      const pads = navigator.getGamepads();
      for (let i = 0; i < pads.length; i++) {
        const pad = pads[i];
        if (!pad) continue;
        ring.push({
          kind: "gamepad",
          tick,
          gamepadIndex: pad.index,
          axes: [...pad.axes],
          buttons: pad.buttons.map((b) => b.value),
        });
      }
    },
    pushTouchAxis: (controlId, value) => {
      ring.push({ kind: "touchAxis", tick, controlId, value });
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
