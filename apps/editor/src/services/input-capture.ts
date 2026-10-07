import {
  InputRingBuffer,
  type RawInputEvent,
} from "@babylonslate/input";

export interface InputCaptureHandle {
  ring: InputRingBuffer;
  /** Current simulation tick used to stamp events. */
  setTick: (tick: number) => void;
  /**
   * Poll gamepads once per frame (axes have no events). A pad sampled on the
   * previous poll but missing now is reported as `gamepadDisconnect`.
   */
  pollGamepads: () => void;
  /** Opt into exclusive routing; suppressed input needs a fresh physical transition on return. */
  setSuppressed: (suppressed: boolean) => void;
  /** Release all game controls without advancing the game clock. Drain the ring at the runtime boundary. */
  neutralize: () => void;
  /** SceneLayer sticks/buttons must use this route when exclusive input is enabled. */
  setTouchAxis: (controlId: string, value: number) => void;
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
  let sampledPads = new Set<number>();
  let exclusive = false;
  let suppressed = false;
  let focusBlocked = false;
  let disposed = false;
  const blockedKeys = new Set<string>();
  const pointers = new Map<number, Extract<RawInputEvent, { kind: "pointer" }>>();
  const blockedPointers = new Set<number>();
  const touchAxes = new Map<string, number>();
  const blockedTouchAxes = new Set<string>();
  const pads = new Map<number, { axes: number[]; buttons: number[] }>();
  const blockedPadAxes = new Map<number, Set<number>>();
  const blockedPadButtons = new Map<number, Set<number>>();
  const isSuppressed = () => exclusive && (suppressed || focusBlocked);

  const push = (raw: RawInputEvent) => {
    if (disposed) return;
    ring.push(raw);
  };

  const releasePointer = (pointerId: number) => {
    try { canvas.releasePointerCapture?.(pointerId); } catch { /* The browser may have released it already. */ }
  };
  const neutralize = () => {
    if (disposed) return;
    // Queued presses must not reach gameplay after this ownership boundary.
    const releases = ring.drain().filter(event =>
      event.kind === "key" ? event.phase === "up" :
      event.kind === "pointer" ? event.phase === "up" || event.phase === "cancel" :
      event.kind === "touchAxis" ? event.value === 0 :
      event.kind === "gamepad" ? event.axes.every(value => value === 0) && event.buttons.every(value => value === 0) : true);
    // A second pause/focus notification must not erase undelivered releases.
    for (const event of releases) push(event);
    for (const code of heldKeys) blockedKeys.add(code);
    releaseKeys();
    for (const [id, pointer] of pointers) {
      blockedPointers.add(id);
      push({ ...pointer, tick, phase: "cancel" });
    }
    const captured = [...pointers.keys()];
    pointers.clear();
    for (const id of captured) releasePointer(id);
    for (const [controlId, value] of touchAxes) {
      if (value !== 0) blockedTouchAxes.add(controlId);
      push({ kind: "touchAxis", tick, controlId, value: 0 });
    }
    for (const [index, pad] of pads) {
      blockedPadAxes.set(index, new Set(pad.axes.flatMap((value, id) => Math.abs(value) > 0.01 ? [id] : [])));
      blockedPadButtons.set(index, new Set(pad.buttons.flatMap((value, id) => Math.abs(value) > 0.01 ? [id] : [])));
      push({ kind: "gamepad", tick, gamepadIndex: index, axes: pad.axes.map(() => 0), buttons: pad.buttons.map(() => 0) });
    }
    if (canvas.ownerDocument.pointerLockElement === canvas) canvas.ownerDocument.exitPointerLock?.();
  };

