import { describe, expect, it, vi } from "vitest";
import type { SerializedComponent } from "@haptic/core";
import type { PropertyRow } from "@haptic/editor-kit";
import { animationGraphPropertyRows, particlePropertyRows } from "./asset-component-property-rows";
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

describe("Animation Graph component rows", () => {
  const assets: Record<string, { type: string; payload: Record<string, unknown> }> = {
    "knight-graph": { type: "AnimationGraph3D", payload: { skeletonGuid: "knight-rig" } },
    "robot-graph": { type: "AnimationGraph2D", payload: { skeletonGuid: null } },
    knight: { type: "Model", payload: { materialSlots: [], skeletonGuid: "knight-rig" } },
    crate: { type: "Model", payload: { materialSlots: [], skeletonGuid: null } },
  };
  const status = (graphGuid: string, modelGuid: string) => {
    const actorContext: ComponentPropertyContext = {
      ...context,
      assetType: (guid) => (guid ? assets[guid]?.type : undefined),
      assetPayload: (guid) => assets[guid]?.payload,
      actorComponents: () => [{ id: "mesh", classId: "MeshComponent", properties: { assetGuid: modelGuid } } as SerializedComponent],
    };
    const component = { id: "anim", classId: "AnimationGraphComponent", properties: { graphGuid } } as SerializedComponent;
    return animationGraphPropertyRows("actor", component, vi.fn(), actorContext)[0]!.status;
  };

  it("say when a 3D graph's Skeleton is not the one the actor's Model is on", () => {
    expect(status("knight-graph", "knight")).toBeUndefined();
    expect(status("knight-graph", "crate")).toMatch(/Skeleton differs/);
    // A 2D graph has no Skeleton to compare.
    expect(status("robot-graph", "crate")).toBeUndefined();
  });
});
