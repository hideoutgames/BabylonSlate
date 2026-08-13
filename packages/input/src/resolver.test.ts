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

describe("normalizeInputMappings", () => {
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

  it("default Move axis includes touch joystick bindings beside gamepad", () => {
    const resolver = new InputResolver(createDefaultInputMappings());
    const resolved = resolver.resolve([
      { kind: "touchAxis", tick: 1, controlId: "joystick-x", value: 1 },
      { kind: "touchAxis", tick: 1, controlId: "joystick-y", value: -1 },
    ]);
    expect(resolved.axes2D.Move!.x).toBeCloseTo(1, 5);
    expect(resolved.axes2D.Move!.y).toBeCloseTo(-1, 5);
  });
});
