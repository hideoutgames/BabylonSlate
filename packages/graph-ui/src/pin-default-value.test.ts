import { describe, expect, it } from "vitest";
import type { SerializedPin } from "./graph-types";
import { readPinDefaultValue } from "./pin-default-preview";
import { inlinePinDefaultStorageValue } from "./pin-default-value";

function pin(type: SerializedPin["type"], rest: Partial<SerializedPin> = {}): SerializedPin {
  return { id: "value", name: "Value", direction: "in", kind: "data", type, ...rest };
}

describe("inline numeric default storage", () => {
  it.each([{ __material: true }, { __particleRole: "operator" }])("keeps numeric graph host values as arrays: %j", (host) => {
    expect(inlinePinDefaultStorageValue(pin({ kind: "float" }), host, 0.123456789)).toEqual([0.123456789]);
    expect(inlinePinDefaultStorageValue(pin({ kind: "vec3" }), host, { x: 7, y: 0.123456789, z: -2 }))
      .toEqual([7, 0.123456789, -2]);
    expect(inlinePinDefaultStorageValue(pin({ kind: "vec3" }, { colorHint: true }), host, { x: 0.1, y: 0.2, z: 0.3, w: 1 }))
      .toEqual([0.1, 0.2, 0.3]);
  });

  it("keeps script scalars and named vector axes while preserving precision", () => {
    expect(inlinePinDefaultStorageValue(pin({ kind: "float" }), {}, 0.123456789)).toBe(0.123456789);
    expect(inlinePinDefaultStorageValue(pin({ kind: "rotator" }), {}, { pitch: 4, yaw: 0.123456789, roll: -7 }))
      .toEqual({ pitch: 4, yaw: 0.123456789, roll: -7 });
    expect(inlinePinDefaultStorageValue(pin({ kind: "int" }), {}, -2.75)).toBe(-2);
  });

  it("honors host bounds for scalar and vector defaults", () => {
    const alpha = pin({ kind: "float" }, { min: 0, max: 1 });
    expect(inlinePinDefaultStorageValue(alpha, { __particleRole: "module" }, 2)).toEqual([1]);
    expect(inlinePinDefaultStorageValue(alpha, { __particleRole: "module" }, -0.5)).toEqual([0]);
    expect(inlinePinDefaultStorageValue(pin({ kind: "vec3" }, { min: 0 }), { __particleRole: "module" }, { x: -1, y: 2, z: 3 }))
      .toEqual([0, 2, 3]);
  });

  it("preserves opaque legacy Particle colors and single-component splats", () => {
    const color = pin({ kind: "color" });
    const host = { __particleRole: "module", "default:value": [0.123456789, 0.2, 0.3] };
    const editable = readPinDefaultValue(color, host);
    expect(editable).toEqual({ x: 0.123456789, y: 0.2, z: 0.3, w: 1 });
    expect(inlinePinDefaultStorageValue(color, host, editable)).toEqual([0.123456789, 0.2, 0.3, 1]);
    expect(readPinDefaultValue(color, { "default:value": [0.5] })).toEqual({ x: 0.5, y: 0.5, z: 0.5, w: 0.5 });
    expect(readPinDefaultValue(pin({ kind: "vec3" }, { defaultValue: [2] }), {})).toEqual({ x: 2, y: 2, z: 2 });
  });

  it("never stores live object or actor constraint labels as literal values", () => {
    expect(inlinePinDefaultStorageValue(pin({ kind: "objectRef", classId: "Component" }), {}, "Component")).toBeUndefined();
    expect(inlinePinDefaultStorageValue(pin({ kind: "actorRef", classId: "Actor" }), {}, "Actor")).toBeUndefined();
    expect(inlinePinDefaultStorageValue(pin({ kind: "structRef", guid: "engine:InputBinding" }), {}, { Input: { Name: "Space" } })).toBeUndefined();
    expect(inlinePinDefaultStorageValue(pin({ kind: "structRef", guid: "user:Stats" }), {}, { Health: 100 })).toBeUndefined();
    expect(inlinePinDefaultStorageValue(pin({ kind: "structRef", guid: "engine:TagContainer" }), {}, { Tags: [2, 7] })).toEqual({ Tags: [2, 7] });
  });
});
