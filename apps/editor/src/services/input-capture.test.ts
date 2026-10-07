import { afterEach, describe, expect, it } from "vitest";
import { InputResolver, InputRingBuffer } from "@babylonslate/input";
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
  const handles: Array<{ dispose(): void }> = [];
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

  it("preserves native text focus claimed by a SceneLayer pointer handler", () => {
    const canvas = document.createElement("canvas");
    canvas.setPointerCapture = () => {};
    const input = document.createElement("input");
    document.body.append(canvas, input);
    canvas.addEventListener("pointerdown", event => {
      event.preventDefault();
      input.focus();
    });
    const handle = attach(canvas);
    handles.push(handle);
    canvas.dispatchEvent(Object.assign(new Event("pointerdown", { cancelable: true }), { pointerId: 1, offsetX: 0, offsetY: 0, button: 0 }));
    expect(document.activeElement).toBe(input);
    expect(handle.ring.drain()).toEqual([{ kind: "pointer", tick: 0, pointerId: 1, phase: "down", x: 0, y: 0, button: 0 }]);
    input.dispatchEvent(key("keydown", "KeyA"));
    expect(handle.ring.drain()).toEqual([]);
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

  it("reports each pad that stops being returned as disconnected once", () => {
    const { handle } = fixture();
    const second = { index: 1, axes: [0.25], buttons: [{ value: 0 }] };
    let pads: unknown[] = [
      { index: 0, axes: [0.5], buttons: [{ value: 1 }] },
      second,
    ];
    Object.assign(navigator, { getGamepads: () => pads });
    handle.pollGamepads();
    handle.ring.drain();
    pads = [null, second];
    handle.pollGamepads();
    expect(handle.ring.drain()).toEqual([
      { kind: "gamepad", tick: 7, gamepadIndex: 1, axes: [0.25], buttons: [0] },
      { kind: "gamepadDisconnect", tick: 7, gamepadIndex: 0 },
    ]);
    pads = [null, { ...second, connected: false }];
    handle.pollGamepads();
    expect(handle.ring.drain()).toEqual([
      { kind: "gamepadDisconnect", tick: 7, gamepadIndex: 1 },
    ]);
    handle.pollGamepads();
    expect(handle.ring.drain()).toEqual([]);
  });

  it("reports chorded mouse buttons that change during one pointer contact", () => {
    const { canvas, handle } = fixture();
    const resolver = new InputResolver({ actions: [
      { name: "Fire", bindings: [{ device: "mouseButton", code: "0" }] },
      { name: "Aim", bindings: [{ device: "mouseButton", code: "2" }] },
    ], axes: [] });
    const mouse = (type: string, button: number, buttons: number) => canvas.dispatchEvent(Object.assign(
      new Event(type, { cancelable: true }), { pointerId: 1, offsetX: 3, offsetY: 4, button, buttons, pointerType: "mouse" }));
    mouse("pointerdown", 0, 1);
    expect(resolver.resolve(handle.ring.drain()).actions.Fire.held).toBe(true);
    mouse("pointermove", 2, 3);
    const aiming = resolver.resolve(handle.ring.drain());
    expect(aiming.actions.Aim).toMatchObject({ pressed: true, held: true });
    expect(aiming.actions.Fire.held).toBe(true);
    mouse("pointermove", 0, 2);
    const fireUp = resolver.resolve(handle.ring.drain());
    expect(fireUp.actions.Fire).toMatchObject({ released: true, held: false });
    expect(fireUp.actions.Aim.held).toBe(true);
    expect(fireUp.cursor.pressed).toBe(false);
    mouse("pointerup", 2, 0);
    const done = resolver.resolve(handle.ring.drain());
    expect(done.actions.Aim).toMatchObject({ released: true, held: false });
    expect(done.actions.Fire.held).toBe(false);
    expect(done.cursor.pressed).toBe(false);
  });

  it("releases chorded buttons when pointerup names a different button", () => {
    const { canvas, handle } = fixture();
    const resolver = new InputResolver({ actions: [
      { name: "Fire", bindings: [{ device: "mouseButton", code: "0" }] },
      { name: "Aim", bindings: [{ device: "mouseButton", code: "2" }] },
    ], axes: [] });
    const mouse = (type: string, button: number, buttons: number) => canvas.dispatchEvent(Object.assign(
      new Event(type, { cancelable: true }), { pointerId: 1, offsetX: 3, offsetY: 4, button, buttons, pointerType: "mouse" }));
    mouse("pointerdown", 0, 1);
    mouse("pointermove", 2, 3);
    mouse("pointerup", 0, 0);
    const done = resolver.resolve(handle.ring.drain());
    expect(done.actions.Fire.held).toBe(false);
    expect(done.actions.Aim).toMatchObject({ pressed: true, held: false });
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

describe("exclusive game input ownership", () => {
  const handles: ReturnType<typeof attachInputCapture>[] = [];
  const originalGamepads = navigator.getGamepads;
  afterEach(() => {
    for (const handle of handles.splice(0)) handle.dispose();
    Object.assign(navigator, { getGamepads: originalGamepads });
  });

  function fixture() {
    const canvas = document.createElement("canvas");
    const captured = new Set<number>();
    canvas.setPointerCapture = id => { captured.add(id); };
    canvas.releasePointerCapture = id => { captured.delete(id); };
    document.body.append(canvas);
    const handle = attachInputCapture(canvas);
    handles.push(handle);
    handle.setSuppressed(false);
    const pad = { index: 0, axes: [0], buttons: [{ value: 0 }] };
    Object.assign(navigator, { getGamepads: () => [pad] });
    const resolver = new InputResolver({
      actions: [
        { name: "Keyboard", bindings: [{ device: "key", code: "KeyW" }] },
        { name: "Pointer", bindings: [{ device: "mouseButton", code: "0" }] },
        { name: "Pad", bindings: [{ device: "gamepadButton", code: "0:0" }] },
      ],
      axes: [
        { name: "Stick", bindings: [{ device: "gamepadAxis", code: "0:0" }] },
        { name: "Touch", bindings: [{ device: "touch", code: "move" }] },
      ],
    });
    const read = () => resolver.resolve(handle.ring.drain());
    const key = (phase: "keydown" | "keyup", repeat = false) =>
      canvas.dispatchEvent(new KeyboardEvent(phase, { code: "KeyW", repeat, bubbles: true }));
    const pointer = (phase: string, id = 1) => canvas.dispatchEvent(Object.assign(
      new Event(phase, { bubbles: true, cancelable: true }),
      { pointerId: id, offsetX: 10, offsetY: 20, button: 0, pointerType: "touch" },
    ));
    const hold = () => {
      key("keydown");
      pointer("pointerdown");
      pad.axes[0] = 0.75;
      pad.buttons[0]!.value = 1;
      handle.pollGamepads();
      handle.setTouchAxis("move", 1);
    };
    return { canvas, captured, handle, pad, read, key, pointer, hold };
  }

  function expectNeutral(state: ReturnType<InputResolver["resolve"]>) {
    expect(state.actions.Keyboard.held).toBe(false);
    expect(state.actions.Pointer.held).toBe(false);
    expect(state.actions.Pad.held).toBe(false);
    expect(state.axes).toEqual({ Stick: 0, Touch: 0 });
    expect(state.cursor.pressed).toBe(false);
  }

  it("neutralizes every device and releases pointer capture across overlapping pause and blur notifications", () => {
    const { canvas, captured, handle, read, hold } = fixture();
    hold();
    const active = read();
    expect(active.actions.Keyboard.held).toBe(true);
    expect(active.actions.Pointer.held).toBe(true);
    expect(active.actions.Pad.held).toBe(true);
    expect(active.axes).toEqual({ Stick: 0.75, Touch: 1 });
    expect(captured.has(1)).toBe(true);
    handle.setSuppressed(true);
    canvas.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("blur"));
    expectNeutral(read());
    expect(captured.size).toBe(0);
  });

  it("requires release and a fresh press for held keys, touch gestures, virtual sticks and gamepad controls", () => {
    const { handle, pad, key, pointer, read, hold } = fixture();
    hold();
    read();
    handle.setSuppressed(true);
    expectNeutral(read());
    pointer("pointerdown", 2);
    handle.setSuppressed(false);
    key("keydown", true);
    pointer("pointermove");
    pointer("pointermove", 2);
    handle.setTouchAxis("move", 1);
    handle.pollGamepads();
    const held = read();
    expectNeutral(held);
    expect(held.pressedKeys).toEqual([]);
    key("keyup");
    pointer("pointerup");
    pointer("pointerup", 2);
    handle.setTouchAxis("move", 0);
    pad.axes[0] = 0;
    pad.buttons[0]!.value = 0;
    handle.pollGamepads();
    expectNeutral(read());
    hold();
    const fresh = read();
    expect(fresh.actions.Keyboard.pressed).toBe(true);
    expect(fresh.actions.Pointer.pressed).toBe(true);
    expect(fresh.actions.Pad.pressed).toBe(true);
    expect(fresh.axes).toEqual({ Stick: 0.75, Touch: 1 });
  });

  it("drops queued presses at the boundary and allows a new canvas gesture after focus returns", () => {
    const { canvas, handle, read, hold, pointer } = fixture();
    hold();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    const state = read();
    expectNeutral(state);
    expect(state.pressedKeys).toEqual([]);
    handle.pollGamepads();
    expectNeutral(read());
    pointer("pointerup");
    pointer("pointerdown", 2);
    expect(document.activeElement).toBe(canvas);
    expect(read().actions.Pointer.pressed).toBe(true);
  });

  it("neutralizes a held pad on its first explicit ownership boundary", () => {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const handle = attachInputCapture(canvas);
    handles.push(handle);
    Object.assign(navigator, { getGamepads: () => [{ index: 0, axes: [0.8], buttons: [{ value: 1 }] }] });
    const resolver = new InputResolver({ actions: [{ name: "Fire", bindings: [{ device: "gamepadButton", code: "0:0" }] }], axes: [] });
    handle.pollGamepads();
    expect(resolver.resolve(handle.ring.drain()).actions.Fire.held).toBe(true);
    handle.neutralize();
    expect(resolver.resolve(handle.ring.drain()).actions.Fire.held).toBe(false);
    handle.pollGamepads();
    expect(resolver.resolve(handle.ring.drain()).actions.Fire.held).toBe(false);
  });

  it("cancels lost pointer capture and blocks continuation until that contact ends", () => {
    const { handle, pointer, read } = fixture();
    pointer("pointerdown");
    expect(read().actions.Pointer.held).toBe(true);
    pointer("lostpointercapture");
    expectNeutral(read());
    pointer("pointermove");
    expect(handle.ring.drain()).toEqual([]);
    window.dispatchEvent(Object.assign(new Event("pointerup"), { pointerId: 1 }));
    pointer("pointerdown");
    expect(read().actions.Pointer.pressed).toBe(true);
  });

  it("releases pointer lock and leaves disposed capture inert", () => {
    const { canvas, captured, handle, hold, read, key, pointer } = fixture();
    let locked: Element | null = canvas;
    const originalLock = Object.getOwnPropertyDescriptor(document, "pointerLockElement");
    const originalExit = document.exitPointerLock;
    Object.defineProperty(document, "pointerLockElement", { configurable: true, get: () => locked });
    document.exitPointerLock = () => { locked = null; };
    try {
      hold();
      read();
      handle.dispose();
      expectNeutral(read());
      expect(locked).toBeNull();
      expect(captured.size).toBe(0);
      key("keydown");
      pointer("pointerdown");
      handle.pollGamepads();
      handle.setTouchAxis("move", 1);
      handle.setSuppressed(false);
      handle.dispose();
      expect(handle.ring.drain()).toEqual([]);
    } finally {
      if (originalLock) Object.defineProperty(document, "pointerLockElement", originalLock);
      else Reflect.deleteProperty(document, "pointerLockElement");
      document.exitPointerLock = originalExit;
    }
  });
});
