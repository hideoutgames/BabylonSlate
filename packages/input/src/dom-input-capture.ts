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

/** Keys whose release macOS still reports while Cmd is held; every other key's keyup is lost then. */
const MODIFIER_CODES: ReadonlySet<string> = new Set([
  "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight",
  "MetaLeft", "MetaRight", "OSLeft", "OSRight", "CapsLock", "Fn", "FnLock",
]);

/** A deviation at or below this counts as at rest when deciding whether a held pad control was let go. */
const PAD_REST = 0.01;
/** A stick blocked at a boundary also comes back once it moves this far from where it was held. */
const PAD_AXIS_FRESH = 0.25;
const NO_AXES: readonly number[] = Object.freeze([]);
const NO_BUTTONS: readonly GamepadButton[] = Object.freeze([]);

/**
 * One pad's controls across polls, in buffers that only grow when the pad
 * reports more controls, so a poll that finds nothing changed allocates nothing.
 */
interface PadSnapshot {
  /** Poll generation that last found the pad connected. */
  seen: number;
  axisCount: number;
  buttonCount: number;
  /** The device's values this poll (non-finite read as 0): what a release boundary blocks. */
  rawAxes: Float64Array;
  rawButtons: Float64Array;
  /** This poll's values after blocking, before they are compared with what was sent. */
  outAxes: Float64Array;
  outButtons: Float64Array;
  /** Where each stick was held across a release boundary (NaN: not blocked); it reports 0 until it rests or moves on. */
  axisBlockedAt: Float64Array;
  /** Buttons held across a release boundary (1), reported as 0 until they come back to rest. */
  blockedButtons: Uint8Array;
  /** The last sample pushed, at the wire's float32 precision. Unset until `announced`. */
  sentAxes: Float32Array;
  sentButtons: Float32Array;
  sentAxisCount: number;
  sentButtonCount: number;
  announced: boolean;
}

function createPadSnapshot(): PadSnapshot {
  return {
    seen: 0, axisCount: 0, buttonCount: 0,
    rawAxes: new Float64Array(4), rawButtons: new Float64Array(17),
    outAxes: new Float64Array(4), outButtons: new Float64Array(17),
    axisBlockedAt: new Float64Array(4).fill(Number.NaN), blockedButtons: new Uint8Array(17),
    sentAxes: new Float32Array(4), sentButtons: new Float32Array(17),
    sentAxisCount: 0, sentButtonCount: 0, announced: false,
  };
}

function allZero(values: Float32Array, count: number): boolean {
  for (let i = 0; i < count; i++) if (values[i] !== 0) return false;
  return true;
}

/** Grows the pad's per-control buffers to `axes` and `buttons` controls, keeping blocked flags and the sent sample. */
function reservePadControls(pad: PadSnapshot, axes: number, buttons: number): void {
  if (axes > pad.rawAxes.length) {
    pad.rawAxes = new Float64Array(axes);
    pad.outAxes = new Float64Array(axes);
    const blocked = new Float64Array(axes).fill(Number.NaN); blocked.set(pad.axisBlockedAt); pad.axisBlockedAt = blocked;
    const sent = new Float32Array(axes); sent.set(pad.sentAxes); pad.sentAxes = sent;
  }
  if (buttons > pad.rawButtons.length) {
    pad.rawButtons = new Float64Array(buttons);
    pad.outButtons = new Float64Array(buttons);
    const blocked = new Uint8Array(buttons); blocked.set(pad.blockedButtons); pad.blockedButtons = blocked;
    const sent = new Float32Array(buttons); sent.set(pad.sentButtons); pad.sentButtons = sent;
  }
}

