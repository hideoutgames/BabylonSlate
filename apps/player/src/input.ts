import {
  InputRingBuffer,
  type RawInputEvent,
} from "@babylonslate/input";

export interface InputCaptureHandle {
  ring: InputRingBuffer;
  setTick: (tick: number) => void;
  /**
   * Poll gamepads once per frame. A pad sampled on the previous poll but
   * missing now is reported as `gamepadDisconnect`.
   */
  pollGamepads: () => void;
  dispose: () => void;
}

/** Tick stamp for canvas events. In-process uses World.clock; worker uses last snapshot tick. */
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
  canvas.style.touchAction = "none";
  canvas.tabIndex = 0;
  canvas.focus({ preventScroll: true });
  const heldKeys = new Set<string>();
  let sampledPads = new Set<number>();

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
      const present = new Set<number>();
      for (let i = 0; i < pads.length; i++) {
        const pad = pads[i];
        if (!pad || pad.connected === false) continue;
        present.add(pad.index);
        push({
          kind: "gamepad",
          tick,
          gamepadIndex: pad.index,
          axes: [...pad.axes],
          buttons: pad.buttons.map((b) => b.value),
        });
      }
      for (const index of sampledPads) {
        if (!present.has(index))
          push({ kind: "gamepadDisconnect", tick, gamepadIndex: index });
      }
      sampledPads = present;
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
