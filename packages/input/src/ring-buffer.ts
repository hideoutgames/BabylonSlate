export type PointerPhase = "down" | "move" | "up" | "cancel";
export type KeyPhase = "down" | "up";
/** `PointerEvent.pointerType` for the devices the game distinguishes. */
export type PointerKind = "mouse" | "touch" | "pen";

export type RawInputEvent =
  | {
      kind: "pointer";
      tick: number;
      pointerId: number;
      phase: PointerPhase;
      x: number;
      y: number;
      button: number;
      /** Absent reads as a mouse. */
      pointerType?: PointerKind;
      /** `PointerEvent.pressure`, 0 to 1; absent reads as 0.5 while pressed. */
      pressure?: number;
    }
  | {
      kind: "key";
      tick: number;
      code: string;
      phase: KeyPhase;
    }
  | {
      kind: "gamepad";
      tick: number;
      gamepadIndex: number;
      axes: number[];
      buttons: number[];
    }
  | {
      /** Touch control (joystick / button) contributing a normalised axis. */
      kind: "touchAxis";
      tick: number;
      controlId: string;
      value: number;
    }
  | {
      /** A pad sampled on the previous poll is no longer reported. */
      kind: "gamepadDisconnect";
      tick: number;
      gamepadIndex: number;
    }
  | {
      /**
       * The device's motion, sampled once per frame while motion input is on.
       * NaN `beta` and `gamma` mean no reading (released at an ownership boundary).
       */
      kind: "motion";
      tick: number;
      /** `DeviceOrientationEvent` front-to-back and left-to-right tilt, in degrees. */
      beta: number;
      gamma: number;
      /** `screen.orientation.angle`, in degrees. */
      screenAngle: number;
      /** Device acceleration without gravity, in m/s² along the device's x, y and z. */
      accelerationX: number;
      accelerationY: number;
      accelerationZ: number;
      /** The largest acceleration magnitude since the previous sample, for shakes. */
      peakAcceleration: number;
      /** Degrees per second around the device's x, y and z (`rotationRate` beta, gamma, alpha). */
      rotationX: number;
      rotationY: number;
      rotationZ: number;
    };

// Bytes 3 and 5 belonged to retired raw kinds; never reuse or renumber them.
const KIND = {
  pointer: 1,
  key: 2,
  gamepad: 4,
  touchAxis: 6,
  gamepadDisconnect: 7,
  motion: 8,
} as const;
const PHASE = { down: 1, move: 2, up: 3, cancel: 4 } as const;
const PHASE_NAME = ["", "down", "move", "up", "cancel"] as const;
// Byte 0 means the pointer type was not given.
const POINTER_KIND = { mouse: 1, touch: 2, pen: 3 } as const;
const POINTER_KIND_NAME = [undefined, "mouse", "touch", "pen"] as const;

/** Motion sample fields in wire order, each a float32. */
const MOTION_FIELDS = [
  "beta", "gamma", "screenAngle", "accelerationX", "accelerationY", "accelerationZ",
  "peakAcceleration", "rotationX", "rotationY", "rotationZ",
] as const satisfies readonly (keyof Extract<RawInputEvent, { kind: "motion" }>)[];

// Whole-buffer, non-streaming use only: neither keeps state between calls.
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Module-level reusable encode buffer for single-pass input event serialization (grown on demand). */
let encodeScratch = new Uint8Array(1024);
let encodeScratchView = new DataView(encodeScratch.buffer);

function ensureEncodeScratch(needed: number): void {
  if (needed <= encodeScratch.byteLength) return;
  let next = encodeScratch.byteLength;
  while (next < needed) next *= 2;
  const grown = new Uint8Array(next);
  grown.set(encodeScratch);
  encodeScratch = grown;
  encodeScratchView = new DataView(encodeScratch.buffer);
}

function writeStringSinglePass(offset: number, value: string): number {
  // Worst-case UTF-8 expansion is 3 bytes per UTF-16 code unit, plus 2-byte u16 length prefix.
  const maxBytes = value.length * 3;
  ensureEncodeScratch(offset + 2 + maxBytes);
  const { written } = textEncoder.encodeInto(value, encodeScratch.subarray(offset + 2));
  encodeScratchView.setUint16(offset, written, true);
  return 2 + written;
}

function readString(
  view: DataView,
  offset: number,
): { value: string; size: number } {
  const len = view.getUint16(offset, true);
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset + 2, len);
  return { value: textDecoder.decode(bytes), size: 2 + len };
}

