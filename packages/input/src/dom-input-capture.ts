import {
  InputRingBuffer,
  isInputReleaseEvent,
  type PointerKind,
  type RawInputEvent,
} from "./ring-buffer";

/** `PointerEvent.buttons` bit for each `PointerEvent.button` (middle and right swap). */
const BUTTON_BITS: readonly number[] = [1, 4, 2, 8, 16, 32];

function pointerKind(type: string | undefined): PointerKind {
  return type === "touch" || type === "pen" ? type : "mouse";
}

export interface InputCaptureHandle {
  ring: InputRingBuffer;
  /** Current simulation tick used to stamp events. */
  setTick: (tick: number) => void;
  /**
   * Poll gamepads once per frame (axes have no events), and sample device
   * motion when it is on. A pad sampled on the previous poll but missing now
   * is reported as `gamepadDisconnect`.
   */
  pollGamepads: () => void;
  /** Opt into exclusive routing; suppressed input needs a fresh physical transition on return. */
  setSuppressed: (suppressed: boolean) => void;
  /** Release all game controls without advancing the game clock. Drain the ring at the runtime boundary. */
  neutralize: () => void;
  /** SceneLayer sticks/buttons must use this route when exclusive input is enabled. */
  setTouchAxis: (controlId: string, value: number) => void;
  /**
   * The game reads tilt or motion: start the device's motion sensors. Where
   * the browser asks permission (iOS), the next tap or key press asks.
   */
  enableMotion: () => void;
  dispose: () => void;
}

/** iOS gates motion sensors behind a permission request made during a user gesture. */
type MotionPermissionEvent = { requestPermission?: () => Promise<"granted" | "denied" | "default"> };

function motionPermissionRequests(): Array<() => Promise<string>> | null {
  const orientation = (globalThis as { DeviceOrientationEvent?: MotionPermissionEvent }).DeviceOrientationEvent;
  const motion = (globalThis as { DeviceMotionEvent?: MotionPermissionEvent }).DeviceMotionEvent;
  const requests = [orientation, motion].flatMap((type) => {
    const request = type?.requestPermission;
    return typeof request === "function" ? [() => request.call(type)] : [];
  });
  return requests.length > 0 ? requests : null;
}

