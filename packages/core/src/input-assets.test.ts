import { describe, expect, it } from "vitest";
import { normalizeInputAssetPayload } from "./input-assets";

describe("input asset controls", () => {
  it("preserves stable bindings and axis tuning while assigning missing identities", () => {
    const asset = normalizeInputAssetPayload("InputAxis", {
      valueType: "2d",
      bindings: [
        {
          id: "left",
          device: "key",
          code: "KeyA",
          component: "x",
          digitalValue: -1,
        },
        {
          device: "gamepadAxis",
          code: "0:1",
          component: "y",
          invert: true,
          deadZone: 0.15,
        },
      ],
    });
    expect(asset).toEqual({
      valueType: "2d",
      bindings: [
        {
          id: "left",
          device: "key",
          code: "KeyA",
          component: "x",
          digitalValue: -1,
        },
        {
          id: "binding-2",
          device: "gamepadAxis",
          code: "0:1",
          component: "y",
          invert: true,
          deadZone: 0.15,
        },
      ],
    });
    expect(
      normalizeInputAssetPayload("InputAxis", {
        ...asset,
        bindings: [...asset.bindings].reverse(),
      }).bindings.map((b) => b.id),
    ).toEqual(["binding-2", "left"]);
  });
  it("keeps incomplete authoring rows but rejects unsupported devices and duplicate identities", () => {
    const asset = normalizeInputAssetPayload("InputAction", {
      bindings: [
        {
          id: "one",
          device: "key",
          code: "",
          modifiers: { ctrl: true, alt: false },
        },
        { id: "one", device: "mouseButton", code: "0" },
        { device: "invalid", code: "A" },
      ],
    });
    expect(asset.bindings).toEqual([
      { id: "one", device: "key", code: "", modifiers: { ctrl: true } },
      { id: "one-copy", device: "mouseButton", code: "0" },
    ]);
    expect(normalizeInputAssetPayload("InputAction", {}).bindings).toEqual([]);
  });
});
