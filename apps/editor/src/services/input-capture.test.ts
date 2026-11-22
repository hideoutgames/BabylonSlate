import { afterEach, describe, expect, it, vi } from "vitest";
import { InputResolver, InputRingBuffer } from "@haptic/input";
import { attachInputCapture } from "./input-capture";
import { attachInputCapture as attachPlayerInputCapture } from "@haptic/input/dom";

class FakeCanvas {
  tabIndex = 0;
  readonly ownerDocument = { activeElement: this as FakeCanvas, visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
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
    const handle = attachInputCapture(canvas as unknown as HTMLCanvasElement, {
      ring: new InputRingBuffer(32),
      skipPointerAndKeyboard: () => true,
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
    expect(handle.ring.drain()).toEqual([{ kind: "pointer", tick: 0, pointerId: 1, phase: "down", x: 0, y: 0, button: 0, pointerType: "mouse" }]);
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
    // The pad still connected has not changed, so it sends nothing.
    expect(handle.ring.drain()).toEqual([
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

  it("releases a key whose keyup Cmd swallowed exactly once, when Cmd lifts", () => {
    const { canvas, handle } = fixture();
    canvas.dispatchEvent(key("keydown", "KeyW"));
    canvas.dispatchEvent(new KeyboardEvent("keydown", { code: "MetaLeft", key: "Meta", metaKey: true, bubbles: true }));
    // macOS delivers no keyup for W while Cmd is held.
    canvas.dispatchEvent(new KeyboardEvent("keyup", { code: "MetaLeft", key: "Meta", bubbles: true }));
    canvas.dispatchEvent(key("keyup", "KeyW"));
    expect(handle.ring.drain()).toEqual([
      { kind: "key", tick: 7, code: "KeyW", phase: "down" },
      { kind: "key", tick: 7, code: "MetaLeft", phase: "down" },
      { kind: "key", tick: 7, code: "KeyW", phase: "up" },
      { kind: "key", tick: 7, code: "MetaLeft", phase: "up" },
    ]);
    canvas.dispatchEvent(key("keydown", "KeyW"));
    expect(handle.ring.drain()).toEqual([{ kind: "key", tick: 7, code: "KeyW", phase: "down" }]);
  });

  it("lets go of every device once when the page is hidden, and takes input again in shared routing", () => {
    const { canvas, handle } = fixture();
    const pad = { index: 0, axes: [0.75], buttons: [{ value: 1 }] };
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
    const pointer = (type: string, pointerId: number) => canvas.dispatchEvent(Object.assign(
      new Event(type, { cancelable: true }), { pointerId, offsetX: 1, offsetY: 2, button: 0, pointerType: "touch" }));
    canvas.dispatchEvent(key("keydown", "KeyW"));
    pointer("pointerdown", 1);
    handle.setTouchAxis("move", 1);
    handle.pollGamepads();
    const held = resolver.resolve(handle.ring.drain());
    expect([held.actions.Keyboard.held, held.actions.Pointer.held, held.actions.Pad.held]).toEqual([true, true, true]);
    expect(held.axes).toEqual({ Stick: 0.75, Touch: 1 });

    let visibility: DocumentVisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
      const released = handle.ring.drain();
      expect(released.map(event => `${event.kind}:${"phase" in event ? event.phase : ""}`)).toEqual([
        "key:up", "pointer:cancel", "touchAxis:", "gamepad:",
      ]);
      const state = resolver.resolve(released);
      expect([state.actions.Keyboard.held, state.actions.Pointer.held, state.actions.Pad.held]).toEqual([false, false, false]);
      expect(state.axes).toEqual({ Stick: 0, Touch: 0 });

      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      // Still held on return: a release, never a replayed press.
      handle.pollGamepads();
      canvas.dispatchEvent(key("keyup", "KeyW"));
      pointer("pointerup", 1);
      handle.setTouchAxis("move", 0);
      expect(resolver.resolve(handle.ring.drain()).actions.Pad.held).toBe(false);
      pad.axes[0] = 0; pad.buttons[0]!.value = 0;
      handle.pollGamepads();
      pad.axes[0] = 0.75; pad.buttons[0]!.value = 1;
      handle.pollGamepads();
      canvas.dispatchEvent(key("keydown", "KeyW"));
      pointer("pointerdown", 2);
      handle.setTouchAxis("move", 1);
      const again = resolver.resolve(handle.ring.drain());
      expect([again.actions.Keyboard.pressed, again.actions.Pointer.pressed, again.actions.Pad.pressed]).toEqual([true, true, true]);
      expect(again.axes).toEqual({ Stick: 0.75, Touch: 1 });
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it("cancels a pointer whose capture is lost, so it cannot stay pressed for the game", () => {
    const { canvas, handle } = fixture();
    const resolver = new InputResolver({ actions: [{ name: "Fire", bindings: [{ device: "mouseButton", code: "0" }] }], axes: [] });
    const pointer = (type: string) => canvas.dispatchEvent(Object.assign(
      new Event(type, { cancelable: true }), { pointerId: 4, offsetX: 1, offsetY: 2, button: 0, pointerType: "touch" }));
    pointer("pointerdown");
    expect(resolver.resolve(handle.ring.drain()).actions.Fire.held).toBe(true);
    pointer("lostpointercapture");
    const lost = resolver.resolve(handle.ring.drain());
    expect(lost.actions.Fire).toMatchObject({ held: false, released: true });
    expect(lost.touchEvents).toEqual([expect.objectContaining({ Phase: "Cancelled" })]);
    // Its lift lands elsewhere; the window still sees it, and nothing is left to end.
    window.dispatchEvent(Object.assign(new Event("pointerup"), { pointerId: 4 }));
    pointer("pointerdown");
    expect(resolver.resolve(handle.ring.drain()).actions.Fire.pressed).toBe(true);
  });

  it("takes pointer capture only for a pointer the game reads, and survives a capture that throws", () => {
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const captured: number[] = [];
    canvas.setPointerCapture = (id) => {
      if (id === 9) throw new DOMException("The pointer is no longer active.", "NotFoundError");
      captured.push(id);
    };
    const handle = attach(canvas, { ownsPointer: (id) => id === 2 });
    handles.push(handle);
    const pointer = (pointerId: number) => canvas.dispatchEvent(Object.assign(
      new Event("pointerdown", { cancelable: true }), { pointerId, offsetX: 0, offsetY: 0, button: 0, pointerType: "touch" }));
    pointer(1);
    pointer(2);
    expect(() => pointer(9)).not.toThrow();
    expect(captured).toEqual([1]);
    expect(handle.ring.drain().map(event => event.kind === "pointer" ? event.pointerId : -1)).toEqual([1, 9]);
  });

  it("pushes a pad's state when it connects, changes or disconnects, and nothing while it is idle", () => {
    const { handle } = fixture();
    const pad = { index: 0, axes: [0.3, 0], buttons: [{ value: 0 }, { value: 0 }] };
    let pads: unknown[] = [pad];
    Object.assign(navigator, { getGamepads: () => pads });
    const kinds = () => handle.ring.drain().map(event => event.kind);
    handle.pollGamepads();
    expect(handle.ring.drain()).toEqual([{ kind: "gamepad", tick: 7, gamepadIndex: 0, axes: [0.3, 0], buttons: [0, 0] }]);
    for (let frame = 0; frame < 5; frame++) handle.pollGamepads();
    expect(kinds()).toEqual([]);
    // Below the wire's float32 precision: the game would read the same value.
    pad.axes[0] = 0.3 + 1e-12;
    handle.pollGamepads();
    expect(kinds()).toEqual([]);
    pad.axes[0] = 0.3001;
    handle.pollGamepads();
    handle.pollGamepads();
    expect(handle.ring.drain()).toEqual([{ kind: "gamepad", tick: 7, gamepadIndex: 0, axes: [0.3001, 0], buttons: [0, 0] }]);
    pad.buttons[1]!.value = 1;
    handle.pollGamepads();
    handle.pollGamepads();
    expect(handle.ring.drain()).toEqual([{ kind: "gamepad", tick: 7, gamepadIndex: 0, axes: [0.3001, 0], buttons: [0, 1] }]);
    pads = [];
    handle.pollGamepads();
    handle.pollGamepads();
    expect(handle.ring.drain()).toEqual([{ kind: "gamepadDisconnect", tick: 7, gamepadIndex: 0 }]);
    pads = [pad];
    handle.pollGamepads();
    expect(handle.ring.drain()).toEqual([{ kind: "gamepad", tick: 7, gamepadIndex: 0, axes: [0.3001, 0], buttons: [0, 1] }]);
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

  it("keeps a stick held across a boundary at 0 until it rests or moves on, so one resting off centre still comes back", () => {
    const { handle, pad, read } = fixture();
    // A worn stick rests at 0.05; a held one sits at 0.75.
    pad.axes = [0.05, 0.75];
    handle.pollGamepads();
    read();
    handle.setSuppressed(true);
    handle.setSuppressed(false);
    expect(read().axes.Stick).toBe(0);
    pad.axes = [0.05, 0.8];
    handle.pollGamepads();
    expect(handle.ring.drain()).toEqual([]);
    pad.axes = [0.6, 0.8];
    handle.pollGamepads();
    expect(handle.ring.drain()).toEqual([expect.objectContaining({ kind: "gamepad", axes: [0.6, 0] })]);
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

describe("pointers engine UI owns", () => {
  const handles: Array<{ dispose(): void }> = [];
  afterEach(() => { for (const handle of handles.splice(0)) handle.dispose(); });

  function fixture() {
    const canvas = document.createElement("canvas");
    canvas.setPointerCapture = () => {};
    document.body.append(canvas);
    // The engine's own listeners settle this before capture sees the event.
    const owned = new Set<number>();
    const handle = attachInputCapture(canvas, { ownsPointer: (pointerId) => owned.has(pointerId) });
    handles.push(handle);
    const pointer = (type: string, pointerId: number, extra: Record<string, unknown> = {}) => canvas.dispatchEvent(Object.assign(
      new Event(type, { cancelable: true }), { pointerId, offsetX: 3, offsetY: 4, button: type === "pointermove" ? -1 : 0, buttons: 1, pointerType: "touch", pressure: 0.5, ...extra }));
    return { owned, handle, pointer };
  }

  it("keeps a pointer owned at the press away from the game until it lifts, and reports other fingers with their type and pressure", () => {
    const { owned, handle, pointer } = fixture();
    owned.add(1);
    pointer("pointerdown", 1);
    // The joystick lets go during its own pointerup handling, before capture runs.
    owned.delete(1);
    pointer("pointermove", 1);
    pointer("pointerup", 1);
    pointer("pointerdown", 2, { pointerType: "pen", pressure: 0.4 });
    expect(handle.ring.drain()).toEqual([
      expect.objectContaining({ kind: "pointer", pointerId: 2, phase: "down", pointerType: "pen", pressure: 0.4 }),
    ]);
    pointer("pointerdown", 1);
    expect(handle.ring.drain()).toEqual([expect.objectContaining({ pointerId: 1, phase: "down", pointerType: "touch" })]);
  });

  it("cancels a pointer for the game once engine UI takes it over, and ignores it until it lifts", () => {
    const { owned, handle, pointer } = fixture();
    const resolver = new InputResolver({ actions: [{ name: "Fire", bindings: [{ device: "mouseButton", code: "0" }] }], axes: [] });
    pointer("pointerdown", 3);
    expect(resolver.resolve(handle.ring.drain()).actions.Fire.held).toBe(true);
    // A drag over a scroll view becomes a scroll once it passes the slop.
    owned.add(3);
    pointer("pointermove", 3, { offsetX: 3, offsetY: 40 });
    const taken = resolver.resolve(handle.ring.drain());
    expect(taken.actions.Fire).toMatchObject({ held: false, released: true });
    expect(taken.touchEvents).toEqual([expect.objectContaining({ Phase: "Cancelled" })]);
    owned.delete(3);
    pointer("pointermove", 3, { offsetX: 3, offsetY: 60 });
    pointer("pointerup", 3);
    expect(handle.ring.drain()).toEqual([]);
  });
});

describe("device motion", () => {
  const handles: Array<{ dispose(): void }> = [];
  afterEach(() => {
    for (const handle of handles.splice(0)) handle.dispose();
    delete (globalThis as { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent;
  });

  function fixture() {
    const canvas = document.createElement("canvas");
    canvas.setPointerCapture = () => {};
    document.body.append(canvas);
    const handle = attachInputCapture(canvas);
    handles.push(handle);
    const tilt = (beta: number, gamma: number) => window.dispatchEvent(Object.assign(new Event("deviceorientation"), { beta, gamma }));
    const shake = (x: number) => window.dispatchEvent(Object.assign(new Event("devicemotion"), {
      acceleration: { x, y: 0, z: 0 }, rotationRate: { alpha: 1, beta: 2, gamma: 3 },
    }));
    const tap = () => canvas.dispatchEvent(Object.assign(new Event("pointerdown", { cancelable: true }),
      { pointerId: 1, offsetX: 0, offsetY: 0, button: 0, pointerType: "touch" }));
    const motionEvents = () => {
      handle.pollGamepads();
      return handle.ring.drain().filter((event) => event.kind === "motion");
    };
    return { handle, tilt, shake, tap, motionEvents };
  }

  it("starts the sensors when the game asks, then sends the latest pose and the strongest acceleration once per frame", () => {
    const { handle, tilt, shake, motionEvents } = fixture();
    tilt(10, 20);
    expect(motionEvents()).toEqual([]);
    handle.enableMotion();
    tilt(10, 20);
    tilt(-5, 30);
    shake(14);
    shake(2);
    expect(motionEvents()).toEqual([expect.objectContaining({
      beta: -5, gamma: 30, accelerationX: 2, peakAcceleration: 14, rotationX: 2, rotationY: 3, rotationZ: 1,
    })]);
    expect(motionEvents()).toEqual([expect.objectContaining({ beta: -5, peakAcceleration: 0 })]);
  });

  it("asks permission during the next tap where the browser requires it, and never again once refused", async () => {
    const requestPermission = vi.fn(async () => "granted");
    (globalThis as { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent = { requestPermission };
    const { handle, tilt, tap, motionEvents } = fixture();
    handle.enableMotion();
    tilt(10, 20);
    expect(motionEvents()).toEqual([]);
    expect(requestPermission).not.toHaveBeenCalled();
    tap();
    expect(requestPermission).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    tilt(10, 20);
    expect(motionEvents()).toEqual([expect.objectContaining({ beta: 10, gamma: 20 })]);

    const refused = vi.fn(async () => "denied");
    (globalThis as { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent = { requestPermission: refused };
    const second = fixture();
    second.handle.enableMotion();
    second.tap();
    await Promise.resolve();
    await Promise.resolve();
    second.tap();
    second.tilt(10, 20);
    expect(refused).toHaveBeenCalledTimes(1);
    expect(second.motionEvents()).toEqual([]);
  });

  it("releases the tilt when the game loses input ownership, and sends nothing while it is held", () => {
    const { handle, tilt, motionEvents } = fixture();
    handle.enableMotion();
    tilt(10, 20);
    expect(motionEvents()).toHaveLength(1);
    handle.setSuppressed(true);
    const released = handle.ring.drain().filter((event) => event.kind === "motion");
    expect(released).toEqual([expect.objectContaining({ beta: Number.NaN, gamma: Number.NaN })]);
    tilt(15, 25);
    expect(motionEvents()).toEqual([]);
    handle.setSuppressed(false);
    expect(motionEvents()).toEqual([expect.objectContaining({ beta: 15, gamma: 25 })]);
  });
});
