import { describe, expect, it } from "vitest";
import {
  createDefaultInputMappings,
  normalizeInputMappings,
  type ActionBinding,
  type InputMappings,
} from "./mappings";
import { InputResolver } from "./resolver";
import type { RawInputEvent } from "./ring-buffer";

function key(tick: number, code: string, phase: "down" | "up"): RawInputEvent {
  return { kind: "key", tick, code, phase };
}

describe("InputResolver event transitions", () => {
  it.each([
    ["shift", "ShiftLeft", "ShiftRight"],
    ["ctrl", "ControlLeft", "ControlRight"],
    ["alt", "AltLeft", "AltRight"],
    ["meta", "MetaLeft", "MetaRight"],
  ])("keeps %s bindings held until both modifier keys are released", (modifier, left, right) => {
    const resolver = new InputResolver({ actions: [{ name: "Modified", bindings: [
      { device: "key", code: "Space", modifiers: { [modifier]: true } },
    ] }], axes: [] });
    expect(resolver.resolve([key(0, left, "down"), key(0, right, "down"), key(0, "Space", "down")]).actions.Modified.held).toBe(true);
    expect(resolver.resolve([key(1, left, "up")]).actions.Modified).toEqual({ held: true, pressed: false, released: false });
    expect(resolver.resolve([key(2, right, "up")]).actions.Modified).toEqual({ held: false, pressed: false, released: true });
  });

  it("preserves a released axis tap direction for navigation without keeping it active next tick", () => {
    const resolver = new InputResolver({ actions: [], axes: [{ id: "nav", name: "Menu", kind: "2d", bindings: [{ device: "key", code: "ArrowLeft", digitalValue: -1 }] }] });
    const state = resolver.resolve([key(0, "ArrowLeft", "down"), key(0, "ArrowLeft", "up")]).inputs.nav;
    expect(state).toMatchObject({ value: { x: 0, y: 0 }, activeValue: { x: -1, y: 0 }, held: false, started: true, released: true });
    expect(resolver.resolve([]).inputs.nav.activeValue).toBeUndefined();
  });
  it("reports every physical press once, including taps and gamepad threshold crossings", () => {
    const resolver = new InputResolver({ actions: [], axes: [] });
    const pad = (buttons: number[], axes: number[]): RawInputEvent => ({ kind: "gamepad", tick: 0, gamepadIndex: 1, buttons, axes });
    expect(resolver.resolve([
      key(0, "KeyW", "down"), key(0, "KeyW", "down"), key(0, "KeyW", "up"),
      key(0, "KeyW", "down"), pad([1], [0.5, -0.6]), pad([1], [0.5, -0.8]),
    ]).pressedKeys).toEqual(["KeyW", "KeyW", "Gamepad2Button0", "Gamepad2Axis1"]);
    expect(resolver.resolve([pad([1], [0, 0.4])]).pressedKeys).toEqual([]);
    expect(resolver.resolve([pad([0], [0, 0.7]), pad([1], [0, 0.7])]).pressedKeys)
      .toEqual(["Gamepad2Axis1", "Gamepad2Button0"]);
    expect(resolver.resolve([]).pressedKeys).toEqual([]);
  });

  it("lets a primary touch activate mouse bindings without a second finger releasing or moving it, and promotes a new finger", () => {
    const resolver = new InputResolver({ actions: [{ name: "Click", bindings: [{ device: "mouseButton", code: "0" }] }], axes: [] });
    const pointer = (pointerId: number, phase: "down" | "move" | "up" | "cancel", x: number): RawInputEvent => ({ kind: "pointer", tick: 0, pointerId, phase, x, y: 20, button: 0 });
    resolver.resolve([pointer(9, "move", 50)]);
    const down = resolver.resolve([pointer(1, "down", 10), pointer(2, "down", 90)]);
    expect(down.actions.Click).toMatchObject({ pressed: true, held: true });
    expect(down.pressedKeys).toEqual(["MouseLeft"]);
    expect(down.cursor).toEqual({ x: 10, y: 20, pressed: true });
    expect(resolver.resolve([pointer(2, "up", 90)]).actions.Click.held).toBe(true);
    resolver.resolve([pointer(2, "down", 90)]);
    const up = resolver.resolve([pointer(1, "up", 15), pointer(2, "move", 100)]);
    expect(up.actions.Click).toMatchObject({ released: true, held: false });
    expect(up.cursor).toEqual({ x: 15, y: 20, pressed: false });
    // Finger 2 stays secondary, but a new finger takes over while it is still down.
    const next = resolver.resolve([pointer(3, "down", 30)]);
    expect(next.pressedKeys).toEqual(["MouseLeft"]);
    expect(next.actions.Click).toMatchObject({ pressed: true, held: true });
    expect(next.cursor).toEqual({ x: 30, y: 20, pressed: true });
    expect(resolver.resolve([pointer(2, "up", 100)]).actions.Click.held).toBe(true);
    expect(resolver.resolve([pointer(3, "cancel", 30)]).actions.Click.released).toBe(true);
  });

  it("combines assets that share a display name in name lookups", () => {
    const resolver = new InputResolver({
      actions: [
        { id: "jump-a", name: "Jump", bindings: [{ device: "key", code: "KeyA" }] },
        { id: "jump-b", name: "Jump", bindings: [{ device: "key", code: "KeyB" }] },
      ],
      axes: [
        { id: "throttle-a", name: "Throttle", bindings: [{ device: "key", code: "KeyA" }] },
        { id: "throttle-b", name: "Throttle", bindings: [{ device: "key", code: "KeyB" }] },
      ],
    });
    const first = resolver.resolve([key(0, "KeyA", "down")]);
    expect(first.actions.Jump).toEqual({ held: true, pressed: true, released: false });
    expect(first.axes.Throttle).toBe(1);
    expect(first.inputs["jump-b"]?.held).toBe(false);
    expect(resolver.resolve([key(1, "KeyB", "down"), key(1, "KeyA", "up")]).actions.Jump)
      .toEqual({ held: true, pressed: false, released: false });
    expect(resolver.resolve([key(2, "KeyB", "up")]).actions.Jump)
      .toEqual({ held: false, pressed: false, released: true });
  });

  it("releases gamepad controls a later sample omits", () => {
    const resolver = new InputResolver({ actions: [{ name: "Menu", bindings: [{ device: "gamepadButton", code: "0:9" }] }],
      axes: [{ name: "Look", bindings: [{ device: "gamepadAxis", code: "0:3" }] }] });
    const pad = (buttons: number[], axes: number[] = []): RawInputEvent => ({ kind: "gamepad", tick: 0, gamepadIndex: 0, axes, buttons });
    const full = resolver.resolve([pad([0, 0, 0, 0, 0, 0, 0, 0, 0, 1], [0, 0, 0, 0.75])]);
    expect(full.actions.Menu.held).toBe(true);
    expect(full.axes.Look).toBe(0.75);
    const short = resolver.resolve([pad([0, 0, 0, 0], [0, 0])]);
    expect(short.actions.Menu).toEqual({ held: false, pressed: false, released: true });
    expect(short.axes.Look).toBe(0);
  });

  it("releases a whole mouse contact when pointerup names a button whose chord edge was missed", () => {
    const resolver = new InputResolver({ actions: [{ name: "Fire", bindings: [{ device: "mouseButton", code: "0" }] }], axes: [] });
    const mouse = (phase: "down" | "up", button: number): RawInputEvent => ({ kind: "pointer", tick: 0, pointerId: 1, phase, x: 5, y: 6, button });
    expect(resolver.resolve([mouse("down", 0)]).actions.Fire.held).toBe(true);
    const up = resolver.resolve([mouse("up", 2)]);
    expect(up.actions.Fire).toMatchObject({ held: false, released: true });
    expect(up.cursor.pressed).toBe(false);
  });
  it("keeps a complete key tap received between two simulation ticks", () => {
    const resolver = new InputResolver(createDefaultInputMappings());
    const tapped = resolver.resolve([
      key(0, "Enter", "down"),
      key(0, "Enter", "up"),
    ]);
    expect(tapped.actions.Confirm).toEqual({
      held: false,
      pressed: true,
      released: true,
    });
    expect(resolver.resolve([]).actions.Confirm).toEqual({
      held: false,
      pressed: false,
      released: false,
    });
  });
  it.each<[string, ActionBinding, RawInputEvent[]]>([
    ["mouse", { device: "mouseButton", code: "0" }, [
      { kind: "pointer", tick: 0, pointerId: 1, phase: "down", x: 1, y: 1, button: 0 },
      { kind: "pointer", tick: 0, pointerId: 1, phase: "move", x: 2, y: 2, button: 0 },
      { kind: "pointer", tick: 0, pointerId: 1, phase: "up", x: 2, y: 2, button: 0 },
    ]],
    ["gamepad button", { device: "gamepadButton", code: "0:0" }, [
      { kind: "gamepad", tick: 0, gamepadIndex: 0, axes: [], buttons: [1] },
      { kind: "gamepad", tick: 0, gamepadIndex: 0, axes: [], buttons: [1] },
      { kind: "gamepad", tick: 0, gamepadIndex: 0, axes: [], buttons: [0] },
    ]],
    ["gamepad stick", { device: "gamepadAxis", code: "0:0" }, [
      { kind: "gamepad", tick: 0, gamepadIndex: 0, axes: [1], buttons: [] },
      { kind: "gamepad", tick: 0, gamepadIndex: 0, axes: [1], buttons: [] },
      { kind: "gamepad", tick: 0, gamepadIndex: 0, axes: [0], buttons: [] },
    ]],
    ["touch control", { device: "touch", code: "fire" }, [
      { kind: "touchAxis", tick: 0, controlId: "fire", value: 1 },
      { kind: "touchAxis", tick: 0, controlId: "fire", value: 1 },
      { kind: "touchAxis", tick: 0, controlId: "fire", value: 0 },
    ]],
    ["gamepad disconnect", { device: "gamepadButton", code: "0:0" }, [
      { kind: "gamepad", tick: 0, gamepadIndex: 0, axes: [], buttons: [1] },
      { kind: "gamepadDisconnect", tick: 0, gamepadIndex: 0 },
      { kind: "gamepadDisconnect", tick: 0, gamepadIndex: 0 },
    ]],
  ])("keeps a complete %s tap received between two simulation ticks", (_device, binding, events) => {
    const resolver = new InputResolver({ actions: [{ name: "Fire", bindings: [binding] }], axes: [] });
    expect(resolver.resolve(events).actions.Fire).toEqual({ held: false, pressed: true, released: true });
    expect(resolver.resolve([]).actions.Fire).toEqual({ held: false, pressed: false, released: false });
  });
  it("does not release an action while another binding is held or retrigger on key repeat", () => {
    const resolver = new InputResolver({
      actions: [
        {
          name: "Jump",
          bindings: [
            { device: "key", code: "KeyH" },
            { device: "key", code: "KeyG" },
          ],
        },
      ],
      axes: [],
    });
    resolver.resolve([key(0, "KeyH", "down")]);
    const overlap = resolver.resolve([
      key(1, "KeyH", "down"),
      key(1, "KeyG", "down"),
      key(1, "KeyH", "up"),
    ]);
    expect(overlap.actions.Jump).toEqual({
      held: true,
      pressed: false,
      released: false,
    });
    const retrigger = resolver.resolve([
      key(2, "KeyG", "up"),
      key(2, "KeyG", "down"),
    ]);
    expect(retrigger.actions.Jump).toEqual({
      held: true,
      pressed: true,
      released: true,
    });
  });
});

