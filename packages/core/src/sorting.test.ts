import { describe, expect, it } from "vitest";
import {
  ORDER_IN_LAYER_LIMIT,
  clampOrderInLayer,
  computeSortKey,
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
