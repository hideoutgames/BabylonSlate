import { describe, expect, it } from "vitest";
import {
  ORDER_IN_LAYER_LIMIT,
  RENDERING_GROUP,
  applySortingToMesh,
  applySortingToSprite,
  clampOrderInLayer,
  computeSortKey,
  renderingGroupForLayer,
  resolveSortingLayer,
} from "./sorting";

describe("computeSortKey", () => {
  it("keeps every value inside one layer below the next layer's floor", () => {
    const layer0Max = computeSortKey(0, ORDER_IN_LAYER_LIMIT);
    const layer1Min = computeSortKey(1, -ORDER_IN_LAYER_LIMIT);
    expect(layer0Max).toBeLessThan(layer1Min);
  });

  it("orders by layer first, then by orderInLayer", () => {
    expect(computeSortKey(0, 10)).toBeLessThan(computeSortKey(1, -10));
    expect(computeSortKey(2, -5)).toBeLessThan(computeSortKey(2, 5));
  });

  it("clamps out-of-range order values instead of overflowing the stride", () => {
    expect(clampOrderInLayer(ORDER_IN_LAYER_LIMIT + 100)).toBe(
      ORDER_IN_LAYER_LIMIT,
    );
    expect(clampOrderInLayer(-ORDER_IN_LAYER_LIMIT - 1)).toBe(
      -ORDER_IN_LAYER_LIMIT,
    );
    expect(computeSortKey(0, ORDER_IN_LAYER_LIMIT + 50)).toBe(
      computeSortKey(0, ORDER_IN_LAYER_LIMIT),
    );
  });
});

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

  it("offsets a sprite's Z by a sub-pixel fraction of the sort key", () => {
    const sprite = { position: { z: 0 } };
    applySortingToSprite(
      sprite,
      resolveSortingLayer(["Default"], "Default", 1),
      100,
    );
    expect(sprite.position.z).toBeLessThan(0);
    expect(Math.abs(sprite.position.z)).toBeLessThan(1);
  });
});