/** Encode a batch of raw input events into a transferable ArrayBuffer in a single pass. */
export function encodeInputEvents(events: readonly RawInputEvent[]): ArrayBuffer {
  ensureEncodeScratch(4);
  let o = 0;
  encodeScratchView.setUint32(o, events.length, true);
  o += 4;
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    ensureEncodeScratch(o + 5);
    encodeScratchView.setUint8(o, KIND[event.kind]);
    o += 1;
    encodeScratchView.setUint32(o, event.tick >>> 0, true);
    o += 4;
    if (event.kind === "pointer") {
      ensureEncodeScratch(o + 19);
      const view = encodeScratchView;
      // `PointerEvent.pointerId` is a signed 32-bit long; pen and touch ids exceed 16 bits.
      view.setInt32(o, event.pointerId, true);
      o += 4;
      view.setUint8(o, PHASE[event.phase]);
      o += 1;
      view.setFloat32(o, event.x, true);
      o += 4;
      view.setFloat32(o, event.y, true);
      o += 4;
      // Signed so a hover move's button -1 survives the transfer.
      view.setInt8(o, event.button);
      o += 1;
      view.setUint8(o, event.pointerType ? POINTER_KIND[event.pointerType] : 0);
      o += 1;
      // NaN marks a missing pressure; a real one is finite.
      view.setFloat32(o, event.pressure ?? Number.NaN, true);
      o += 4;
    } else if (event.kind === "key") {
      ensureEncodeScratch(o + 1);
      encodeScratchView.setUint8(o, PHASE[event.phase]);
      o += 1;
      o += writeStringSinglePass(o, event.code);
    } else if (event.kind === "gamepad") {
      ensureEncodeScratch(o + 3 + 4 * (event.axes.length + event.buttons.length));
      const view = encodeScratchView;
      view.setUint8(o, event.gamepadIndex);
      o += 1;
      view.setUint8(o, event.axes.length);
      o += 1;
      for (let a = 0; a < event.axes.length; a++) {
        view.setFloat32(o, event.axes[a]!, true);
        o += 4;
      }
      view.setUint8(o, event.buttons.length);
      o += 1;
      for (let b = 0; b < event.buttons.length; b++) {
        view.setFloat32(o, event.buttons[b]!, true);
        o += 4;
      }
    } else if (event.kind === "touchAxis") {
      o += writeStringSinglePass(o, event.controlId);
      ensureEncodeScratch(o + 4);
      encodeScratchView.setFloat32(o, event.value, true);
      o += 4;
    } else if (event.kind === "motion") {
      ensureEncodeScratch(o + 4 * MOTION_FIELDS.length);
      const view = encodeScratchView;
      for (let m = 0; m < MOTION_FIELDS.length; m++) {
        view.setFloat32(o, event[MOTION_FIELDS[m]!], true);
        o += 4;
      }
    } else {
      ensureEncodeScratch(o + 1);
      encodeScratchView.setUint8(o, event.gamepadIndex);
      o += 1;
    }
  }
  return encodeScratch.buffer.slice(0, o);
}

