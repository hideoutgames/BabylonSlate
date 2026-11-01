import { describe, expect, it } from "vitest";
import { engineScriptApiFor } from "./engine-script-api";
import { engineComponentPropertyCapability, isTimelineAnimatableComponentProperty } from "./live-properties";

const animatable = (classId: string) => (engineScriptApiFor(classId)?.variables ?? [])
  .filter((variable) => isTimelineAnimatableComponentProperty(classId, variable))
  .map((variable) => variable.propertyKey);

describe("engineComponentPropertyCapability", () => {
  it("keeps the runtime inspector's live, rebuild and new-session rules", () => {
    expect(engineComponentPropertyCapability("LightComponent", { propertyKey: "intensity", typeId: "float" })).toBe("live");
    expect(engineComponentPropertyCapability("MeshComponent", { propertyKey: "castShadows", typeId: "bool" })).toBe("live");
    expect(engineComponentPropertyCapability("MeshComponent", { propertyKey: "meshKind", typeId: "string" })).toBeUndefined();
    expect(engineComponentPropertyCapability("AudioComponent", { propertyKey: "volume", typeId: "float" })).toBe("live");
    expect(engineComponentPropertyCapability("AudioComponent", { propertyKey: "loop", typeId: "bool" })).toBeUndefined();
    expect(engineComponentPropertyCapability("ColliderComponent", { propertyKey: "isTrigger", typeId: "bool" })).toBe("rebuild");
    expect(engineComponentPropertyCapability("LightComponent", { propertyKey: "tags", typeId: "string", container: "map" })).toBeUndefined();
  });
});

describe("isTimelineAnimatableComponentProperty", () => {
  it("offers live single values of track value types", () => {
    expect(animatable("LightComponent")).toEqual([
      "enabled", "color", "intensity", "lightKind", "range", "innerAngle", "outerAngle", "castShadows", "shadowPriority",
    ]);
    expect(animatable("AudioComponent")).toEqual(["volume"]);
    // A Collider rebuilds rather than changing live.
    expect(animatable("ColliderComponent")).toEqual([]);
  });

  it("offers a Mesh's Material but no other asset", () => {
    expect(animatable("MeshComponent")).toContain("materialGuid");
    expect(animatable("2DTextComponent")).not.toContain("fontAssetGuid");
  });

  it("offers the 2D properties tweens animate", () => {
    expect(animatable("2DTextComponent")).toEqual(["size", "color", "opacity", "tint", "outline", "outlineColor", "wrapWidth", "wrapHeight"]);
    expect(animatable("2DAnchorComponent")).toEqual(["offsetX", "offsetY"]);
    expect(animatable("2DVerticalBoxComponent")).toEqual(expect.arrayContaining(["width", "height"]));
    expect(animatable("2DPaddingComponent")).not.toContain("width");
    expect(animatable("2DScrollBoxComponent")).toEqual(expect.arrayContaining(["scrollX", "scrollY"]));
  });

  it("leaves out read-only, array and unsupported types", () => {
    expect(isTimelineAnimatableComponentProperty("LightComponent", { name: "Intensity", typeId: "float", propertyKey: "intensity", getOnly: true })).toBe(false);
    expect(isTimelineAnimatableComponentProperty("LightComponent", { name: "Values", typeId: "float", propertyKey: "intensity", container: "array" })).toBe(false);
    expect(isTimelineAnimatableComponentProperty("LightComponent", { name: "Target", typeId: "actor", propertyKey: "intensity" })).toBe(false);
  });
});
