import { describe, expect, it } from "vitest";
import {
  createDefaultInputMappings,
  normalizeInputMappings,
  type InputMappings,
} from "./mappings";
import { InputResolver } from "./resolver";
import type { RawInputEvent } from "./ring-buffer";

function key(tick: number, code: string, phase: "down" | "up"): RawInputEvent {
  return { kind: "key", tick, code, phase };
}

describe("InputResolver event transitions", () => {
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
    resolver.reset();
    expect(resolver.resolve([key(0, "KeyW", "down")]).pressedKeys).toEqual(["KeyW"]);
  });

  it("lets a primary touch activate mouse bindings without a second finger releasing or moving it", () => {
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
    resolver.resolve([pointer(2, "up", 100)]);
    expect(resolver.resolve([pointer(3, "down", 30)]).pressedKeys).toEqual(["MouseLeft"]);
    expect(resolver.resolve([pointer(3, "cancel", 30)]).actions.Click.released).toBe(true);
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
  it("H13: preserves explicit empty action and axis lists", () => {
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
  it("falls back to defaults for an empty payload", () => {
    const mappings = normalizeInputMappings({});
    expect(mappings.actions.length).toBeGreaterThan(0);
    expect(mappings.axes.some((axis) => axis.name === "Move")).toBe(true);
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

  it("drops empty-code drafts by default", () => {
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

  it("keeps empty-code drafts when allowIncomplete is set", () => {
    const mappings = normalizeInputMappings(
      {
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
      },
      { allowIncomplete: true },
    );
    expect(mappings.actions).toEqual([
      {
        name: "Jump",
        bindings: [
          { device: "key", code: "Space" },
          { device: "key", code: "" },
        ],
      },
    ]);
    expect(mappings.axes).toEqual([
      {
        name: "Look",
        kind: "1d",
        bindings: [{ device: "gamepadAxis", code: "" }],
      },
    ]);
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

    resolver.reset();
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

  it("emits gamepad disconnect and clears that pad's button state", () => {
    const resolver = new InputResolver(mappings);
    resolver.resolve([
      {
        kind: "gamepad",
        tick: 1,
        gamepadIndex: 0,
        axes: [],
        buttons: [1, 0],
      },
    ]);
    expect(resolver.resolve([]).actions.Jump?.held).toBe(true);

    const disconnect = resolver.resolve([
      {
        kind: "gamepadConnection",
        tick: 2,
        gamepadIndex: 0,
        connected: false,
      },
    ]);
    expect(disconnect.gamepadConnections).toEqual([
      { gamepadIndex: 0, connected: false },
    ]);
    expect(disconnect.actions.Jump?.held).toBe(false);
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
      { kind: "mouse", tick: 1, phase: "down", x: 0, y: 0, button: 0 },
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

  it("treats mouse samples as the cursor when no pointer is primary", () => {
    const resolver = new InputResolver(mappings);
    const tick = resolver.resolve([
      { kind: "mouse", tick: 1, phase: "move", x: 10, y: 20, button: 0 },
    ]);
    expect(tick.cursor).toEqual({ x: 10, y: 20, pressed: false });
    const down = resolver.resolve([
      { kind: "mouse", tick: 2, phase: "down", x: 11, y: 21, button: 0 },
    ]);
    expect(down.cursor).toEqual({ x: 11, y: 21, pressed: true });
  });
});