  const onPointer = (phase: "down" | "move" | "up" | "cancel") =>
    (event: PointerEvent) => {
      if (exclusive && (suppressed || (focusBlocked && phase !== "down") || blockedPointers.has(event.pointerId))) {
        if (phase === "down") blockedPointers.add(event.pointerId);
        if (phase === "up" || phase === "cancel") blockedPointers.delete(event.pointerId);
        return;
      }
      const handled = event.defaultPrevented;
      event.preventDefault();
      if (phase === "down") {
        // SceneLayer text controls focus their native editor during pointerdown.
        if (!handled) {
          canvas.focus({ preventScroll: true });
          if (exclusive) onFocus();
        }
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
      if (phase === "down" || (phase === "move" && pointers.has(event.pointerId))) pointers.set(event.pointerId, raw);
      if (phase === "up" || phase === "cancel") pointers.delete(event.pointerId);
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
      blockedKeys.delete(event.code);
      if (heldKeys.delete(event.code)) push({ kind: "key", tick, code: event.code, phase });
      return;
    }
    if (isSuppressed()) { blockedKeys.add(event.code); return; }
    if (exclusive && (blockedKeys.has(event.code) || event.repeat)) return;
    if (options.skipPointerAndKeyboard?.()) {
      releaseKeys();
      return;
    }
    if (canvas.ownerDocument.activeElement !== canvas) return;
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code) && !event.ctrlKey && !event.altKey && !event.metaKey) event.preventDefault();
    if (heldKeys.has(event.code)) return;
    heldKeys.add(event.code);
    push({ kind: "key", tick, code: event.code, phase });
  };
  const keyDown = onKey("down");
  const keyUp = onKey("up");
  const onBlur = () => {
    if (!exclusive) { releaseKeys(); return; }
    focusBlocked = true;
    neutralize();
  };
  const onFocus = () => {
    if (canvas.ownerDocument.activeElement !== canvas) return;
    if (exclusive && focusBlocked) handle.pollGamepads();
    focusBlocked = false;
  };
  const onPointerEnd = (event: PointerEvent) => {
    blockedPointers.delete(event.pointerId);
    const pointer = pointers.get(event.pointerId);
    if (!pointer || !exclusive) return;
    pointers.delete(event.pointerId);
    push({ ...pointer, tick, phase: "cancel" });
    releasePointer(event.pointerId);
  };
  const onLostPointerCapture = (event: PointerEvent) => {
    const pointer = pointers.get(event.pointerId);
    if (!exclusive || !pointer) return;
    pointers.delete(event.pointerId);
    blockedPointers.add(event.pointerId);
    push({ ...pointer, tick, phase: "cancel" });
  };
  const setTouchAxis = (controlId: string, value: number) => {
    if (disposed || !controlId || !Number.isFinite(value)) return;
    if (value === 0) touchAxes.delete(controlId);
    else touchAxes.set(controlId, value);
    if (isSuppressed()) {
      if (value !== 0) blockedTouchAxes.add(controlId);
      else blockedTouchAxes.delete(controlId);
      return;
    }
    if (exclusive && blockedTouchAxes.has(controlId)) {
      if (value === 0) blockedTouchAxes.delete(controlId);
      return;
    }
    push({ kind: "touchAxis", tick, controlId, value });
  };
  const maskPadControls = (values: number[], index: number, blockedByPad: Map<number, Set<number>>) => {
    const blocked = blockedByPad.get(index) ?? new Set<number>();
    blockedByPad.set(index, blocked);
    return values.map((value, id) => {
      if (!Number.isFinite(value)) return 0;
      if (isSuppressed()) {
        if (Math.abs(value) > 0.01) blocked.add(id); else blocked.delete(id);
        return 0;
      }
      if (blocked.has(id)) {
        if (Math.abs(value) <= 0.01) blocked.delete(id);
        return 0;
      }
      return value;
    });
  };
  const samplePad = (present: Set<number>, index: number, axes: number[], buttons: number[]) => {
    present.add(index);
    if (exclusive) {
      pads.set(index, { axes, buttons });
      axes = maskPadControls(axes, index, blockedPadAxes);
      buttons = maskPadControls(buttons, index, blockedPadButtons);
    }
    if (!isSuppressed()) push({ kind: "gamepad", tick, gamepadIndex: index, axes, buttons });
  };

  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", keyDown);
  window.addEventListener("keyup", keyUp);
  canvas.addEventListener("blur", onBlur);
  window.addEventListener("blur", onBlur);
  canvas.addEventListener("focus", onFocus);
  window.addEventListener("focus", onFocus);
  window.addEventListener("pointerup", onPointerEnd);
  window.addEventListener("pointercancel", onPointerEnd);
  canvas.addEventListener("lostpointercapture", onLostPointerCapture);

  const handle: InputCaptureHandle = {
    ring,
    setTick: (value) => {
      tick = value;
    },
    pollGamepads: () => {
      if (disposed) return;
      if (options.skipPointerAndKeyboard?.()) releaseKeys();
      if (typeof navigator === "undefined" || !navigator.getGamepads) return;
      const gamepads = navigator.getGamepads();
      const present = new Set<number>();
      for (let i = 0; i < gamepads.length; i++) {
        const pad = gamepads[i];
        if (!pad || pad.connected === false) continue;
        samplePad(present, pad.index, [...pad.axes], pad.buttons.map((b) => b.value));
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
        samplePad(present, synthetic.index, [...synthetic.axes], [...synthetic.buttons]);
      }
      for (const index of sampledPads) {
        if (!present.has(index)) {
          push({ kind: "gamepadDisconnect", tick, gamepadIndex: index });
          pads.delete(index);
          blockedPadAxes.delete(index);
          blockedPadButtons.delete(index);
        }
      }
      sampledPads = present;
      const touchAxes = (
        globalThis as {
          __babylonslateTestTouchAxes?: Record<string, number>;
        }
      ).__babylonslateTestTouchAxes;
      if (touchAxes) {
        for (const [controlId, value] of Object.entries(touchAxes)) {
          if (typeof value === "number" && Number.isFinite(value)) {
            setTouchAxis(controlId, value);
          }
        }
      }
    },
    setSuppressed: (value) => {
      if (disposed) return;
      exclusive = true;
      if (suppressed === value) return;
      if (value) {
        suppressed = true;
        handle.pollGamepads();
        neutralize();
      } else {
        // Catch a held pad even when suppression began between host polls.
        handle.pollGamepads();
        suppressed = false;
      }
    },
    neutralize: () => {
      if (disposed) return;
      exclusive = true;
      const previous = suppressed;
      suppressed = true;
      handle.pollGamepads();
      neutralize();
      suppressed = previous;
    },
    setTouchAxis,
    dispose: () => {
      if (disposed) return;
      if (exclusive) neutralize(); else releaseKeys();
      disposed = true;
      canvas.removeEventListener("blur", onBlur);
      window.removeEventListener("blur", onBlur);
      canvas.removeEventListener("focus", onFocus);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      canvas.removeEventListener("lostpointercapture", onLostPointerCapture);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      heldKeys.clear();
      blockedKeys.clear();
      pointers.clear();
      blockedPointers.clear();
      touchAxes.clear();
      blockedTouchAxes.clear();
      pads.clear();
      blockedPadAxes.clear();
      blockedPadButtons.clear();
      sampledPads.clear();
    },
  };
  return handle;
}