export function decodeInputEvents(
  buffer: ArrayBuffer | ArrayBufferView,
): RawInputEvent[] {
  const view =
    buffer instanceof ArrayBuffer
      ? new DataView(buffer)
      : new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let o = 0;
  const count = view.getUint32(o, true);
  o += 4;
  const events: RawInputEvent[] = [];
  for (let i = 0; i < count; i++) {
    const kindByte = view.getUint8(o);
    o += 1;
    const tick = view.getUint32(o, true);
    o += 4;
    if (kindByte === KIND.pointer) {
      const pointerId = view.getInt32(o, true);
      o += 4;
      const phase = PHASE_NAME[view.getUint8(o)] as PointerPhase;
      o += 1;
      const x = view.getFloat32(o, true);
      o += 4;
      const y = view.getFloat32(o, true);
      o += 4;
      const button = view.getInt8(o);
      o += 1;
      const pointerType = POINTER_KIND_NAME[view.getUint8(o)];
      o += 1;
      const pressure = view.getFloat32(o, true);
      o += 4;
      events.push({
        kind: "pointer", tick, pointerId, phase, x, y, button,
        ...(pointerType ? { pointerType } : {}),
        ...(Number.isNaN(pressure) ? {} : { pressure }),
      });
    } else if (kindByte === KIND.key) {
      const phase = PHASE_NAME[view.getUint8(o)] as KeyPhase;
      o += 1;
      const code = readString(view, o);
      o += code.size;
      events.push({ kind: "key", tick, code: code.value, phase });
    } else if (kindByte === KIND.gamepad) {
      const gamepadIndex = view.getUint8(o);
      o += 1;
      const axisCount = view.getUint8(o);
      o += 1;
      const axes: number[] = [];
      for (let a = 0; a < axisCount; a++) {
        axes.push(view.getFloat32(o, true));
        o += 4;
      }
      const buttonCount = view.getUint8(o);
      o += 1;
      const buttons: number[] = [];
      for (let b = 0; b < buttonCount; b++) {
        buttons.push(view.getFloat32(o, true));
        o += 4;
      }
      events.push({ kind: "gamepad", tick, gamepadIndex, axes, buttons });
    } else if (kindByte === KIND.touchAxis) {
      const controlId = readString(view, o);
      o += controlId.size;
      const value = view.getFloat32(o, true);
      o += 4;
      events.push({
        kind: "touchAxis",
        tick,
        controlId: controlId.value,
        value,
      });
    } else if (kindByte === KIND.motion) {
      const motion: Extract<RawInputEvent, { kind: "motion" }> = {
        kind: "motion", tick, beta: 0, gamma: 0, screenAngle: 0, accelerationX: 0, accelerationY: 0, accelerationZ: 0,
        peakAcceleration: 0, rotationX: 0, rotationY: 0, rotationZ: 0,
      };
      for (const field of MOTION_FIELDS) {
        motion[field] = view.getFloat32(o, true);
        o += 4;
      }
      events.push(motion);
    } else if (kindByte === KIND.gamepadDisconnect) {
      const gamepadIndex = view.getUint8(o);
      o += 1;
      events.push({ kind: "gamepadDisconnect", tick, gamepadIndex });
    } else {
      throw new Error(`Unknown input event kind ${kindByte}`);
    }
  }
  return events;
}

/** True for events that end a press or deflection; overflow and ownership boundaries keep them. */
export function isInputReleaseEvent(event: RawInputEvent): boolean {
  switch (event.kind) {
    case "key": return event.phase === "up";
    case "pointer": return event.phase === "up" || event.phase === "cancel";
    case "touchAxis": return event.value === 0;
    case "gamepad": return event.axes.every(value => value === 0) && event.buttons.every(value => value === 0);
    // A reading of the device's pose, not a press; the next sample replaces it.
    case "motion": return false;
    default: return true;
  }
}

/** Events for one control share a key; a later event for it may supersede an earlier sample. */
function controlKey(event: RawInputEvent): string | undefined {
  switch (event.kind) {
    case "pointer": return `p${event.pointerId}`;
    case "gamepad": case "gamepadDisconnect": return `g${event.gamepadIndex}`;
    case "touchAxis": return `t${event.controlId}`;
    case "motion": return "m";
    default: return undefined;
  }
}

/** A whole control's state (a pad, a touch axis), which its writer sends only when it changes: the newest one must arrive. */
function isStateSample(event: RawInputEvent): boolean {
  return event.kind === "gamepad" || event.kind === "touchAxis";
}

/** Resolver thresholds: zero (input started/released) and 0.5 (actions and pressed keys). */
function level(value: number): number {
  const magnitude = Math.abs(value);
  return magnitude > 0.5 ? 2 : magnitude > 0 ? 1 : 0;
}

/** Whether dropping `sample` keeps every resolver edge because `next` follows it. */
function supersededBy(sample: RawInputEvent, next: RawInputEvent): boolean {
  if (sample.kind === "pointer") return sample.phase === "move";
  if (sample.kind === "touchAxis" && next.kind === "touchAxis") return level(sample.value) === level(next.value);
  if (sample.kind === "motion") return next.kind === "motion";
  if (sample.kind !== "gamepad" || next.kind !== "gamepad") return false;
  return sameLevels(sample.axes, next.axes) && sameLevels(sample.buttons, next.buttons);
}

/** Same control count and every control at the same `level`; compared in place, since a saturated push runs it per queued pair. */
function sameLevels(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (level(a[i]!) !== level(b[i]!)) return false;
  return true;
}

/** What a release lets go of; a later release with the same key repeats it. Disconnects never repeat. */
function releasedControl(event: RawInputEvent): string | undefined {
  switch (event.kind) {
    case "key": return `k${event.code}`;
    case "pointer": return `p${event.pointerId}:${event.phase}:${event.button}`;
    case "gamepadDisconnect": return undefined;
    default: return controlKey(event);
  }
}

