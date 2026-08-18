import { describe, expect, it } from "vitest";
import { InputRingBuffer } from "@babylonslate/input";
import { attachInputCapture, playInputStampTick } from "./input";

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

describe("playInputStampTick", () => {
  it("prefers the in-process clock when present", () => {
    expect(playInputStampTick(12, 3)).toBe(12);
  });

  it("uses the last worker tick when the in-process clock is missing", () => {
    expect(playInputStampTick(undefined, 7)).toBe(7);
  });
});

describe("attachInputCapture", () => {
  it("skips pointer and keyboard while free cam is on, but still forwards gamepads", () => {
    const canvas = new FakeCanvas();
    const windowListeners = new Map<string, Set<EventListener>>();
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener(type: string, listener: EventListener) {
          const set = windowListeners.get(type) ?? new Set();
          set.add(listener);
          windowListeners.set(type, set);
        },
        removeEventListener(type: string, listener: EventListener) {
          windowListeners.get(type)?.delete(listener);
        },
      },
    });
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
    for (const listener of windowListeners.get("keydown") ?? []) {
      listener(
        Object.assign(new Event("keydown"), { code: "KeyW" }) as Event,
      );
    }
    expect(handle.ring.drain()).toEqual([]);
    steal = false;
    Object.assign(globalThis.navigator ?? {}, {
      getGamepads: () => [
        { index: 0, axes: [0.2, 0], buttons: [{ value: 0 }] },
      ],
    });
    if (!("navigator" in globalThis) || !globalThis.navigator) {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
          getGamepads: () => [
            { index: 0, axes: [0.2, 0], buttons: [{ value: 0 }] },
          ],
        },
      });
    }
    handle.pollGamepads();
    const events = handle.ring.drain();
    expect(events.some((event) => event.kind === "gamepad")).toBe(true);
    handle.dispose();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  });
});