export interface InputCaptureHandle {
  ring: InputRingBuffer;
  /** Current simulation tick used to stamp events. */
  setTick: (tick: number) => void;
  /**
   * Poll gamepads once per frame (axes have no events), and sample device
   * motion when it is on. A pad's whole state is pushed when it connects and
   * whenever a control changes at the wire's float32 precision; an unchanged
   * pad pushes nothing. A pad announced earlier but missing now is reported
   * as `gamepadDisconnect`.
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

/** The screen's rotation from `screen.orientation.angle`, or 0 when the view has none. */
function screenAngle(view: Window | null): number {
  const angle = view?.screen?.orientation?.angle;
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
  /** Pads by `Gamepad.index`; a pad's entry lives from its first poll until it disconnects. */
  const pads: (PadSnapshot | undefined)[] = [];
  let padGeneration = 0;
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
    // Released once: a stick still held reports again through setTouchAxis.
    touchAxes.clear();
    releaseMotion();
    for (let index = 0; index < pads.length; index++) {
      const pad = pads[index];
      if (!pad) continue;
      // Held controls stay at 0 until they come back to rest: a fresh press, never a replay.
      for (let id = 0; id < pad.axisCount; id++) if (Math.abs(pad.rawAxes[id]!) > PAD_REST) pad.axisBlockedAt[id] = pad.rawAxes[id]!;
      for (let id = 0; id < pad.buttonCount; id++) if (Math.abs(pad.rawButtons[id]!) > PAD_REST) pad.blockedButtons[id] = 1;
      // A pad the game never saw has nothing to release; one already at rest is released once.
      if (!pad.announced || (pad.sentAxisCount === pad.axisCount && pad.sentButtonCount === pad.buttonCount &&
        allZero(pad.sentAxes, pad.axisCount) && allZero(pad.sentButtons, pad.buttonCount))) continue;
      pad.sentAxes.fill(0, 0, pad.axisCount);
      pad.sentButtons.fill(0, 0, pad.buttonCount);
      pad.sentAxisCount = pad.axisCount;
      pad.sentButtonCount = pad.buttonCount;
      push({ kind: "gamepad", tick, gamepadIndex: index, axes: new Array<number>(pad.axisCount).fill(0), buttons: new Array<number>(pad.buttonCount).fill(0) });
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
      // Only a pointer the game reads is captured here; free cam and engine UI capture their own.
      if (phase === "down") {
        try { canvas.setPointerCapture?.(id); } catch { /* The pointer may already be up (InvalidPointerId). */ }
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
  /**
   * macOS (and iPadOS with a keyboard) sends no keyup for a key released
   * while Cmd is held, so Cmd's own keyup lets go of every other key, as the
   * editor's fly keys do. Unconditional: on Windows and Linux every keyup
   * still arrives, and a key that stays down there only reads released early
   * (the Windows key usually takes focus away anyway).
   */
  const releaseChordedKeys = () => {
    for (const code of heldKeys) {
      if (MODIFIER_CODES.has(code)) continue;
      heldKeys.delete(code);
      push({ kind: "key", tick, code, phase: "up" });
    }
    // A key blocked at a boundary would otherwise wait forever for its lost keyup.
    for (const code of blockedKeys) if (!MODIFIER_CODES.has(code)) blockedKeys.delete(code);
  };
  const onKey = (phase: "down" | "up") => (event: KeyboardEvent) => {
    if (phase === "up") {
      if (event.key === "Meta" || event.code === "MetaLeft" || event.code === "MetaRight") releaseChordedKeys();
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
  /**
   * Focus moved within the page (a text field, another panel). Shared routing
   * only lets go of keys there, since gamepads, touches and pointers still
   * drive the game; exclusive routing takes everything until focus returns.
   */
  const onCanvasBlur = () => {
    if (!exclusive) { releaseKeys(); return; }
    focusBlocked = true;
    neutralize();
  };
  /**
   * The page lost focus or was hidden (another app, a backgrounded tab or
   * WebView, a browser dialog): no lift or keyup is guaranteed to arrive, so
   * every device lets go in either routing. Controls still held stay away
   * from the game until they come back to rest; shared routing takes input
   * again at once, exclusive routing when the canvas has focus again.
   */
  const onPageBlur = () => {
    if (exclusive) focusBlocked = true;
    neutralize();
  };
  const onVisibilityChange = () => {
    if (canvas.ownerDocument.visibilityState === "hidden") onPageBlur();
  };
  const onFocus = () => {
    if (canvas.ownerDocument.activeElement !== canvas) return;
    if (exclusive && focusBlocked) handle.pollGamepads();
    focusBlocked = false;
  };
  const onPointerEnd = (event: PointerEvent) => {
    blockedPointers.delete(event.pointerId);
    uiPointers.delete(event.pointerId);
    // Its lift landed off the canvas (capture lost or never taken): the game hears a cancel, in either routing.
    const pointer = pointers.get(event.pointerId);
    if (!pointer) return;
    forgetPointer(event.pointerId);
    push({ ...pointer, tick, phase: "cancel" });
    releasePointer(event.pointerId);
  };
  const onLostPointerCapture = (event: PointerEvent) => {
    // Its lift may now land elsewhere; a stale entry would swallow the id's next press.
    uiPointers.delete(event.pointerId);
    // In either routing: nothing guarantees this contact's lift reaches the canvas now.
    const pointer = pointers.get(event.pointerId);
    if (!pointer) return;
    forgetPointer(event.pointerId);
    blockedPointers.add(event.pointerId);
    push({ ...pointer, tick, phase: "cancel" });
  };
  const setTouchAxis = (controlId: string, value: number) => {
    if (disposed || !controlId || !Number.isFinite(value)) return;
    const deflected = touchAxes.has(controlId);
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
    // Already released for the game (a boundary sent its 0): no second release.
    if (value === 0 && !deflected) return;
    push({ kind: "touchAxis", tick, controlId, value });
  };
  /** The value the game gets for one control this poll, keeping a control held across a boundary at 0. */
  const maskAxis = (pad: PadSnapshot, id: number, value: number): number => {
    const blockedAt = pad.axisBlockedAt[id]!;
    if (isSuppressed()) {
      pad.axisBlockedAt[id] = Math.abs(value) > PAD_REST ? value : Number.NaN;
      return 0;
    }
    if (Number.isNaN(blockedAt)) return value;
    // At rest, or moved well away from where it was held: a stick resting off
    // centre (wear, drift) never stays blocked.
    if (Math.abs(value) > PAD_REST && Math.abs(value - blockedAt) <= PAD_AXIS_FRESH) return 0;
    pad.axisBlockedAt[id] = Number.NaN;
    return value;
  };
  const maskButton = (pad: PadSnapshot, id: number, value: number): number => {
    if (isSuppressed()) {
      pad.blockedButtons[id] = Math.abs(value) > PAD_REST ? 1 : 0;
      return 0;
    }
    if (pad.blockedButtons[id] === 0) return value;
    if (Math.abs(value) > PAD_REST) return 0;
    pad.blockedButtons[id] = 0;
    return value;
  };
  /**
   * Reads one pad into its snapshot and pushes its whole state only when it
   * connected or a control changed at float32 precision (the wire's), so an
   * idle pad pushes and allocates nothing. Takes the source's values by index
   * rather than copying them.
   */
  const samplePad = (
    index: number,
    axisCount: number, axisAt: (id: number) => number,
    buttonCount: number, buttonAt: (id: number) => number,
  ) => {
    let pad = pads[index];
    if (!pad) pads[index] = pad = createPadSnapshot();
    if (axisCount > pad.rawAxes.length || buttonCount > pad.rawButtons.length) reservePadControls(pad, axisCount, buttonCount);
    pad.seen = padGeneration;
    pad.axisCount = axisCount;
    pad.buttonCount = buttonCount;
    let changed = !pad.announced || pad.sentAxisCount !== axisCount || pad.sentButtonCount !== buttonCount;
    for (let id = 0; id < axisCount; id++) {
      const raw = axisAt(id);
      const value = Number.isFinite(raw) ? raw : 0;
      pad.rawAxes[id] = value;
      const out = maskAxis(pad, id, value);
      pad.outAxes[id] = out;
      if (!changed && Math.fround(out) !== pad.sentAxes[id]) changed = true;
    }
    for (let id = 0; id < buttonCount; id++) {
      const raw = buttonAt(id);
      const value = Number.isFinite(raw) ? raw : 0;
      pad.rawButtons[id] = value;
      const out = maskButton(pad, id, value);
      pad.outButtons[id] = out;
      if (!changed && Math.fround(out) !== pad.sentButtons[id]) changed = true;
    }
    if (!changed || isSuppressed()) return;
    const axes = new Array<number>(axisCount);
    const buttons = new Array<number>(buttonCount);
    for (let id = 0; id < axisCount; id++) pad.sentAxes[id] = axes[id] = pad.outAxes[id]!;
    for (let id = 0; id < buttonCount; id++) pad.sentButtons[id] = buttons[id] = pad.outButtons[id]!;
    pad.sentAxisCount = axisCount;
    pad.sentButtonCount = buttonCount;
    pad.announced = true;
    push({ kind: "gamepad", tick, gamepadIndex: index, axes, buttons });
  };
  // Hoisted readers for `samplePad`, so a poll creates no closures.
  let deviceAxes: readonly number[] = NO_AXES;
  let deviceButtons: readonly GamepadButton[] = NO_BUTTONS;
  let syntheticPad: { index: number; axes: number[]; buttons: number[] } | null = null;
  const deviceAxis = (id: number) => deviceAxes[id]!;
  const deviceButton = (id: number) => deviceButtons[id]?.value ?? 0;
  const syntheticAxis = (id: number) => syntheticPad!.axes[id]!;
  const syntheticButton = (id: number) => syntheticPad!.buttons[id]!;

  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", keyDown);
  window.addEventListener("keyup", keyUp);
  canvas.addEventListener("blur", onCanvasBlur);
  window.addEventListener("blur", onPageBlur);
  canvas.ownerDocument.addEventListener("visibilitychange", onVisibilityChange);
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
      padGeneration++;
      for (let i = 0; i < gamepads.length; i++) {
        const pad = gamepads[i];
        if (!pad || pad.connected === false) continue;
        deviceAxes = pad.axes;
        deviceButtons = pad.buttons;
        samplePad(pad.index, deviceAxes.length, deviceAxis, deviceButtons.length, deviceButton);
      }
      // Hold no Gamepad snapshot past the poll.
      deviceAxes = NO_AXES;
      deviceButtons = NO_BUTTONS;
      syntheticPad = options.syntheticGamepad?.() ?? null;
      if (syntheticPad) {
        samplePad(syntheticPad.index, syntheticPad.axes.length, syntheticAxis, syntheticPad.buttons.length, syntheticButton);
        syntheticPad = null;
      }
      for (let index = 0; index < pads.length; index++) {
        const pad = pads[index];
        if (!pad || pad.seen === padGeneration) continue;
        pads[index] = undefined;
        // A pad the game never saw has nothing to disconnect.
        if (pad.announced) push({ kind: "gamepadDisconnect", tick, gamepadIndex: index });
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
      canvas.removeEventListener("blur", onCanvasBlur);
      window.removeEventListener("blur", onPageBlur);
      canvas.ownerDocument.removeEventListener("visibilitychange", onVisibilityChange);
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
      pads.length = 0;
    },
  };
  return handle;
}