/**
 * Bounded input queue that never strands a held control. At `capacity`, push
 * first coalesces the oldest continuous sample (pointer move, gamepad or
 * touch-axis sample) that the next event for the same control supersedes
 * without changing a threshold edge. A queue of edges may grow to four times
 * `capacity`; beyond that the oldest press or sample is dropped, so a release
 * can arrive without its press but is never lost itself. A control's newest
 * state sample (pad, touch axis) is never dropped either: writers send state
 * only when it changes, so a lost newest sample would leave a stick deflected
 * or a button held. An incoming state sample replaces an older one of its
 * control instead. A queue holding only releases and newest state drops only
 * a release that a later release of the same control repeats, so it grows at
 * most by one release and one state sample per control.
 */
export class InputRingBuffer {
  private readonly capacity: number;
  private readonly events: RawInputEvent[] = [];
  /** `controlKey` of each queued event, kept aligned with `events` so a saturated push builds no strings per queued event. */
  private readonly keys: (string | undefined)[] = [];
  private readonly nextScratch = new Map<string, RawInputEvent>();

  constructor(capacity = 256) {
    this.capacity = capacity;
  }

  push(event: RawInputEvent): void {
    const key = controlKey(event);
    if (this.events.length >= this.capacity) {
      let victim = this.supersededIndex(event, key);
      if (victim < 0 && this.events.length >= this.capacity * 4) {
        victim = this.droppablePressIndex(event, key);
        if (victim < 0) {
          // A state sample is the control's latest state: it takes an older sample's place, or joins the queue.
          if (isStateSample(event)) victim = this.olderSampleIndex(event, key!);
          else if (!isInputReleaseEvent(event)) return;
          else victim = this.repeatedReleaseIndex(event);
        }
      }
      if (victim >= 0) {
        this.events.splice(victim, 1);
        this.keys.splice(victim, 1);
      }
    }
    this.events.push(event);
    this.keys.push(key);
  }

  drain(): RawInputEvent[] {
    this.keys.length = 0;
    return this.events.splice(0, this.events.length);
  }

  /**
   * Oldest queued press or sample that may go, or -1: never a release, and
   * never a control's newest state sample (no later event for its control is
   * queued or incoming), since writers send pad and touch-axis state only
   * when it changes and would not send it again.
   */
  private droppablePressIndex(incoming: RawInputEvent, incomingKey: string | undefined): number {
    const later = this.nextScratch;
    later.clear();
    if (incomingKey) later.set(incomingKey, incoming);
    let victim = -1;
    for (let index = this.events.length - 1; index >= 0; index--) {
      const event = this.events[index]!;
      const key = this.keys[index];
      const newestState = isStateSample(event) && !later.has(key!);
      if (key) later.set(key, event);
      if (!newestState && !isInputReleaseEvent(event)) victim = index;
    }
    return victim;
  }

  /** Oldest queued sample of the same kind for the incoming state sample's control, or -1. */
  private olderSampleIndex(incoming: RawInputEvent, key: string): number {
    for (let index = 0; index < this.events.length; index++) {
      if (this.keys[index] === key && this.events[index]!.kind === incoming.kind) return index;
    }
    return -1;
  }

  /** Oldest queued release whose control is released again later, or -1. */
  private repeatedReleaseIndex(incoming: RawInputEvent): number {
    const later = new Set<string>();
    const incomingControl = releasedControl(incoming);
    if (incomingControl) later.add(incomingControl);
    let victim = -1;
    for (let index = this.events.length - 1; index >= 0; index--) {
      const control = releasedControl(this.events[index]!);
      if (!control) continue;
      if (later.has(control)) victim = index;
      later.add(control);
    }
    return victim;
  }

  /** Oldest queued sample made redundant by the next event for its control, or -1. */
  private supersededIndex(incoming: RawInputEvent, incomingKey: string | undefined): number {
    const next = this.nextScratch;
    next.clear();
    if (incomingKey) next.set(incomingKey, incoming);
    let victim = -1;
    for (let index = this.events.length - 1; index >= 0; index--) {
      const key = this.keys[index];
      if (!key) continue;
      const event = this.events[index]!;
      const later = next.get(key);
      if (later && supersededBy(event, later)) victim = index;
      next.set(key, event);
    }
    return victim;
  }
}
