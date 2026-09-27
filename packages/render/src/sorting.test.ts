import { describe, expect, it } from "vitest";
import { computeSortKey } from "@babylonslate/core";
import {
  RENDERING_GROUP,
  applySortingToMesh,
  applySortingToParticleSystem,
  renderingGroupForLayer,
  resolveSortingLayer,
} from "./sorting";

describe("resolveSortingLayer", () => {
  const layers = ["Background", "Default", "Foreground", "UI"];

  it("maps reserved layer names onto the reserved rendering groups", () => {
    expect(renderingGroupForLayer("Background")).toBe(
      RENDERING_GROUP.background,
    );
    expect(renderingGroupForLayer("Foreground")).toBe(
      RENDERING_GROUP.foreground,
    );
    expect(renderingGroupForLayer("UI")).toBe(RENDERING_GROUP.ui);
    expect(renderingGroupForLayer("Default")).toBe(RENDERING_GROUP.world);
  });

  it("resolves a known layer to its index and sort key", () => {
    const resolved = resolveSortingLayer(layers, "Foreground", 3);
    expect(resolved.layerIndex).toBe(2);
    expect(resolved.renderingGroupId).toBe(RENDERING_GROUP.foreground);
    expect(resolved.sortKey).toBe(computeSortKey(2, 3));
  });

  it("falls back to Default for an unknown layer while reporting -1", () => {
    const resolved = resolveSortingLayer(layers, "Effects", 0);
    expect(resolved.layerIndex).toBe(-1);
    expect(resolved.sortKey).toBe(computeSortKey(1, 0));
  });
});

describe("applySorting", () => {
  it("writes alphaIndex and renderingGroupId onto a mesh", () => {
    const mesh = { alphaIndex: 0, renderingGroupId: 0 };
    applySortingToMesh(mesh, resolveSortingLayer(["Default"], "Default", 7));
    expect(mesh.alphaIndex).toBe(computeSortKey(0, 7));
    expect(mesh.renderingGroupId).toBe(RENDERING_GROUP.world);
  });

  it("writes renderingGroupId onto a particle system", () => {
    const system = { renderingGroupId: 0 };
    applySortingToParticleSystem(
      system,
      resolveSortingLayer(["Background", "Default", "Foreground", "UI"], "UI", 4),
    );
    expect(system.renderingGroupId).toBe(RENDERING_GROUP.ui);
  });
});
