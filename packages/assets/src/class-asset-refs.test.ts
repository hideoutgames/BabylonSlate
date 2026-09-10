import { describe, expect, it } from "vitest";
import { findClassAssetReferences, replaceClassAssetReferences } from "./class-asset-refs";

const hero = { guid: "hero-guid", classId: "Hero" };
const replacement = { guid: "npc-guid", classId: "NPC" };

describe("Class reference replacement", () => {
  it("tracks and retargets the class selected by a Logic Component", () => {
    const component = { classId: "LogicComponent", properties: { logicClass: "Hero" } };
    expect(findClassAssetReferences(component, [hero])).toEqual(["hero-guid"]);
    expect(replaceClassAssetReferences(component, [{ ...hero, replacement }]).value.properties.logicClass).toBe("NPC");
  });
  it("replaces every instance and typed or GUID reference without changing display text", () => {
    const value = {
      actors: [{ id: "one", name: "Hero", classId: "Hero", components: [] },
        { id: "two", classId: "Hero", components: [] }],
      nodes: [{ data: { class: "Hero", typeClassId: "Hero", assetGuid: "hero-guid", text: "Hero" } }],
      parentClass: "Hero", dependencies: ["hero-guid", "keep"],
    };
    expect(findClassAssetReferences(value, [hero])).toEqual(["hero-guid"]);
    expect(replaceClassAssetReferences(value, [{ ...hero, replacement }]).value).toEqual({
      actors: [{ id: "one", name: "Hero", classId: "NPC", components: [] },
        { id: "two", classId: "NPC", components: [] }],
      nodes: [{ data: { class: "NPC", typeClassId: "NPC", assetGuid: "npc-guid", text: "Hero" } }],
      parentClass: "NPC", dependencies: ["npc-guid", "keep"],
    });
    expect(value.actors[0]!.classId).toBe("Hero");
  });

  it("clears None while preserving valid actor and component identities", () => {
    const value = {
      actors: [{ id: "actor", classId: "Hero", components: [
        { id: "component", classId: "Hero", properties: { amount: 1 } },
      ] }],
      parentClass: "Hero", gameInstanceClass: "Hero", editorUtilityObjects: ["Hero", "Keep"],
      nodes: [{ data: { classId: "Hero", class: "Hero", guid: "hero-guid" } }],
      dependencies: ["keep", "hero-guid"],
    };
    expect(replaceClassAssetReferences(value, [{ ...hero, replacement: null }]).value).toEqual({
      actors: [{ id: "actor", classId: "Actor", components: [
        { id: "component", classId: "ActorComponent", properties: { amount: 1 } },
      ] }],
      parentClass: "BObject", gameInstanceClass: null, editorUtilityObjects: ["Keep"],
      nodes: [{ data: { classId: null, class: null, guid: null } }],
      dependencies: ["keep"],
    });
  });

  it("does not rewrite class-looking text or mutate an unrelated payload", () => {
    const value = { name: "Hero", source: "new Hero()", note: "prefix-hero-guid", classId: "Keep" };
    expect(findClassAssetReferences(value, [hero])).toEqual([]);
    expect(replaceClassAssetReferences(value, [{ ...hero, replacement }])).toEqual({ value, changed: false });
    expect(replaceClassAssetReferences(value, [{ ...hero, replacement }]).value).toBe(value);
  });

  it("updates serialized Spawn Actor defaults and Class variable defaults", () => {
    const graph = { nodes: [{ properties: { "default:classId": "Hero", "default:text": "Hero" },
      pins: [{ type: { kind: "classRef", classId: "Hero" } }] }],
      variables: [{ typeId: "class", defaultValue: "Hero" }, { typeId: "string", defaultValue: "Hero" }] };
    const result = replaceClassAssetReferences(graph, [{ ...hero, replacement }]).value;
    expect(result.nodes[0]!.properties).toEqual({ "default:classId": "NPC", "default:text": "Hero" });
    expect(result.variables.map((entry) => entry.defaultValue)).toEqual(["NPC", "Hero"]);
    const cleared = replaceClassAssetReferences(graph, [{ ...hero, replacement: null }]).value;
    expect(cleared.nodes[0]!.pins[0]!.type.classId).toBe("BObject");
    expect(cleared.nodes[0]!.properties["default:classId"]).toBeNull();
  });

  it("rewrites Class arrays, map keys and values, and custom pin defaults without touching text entries", () => {
    const value = { members: [
      { container: "array", typeId: "class", defaultValue: ["Hero", "Keep"] },
      { container: "map", keyTypeId: "class", typeId: "string", defaultValue: [{ key: "Hero", value: "Hero" }] },
      { container: "map", keyTypeId: "string", typeId: "class", defaultValue: [{ key: "Hero", value: "Hero" }] },
    ], nodes: [{ pins: [{ id: "custom", type: { kind: "classRef", classId: "Actor" } }], properties: { "default:custom": "Hero" } }] };
    const result = replaceClassAssetReferences(value, [{ ...hero, replacement }]).value;
    expect(result.members.map((member) => member.defaultValue)).toEqual([
      ["NPC", "Keep"], [{ key: "NPC", value: "Hero" }], [{ key: "Hero", value: "NPC" }],
    ]);
    expect(result.nodes[0]!.properties["default:custom"]).toBe("NPC");
  });
});
