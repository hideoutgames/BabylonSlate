import { describe, expect, it } from "vitest";
import { actorPropertyReferences, type ActorPropertyReferenceClass } from "./actor-property-references";

describe("actorPropertyReferences", () => {
  it("follows inherited typed overrides in nested switcher entries without collecting text", () => {
    const schemas: Record<string, ActorPropertyReferenceClass> = {
      Base: { members: [
        { id: "art", kind: "variable", name: "Artwork", typeId: "asset", container: "array" },
        { id: "caption", kind: "variable", name: "Caption", typeId: "string" },
      ] },
      Screen: { parentClassId: "Base", members: [
        { id: "variants", kind: "variable", name: "Variants", typeId: "asset", container: "map", keyTypeId: "class" },
      ] },
    };
    const value = { classId: "SceneLayerActorSwitcher", properties: { sceneLayerActors: [{ classId: "Screen", defaults: { Artwork: ["texture"], Caption: "unrelated-asset", Variants: [{ key: "Popup", value: "material" }] } }] } };
    expect(actorPropertyReferences(value, id => schemas[id])).toEqual({ assetGuids: ["texture", "material"], classIds: ["Popup"] });
  });
  it("handles cyclic class ancestry and subtype variable replacement", () => {
    const schemas: Record<string, ActorPropertyReferenceClass> = {
      Parent: { parentClassId: "Child", members: [{ id: "a", kind: "variable", name: "Resource", typeId: "asset" }] },
      Child: { parentClassId: "Parent", members: [{ id: "b", kind: "variable", name: "Resource", typeId: "string" }] },
    };
    expect(actorPropertyReferences({ classId: "Child", properties: { Resource: "ordinary-text" } }, id => schemas[id])).toEqual({ assetGuids: [], classIds: [] });
  });
});
