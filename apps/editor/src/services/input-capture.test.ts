import { afterEach, describe, expect, it } from "vitest";
import { InputRingBuffer } from "@babylonslate/input";
import { attachInputCapture } from "./input-capture";

class FakeCanvas {
  style: { touchAction: string } = { touchAction: "" };
  readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    const set = this.listeners.get(type) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  setPointerCapture(): void {}

  dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener.call(this, event);
    }
  }
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("attachInputCapture", () => {
  it("skips pointer and keyboard while free cam is on, but still forwards gamepads", () => {
    const canvas = new FakeCanvas();
    let steal = true;
    const handle = attachInputCapture(canvas as unknown as HTMLCanvasElement, {
      ring: new InputRingBuffer(32),
      skipPointerAndKeyboard: () => steal,
    });
    canvas.dispatch(
      "pointerdown",
      Object.assign(new Event("pointerdown"), {
        pointerId: 1,
        offsetX: 4,
        offsetY: 5,
        button: 0,
        preventDefault() {},
      }),
    );
    window.dispatchEvent(
      Object.assign(new KeyboardEvent("keydown", { code: "KeyW" }), {}),
    );
    expect(handle.ring.drain()).toEqual([]);
    steal = false;
    Object.assign(navigator, {
      getGamepads: () => [
        { index: 0, axes: [0.2, 0], buttons: [{ value: 0 }] },
      ],
    });
    handle.pollGamepads();
    const events = handle.ring.drain();
    expect(events.some((event) => event.kind === "gamepad")).toBe(true);
    handle.dispose();
  });
});

describe("attachInputCapture input mode", () => {
  it("keeps HUD touch axes and drops keys in Interface mode", () => {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const handle = attachInputCapture(canvas);
    handle.setInputMode("Interface");
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA" }));
    expect(handle.ring.drain()).toEqual([]);
    handle.pushTouchAxis("Jump", 1);
    expect(handle.ring.drain()).toEqual([
      expect.objectContaining({ kind: "touchAxis", controlId: "Jump", value: 1 }),
    ]);
    handle.dispose();
  });
});
