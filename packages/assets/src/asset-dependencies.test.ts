import { describe, expect, it } from "vitest";
import { collectAssetDependencyMetadata, DependencyMetadataUpgradeRequiredError, getRequiredDependencies } from "./asset-dependencies";
import { encodeAssetDocument } from "./asset-document";
import { readBabassetHeader } from "./babasset";

describe("typed asset dependencies", () => {
  it("keeps streamed scenes and disabled layers reachable without preparing them, while active components load normally", () => {
    const metadata = collectAssetDependencyMetadata("Scene", {
      settings: { environmentTextureGuid: "environment", sceneLayers: [
        { assetGuid: "hud", enabled: true }, { assetGuid: "pause", enabled: false },
      ] },
      actors: [{ classId: "Hero", components: [
        { classId: "MeshComponent", properties: { assetGuid: "model", materialGuid: "material" } },
        { classId: "SceneStreamingComponent", properties: { sceneGuid: "scene-b" } },
        { classId: "AudioComponent", properties: { audioAssetGuid: "sound" } },
        { classId: "ParticleComponent", properties: { particleSystemGuid: "spark" } },
        { classId: "2DTextComponent", properties: { fontAssetGuid: "font", text: "scene-c" } },
      ] }],
    }, { classes: [{ guid: "hero", classId: "Hero" }] });
    expect(metadata.dependencies).toEqual(["environment", "font", "hero", "hud", "material", "model", "pause", "scene-b", "sound", "spark"]);
    expect(getRequiredDependencies({ guid: "scene-a", ...metadata })).toEqual(["environment", "font", "hero", "hud", "material", "model", "sound", "spark"]);
  });

  it("keeps saved scene-owned material textures in the required source closure without loading stale overrides", async () => {
    const bytes = await encodeAssetDocument({ type: "Scene", guid: "scene", name: "Scene", version: 1, payload: {
      actors: [{ classId: "engine:Actor", suppressedComponentSourceIds: ["removed-component"], components: [
        { classId: "MeshComponent", properties: { materialGuid: "surface" }, materialInstance: {
          materialGuid: "surface", parameters: {
            Albedo: { kind: "texture", textureAssetGuid: "private-texture" },
            Empty: { kind: "texture", textureAssetGuid: null },
            Invalid: { kind: "texture", value: "not-a-persisted-texture" },
            Label: { kind: "string", value: "not-an-asset" },
          },
        } },
        { classId: "MeshComponent", properties: { materialGuid: "replacement" }, materialInstance: {
          materialGuid: "old-material", parameters: { Albedo: { kind: "texture", textureAssetGuid: "old-texture" } },
        } },
      ] }],
    } });
    const header = readBabassetHeader(bytes);
    expect(header.dependencies).toEqual(["private-texture", "replacement", "surface"]);
    expect(getRequiredDependencies(header)).toEqual(["private-texture", "replacement", "surface"]);
  });

  it("collects typed graph literals, nested structure collections and selected classes without treating free text as references", () => {
    const metadata = collectAssetDependencyMetadata("Class", {
      nodes: [{ id: "spawn", type: "spawn", data: { "default:class": "Enemy", "default:asset": "", Asset: "old-texture", text: "unrelated" } }], edges: [],
      members: [{ kind: "variable", name: "Catalog", typeId: "struct", typeClassId: "entry-schema", container: "array", defaultValue: [{ model: "enemy-model" }] }],
    }, {
      classes: [{ guid: "enemy-class", classId: "Enemy" }],
      definitionFields: guid => guid === "entry-schema" ? [{ name: "model", typeId: "asset", typeClassId: "Model" }] : undefined,
      graphPins: () => [
        { id: "class", name: "Class", direction: "in", type: { kind: "classRef", classId: "Actor" } },
        { id: "asset", name: "Asset", direction: "in", type: { kind: "assetRef", assetType: "Texture" } },
      ],
    });
    expect(metadata.dependencies).toEqual(["enemy-class", "enemy-model", "entry-schema"]);
    expect(metadata.requiredDependencies).toEqual(["entry-schema"]);
  });

  it("requires a model referenced by a prefab component even when a gameplay variable also references that model", () => {
    const metadata = collectAssetDependencyMetadata("Class", {
      nodes: [], edges: [],
      members: [{ kind: "variable", typeId: "asset", defaultValue: "shared-model" }],
      components: [{ classId: "MeshComponent", properties: { assetGuid: "shared-model" } }],
    });
    expect(metadata.dependencies).toEqual(["shared-model"]);
    expect(metadata.requiredDependencies).toEqual(["shared-model"]);
  });

  it("prepares input bindings, synchronous data literals and called modules while cold data remains deferred", () => {
    const metadata = collectAssetDependencyMetadata("Class", {
      nodes: [
        { id: "binding", type: "struct.make", data: { "default:Input": { Name: "Move", Asset: "move" } } },
        { id: "input", type: "input.axisEvent", data: {} },
        { id: "tree", type: "literal.makeAsset", data: { "default:in": "items" } },
        { id: "read", type: "data.readEntry", data: { definitionGuid: "item-schema" } },
        { id: "later", type: "data.readEntryAsync", data: { "default:tree": "later-items", definitionGuid: "later-schema" } },
        { id: "call", type: "functions.call", data: { classId: "InventoryFunctions", static: true } },
      ],
      edges: [
        { source: "binding", target: "input", targetHandle: "binding" },
        { source: "tree", target: "read", targetHandle: "tree" },
      ],
    }, { classes: [{ guid: "inventory-module", classId: "InventoryFunctions" }] });
    expect(metadata.dependencies).toEqual(["inventory-module", "item-schema", "items", "later-items", "later-schema", "move"]);
    expect(metadata.requiredDependencies).toEqual(["inventory-module", "item-schema", "items", "move"]);
  });

  it("requires nested data schemas while keeping asset values reachable without loading their sources", () => {
    const metadata = collectAssetDependencyMetadata("DataTree", {
      kind: "dataTree", defaultDefinitionGuid: "items",
      entries: [{ id: "sword", definitionGuid: "weapon", schema: [
        { name: "Appearance", typeId: "struct", typeClassId: "appearance", fields: [
          { name: "Mesh", typeId: "asset", typeClassId: "Model" },
          { name: "Quality", typeId: "enum", typeClassId: "quality" },
        ] },
      ], values: { Appearance: { Mesh: "sword-model", Quality: "Rare" } } }],
    });
    expect(metadata.dependencies).toEqual(["appearance", "items", "quality", "sword-model", "weapon"]);
    expect(metadata.requiredDependencies).toEqual(["appearance", "items", "quality", "weapon"]);
  });

  it("preserves required variable roles through inherited actor overrides without loading unrelated data variables", () => {
    const members = [
      { kind: "variable" as const, id: "inventory", name: "Inventory", propertyKey: "inventory", typeId: "asset", typeClassId: "DataTree", defaultValue: "default-tree" },
      { kind: "variable" as const, id: "catalog", name: "Catalog", typeId: "asset", typeClassId: "DataTree", defaultValue: "unused-default" },
    ];
    const base = { guid: "base", classId: "Base", members };
    const consumer = collectAssetDependencyMetadata("Class", {
      nodes: [
        { id: "value", type: "variables.get", data: { variableName: "Inventory", propertyKey: "inventory" } },
        { id: "read", type: "data.readEntry", data: {} },
      ], edges: [{ source: "value", target: "read", targetHandle: "tree" }],
    }, { parentClass: "Base", classes: [base] });
    expect(consumer.requiredVariableNames).toEqual(["inventory"]);
    const scene = collectAssetDependencyMetadata("Scene", {
      actors: [{ classId: "Hero", properties: { inventory: "override-tree", Catalog: "unused-override" } }],
    }, { classes: [base, { guid: "hero", classId: "Hero", parentClassId: "Base", requiredVariableNames: consumer.requiredVariableNames }] });
    expect(scene.dependencies).toEqual(["hero", "override-tree", "unused-override"]);
    expect(scene.requiredDependencies).toEqual(["hero", "override-tree"]);
  });

  it("stamps saved documents and requires an explicit upgrade for legacy metadata", async () => {
    const bytes = await encodeAssetDocument({ type: "Font", guid: "font", name: "Font", version: 1, payload: { fallbackGuids: ["fallback"] } });
    expect(getRequiredDependencies(readBabassetHeader(bytes))).toEqual(["fallback"]);
    expect(() => getRequiredDependencies({ guid: "old" })).toThrow(DependencyMetadataUpgradeRequiredError);
  });

  it("keeps command registration and unresolved typed Class identities in catalog metadata", async () => {
    const command = await encodeAssetDocument({ type: "Class", guid: "command", name: "Heal", version: 1, payload: {
      nodes: [{ id: "run", type: "flow.event.commandRun", data: {
        commandName: "heal", description: "Restore health", parameters: [{ name: "amount", type: "int" }],
      } }], edges: [],
    } }, { parentClass: "BDebugCommand" });
    const header = readBabassetHeader(command);
    expect(header.consoleCommand).toEqual({ name: "heal", description: "Restore health", category: "game", parameters: [{ name: "amount", type: "int" }] });
    const scene = collectAssetDependencyMetadata("Scene", { actors: [{ classId: "CustomActor", components: [] }] });
    expect(scene.requiredClassReferences).toEqual(["CustomActor"]);
    expect(scene.requiredDependencies).toEqual([]); // Registry resolves the symbolic identity using header metadata.
  });
});
