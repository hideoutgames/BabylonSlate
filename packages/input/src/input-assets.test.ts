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
    const missingBindingId = JSON.parse(saved);
    delete missingBindingId.overrides[0].bindingId;
    expect(
      renamed.bindings.importBindings(JSON.stringify(missingBindingId)),
    ).toBe(false);
    const displayNameProfile = JSON.parse(saved);
    displayNameProfile.overrides[0].mapping = "Movement";
    expect(
      renamed.bindings.importBindings(JSON.stringify(displayNameProfile)),
    ).toBe(false);
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

  it("keeps same-name assets independent through their asset identities", () => {
    const resolver = new InputResolver(
      inputMappingsFromAssets([
        action,
        {
          ...action,
          guid: "other",
          bindings: [{ id: "keyboard", device: "key", code: "KeyJ" }],
        },
      ]),
    );
    const pressed = resolver.resolve([key("Space", "down")]);
    expect(pressed.inputs.jump.held).toBe(true);
    expect(pressed.inputs.other.held).toBe(false);
    const binding = resolver.bindings.getInputBindings({
      Name: "Jump",
      Asset: "jump",
    })[0]!;
    expect(
      resolver.bindings.setInputControl(binding, {
        Device: "key",
        Code: "KeyH",
        Shift: false,
        Ctrl: false,
        Alt: false,
        Meta: false,
      }),
    ).toBe(true);
    expect(
      resolver.bindings.getInputBindings({ Name: "Jump", Asset: "other" })[0]
        ?.Control.Code,
    ).toBe("KeyJ");
  });

  it("captures a replacement key without activating gameplay", () => {
    const resolver = new InputResolver(inputMappingsFromAssets([action]));
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
