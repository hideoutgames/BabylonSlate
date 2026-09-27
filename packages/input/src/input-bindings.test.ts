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

/** Version 1 player saves store per-slot overrides of authored bindings. */
const jumpOnJ = JSON.stringify({
  version: 1,
  overrides: [
    {
      kind: "action",
      mapping: "Jump",
      index: 0,
      defaultBinding: { device: "key", code: "Space" },
      device: "key",
      code: "KeyJ",
    },
  ],
});

describe("runtime input bindings", () => {
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
    const saved = JSON.stringify({
      version: 1,
      overrides: [
        {
          kind: "axis",
          mapping: "Diagonal",
          index: 0,
          defaultBinding: { device: "key", code: "KeyW", component: "x" },
          device: "key",
          code: "KeyA",
        },
      ],
    });
    const game = new InputResolver(defaults);
    expect(game.bindings.importBindings(saved)).toBe(true);
    expect(game.resolve([key("KeyA")]).axes2D.Diagonal).toEqual({
      x: 1,
      y: 0,
    });
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

  it("round trips only overrides and rejects malformed imports atomically", () => {
    const original = new InputResolver(createDefaultInputMappings());
    expect(original.bindings.importBindings(jumpOnJ)).toBe(true);
    const saved = original.bindings.exportBindings();
    const next = new InputResolver(createDefaultInputMappings());
    expect(next.bindings.importBindings(saved)).toBe(true);
    expect(next.resolve([key("KeyJ")]).actions.Jump?.pressed).toBe(true);
    const malformed = JSON.parse(saved);
    malformed.overrides[0].code = "KeyH";
    malformed.overrides.push({});
    expect(next.bindings.importBindings(JSON.stringify(malformed))).toBe(false);
    expect(next.bindings.exportBindings()).toBe(saved);
    expect(next.bindings.importBindings("not json")).toBe(false);
    expect(next.bindings.importBindings('{"version":3,"overrides":[]}')).toBe(
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
    expect(updatedGame.resolve([key("KeyJ")]).actions.Jump?.held).toBe(false);
  });
});
