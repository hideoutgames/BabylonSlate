import { describe, expect, it } from "vitest";
import { InputResolver } from "./resolver";
import { createDefaultInputMappings } from "./mappings";
import type { RawInputEvent } from "./ring-buffer";

const key = (code: string, phase: "down" | "up" = "down"): RawInputEvent => ({
  kind: "key",
  code,
  phase,
  tick: 0,
});

describe("runtime input bindings", () => {
  it("captures a standalone modifier on release without requiring itself as a modifier", () => {
    const resolver = new InputResolver(createDefaultInputMappings());
    resolver.bindings.beginRebind("action", "Jump", 0);
    resolver.resolve([key("ShiftLeft")]);
    expect(resolver.bindings.getRebindStatus()).toBe("listening");
    resolver.resolve([key("ShiftLeft", "up")]);
    expect(resolver.bindings.getRebindStatus()).toBe("completed");
    expect(resolver.bindings.getBinding("action", "Jump", 0)).toMatchObject({
      code: "ShiftLeft",
      shift: false,
    });
    expect(resolver.resolve([key("ShiftLeft")]).actions.Jump?.pressed).toBe(
      true,
    );
    resolver.bindings.beginRebind("action", "Jump", 0);
    resolver.resolve([key("ShiftLeft", "up")]);
    expect(resolver.bindings.getRebindStatus()).toBe("listening");
    resolver.resolve([key("Escape")]);
    expect(resolver.bindings.getRebindStatus()).toBe("cancelled");
  });

  it("rejects reordered axis slots with the same key but different components", () => {
    const defaults = {
      actions: [],
      axes: [
        {
          name: "Diagonal",
          kind: "2d" as const,
          bindings: [
            { device: "key" as const, code: "KeyW", component: "x" as const },
            { device: "key" as const, code: "KeyW", component: "y" as const },
          ],
        },
      ],
    };
    const resolver = new InputResolver(defaults);
    resolver.bindings.setBinding("axis", "Diagonal", 0, "key", "KeyA");
    const saved = resolver.bindings.exportBindings();
    defaults.axes[0]!.bindings.reverse();
    const updatedGame = new InputResolver(defaults);
    expect(updatedGame.bindings.importBindings(saved)).toBe(false);
    expect(updatedGame.resolve([key("KeyA")]).axes2D.Diagonal).toEqual({
      x: 0,
      y: 0,
    });
    expect(updatedGame.resolve([key("KeyW")]).axes2D.Diagonal).toEqual({
      x: 1,
      y: 1,
    });
  });

  it("rebinds one action slot without mutating defaults or other devices", () => {
    const defaults = createDefaultInputMappings();
    const resolver = new InputResolver(defaults);
    resolver.resolve([key("Space"), key("KeyW")]);
    expect(
      resolver.bindings?.setBinding("action", "Jump", 0, "key", "KeyJ"),
    ).toBe(true);
    const changed = resolver.resolve([]);
    expect(changed.actions.Jump).toEqual({
      pressed: false,
      released: true,
      held: false,
    });
    expect(changed.axes2D.Move).toEqual({ x: 0, y: 1 });
    expect(resolver.resolve([key("Space")]).actions.Jump?.held).toBe(false);
    expect(resolver.resolve([key("KeyJ")]).actions.Jump?.pressed).toBe(true);
    expect(defaults.actions[0]?.bindings[0]?.code).toBe("Space");
    expect(resolver.bindings.getBinding("action", "Jump", 1)?.code).toBe("0:0");
    resolver.resolve([key("Space", "up"), key("KeyJ", "up")]);
    expect(resolver.bindings.resetBindings("action", "Jump")).toBe(true);
    expect(resolver.resolve([key("Space")]).actions.Jump?.pressed).toBe(true);
  });

  it("preserves axis direction and shaping when changing a control", () => {
    const resolver = new InputResolver(createDefaultInputMappings());
    expect(
      resolver.bindings?.setBinding("axis", "Move", 0, "key", "ArrowLeft"),
    ).toBe(true);
    expect(resolver.resolve([key("ArrowLeft")]).axes2D.Move).toEqual({
      x: -1,
      y: 0,
    });
    expect(resolver.bindings.getBinding("axis", "Move", 0)?.label).toBe("Left");
    expect(
      resolver.bindings.setBinding("axis", "Move", -1, "key", "KeyJ"),
    ).toBe(false);
    expect(
      resolver.bindings.setBinding("action", "Missing", 0, "key", "KeyJ"),
    ).toBe(false);
    expect(
      resolver.bindings.setBinding("action", "Jump", 0, "mouseButton", ""),
    ).toBe(false);
  });

  it("captures a fresh keyboard chord and suppresses it until release", () => {
    const resolver = new InputResolver(createDefaultInputMappings());
    resolver.resolve([key("Enter")]);
    expect(resolver.bindings?.beginRebind("action", "Jump", 0)).toBe(true);
    resolver.resolve([key("Enter")]);
    expect(resolver.bindings.getRebindStatus()).toBe("listening");
    const capture = resolver.resolve([key("ControlLeft"), key("KeyJ")]);
    expect(resolver.bindings.getRebindStatus()).toBe("completed");
    expect(resolver.bindings.getBinding("action", "Jump", 0)).toMatchObject({
      code: "KeyJ",
      ctrl: true,
    });
    expect(capture.actions.Jump?.held).toBe(false);
    expect(resolver.resolve([key("KeyJ")]).actions.Jump?.held).toBe(false);
    resolver.resolve([key("KeyJ", "up"), key("ControlLeft", "up")]);
    expect(
      resolver.resolve([key("ControlLeft"), key("KeyJ")]).actions.Jump?.pressed,
    ).toBe(true);
    resolver.bindings.beginRebind("action", "Jump", 0);
    resolver.resolve([key("Escape")]);
    expect(resolver.bindings.getRebindStatus()).toBe("cancelled");
    expect(resolver.bindings.getBinding("action", "Jump", 0)?.code).toBe(
      "KeyJ",
    );
  });

  it("round trips only overrides and rejects malformed imports atomically", () => {
    const original = new InputResolver(createDefaultInputMappings());
    expect(
      original.bindings?.setBinding("action", "Jump", 0, "key", "KeyJ"),
    ).toBe(true);
    const saved = original.bindings.exportBindings();
    const next = new InputResolver(createDefaultInputMappings());
    expect(next.bindings.importBindings(saved)).toBe(true);
    expect(next.resolve([key("KeyJ")]).actions.Jump?.pressed).toBe(true);
    const malformed = JSON.parse(saved);
    malformed.overrides[0].code = "KeyH";
    malformed.overrides.push({});
    expect(next.bindings.importBindings(JSON.stringify(malformed))).toBe(false);
    expect(next.bindings.getBinding("action", "Jump", 0)?.code).toBe("KeyJ");
    expect(next.bindings.importBindings("not json")).toBe(false);
    expect(next.bindings.importBindings('{"version":2,"overrides":[]}')).toBe(
      false,
    );
    next.bindings.resetBindings();
    expect(JSON.parse(next.bindings.exportBindings())).toEqual({
      version: 1,
      overrides: [],
    });
    expect(next.resolve([key("Space")]).actions.Jump).toEqual({
      pressed: true,
      released: true,
      held: true,
    });
    const changedDefaults = createDefaultInputMappings();
    changedDefaults.actions[0]!.bindings.reverse();
    const updatedGame = new InputResolver(changedDefaults);
    expect(updatedGame.bindings.importBindings(saved)).toBe(false);
    expect(updatedGame.bindings.getBinding("action", "Jump", 0)?.device).toBe(
      "touch",
    );
  });

  it("keeps gamepad state and cursor samples while listening for a keyboard binding", () => {
    const resolver = new InputResolver(createDefaultInputMappings());
    resolver.resolve([
      { kind: "gamepad", tick: 0, gamepadIndex: 0, axes: [0.8], buttons: [1] },
      {
        kind: "pointer",
        tick: 0,
        pointerId: 1,
        phase: "down",
        x: 40,
        y: 20,
        button: 0,
      },
    ]);
    resolver.bindings.beginRebind("action", "Jump", 0);
    const listening = resolver.resolve([
      { kind: "gamepad", tick: 1, gamepadIndex: 0, axes: [0.8], buttons: [1] },
      key("KeyJ"),
    ]);
    expect(listening.gamepadConnections).toEqual([]);
    expect(listening.cursor).toEqual({ x: 40, y: 20, pressed: true });
    expect(listening.actions.Jump?.held).toBe(true);
    expect(listening.axes2D.Move!.x).toBeGreaterThan(0.5);
    resolver.reset();
    expect(resolver.bindings.getRebindStatus()).toBe("idle");
    resolver.bindings.beginRebind("action", "Jump", 0);
    resolver.resolve([key("KeyJ")]);
    expect(resolver.bindings.getRebindStatus()).toBe("completed");
  });
});
