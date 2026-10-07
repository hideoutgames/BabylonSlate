import { describe, expect, it } from "vitest";
import { createActor, createDefaultScene, createMeshComponent, normalizeScene } from "./index";

describe("scene instance persistence", () => {
  it("round-trips suppressed prefab IDs and typed surface overrides without sharing source values", () => {
    const mesh = createMeshComponent("mesh");
    mesh.properties.materialGuid = "surface";
    mesh.materialInstance = { materialGuid: "surface", parameters: {
      Gain: { kind: "float", value: 0.5 }, Tint: { kind: "color", value: [1, 0, 0, 1] },
      Image: { kind: "texture", textureAssetGuid: "texture" }, Empty: { kind: "texture", textureAssetGuid: null },
    } };
    const source = { ...createDefaultScene(), actors: [createActor("actor", "Actor", {
      components: [mesh], suppressedComponentSourceIds: ["removed", "removed", " child "],
    })] };
    const restored = normalizeScene(JSON.parse(JSON.stringify(source)));
    expect(restored.actors[0]!.suppressedComponentSourceIds).toEqual(["removed", "child"]);
    expect(restored.actors[0]!.components[0]!.materialInstance).toStrictEqual(mesh.materialInstance);
    mesh.materialInstance.parameters.Gain = { kind: "float", value: 9 };
    expect(restored.actors[0]!.components[0]!.materialInstance!.parameters.Gain).toEqual({ kind: "float", value: 0.5 });
  });

  it("does not invent instance state for legacy components and drops invalid persisted parameter values", () => {
    const source = createDefaultScene();
    source.actors = [createActor("actor", "Actor", { components: [createMeshComponent("mesh")] })];
    expect(normalizeScene(source).actors[0]!.components[0]).not.toHaveProperty("materialInstance");
    const raw = { ...source, actors: [{ ...source.actors[0], suppressedComponentSourceIds: [null, "", "gone"], components: [{
      ...source.actors[0]!.components[0], materialInstance: { materialGuid: "surface", parameters: {
        Good: { kind: "float", value: 2 }, Invalid: { kind: "float", value: Infinity }, Wrong: { kind: "color", value: [1] },
      } },
    }] }] };
    const restored = normalizeScene(raw).actors[0]!;
    expect(restored.suppressedComponentSourceIds).toEqual(["gone"]);
    expect(restored.components[0]!.materialInstance).toEqual({ materialGuid: "surface", parameters: { Good: { kind: "float", value: 2 } } });
  });
});
