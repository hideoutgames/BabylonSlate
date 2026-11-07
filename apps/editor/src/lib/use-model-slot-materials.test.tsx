import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { IndexedAsset } from "@haptic/assets";
import { useModelSlotMaterials } from "./use-model-slot-materials";

const registry = { list: vi.fn((): IndexedAsset[] => []) };
let registryEpoch = 0;

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  assetRegistry: registry,
  registryEpoch,
})));

afterEach(() => {
  cleanup();
  registry.list.mockClear();
  registryEpoch = 0;
});

describe("useModelSlotMaterials", () => {
  it("reads the saved Material key from the registry once per registry change, not on every render", () => {
    const hostRef = { current: null };
    const { rerender } = renderHook(
      ({ slots }: { slots: Array<{ index: number; name: string; materialGuid: string | null }> }) =>
        useModelSlotMaterials({ hostRef, engine: null, slots, generation: 0, onApplied: () => {} }),
      { initialProps: { slots: [{ index: 0, name: "Body", materialGuid: null }] } },
    );
    expect(registry.list).toHaveBeenCalledTimes(1);

    // A Model payload edit (a collider or slot change) re-renders the preview canvas.
    rerender({ slots: [{ index: 0, name: "Body", materialGuid: null }] });
    rerender({ slots: [{ index: 0, name: "Body", materialGuid: "mat-1" }] });
    expect(registry.list).toHaveBeenCalledTimes(1);

    registryEpoch = 1;
    rerender({ slots: [{ index: 0, name: "Body", materialGuid: "mat-1" }] });
    expect(registry.list).toHaveBeenCalledTimes(2);
  });
});
