import { expect, it } from "vitest";
import { ClassRegistry } from "./class-registry";
import { engineEventTypeClassIds, engineScriptApiFor } from "./engine-script-api";
import { isSceneLayerAllowedComponent, isSceneLayerExclusiveComponent } from "./ids";

it("makes control asset overrides and range updates available as typed graph members", () => {
  const registry = new ClassRegistry();
  expect(registry.isA("2DRangeSliderComponent", "ActorComponent")).toBe(true);
  expect(isSceneLayerAllowedComponent("2DRangeSliderComponent")).toBe(true);
  expect(isSceneLayerExclusiveComponent("2DRangeSliderComponent")).toBe(true);
  const api = engineScriptApiFor("2DRangeSliderComponent")!;
  expect(api.variables).toEqual(expect.arrayContaining([
    expect.objectContaining({ propertyKey: "thumbMaterialGuid", typeId: "asset", typeClassId: "Material" }),
    expect.objectContaining({ propertyKey: "thumbTextureGuid", typeId: "asset", typeClassId: "Texture" }),
  ]));
  expect(api.functions?.find((entry) => entry.runtime === "setUIControlRange")?.pins).toEqual(expect.arrayContaining([
    { name: "lowerValue", direction: "in", typeId: "float" },
    { name: "upperValue", direction: "in", typeId: "float" },
    { name: "success", direction: "out", typeId: "bool" },
  ]));
  expect(engineEventTypeClassIds()["flow.event.uiRangeChanged"]).toContain("2DRangeSliderComponent");
});

it("offers input submission and selection events without making meters focusable", () => {
  const bindings = engineEventTypeClassIds();
  expect(bindings["flow.event.uiTextSubmitted"]).toContain("2DTextInputComponent");
  expect(bindings["flow.event.uiSelectionChanged"]).toContain("2DDropdownComponent");
  expect(bindings["flow.event.focusActivate"]).toContain("2DTextInputComponent");
  expect(bindings["flow.event.focusActivate"]).not.toContain("2DProgressBarComponent");
  expect(engineScriptApiFor("2DDropdownComponent")?.variables).toContainEqual({ name: "Options", propertyKey: "options", typeId: "string", container: "array" });
});
