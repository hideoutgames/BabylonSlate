import { describe, expect, it } from "vitest";
import { createActor, createMeshComponent, type MaterialParameterCatalog } from "@babylonslate/core";
import { ClassRegistry, MaterialObject, World, createActorFromSerialized } from "@babylonslate/object-model";
import { RuntimeMaterialParameters } from "./runtime-material-parameters";

const catalog: MaterialParameterCatalog = { surface: { domain: "surface", planHash: "surface-plan", parameters: {
  Gain: { kind: "float", value: 1 }, Tint: { kind: "color", value: [1, 1, 1, 1] }, Image: { kind: "texture", textureAssetGuid: null },
} } };

function fixture() {
  const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
  const mesh = createMeshComponent("mesh");
  mesh.properties.materialGuid = "surface";
  mesh.materialInstance = { materialGuid: "surface", parameters: { Gain: { kind: "float", value: 0.25 } } };
  const actor = createActorFromSerialized(world, createActor("actor", "Actor", { components: [mesh] }))!;
  return { world, actor, component: actor.components[0]!, material: actor.components[0]!.getVariable("materialObject") as MaterialObject };
}

describe("RuntimeMaterialParameters authoring boundary", () => {
  it("loads and captures private values while a sibling and source asset retain their defaults", () => {
    const { actor, component, material } = fixture();
    const sibling = fixture().component;
    sibling.materialInstance = undefined;
    const parameters = new RuntimeMaterialParameters(catalog, ["texture"]);
    expect(parameters.get(material, "Gain", "float")).toEqual({ kind: "float", value: 0.25 });
    parameters.set(material, "Tint", { kind: "color", value: [0, 1, 0, 1] });
    parameters.set(material, "Image", { kind: "texture", textureAssetGuid: "texture" });
    const captured = parameters.captureOverrides(material)!;
    expect(captured).toEqual({ Gain: { kind: "float", value: 0.25 }, Tint: { kind: "color", value: [0, 1, 0, 1] }, Image: { kind: "texture", textureAssetGuid: "texture" } });
    expect(parameters.captureOverrides(sibling.getVariable("materialObject") as MaterialObject)).toEqual({});
    expect(catalog.surface!.parameters.Gain).toEqual({ kind: "float", value: 1 });
    captured.Gain = { kind: "float", value: 10 };
    expect(parameters.get(material, "Gain", "float")).toEqual({ kind: "float", value: 0.25 });
    expect(component.materialInstance!.parameters).toEqual({ Gain: { kind: "float", value: 0.25 } });
    actor.destroyed = true;
    expect(parameters.captureOverrides(material)).toBeNull();
  });

  it("validates the entire seed before applying and forgets authored values after reassignment", () => {
    const { component, material } = fixture();
    const parameters = new RuntimeMaterialParameters(catalog, ["texture"]);
    expect(parameters.seed(material, { Gain: { kind: "float", value: 0.75 }, Image: { kind: "texture", textureAssetGuid: "missing" } })).toBe(false);
    expect(parameters.get(material, "Gain", "float")).toEqual({ kind: "float", value: 0.25 });
    expect(parameters.seed(material, { Gain: { kind: "float", value: 0.75 }, Image: { kind: "texture", textureAssetGuid: "texture" } })).toBe(true);
    expect(parameters.resetValue(material, "Gain", "float")).toEqual({ kind: "float", value: 0.75 });
    const saved = parameters.captureOverrides(material)!;
    const recreated = fixture().material;
    const next = new RuntimeMaterialParameters(catalog, ["texture"]);
    expect(next.seed(recreated, saved)).toBe(true);
    expect(next.captureOverrides(recreated)).toEqual(saved);
    component.setVariable("materialGuid", null);
    component.setVariable("materialGuid", "surface");
    expect(parameters.captureOverrides(material)).toBeNull();
    expect(parameters.captureOverrides(component.getVariable("materialObject") as MaterialObject)).toEqual({});
  });
});
