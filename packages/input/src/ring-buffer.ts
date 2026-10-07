export type PointerPhase = "down" | "move" | "up" | "cancel";
export type KeyPhase = "down" | "up";

export type RawInputEvent =
  | {
      kind: "pointer";
      tick: number;
      pointerId: number;
      phase: PointerPhase;
      x: number;
      y: number;
      button: number;
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
    };

// Bytes 3 and 5 belonged to retired raw kinds; never reuse or renumber them.
const KIND = {
  pointer: 1,
  key: 2,
  gamepad: 4,
  touchAxis: 6,
  gamepadDisconnect: 7,
} as const;
const PHASE = { down: 1, move: 2, up: 3, cancel: 4 } as const;
const PHASE_NAME = ["", "down", "move", "up", "cancel"] as const;

function writeString(view: DataView, offset: number, value: string): number {
  const bytes = new TextEncoder().encode(value);
  view.setUint16(offset, bytes.length, true);
  new Uint8Array(view.buffer, view.byteOffset + offset + 2, bytes.length).set(
    bytes,
  );
  return 2 + bytes.length;
}

function readString(
  view: DataView,
  offset: number,
): { value: string; size: number } {
  const len = view.getUint16(offset, true);
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset + 2, len);
  return { value: new TextDecoder().decode(bytes), size: 2 + len };
}

/** Encode a batch of raw input events into a transferable ArrayBuffer. */
export function encodeInputEvents(events: readonly RawInputEvent[]): ArrayBuffer {
  // Samples may contain more controls than a standard gamepad, and identifiers
  // are UTF-8 strings. Size the actual wire payload rather than an event average.
  let size = 4;
  const encoder = new TextEncoder();
  for (const event of events) {
    size += 5;
    switch (event.kind) {
      case "pointer": size += 14; break;
      case "key": size += 3 + encoder.encode(event.code).length; break;
      case "gamepad": size += 3 + 4 * (event.axes.length + event.buttons.length); break;
      case "touchAxis": size += 6 + encoder.encode(event.controlId).length; break;
      case "gamepadDisconnect": size += 1; break;
    }
  }
  const scratch = new ArrayBuffer(size);
  const view = new DataView(scratch);
  let o = 0;
  view.setUint32(o, events.length, true);
  o += 4;
  for (const event of events) {
    view.setUint8(o, KIND[event.kind]);
    o += 1;
    view.setUint32(o, event.tick >>> 0, true);
    o += 4;
    if (event.kind === "pointer") {
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
    } else if (event.kind === "key") {
      view.setUint8(o, PHASE[event.phase]);
      o += 1;
      o += writeString(view, o, event.code);
    } else if (event.kind === "gamepad") {
      view.setUint8(o, event.gamepadIndex);
      o += 1;
      view.setUint8(o, event.axes.length);
      o += 1;
      for (const axis of event.axes) {
        view.setFloat32(o, axis, true);
        o += 4;
      }
      view.setUint8(o, event.buttons.length);
      o += 1;
      for (const button of event.buttons) {
        view.setFloat32(o, button, true);
        o += 4;
      }
    } else if (event.kind === "touchAxis") {
      o += writeString(view, o, event.controlId);
      view.setFloat32(o, event.value, true);
      o += 4;
    } else {
      view.setUint8(o, event.gamepadIndex);
      o += 1;
    }
  }
  return scratch;
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
      events.push({ kind: "pointer", tick, pointerId, phase, x, y, button });
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
    default: return true;
  }
}

/** Events for one control share a key; a later event for it may supersede an earlier sample. */
function controlKey(event: RawInputEvent): string | undefined {
  switch (event.kind) {
    case "pointer": return `p${event.pointerId}`;
    case "gamepad": case "gamepadDisconnect": return `g${event.gamepadIndex}`;
    case "touchAxis": return `t${event.controlId}`;
    default: return undefined;
  }
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
  if (sample.kind !== "gamepad" || next.kind !== "gamepad") return false;
  const levels = (event: typeof sample) => [...event.axes, ...event.buttons].map(level).join();
  return sample.axes.length === next.axes.length && levels(sample) === levels(next);
}

/**
 * Bounded input queue that never strands a held control. At `capacity`, push
 * first coalesces the oldest continuous sample (pointer move, gamepad or
 * touch-axis sample) that the next event for the same control supersedes
 * without changing a threshold edge. A queue of edges may grow to four times
 * `capacity`; beyond that the oldest press or sample is dropped, so a release
 * can arrive without its press but is never lost itself.
 */
export class InputRingBuffer {
  private readonly capacity: number;
  private readonly events: RawInputEvent[] = [];

  constructor(capacity = 256) {
    this.capacity = capacity;
  }

  push(event: RawInputEvent): void {
    if (this.events.length >= this.capacity) {
      let victim = this.supersededIndex(event);
      if (victim < 0 && this.events.length >= this.capacity * 4) {
        victim = this.events.findIndex(queued => !isInputReleaseEvent(queued));
        if (victim < 0 && !isInputReleaseEvent(event)) return;
        victim = Math.max(victim, 0);
      }
      if (victim >= 0) this.events.splice(victim, 1);
    }
    this.events.push(event);
  }

  drain(): RawInputEvent[] {
    return this.events.splice(0, this.events.length);
  }

  /** Oldest queued sample made redundant by the next event for its control, or -1. */
  private supersededIndex(incoming: RawInputEvent): number {
    const next = new Map<string, RawInputEvent>();
    const incomingKey = controlKey(incoming);
    if (incomingKey) next.set(incomingKey, incoming);
    let victim = -1;
    for (let index = this.events.length - 1; index >= 0; index--) {
      const event = this.events[index]!;
      const key = controlKey(event);
      if (!key) continue;
      const later = next.get(key);
      if (later && supersededBy(event, later)) victim = index;
      next.set(key, event);
    }
    return victim;
  }
}
