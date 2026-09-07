import { afterEach, describe, expect, it } from "vitest";
import { InputRingBuffer } from "@babylonslate/input";
import { attachInputCapture } from "./input-capture";
import { attachInputCapture as attachPlayerInputCapture } from "../../../player/src/input";

class FakeCanvas {
  tabIndex = 0;
  readonly ownerDocument: { activeElement: FakeCanvas } = { activeElement: this };
  focus(): void {}
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

describe.each([
  ["Editor Play", attachInputCapture],
  ["Packaged Player", attachPlayerInputCapture],
] as const)("H21/M33 focus ownership: %s", (_name, attach) => {
  const handles: ReturnType<typeof attachInputCapture>[] = [];
  afterEach(() => { for (const handle of handles.splice(0)) handle.dispose(); });

  function fixture() {
    const canvas = document.createElement("canvas");
    canvas.setPointerCapture = () => {};
    const input = document.createElement("textarea");
    const button = document.createElement("button");
    document.body.append(canvas, input, button);
    const handle = attach(canvas);
    handles.push(handle);
    handle.setTick(7);
    return { canvas, input, button, handle };
  }
  function key(phase: "keydown" | "keyup", code: string) {
    return new KeyboardEvent(phase, { code, bubbles: true, cancelable: true });
  }

  it("focuses the canvas on start and forwards one tick-stamped key pair", () => {
    const { canvas, handle } = fixture();
    expect(document.activeElement).toBe(canvas);
    canvas.dispatchEvent(key("keydown", "Space"));
    canvas.dispatchEvent(key("keyup", "Space"));
    expect(handle.ring.drain()).toEqual([
      { kind: "key", tick: 7, code: "Space", phase: "down" },
      { kind: "key", tick: 7, code: "Space", phase: "up" },
    ]);
  });

  it("leaves textarea and button keys with the focused UI and returns ownership on canvas pointerdown", () => {
    const { canvas, input, button, handle } = fixture();
    for (const element of [input, button]) {
      element.focus();
      const event = key("keydown", "Space");
      element.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(handle.ring.drain()).toEqual([]);
    }
    canvas.dispatchEvent(Object.assign(new Event("pointerdown", { cancelable: true }), { pointerId: 1, offsetX: 0, offsetY: 0, button: 0 }));
    expect(document.activeElement).toBe(canvas);
    handle.ring.drain();
    const event = key("keydown", "Space");
    canvas.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(handle.ring.drain()).toEqual([{ kind: "key", tick: 7, code: "Space", phase: "down" }]);
  });

  it("releases a held game key once when focus moves or the window blurs", () => {
    const { canvas, input, handle } = fixture();
    canvas.tabIndex = 0;
    canvas.focus();
    canvas.dispatchEvent(key("keydown", "KeyW"));
    handle.ring.drain();
    input.focus();
    expect(handle.ring.drain()).toEqual([{ kind: "key", tick: 7, code: "KeyW", phase: "up" }]);
    input.dispatchEvent(key("keyup", "KeyW"));
    expect(handle.ring.drain()).toEqual([]);
    canvas.focus();
    canvas.dispatchEvent(key("keydown", "KeyW"));
    handle.ring.drain();
    window.dispatchEvent(new Event("blur"));
    expect(handle.ring.drain()).toEqual([{ kind: "key", tick: 7, code: "KeyW", phase: "up" }]);
    window.dispatchEvent(key("keyup", "KeyW"));
    expect(handle.ring.drain()).toEqual([]);
  });

  it("removes the old listeners when a session restarts", () => {
    const { canvas, handle } = fixture();
    handle.dispose();
    const next = attach(canvas);
    handles.push(next);
    canvas.dispatchEvent(key("keydown", "KeyF"));
    expect(handle.ring.drain()).toEqual([]);
    expect(next.ring.drain()).toEqual([{ kind: "key", tick: 0, code: "KeyF", phase: "down" }]);
  });
});