describe("normalizeInputMappings", () => {
  it("H13: keeps explicit empty and missing action and axis lists empty", () => {
    expect(normalizeInputMappings({})).toEqual({ actions: [], axes: [] });
    const resolver = new InputResolver(
      normalizeInputMappings({ actions: [], axes: [] }),
    );
    const resolved = resolver.resolve([
      key(0, "Space", "down"),
      key(0, "KeyW", "down"),
    ]);
    expect(resolved.actions).toEqual({});
    expect(resolved.axes2D).toEqual({});
  });

  it("drops malformed bindings and keeps valid ones", () => {
    const mappings = normalizeInputMappings({
      actions: [
        {
          name: "Jump",
          bindings: [
            { device: "key", code: "Space" },
            { device: "nope", code: "X" },
            { device: "key" },
          ],
        },
      ],
      axes: [],
    });
    expect(mappings.actions).toEqual([
      { name: "Jump", bindings: [{ device: "key", code: "Space" }] },
    ]);
  });

  it("drops empty-code drafts", () => {
    const mappings = normalizeInputMappings({
      actions: [
        {
          name: "Jump",
          bindings: [
            { device: "key", code: "Space" },
            { device: "key", code: "" },
          ],
        },
      ],
      axes: [
        {
          name: "Look",
          kind: "1d",
          bindings: [{ device: "gamepadAxis", code: "" }],
        },
      ],
    });
    expect(mappings.actions).toEqual([
      { name: "Jump", bindings: [{ device: "key", code: "Space" }] },
    ]);
    expect(mappings.axes).toEqual([{ name: "Look", kind: "1d", bindings: [] }]);
  });
});

