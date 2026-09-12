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
  it("adds and removes typed action keys and restores authored defaults", () => {
    const resolver = new InputResolver(inputMappingsFromAssets([action, axis]));
    const input = { Name: "Ignored", Asset: "jump" };
    expect(
      resolver.bindings.addInputActionBinding(input, "Gamepad2Button0"),
    ).toBe(true);
    expect(resolver.bindings.addInputAxisBinding(input, "KeyW")).toBe(false);
    expect(resolver.bindings.addInputActionBinding(input, "None")).toBe(false);
    const binding = resolver.bindings.getInputBindings(input)[1]!;
    expect(binding).toMatchObject({
      Key: "Gamepad2Button0",
      Input: { Name: "Jump", Asset: "jump" },
    });
    expect(
      resolver.resolve([
        { kind: "gamepad", tick: 0, gamepadIndex: 1, axes: [], buttons: [1] },
      ]).inputs.jump.held,
    ).toBe(true);
    expect(resolver.bindings.setInputActionBinding(binding, "MouseLeft")).toBe(
      true,
    );
    expect(resolver.resolve([]).inputs.jump.released).toBe(true);
    expect(
      resolver.resolve([
        {
          kind: "pointer",
          tick: 0,
          pointerId: 1,
          phase: "down",
          x: 0,
          y: 0,
          button: 0,
        },
      ]).inputs.jump.held,
    ).toBe(true);
    expect(resolver.bindings.removeInputActionBinding(input, "MouseLeft")).toBe(
      true,
    );
    expect(resolver.resolve([]).inputs.jump.released).toBe(true);
    expect(resolver.bindings.removeInputActionBinding(input, "Space")).toBe(
      true,
    );
    expect(resolver.resolve([key("Space", "down")]).inputs.jump.held).toBe(
      false,
    );
    expect(resolver.bindings.resetInputBindings(input)).toBe(true);
    expect(resolver.resolve([]).inputs.jump.held).toBe(true);
    expect(resolver.bindings.getInputBindings(input)).toHaveLength(1);
  });

  it("persists typed axis edits by stable binding identity with direction and shaping", () => {
    const original = {
      ...axis,
      bindings: [
        {
          id: "forward",
          device: "key" as const,
          code: "KeyW",
          component: "y" as const,
          digitalValue: -1,
          scale: 0.8,
          sensitivity: 0.5,
          deadZone: 0.2,
        },
        ...axis.bindings,
      ],
    };
    const input = { Name: "Move", Asset: "move" };
    const resolver = new InputResolver(
      inputMappingsFromAssets([original, action]),
    );
    const forward = resolver.bindings.getInputBindings(input)[0]!;
    expect(resolver.bindings.setInputAxisBinding(forward, "ArrowUp")).toBe(
      true,
    );
    expect(resolver.bindings.setInputActionBinding(forward, "ArrowUp")).toBe(
      false,
    );
    expect(
      resolver.bindings.addInputAxisBinding(input, "KeyH", {
        Component: "X",
        DigitalValue: -1,
        Scale: 0.5,
      }),
    ).toBe(true);
    const added = resolver.bindings.getInputBindings(input)[2]!;
    expect(resolver.bindings.setInputAxisBinding(added, "KeyJ")).toBe(true);
    expect(resolver.bindings.removeInputAxisBinding(input, "KeyD")).toBe(true);
    const saved = resolver.bindings.exportBindings();
    const restored = new InputResolver(
      inputMappingsFromAssets([
        {
          ...original,
          name: "Movement",
          bindings: [...original.bindings].reverse(),
        },
        action,
      ]),
    );
    expect(restored.bindings.importBindings(saved)).toBe(true);
    expect(
      restored.resolve([
        key("ArrowUp", "down"),
        key("KeyJ", "down"),
        key("KeyD", "down"),
      ]).inputs.move.value,
    ).toEqual({ x: -0.5, y: -0.4 });
    expect(restored.bindings.getInputBindings(input)[0]).toMatchObject({
      Id: "forward",
      Key: "ArrowUp",
      Component: "Y",
      DigitalValue: -1,
      Scale: 0.8,
      Sensitivity: 0.5,
      DeadZone: 0.2,
    });
    expect(restored.bindings.getInputBindings(input)[1].Id).toBe(added.Id);
    const invalid = JSON.parse(saved);
    invalid.edits[0].mapping = "missing";
    expect(restored.bindings.importBindings(JSON.stringify(invalid))).toBe(
      false,
    );
    expect(restored.resolve([]).inputs.move.value).toEqual({
      x: -0.5,
      y: -0.4,
    });
    expect(restored.bindings.resetInputBindings(input)).toBe(true);
    expect(restored.resolve([]).inputs.move.value).toEqual({ x: 1, y: 0 });
  });

  it("removes every occurrence of a key only from the selected asset", () => {
    const resolver = new InputResolver(
      inputMappingsFromAssets([axis, { ...axis, guid: "other" }]),
    );
    const input = { Name: "", Asset: "move" };
    expect(
      resolver.bindings.addInputAxisBinding(input, "KeyD", {
        Component: "Y",
        Shift: true,
      }),
    ).toBe(true);
    expect(resolver.bindings.removeInputAxisBinding(input, "KeyD")).toBe(true);
    expect(resolver.bindings.getInputBindings(input)).toEqual([]);
    const tick = resolver.resolve([key("KeyD", "down")]);
    expect(tick.inputs.move.value).toEqual({ x: 0, y: 0 });
    expect(tick.inputs.other.value).toEqual({ x: 1, y: 0 });
    expect(resolver.bindings.removeInputAxisBinding(input, "KeyD")).toBe(false);
  });
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
        ?.Key,
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
