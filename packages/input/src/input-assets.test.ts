import { describe, expect, it } from "vitest";
import {
  normalizeInputAssetPayload,
  type InputAssetDefinition,
} from "@babylonslate/core";
import { inputMappingsFromAssets } from "./input-assets";
import { InputResolver } from "./resolver";
import type { RawInputEvent } from "./ring-buffer";

const key = (code: string, phase: "down" | "up"): RawInputEvent => ({
  kind: "key",
  tick: 9999,
  code,
  phase,
});
const action: InputAssetDefinition = {
  guid: "jump",
  name: "Jump",
  type: "InputAction",
  ...normalizeInputAssetPayload("InputAction", {
    bindings: [{ id: "keyboard", device: "key", code: "Space" }],
  }),
};
const axis: InputAssetDefinition = {
  guid: "move",
  name: "Move",
  type: "InputAxis",
  ...normalizeInputAssetPayload("InputAxis", {
    valueType: "2d",
    bindings: [{ id: "right", device: "key", code: "KeyD", component: "x" }],
  }),
};

describe("asset input runtime", () => {
  it("retains short action and axis taps and counts held time in simulation seconds", () => {
    const resolver = new InputResolver(inputMappingsFromAssets([action, axis]));
    const tap = resolver.resolve(
      [
        key("Space", "down"),
        key("Space", "up"),
        key("KeyD", "down"),
        key("KeyD", "up"),
      ],
      0.25,
    );
    for (const id of ["jump", "move"])
      expect(tap.inputs[id]).toMatchObject({
        started: true,
        released: true,
        held: false,
        heldSeconds: 0,
      });
    expect(
      resolver.resolve([key("Space", "down")], 0.25).inputs.jump,
    ).toMatchObject({ started: true, held: true, heldSeconds: 0 });
    expect(resolver.resolve([], 0.25).inputs.jump.heldSeconds).toBe(0.25);
    expect(
      resolver.resolve([key("Space", "up")], 0.25).inputs.jump,
    ).toMatchObject({
      held: false,
      released: true,
      heldSeconds: 0,
      lastHeldSeconds: 0.25,
    });
    expect(resolver.resolve([], 0.25).inputs.jump.released).toBe(false);
    expect(
      new InputResolver(inputMappingsFromAssets([])).resolve([]).inputs,
    ).toEqual({});
  });

  it("restores player controls after asset rename and binding reordering without changing tuning", () => {
    const original = {
      ...axis,
      bindings: [
        ...axis.bindings,
        {
          id: "left",
          device: "key" as const,
          code: "KeyA",
          component: "x" as const,
          digitalValue: -1,
        },
      ],
    };
    const resolver = new InputResolver(inputMappingsFromAssets([original]));
    const selected = resolver.bindings.getInputBindings({
      Name: "stale",
      Asset: "move",
    })[1]!;
    expect(
      resolver.bindings.setInputControl(selected, {
        Device: "key",
        Code: "KeyH",
        Shift: false,
        Ctrl: false,
        Alt: false,
        Meta: false,
      }),
    ).toBe(true);
    expect(
      resolver.bindings.getInputBindings({ Name: "", Asset: "move" })[1]!.Label,
    ).toBe("H");
    const saved = resolver.bindings.exportBindings();
    const renamed = new InputResolver(
      inputMappingsFromAssets([
        {
          ...original,
          name: "Movement",
          bindings: [...original.bindings].reverse(),
        },
      ]),
    );
    expect(renamed.bindings.importBindings(saved)).toBe(true);
    expect(renamed.resolve([key("KeyH", "down")]).inputs.move).toMatchObject({
      input: { Name: "Movement", Asset: "move" },
      value: { x: -1, y: 0 },
    });
    expect(
      renamed.bindings.resetInputBindings({ Name: "", Asset: "move" }),
    ).toBe(true);
    expect(renamed.resolve([]).inputs.move).toMatchObject({
      released: true,
      value: { x: 0, y: 0 },
    });
    expect(
      renamed.bindings.beginInputRebind({ ...selected, Id: "deleted" }),
    ).toBe(false);
  });

  it("keeps legacy aliases attached to their original asset when new inputs reuse a name", () => {
    const assets = [
      {
        ...action,
        guid: "other",
        bindings: [{ id: "keyboard", device: "key" as const, code: "KeyJ" }],
      },
      { ...action, name: "Leap", legacyName: "Jump" },
      { ...axis, name: "Jump", legacyName: "Jump" },
    ];
    const resolver = new InputResolver(inputMappingsFromAssets(assets));
    const pressed = resolver.resolve([key("Space", "down")]);
    expect(pressed.inputs.jump.held).toBe(true);
    expect(pressed.inputs.other.held).toBe(false);
    expect(pressed.actions.Jump.held).toBe(true);
    expect(resolver.isActionHeld("Jump")).toBe(true);
    expect(resolver.bindings.getBinding("action", "Jump", 0)?.code).toBe(
      "Space",
    );
    expect(
      resolver.bindings.setBinding("action", "Jump", 0, "key", "KeyH"),
    ).toBe(true);
    expect(
      resolver.bindings.getInputBindings({ Name: "", Asset: "jump" })[0]
        ?.Control.Code,
    ).toBe("KeyH");
    expect(
      resolver.bindings.getInputBindings({ Name: "", Asset: "other" })[0]
        ?.Control.Code,
    ).toBe("KeyJ");
    expect(resolver.bindings.setBinding("axis", "Jump", 0, "key", "KeyL")).toBe(
      true,
    );
    expect(resolver.bindings.resetBindings("axis", "Jump")).toBe(true);
    expect(
      resolver.bindings.getInputBindings({ Name: "", Asset: "move" })[0]
        ?.Control.Code,
    ).toBe("KeyD");
    const saved = JSON.parse(resolver.bindings.exportBindings());
    saved.version = 1;
    saved.overrides[0].mapping = "Jump";
    delete saved.overrides[0].bindingId;
    const restored = new InputResolver(inputMappingsFromAssets(assets));
    expect(restored.bindings.importBindings(JSON.stringify(saved))).toBe(true);
    expect(
      restored.bindings.getInputBindings({ Name: "", Asset: "jump" })[0]
        ?.Control.Code,
    ).toBe("KeyH");
  });

  it("captures a replacement key without activating gameplay and preserves legacy aliases", () => {
    const resolver = new InputResolver(
      inputMappingsFromAssets([
        { ...action, name: "Leap", legacyName: "Jump" },
      ]),
    );
    const binding = resolver.bindings.getInputBindings({
      Name: "Jump",
      Asset: "jump",
    })[0]!;
    expect(resolver.bindings.beginInputRebind(binding)).toBe(true);
    expect(resolver.resolve([key("KeyH", "down")]).inputs.jump.held).toBe(
      false,
    );
    resolver.resolve([key("KeyH", "up")]);
    const pressed = resolver.resolve([key("KeyH", "down")]);
    expect(pressed.inputs.jump.started).toBe(true);
    expect(pressed.actions.Jump.held).toBe(true);
  });
});