describe("InputResolver", () => {
  const mappings: InputMappings = createDefaultInputMappings();

  it("reports pressed, held and released for a key-bound action", () => {
    const resolver = new InputResolver(mappings);

    const down = resolver.resolve([key(1, "Space", "down")]);
    expect(down.actions.Jump).toEqual({
      pressed: true,
      held: true,
      released: false,
    });

    const held = resolver.resolve([]);
    expect(held.actions.Jump).toEqual({
      pressed: false,
      held: true,
      released: false,
    });

    const up = resolver.resolve([key(3, "Space", "up")]);
    expect(up.actions.Jump).toEqual({
      pressed: false,
      held: false,
      released: true,
    });
  });

  it("folds WASD and a gamepad stick into the Move 2D axis", () => {
    const resolver = new InputResolver(mappings);

    const keyboard = resolver.resolve([
      key(1, "KeyW", "down"),
      key(1, "KeyD", "down"),
    ]);
    expect(keyboard.axes2D.Move).toEqual({ x: 1, y: 1 });

    resolver.resolve([key(1, "KeyW", "up"), key(1, "KeyD", "up")]);
    const stick = resolver.resolve([
      {
        kind: "gamepad",
        tick: 1,
        gamepadIndex: 0,
        axes: [0.8, -0.6, 0, 0],
        buttons: [],
      },
    ]);
    expect(stick.axes2D.Move!.x).toBeGreaterThan(0.5);
    expect(stick.axes2D.Move!.y).toBeGreaterThan(0.4);
    expect(stick.gamepadConnections).toEqual([
      { gamepadIndex: 0, connected: true },
    ]);
    const next = resolver.resolve([
      {
        kind: "gamepad",
        tick: 2,
        gamepadIndex: 0,
        axes: [0.8, -0.6, 0, 0],
        buttons: [],
      },
    ]);
    expect(next.gamepadConnections).toEqual([]);
    expect(next.axes2D.Move!.x).toBeGreaterThan(0.5);
  });

  it("reports a disconnected pad once and drops only its held buttons and stick", () => {
    const resolver = new InputResolver({
      actions: [
        { name: "Jump", bindings: [{ device: "gamepadButton", code: "0:0" }] },
        { name: "Fire", bindings: [{ device: "gamepadButton", code: "1:0" }] },
      ],
      axes: [
        {
          name: "Move",
          kind: "2d",
          bindings: [{ device: "gamepadAxis", code: "0:0", component: "x" }],
        },
      ],
    });
    const pad = (tick: number, gamepadIndex: number): RawInputEvent => ({
      kind: "gamepad",
      tick,
      gamepadIndex,
      axes: [0.8],
      buttons: [1],
    });
    const disconnect = (tick: number): RawInputEvent => ({
      kind: "gamepadDisconnect",
      tick,
      gamepadIndex: 0,
    });
    resolver.resolve([pad(1, 0), pad(1, 1)]);

    const lost = resolver.resolve([disconnect(2)]);
    expect(lost.gamepadConnections).toEqual([
      { gamepadIndex: 0, connected: false },
    ]);
    expect(lost.actions.Jump).toEqual({
      pressed: false,
      released: true,
      held: false,
    });
    expect(lost.actions.Fire?.held).toBe(true);
    expect(lost.axes2D.Move).toEqual({ x: 0, y: 0 });
    expect(resolver.resolve([disconnect(3)]).gamepadConnections).toEqual([]);

    const back = resolver.resolve([pad(4, 0)]);
    expect(back.gamepadConnections).toEqual([
      { gamepadIndex: 0, connected: true },
    ]);
    expect(back.actions.Jump?.pressed).toBe(true);
  });

  it("applies dead zone, scale and inversion on a 1D axis", () => {
    const resolver = new InputResolver({
      actions: [],
      axes: [
        {
          name: "Look",
          kind: "1d",
          bindings: [
            {
              device: "gamepadAxis",
              code: "0:0",
              deadZone: 0.2,
              scale: 2,
              invert: true,
            },
          ],
        },
      ],
    });

    const insideDeadZone = resolver.resolve([
      {
        kind: "gamepad",
        tick: 1,
        gamepadIndex: 0,
        axes: [0.1],
        buttons: [],
      },
    ]);
    expect(insideDeadZone.axes.Look).toBe(0);

    const outside = resolver.resolve([
      {
        kind: "gamepad",
        tick: 2,
        gamepadIndex: 0,
        axes: [0.6],
        buttons: [],
      },
    ]);
    // (0.6 - 0.2) / 0.8 = 0.5, then * scale 2 = 1, then invert = -1, clamped.
    expect(outside.axes.Look).toBeCloseTo(-1, 10);
  });

  it("reads a touch control as an axis contribution", () => {
    const resolver = new InputResolver({
      actions: [],
      axes: [
        {
          name: "Move",
          kind: "2d",
          bindings: [
            {
              device: "touch",
              code: "joystick-x",
              component: "x",
            },
          ],
        },
      ],
    });
    const resolved = resolver.resolve([
      { kind: "touchAxis", tick: 1, controlId: "joystick-x", value: 0.75 },
    ]);
    expect(resolved.axes2D.Move!.x).toBeCloseTo(0.75, 5);
    expect(resolved.axes2D.Move!.y).toBe(0);
  });

  it("does not treat an empty mouseButton code as left click", () => {
    const resolver = new InputResolver({
      actions: [
        { name: "Fire", bindings: [{ device: "mouseButton", code: "" }] },
      ],
      axes: [],
    });
    const tick = resolver.resolve([
      {
        kind: "pointer",
        tick: 1,
        pointerId: 1,
        phase: "down",
        x: 0,
        y: 0,
        button: 0,
      },
    ]);
    expect(tick.actions.Fire).toEqual({
      pressed: false,
      held: false,
      released: false,
    });
  });

  it("keeps primary pointer XY and pressed; extra fingers do not steal the cursor", () => {
    const resolver = new InputResolver(mappings);
    const down = resolver.resolve([
      {
        kind: "pointer",
        tick: 1,
        pointerId: 7,
        phase: "down",
        x: 120,
        y: 40,
        button: 0,
      },
    ]);
    expect(down.cursor).toEqual({ x: 120, y: 40, pressed: true });

    const extra = resolver.resolve([
      {
        kind: "pointer",
        tick: 2,
        pointerId: 8,
        phase: "down",
        x: 0,
        y: 0,
        button: 0,
      },
      {
        kind: "pointer",
        tick: 2,
        pointerId: 7,
        phase: "move",
        x: 130,
        y: 50,
        button: 0,
      },
    ]);
    expect(extra.cursor).toEqual({ x: 130, y: 50, pressed: true });

    const up = resolver.resolve([
      {
        kind: "pointer",
        tick: 3,
        pointerId: 7,
        phase: "up",
        x: 131,
        y: 51,
        button: 0,
      },
    ]);
    expect(up.cursor).toEqual({ x: 131, y: 51, pressed: false });

    const idle = resolver.resolve([]);
    expect(idle.cursor).toEqual({ x: 131, y: 51, pressed: false });
  });
});