/** `screen.orientation.angle`, or the older `window.orientation` that iOS Safari had alone. */
function screenAngle(view: Window | null): number {
  const angle = view?.screen?.orientation?.angle ?? (view as { orientation?: unknown } | null)?.orientation;
  return typeof angle === "number" && Number.isFinite(angle) ? angle : 0;
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
    syntheticGamepad?: () => { index: number; axes: number[]; buttons: number[] } | undefined;
    syntheticTouchAxes?: () => Record<string, number> | undefined;
    /**
     * True while engine UI owns the pointer: a SceneLayer joystick, 2D
     * control or scroll drag. Asked during each pointer event, so attach
     * capture after `createEngine` and its canvas listeners have run.
     * A pointer it owns at the press never reaches the game; one it takes
     * over later is cancelled for the game. Either stays away until it lifts.
     */
    ownsPointer?: (pointerId: number) => boolean;
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
  /** Buttons already reported down for each tracked pointer, as a `buttons` mask. */
  const pointerMasks = new Map<number, number>();
  const blockedPointers = new Set<number>();
  /** Pointers engine UI owns, kept away from the game until they lift. */
  const uiPointers = new Set<number>();
  const touchAxes = new Map<string, number>();
  const blockedTouchAxes = new Set<string>();
  /** Off until the game reads motion; waiting for a gesture where permission is asked. */
  let motionState: "off" | "awaitingGesture" | "requesting" | "on" | "denied" = "off";
  const orientation = { beta: Number.NaN, gamma: Number.NaN };
  const motionSample = { accelerationX: 0, accelerationY: 0, accelerationZ: 0, peakAcceleration: 0, rotationX: 0, rotationY: 0, rotationZ: 0 };
  let motionReported = false;
  const pads = new Map<number, { axes: number[]; buttons: number[] }>();
  const blockedPadAxes = new Map<number, Set<number>>();
  const blockedPadButtons = new Map<number, Set<number>>();
  const isSuppressed = () => exclusive && (suppressed || focusBlocked);

  const push = (raw: RawInputEvent) => {
    if (disposed) return;
    ring.push(raw);
  };

  const forgetPointer = (pointerId: number) => {
    pointers.delete(pointerId);
    pointerMasks.delete(pointerId);
  };
  const releasePointer = (pointerId: number) => {
    try { canvas.releasePointerCapture?.(pointerId); } catch { /* The browser may have released it already. */ }
  };
  const neutralize = () => {
    if (disposed) return;
    // Queued presses must not reach gameplay after this ownership boundary.
    const releases = ring.drain().filter(isInputReleaseEvent);
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
    pointerMasks.clear();
    for (const id of captured) releasePointer(id);
    for (const [controlId, value] of touchAxes) {
      if (value !== 0) blockedTouchAxes.add(controlId);
      push({ kind: "touchAxis", tick, controlId, value: 0 });
    }
    releaseMotion();
    for (const [index, pad] of pads) {
      blockedPadAxes.set(index, new Set(pad.axes.flatMap((value, id) => Math.abs(value) > 0.01 ? [id] : [])));
      blockedPadButtons.set(index, new Set(pad.buttons.flatMap((value, id) => Math.abs(value) > 0.01 ? [id] : [])));
      push({ kind: "gamepad", tick, gamepadIndex: index, axes: pad.axes.map(() => 0), buttons: pad.buttons.map(() => 0) });
    }
    if (canvas.ownerDocument.pointerLockElement === canvas) canvas.ownerDocument.exitPointerLock?.();
  };

  const onDeviceOrientation = (event: DeviceOrientationEvent) => {
    if (typeof event.beta === "number" && typeof event.gamma === "number") {
      orientation.beta = event.beta;
      orientation.gamma = event.gamma;
    }
  };
  const onDeviceMotion = (event: DeviceMotionEvent) => {
    const acceleration = event.acceleration;
    if (acceleration) {
      motionSample.accelerationX = acceleration.x ?? 0;
      motionSample.accelerationY = acceleration.y ?? 0;
      motionSample.accelerationZ = acceleration.z ?? 0;
      motionSample.peakAcceleration = Math.max(motionSample.peakAcceleration,
        Math.hypot(motionSample.accelerationX, motionSample.accelerationY, motionSample.accelerationZ));
    }
    const rotation = event.rotationRate;
    if (rotation) {
      motionSample.rotationX = rotation.beta ?? 0;
      motionSample.rotationY = rotation.gamma ?? 0;
      motionSample.rotationZ = rotation.alpha ?? 0;
    }
  };
  const view = canvas.ownerDocument.defaultView;
  const startMotion = () => {
    motionState = "on";
    view?.addEventListener("deviceorientation", onDeviceOrientation);
    view?.addEventListener("devicemotion", onDeviceMotion);
  };
  /** Runs inside a pointer or key handler: iOS accepts the request only during a gesture. */
  const requestMotionOnGesture = () => {
    if (motionState !== "awaitingGesture") return;
    const requests = motionPermissionRequests();
    if (!requests) { startMotion(); return; }
    motionState = "requesting";
    Promise.all(requests.map((request) => request())).then((answers) => {
      if (disposed) return;
      if (answers.every((answer) => answer === "granted")) startMotion();
      else motionState = "denied";
    }, () => {
      // Refused without an answer (no gesture, an embedded frame): the next gesture asks again.
      if (!disposed && motionState === "requesting") motionState = "awaitingGesture";
    });
  };
  /** One sample per frame: the latest pose and the strongest acceleration since the last one. */
  const pollMotion = () => {
    if (motionState !== "on" || !Number.isFinite(orientation.beta) || isSuppressed()) return;
    push({ kind: "motion", tick, beta: orientation.beta, gamma: orientation.gamma, screenAngle: screenAngle(view), ...motionSample });
    motionSample.peakAcceleration = 0;
    motionReported = true;
  };
  /** Tilt must not keep steering a game that lost input ownership. */
  const releaseMotion = () => {
    if (!motionReported) return;
    motionReported = false;
    push({ kind: "motion", tick, beta: Number.NaN, gamma: Number.NaN, screenAngle: 0, accelerationX: 0, accelerationY: 0,
      accelerationZ: 0, peakAcceleration: 0, rotationX: 0, rotationY: 0, rotationZ: 0 });
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
      if (phase === "down") requestMotionOnGesture();
      if (phase === "down") {
        // SceneLayer text controls focus their native editor during pointerdown.
        if (!handled) {
          canvas.focus({ preventScroll: true });
          if (exclusive) onFocus();
        }
        canvas.setPointerCapture(event.pointerId);
      }
      if (options.skipPointerAndKeyboard?.()) return;
      const id = event.pointerId;
      // The engine's listener has already released UI ownership on up, so the
      // verdict taken earlier decides, not a fresh query.
      if (uiPointers.has(id)) {
        if (phase === "up" || phase === "cancel") uiPointers.delete(id);
        return;
      }
      if (options.ownsPointer?.(id)) {
        const reported = pointers.get(id);
        if (reported) {
          forgetPointer(id);
          push({ ...reported, tick, phase: "cancel" });
        }
        if (phase !== "up" && phase !== "cancel") uiPointers.add(id);
        return;
      }
      const bit = BUTTON_BITS[event.button] ?? 0;
      const mask = pointerMasks.get(id) ?? 0;
      let reported: typeof phase = phase;
      if (phase === "down") pointerMasks.set(id, mask | bit);
      else if (phase === "move" && bit && typeof event.buttons === "number" && pointers.has(id)) {
        // Pointer Events report a chorded button change as pointermove with
        // `button` set; pointerdown/up only bracket the first and last button.
        const held = (event.buttons & bit) !== 0;
        if (held !== ((mask & bit) !== 0)) {
          reported = held ? "down" : "up";
          pointerMasks.set(id, held ? mask | bit : mask & ~bit);
        }
      }
      const raw: Extract<RawInputEvent, { kind: "pointer" }> = {
        kind: "pointer",
        tick,
        pointerId: id,
        phase: reported,
        x: event.offsetX,
        y: event.offsetY,
        button: event.button,
        pointerType: pointerKind(event.pointerType),
        ...(typeof event.pressure === "number" && Number.isFinite(event.pressure) ? { pressure: event.pressure } : {}),
      };
      if (phase === "up") {
        // pointerup means no buttons remain; release any chorded button first.
        BUTTON_BITS.forEach((other, button) => {
          if (button !== event.button && (mask & other) !== 0) push({ ...raw, phase: "up", button });
        });
      }
      if (phase === "down" || (phase === "move" && pointers.has(id))) pointers.set(id, raw);
      if (phase === "up" || phase === "cancel") forgetPointer(id);
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
    requestMotionOnGesture();
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
    uiPointers.delete(event.pointerId);
    const pointer = pointers.get(event.pointerId);
    if (!pointer || !exclusive) return;
    forgetPointer(event.pointerId);
    push({ ...pointer, tick, phase: "cancel" });
    releasePointer(event.pointerId);
  };
  const onLostPointerCapture = (event: PointerEvent) => {
    // Its lift may now land elsewhere; a stale entry would swallow the id's next press.
    uiPointers.delete(event.pointerId);
    const pointer = pointers.get(event.pointerId);
    if (!exclusive || !pointer) return;
    forgetPointer(event.pointerId);
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
      pollMotion();
      if (typeof navigator === "undefined" || !navigator.getGamepads) return;
      const gamepads = navigator.getGamepads();
      const present = new Set<number>();
      for (let i = 0; i < gamepads.length; i++) {
        const pad = gamepads[i];
        if (!pad || pad.connected === false) continue;
        samplePad(present, pad.index, [...pad.axes], pad.buttons.map((b) => b.value));
      }
      const synthetic = options.syntheticGamepad?.();
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
      const touchAxes = options.syntheticTouchAxes?.();
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
    enableMotion: () => {
      if (disposed || motionState !== "off") return;
      if (motionPermissionRequests()) motionState = "awaitingGesture";
      else startMotion();
    },
    dispose: () => {
      if (disposed) return;
      if (exclusive) neutralize(); else releaseKeys();
      disposed = true;
      view?.removeEventListener("deviceorientation", onDeviceOrientation);
      view?.removeEventListener("devicemotion", onDeviceMotion);
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
      pointerMasks.clear();
      blockedPointers.clear();
      uiPointers.clear();
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
