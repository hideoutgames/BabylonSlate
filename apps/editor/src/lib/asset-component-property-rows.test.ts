import { describe, expect, it, vi } from "vitest";
import type { SerializedComponent } from "@haptic/core";
import type { PropertyRow } from "@haptic/editor-kit";
import { particlePropertyRows } from "./asset-component-property-rows";
import type { ComponentPropertyContext } from "./component-property-row-helpers";

const context: ComponentPropertyContext = {
  sortingLayers: ["Default"],
  collisionLayers: [],
  assetLabel: () => undefined,
  physicsWorld: "3d",
  onPickAsset: () => {},
};

function particle(properties: Record<string, unknown>): SerializedComponent {
  return { id: "sparks", classId: "ParticleComponent", properties } as SerializedComponent;
}

const retriggerRow = (rows: PropertyRow[]) =>
  rows.find((row) => row.label === "Retrigger") as Extract<PropertyRow, { kind: "enum" }> | undefined;

describe("Particle component rows", () => {
  it("offer Retrigger as Overlap or Restart, reading Overlap for a missing or unknown value", () => {
    const update = vi.fn();
    for (const value of [undefined, "sideways"]) {
      const row = retriggerRow(particlePropertyRows("actor", particle({ retrigger: value }), update, context))!;
      expect(row.value).toBe("overlap");
      expect(row.options).toEqual([{ value: "overlap", label: "Overlap" }, { value: "restart", label: "Restart" }]);
    }
    const row = retriggerRow(particlePropertyRows("actor", particle({ retrigger: "restart" }), update, context))!;
    expect(row.value).toBe("restart");
    row.onChange("overlap");
    expect(update).toHaveBeenCalledWith("retrigger", "overlap");
    // The generic rows below never list it a second time.
    expect(particlePropertyRows("actor", particle({ retrigger: "restart" }), update, context)
      .filter((entry) => entry.id.endsWith("retrigger"))).toHaveLength(1);
  });
});