describe("InputResolver touches", () => {
  type PointerEvent = Extract<RawInputEvent, { kind: "pointer" }>;
  const finger = (
    pointerId: number,
    phase: PointerEvent["phase"],
    x: number,
    y: number,
    extra: Partial<PointerEvent> = {},
  ): RawInputEvent => ({ kind: "pointer", tick: 0, pointerId, phase, x, y, button: phase === "move" ? -1 : 0, pointerType: "touch", ...extra });
  const summary = (touches: readonly { Finger: number; Phase: string }[]) => touches.map((touch) => `${touch.Finger}:${touch.Phase}`);

  it("gives each contact the lowest free finger, keeps it while held and frees it the tick after the lift", () => {
    const resolver = new InputResolver({ actions: [], axes: [] });
    const both = resolver.resolve([finger(11, "down", 10, 10), finger(12, "down", 50, 50)]);
    expect(summary(both.touches)).toEqual(["0:Began", "1:Began"]);
    expect(summary(both.touchEvents)).toEqual(["0:Began", "1:Began"]);

    // The lifted finger is still listed this tick, so a new contact cannot take its slot yet.
    const lift = resolver.resolve([finger(11, "up", 12, 10), finger(13, "down", 90, 90)]);
    expect(summary(lift.touches)).toEqual(["0:Ended", "1:Stationary", "2:Began"]);
    expect(lift.touches[0]).toMatchObject({ Position: { x: 12, y: 10 }, Delta: { x: 2, y: 0 }, StartPosition: { x: 10, y: 10 } });

    const next = resolver.resolve([finger(14, "down", 5, 5)]);
    expect(summary(next.touches)).toEqual(["0:Began", "1:Stationary", "2:Stationary"]);
    expect(next.touches[0]).toMatchObject({ Position: { x: 5, y: 5 }, Type: "Finger" });
  });

  it("reports one Moved record per contact per tick with the movement since the tick began", () => {
    const resolver = new InputResolver({ actions: [], axes: [] });
    resolver.resolve([finger(1, "down", 0, 0)]);
    const moved = resolver.resolve([finger(1, "move", 5, 0), finger(1, "move", 8, 4)]);
    expect(moved.touchEvents).toEqual([expect.objectContaining({ Finger: 0, Phase: "Moved", Position: { x: 8, y: 4 }, Delta: { x: 8, y: 4 } })]);
    expect(moved.touches).toEqual([expect.objectContaining({ Phase: "Moved", Delta: { x: 8, y: 4 } })]);

    const still = resolver.resolve([]);
    expect(still.touchEvents).toEqual([]);
    expect(still.touches).toEqual([expect.objectContaining({ Phase: "Stationary", Position: { x: 8, y: 4 }, Delta: { x: 0, y: 0 } })]);

    // A contact that begins and moves in one tick stays Began, with its movement since the press.
    const fresh = resolver.resolve([finger(2, "down", 100, 100), finger(2, "move", 103, 100)]);
    expect(summary(fresh.touchEvents)).toEqual(["1:Began", "1:Moved"]);
    expect(fresh.touches[1]).toMatchObject({ Phase: "Began", Delta: { x: 3, y: 0 } });
  });

  it("lists a tap inside one tick once, as Ended, after its Began record", () => {
    const resolver = new InputResolver({ actions: [], axes: [] });
    const tap = resolver.resolve([finger(1, "down", 20, 30), finger(1, "up", 20, 30)]);
    expect(summary(tap.touchEvents)).toEqual(["0:Began", "0:Ended"]);
    expect(summary(tap.touches)).toEqual(["0:Ended"]);
    expect(resolver.resolve([]).touches).toEqual([]);
  });

  it("ends a cancelled contact as Cancelled at its last reported position", () => {
    const resolver = new InputResolver({ actions: [], axes: [] });
    resolver.resolve([finger(1, "down", 20, 30), finger(1, "move", 25, 30)]);
    const cancelled = resolver.resolve([finger(1, "cancel", 0, 0)]);
    expect(cancelled.touchEvents).toEqual([expect.objectContaining({ Phase: "Cancelled", Position: { x: 25, y: 30 }, Delta: { x: 0, y: 0 } })]);
  });

  it("counts a pen tip and the left mouse button as contacts, not other mouse buttons, and keeps pressure from the last sample", () => {
    const resolver = new InputResolver({ actions: [], axes: [] });
    const pen = resolver.resolve([finger(5, "down", 1, 1, { pointerType: "pen", pressure: 0.3 })]);
    expect(pen.touches).toEqual([expect.objectContaining({ Type: "Pen", Pressure: 0.3 })]);
    resolver.resolve([finger(5, "move", 2, 1, { pointerType: "pen", pressure: 0.6 })]);
    const lifted = resolver.resolve([finger(5, "up", 2, 1, { pointerType: "pen", pressure: 0 })]);
    expect(lifted.touchEvents).toEqual([expect.objectContaining({ Phase: "Ended", Pressure: 0.6 })]);

    const right = resolver.resolve([{ kind: "pointer", tick: 0, pointerId: 1, phase: "down", x: 4, y: 4, button: 2 }]);
    expect(right.touches).toEqual([]);
    // Pressing left during the right-button chord makes the mouse a contact; a mouse without a type is still a mouse.
    const left = resolver.resolve([{ kind: "pointer", tick: 0, pointerId: 1, phase: "down", x: 4, y: 4, button: 0 }]);
    expect(left.touches).toEqual([expect.objectContaining({ Finger: 0, Type: "Mouse", Pressure: 0.5 })]);
    expect(summary(resolver.resolve([{ kind: "pointer", tick: 0, pointerId: 1, phase: "up", x: 4, y: 4, button: 0 }]).touches)).toEqual(["0:Ended"]);
  });

  it("drops every contact on reset", () => {
    const resolver = new InputResolver({ actions: [], axes: [] });
    resolver.resolve([finger(1, "down", 0, 0), finger(2, "down", 9, 9)]);
    expect(resolver.reset().touches).toEqual([]);
    expect(summary(resolver.resolve([finger(3, "down", 1, 1)]).touches)).toEqual(["0:Began"]);
  });
});
