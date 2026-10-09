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

  describe("Loading policy", () => {
    it("requires Hard asset variables and their keys while Soft variables stay referenced", () => {
      const metadata = collectAssetDependencyMetadata("Class", { nodes: [], edges: [], members: [
        { kind: "variable", name: "Weapon", propertyKey: "weapon", typeId: "asset", typeClassId: "Model", loading: "hard", defaultValue: "hard-model" },
        { kind: "variable", name: "Cue", typeId: "asset", typeClassId: "Audio", defaultValue: "soft-audio" },
        { kind: "variable", name: "Cues", typeId: "asset", typeClassId: "Audio", container: "array", loading: "hard", defaultValue: ["cue-a", "cue-b"] },
        { kind: "variable", name: "Skins", typeId: "asset", container: "map", keyTypeId: "asset", loading: "hard", defaultValue: [{ key: "skin-key", value: "skin-value" }] },
      ] });
      expect(metadata.dependencies).toEqual(["cue-a", "cue-b", "hard-model", "skin-key", "skin-value", "soft-audio"]);
      expect(metadata.requiredDependencies).toEqual(["cue-a", "cue-b", "hard-model", "skin-key", "skin-value"]);
      expect(metadata.requiredVariableNames).toEqual(["Cues", "Skins", "weapon"]);
      // A function-local variable has no owner whose instance overrides could inherit the role.
      const local = { kind: "variable", name: "Weapon", typeId: "asset", loading: "hard", functionId: "fn" };
      expect(collectAssetDependencyMetadata("Class", { nodes: [], edges: [], members: [local] }).requiredVariableNames).toEqual([]);
    });

    it("requires the default Class of a Hard Class variable but never its base Class constraint", () => {
      const metadata = collectAssetDependencyMetadata("Class", { nodes: [], edges: [], members: [
        { kind: "variable", name: "Boss", typeId: "class", typeClassId: "Enemy", loading: "hard", defaultValue: "Brute" },
        { kind: "variable", name: "Minion", typeId: "class", typeClassId: "Enemy", defaultValue: "Imp" },
      ] }, { classes: [
        { guid: "enemy-class", classId: "Enemy" }, { guid: "brute-class", classId: "Brute" }, { guid: "imp-class", classId: "Imp" },
      ] });
      expect(metadata.classReferences).toEqual(["Brute", "Enemy", "Imp"]);
      expect(metadata.requiredClassReferences).toEqual(["Brute"]);
      expect(metadata.requiredDependencies).toEqual(["brute-class"]);
    });

    it("lets the innermost declaring field decide for struct-typed variables", () => {
      const schemas: Record<string, readonly unknown[]> = {
        outer: [{ name: "Inner", typeId: "struct", typeClassId: "inner" }, { name: "Banner", typeId: "asset", typeClassId: "Texture" }],
        inner: [{ name: "Mesh", typeId: "asset", typeClassId: "Model", loading: "hard" }, { name: "Skin", typeId: "asset", typeClassId: "Texture" }],
      };
      const metadata = collectAssetDependencyMetadata("Class", { nodes: [], edges: [], members: [
        { kind: "variable", name: "Loadout", typeId: "struct", typeClassId: "outer", defaultValue: { Inner: { Mesh: "mesh", Skin: "skin" }, Banner: "banner" } },
      ] }, { definitionFields: guid => schemas[guid] });
      expect(metadata.dependencies).toEqual(["banner", "inner", "mesh", "outer", "skin"]);
      expect(metadata.requiredDependencies).toEqual(["inner", "mesh", "outer"]);
    });

    it("keeps a synchronously read variable wholly required whatever its fields declare", () => {
      const metadata = collectAssetDependencyMetadata("Class", {
        nodes: [
          { id: "get", type: "variables.get", data: { variableName: "Loadout" } },
          { id: "input", type: "input.axisEvent", data: {} },
        ],
        edges: [{ source: "get", target: "input", targetHandle: "binding" }],
        members: [
          { kind: "variable", name: "Loadout", typeId: "struct", typeClassId: "loadout", defaultValue: { Mesh: "mesh", Skin: "skin" } },
          { kind: "variable", name: "Spare", typeId: "asset", typeClassId: "Model", defaultValue: "spare" },
        ],
      }, { definitionFields: guid => guid === "loadout" ? [
        { name: "Mesh", typeId: "asset", typeClassId: "Model", loading: "hard" }, { name: "Skin", typeId: "asset", typeClassId: "Texture" },
      ] : undefined });
      expect(metadata.requiredVariableNames).toEqual(["Loadout"]);
      expect(metadata.requiredDependencies).toEqual(["loadout", "mesh", "skin"]);
      expect(metadata.dependencies).toEqual(["loadout", "mesh", "skin", "spare"]);
    });

    it("requires Hard references of Data Tree entries and lets the Definition's current Loading decide", () => {
      const definition = [
        { id: "mesh", name: "Mesh", typeId: "asset", typeClassId: "Model", loading: "hard" },
        { id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture" },
        { id: "sound", name: "Sound", typeId: "asset", typeClassId: "Audio", loading: "hard" },
      ];
      // This snapshot predates the Definition's Loading: Mesh and Sound were Soft, Icon was Hard.
      const stale = [
        { id: "mesh", name: "Mesh", typeId: "asset", typeClassId: "Model" },
        { id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture", loading: "hard" },
        { id: "sound", name: "Sound", typeId: "asset", typeClassId: "Audio" },
      ];
      const metadata = collectAssetDependencyMetadata("DataTree", {
        kind: "dataTree", defaultDefinitionGuid: "weapon",
        entries: [
          { id: "sword", parentId: null, name: "Sword", definitionGuid: "weapon", schema: stale,
            values: { Mesh: "sword-mesh", Icon: "sword-icon", Sound: "sword-sound" } },
          // No snapshot: the inherited Definition types the values.
          { id: "axe", parentId: null, name: "Axe", values: { Mesh: "axe-mesh", Icon: "axe-icon", Sound: "axe-sound" } },
          // Untyped data has no declaration, so it stays a plain value.
          { id: "note", parentId: null, name: "Note", definitionGuid: null, values: { Mesh: "note-mesh" } },
        ],
      }, { definitionFields: guid => guid === "weapon" ? definition : undefined });
      expect(metadata.requiredDependencies).toEqual(["axe-mesh", "axe-sound", "sword-mesh", "sword-sound", "weapon"]);
      expect(metadata.dependencies).toEqual(expect.arrayContaining(["axe-icon", "sword-icon", "weapon"]));
      expect(metadata.dependencies).not.toContain("note-mesh");
    });

    it("falls back to the stored snapshot when a Data Tree entry's Definition cannot be resolved", () => {
      const metadata = collectAssetDependencyMetadata("DataTree", {
        kind: "dataTree", defaultDefinitionGuid: null,
        entries: [{ id: "sword", parentId: null, name: "Sword", definitionGuid: "missing", schema: [
          { id: "mesh", name: "Mesh", typeId: "asset", typeClassId: "Model", loading: "hard" },
          { id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture" },
        ], values: { Mesh: "sword-mesh", Icon: "sword-icon" } }],
      });
      expect(metadata.requiredDependencies).toEqual(["missing", "sword-mesh"]);
      expect(metadata.dependencies).toEqual(["missing", "sword-icon", "sword-mesh"]);
    });

    it("requires Hard references stored in a Data Definition or Structure default", () => {
      for (const assetType of ["DataDefinition", "Structure"]) {
        const metadata = collectAssetDependencyMetadata(assetType, { kind: "dataDefinition", fields: [
          { id: "mesh", name: "Mesh", typeId: "asset", typeClassId: "Model", loading: "hard", defaultValue: "default-mesh" },
          { id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture", defaultValue: "default-icon" },
        ] });
        expect(metadata.requiredDependencies).toEqual(["default-mesh"]);
        expect(metadata.dependencies).toEqual(["default-icon", "default-mesh"]);
      }
    });

    it("makes a Scene require instance overrides of a Hard property, not of a Soft one", () => {
      // A closed Class header lists its variables by name and type, without defaults or Loading.
      const header = [
        { id: "weapon", kind: "variable" as const, name: "Weapon", typeId: "asset", typeClassId: "Model" },
        { id: "trophy", kind: "variable" as const, name: "Trophy", typeId: "asset", typeClassId: "Model" },
      ];
      const hero = collectAssetDependencyMetadata("Class", { nodes: [], edges: [], members: [
        { ...header[0], loading: "hard", defaultValue: "default-weapon" }, { ...header[1], defaultValue: "default-trophy" },
      ] });
      expect(hero.requiredVariableNames).toEqual(["Weapon"]);
      const scene = collectAssetDependencyMetadata("Scene", {
        actors: [{ classId: "Hero", properties: { Weapon: "placed-weapon", Trophy: "placed-trophy" } }],
      }, { classes: [{ guid: "hero", classId: "Hero", members: header, requiredVariableNames: hero.requiredVariableNames }] });
      expect(scene.dependencies).toEqual(["hero", "placed-trophy", "placed-weapon"]);
      expect(scene.requiredDependencies).toEqual(["hero", "placed-weapon"]);
    });

    it("stamps the Hard role of a Class variable into saved documents", async () => {
      const bytes = await encodeAssetDocument({ type: "Class", guid: "hero", name: "Hero", version: 1, payload: {
        nodes: [], edges: [], members: [
          { id: "weapon", kind: "variable", name: "Weapon", typeId: "asset", typeClassId: "Model", loading: "hard", defaultValue: "sword" },
          { id: "trophy", kind: "variable", name: "Trophy", typeId: "asset", typeClassId: "Model", defaultValue: "cup" },
        ],
      } });
      const header = readBabassetHeader(bytes);
      expect(header.dependencies).toEqual(["cup", "sword"]);
      expect(getRequiredDependencies(header)).toEqual(["sword"]);
      expect(header.requiredVariableNames).toEqual(["Weapon"]);
    });
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
