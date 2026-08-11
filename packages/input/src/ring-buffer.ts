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
      kind: "mouse";
      tick: number;
      phase: PointerPhase;
      x: number;
      y: number;
      button: number;
    }
  | {
      kind: "gamepad";
      tick: number;
      gamepadIndex: number;
      axes: number[];
      buttons: number[];
    };

const KIND = { pointer: 1, key: 2, mouse: 3, gamepad: 4 } as const;
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
  // Over-allocate then slice.
  const scratch = new ArrayBuffer(Math.max(64, events.length * 96));
  const view = new DataView(scratch);
  let o = 0;
  view.setUint32(o, events.length, true);
  o += 4;
  for (const event of events) {
    view.setUint8(o, KIND[event.kind]);
    o += 1;
    view.setUint32(o, event.tick >>> 0, true);
    o += 4;
    if (event.kind === "pointer" || event.kind === "mouse") {
      if (event.kind === "pointer") {
        view.setUint16(o, event.pointerId, true);
        o += 2;
      }
      view.setUint8(o, PHASE[event.phase]);
      o += 1;
      view.setFloat32(o, event.x, true);
      o += 4;
      view.setFloat32(o, event.y, true);
      o += 4;
      view.setUint8(o, event.button, true);
      o += 1;
    } else if (event.kind === "key") {
      view.setUint8(o, PHASE[event.phase]);
      o += 1;
      o += writeString(view, o, event.code);
    } else {
      view.setUint8(o, event.gamepadIndex, true);
      o += 1;
      view.setUint8(o, event.axes.length, true);
      o += 1;
      for (const axis of event.axes) {
        view.setFloat32(o, axis, true);
        o += 4;
      }
      view.setUint8(o, event.buttons.length, true);
      o += 1;
      for (const button of event.buttons) {
        view.setFloat32(o, button, true);
        o += 4;
      }
    }
  }
  return scratch.slice(0, o);
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
      const pointerId = view.getUint16(o, true);
      o += 2;
      const phase = PHASE_NAME[view.getUint8(o)] as PointerPhase;
      o += 1;
      const x = view.getFloat32(o, true);
      o += 4;
      const y = view.getFloat32(o, true);
      o += 4;
      const button = view.getUint8(o);
      o += 1;
      events.push({ kind: "pointer", tick, pointerId, phase, x, y, button });
    } else if (kindByte === KIND.mouse) {
      const phase = PHASE_NAME[view.getUint8(o)] as PointerPhase;
      o += 1;
      const x = view.getFloat32(o, true);
      o += 4;
      const y = view.getFloat32(o, true);
      o += 4;
      const button = view.getUint8(o);
      o += 1;
      events.push({ kind: "mouse", tick, phase, x, y, button });
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
    } else {
      throw new Error(`Unknown input event kind ${kindByte}`);
    }
  }
  return events;
}

/** Fixed-capacity ring; push drops the oldest event when full. */
export class InputRingBuffer {
  private readonly capacity: number;
  private readonly events: RawInputEvent[] = [];

  constructor(capacity = 256) {
    this.capacity = capacity;
  }

  push(event: RawInputEvent): void {
    if (this.events.length >= this.capacity) {
      this.events.shift();
    }
    this.events.push(event);
  }

  drain(): RawInputEvent[] {
    return this.events.splice(0, this.events.length);
  }

  peek(): readonly RawInputEvent[] {
    return this.events;
  }

  clear(): void {
    this.events.length = 0;
  }
}
