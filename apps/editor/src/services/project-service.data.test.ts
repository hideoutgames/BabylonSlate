import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { createDataEntryForDefinition, type TypeSchemas } from "@babylonslate/scripting";
import { ProjectService } from "./project-service";
import { createPickerAsset, createProjectAsset } from "../lib/create-project-asset";

const fields = [{ id: "damage", name: "Damage", typeId: "float", defaultValue: 24 }];

describe("Data Definition and tree persistence", () => {
  it("creates independent definitions and saves owned entries and parent links without changing another tree", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("TreeData");
    const project = new ProjectService(storage);
    try {
      await project.loadCurrentProject();
      const registry = project.registry!;
      const definition = await createProjectAsset({
        registry, rootId: "project", folderRelative: "Data", type: "DataDefinition", name: "Weapon",
        dataDefinition: { kind: "dataDefinition", fields },
      });
      const definitionGuid = definition.header.guid;
      const schema = { name: "Weapon", fields };
      const typeSchemas: TypeSchemas = { structs: { [definitionGuid]: schema }, dataDefinitions: { [definitionGuid]: schema }, enums: {} };
      const parent = { id: "weapons", parentId: null, name: "Weapons", values: {}, definitionGuid: null };
      const entry = createDataEntryForDefinition(definitionGuid, fields, typeSchemas, "Iron Sword", "sword", parent.id);
      const createTree = (name: string) => createProjectAsset({ registry, rootId: "project", folderRelative: "Data", type: "DataTree", name, defaultDefinitionGuid: definitionGuid, typeSchemas,
        dataTree: { kind: "dataTree", defaultDefinitionGuid: definitionGuid, entries: [parent, entry] },
      });
      const first = await createTree("Weapons");
      const second = await createTree("Starter Weapons");
      const loaded = await project.loadDocument("data-tree", first.path) as Record<string, unknown>;
      expect(loaded.entries).toMatchObject([{ id: "weapons", parentId: null }, { id: "sword", parentId: "weapons", name: "Iron Sword", values: { Damage: 24 } }]);
      await project.saveDocument("data-tree", first.path, { ...loaded, entries: [parent, { ...entry, values: { Damage: 36 } }] });
      await project.remountRegistry();
      expect(await project.loadDocument("data-tree", first.path)).toMatchObject({ entries: [{ id: "weapons", parentId: null }, { id: "sword", parentId: "weapons", values: { Damage: 36 } }] });
      expect(await project.loadDocument("data-tree", second.path)).toMatchObject({ entries: [{ id: "weapons", parentId: null }, { id: "sword", parentId: "weapons", values: { Damage: 24 } }] });
      expect(await project.loadDocument("data-definition", definition.path)).toEqual({ kind: "dataDefinition", fields });
      const indexed = project.registry!.getByGuid(first.header.guid)!;
      expect(indexed.header.name).toBe("Weapons");
      expect(indexed.header.payload.entries).toMatchObject([{ id: "weapons", parentId: null }, { id: "sword", parentId: "weapons", values: { Damage: 36 } }]);
      expect(indexed.header.dependencies).toContain(definitionGuid);
      expect(project.registry!.list().filter(asset => asset.header.type === "Structure")).toHaveLength(0);
    } finally { project.dispose(); }
  });

  it("carries the live definition through picker creation and rejects a Structure as its definition", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("PickerData");
    const project = new ProjectService(storage);
    try {
      await project.loadCurrentProject();
      const registry = project.registry!;
      const definition = await createProjectAsset({ registry, rootId: "project", folderRelative: "", type: "DataDefinition", name: "Item" });
      const definitionGuid = definition.header.guid;
      const tree = await createPickerAsset({
        registry, ownerPath: definition.path, type: "DataTree", name: "Equipment", defaultDefinitionGuid: definitionGuid,
        openDocuments: [{ ref: { kind: "data-definition", path: definition.path }, content: { kind: "dataDefinition", fields } }],
      });
      expect(await project.loadDocument("data-tree", tree.path)).toEqual({ kind: "dataTree", defaultDefinitionGuid: definitionGuid, entries: [] });
      const grouping = await createProjectAsset({ registry, rootId: "project", folderRelative: "", type: "DataTree", name: "Organize First",
        dataTree: { kind: "dataTree", defaultDefinitionGuid: null, entries: [{ id: "group", parentId: null, name: "Equipment", values: {} }] },
      });
      expect(await project.loadDocument("data-tree", grouping.path)).toMatchObject({ defaultDefinitionGuid: null, entries: [{ name: "Equipment" }] });
      await expect(createProjectAsset({ registry, rootId: "project", folderRelative: "", type: "DataTree", name: "Invalid Hierarchy",
        dataTree: { kind: "dataTree", defaultDefinitionGuid: null, entries: [{ id: "orphan", parentId: "missing", name: "Orphan", values: {} }] },
      })).rejects.toThrow(/parent/i);
      const structure = await createProjectAsset({ registry, rootId: "project", folderRelative: "", type: "Structure", name: "Unrelated" });
      await expect(createProjectAsset({ registry, rootId: "project", folderRelative: "", type: "DataTree", name: "Invalid", defaultDefinitionGuid: structure.header.guid,
        typeSchemas: { structs: { [structure.header.guid]: { name: "Unrelated", fields: [] } }, enums: {} },
      })).rejects.toThrow(/Data Definition/);
      expect(registry.list().some(asset => asset.header.name === "Invalid")).toBe(false);
    } finally { project.dispose(); }
  });

  it("keeps Loading through save and reload and stamps Hard references into the saved headers", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("LoadingData");
    const project = new ProjectService(storage);
    try {
      await project.loadCurrentProject();
      const registry = project.registry!;
      const loadingFields = [
        { id: "mesh", name: "Mesh", typeId: "asset", typeClassId: "Model", loading: "hard" as const },
        { id: "icon", name: "Icon", typeId: "asset", typeClassId: "Texture" },
      ];
      const definition = await createProjectAsset({
        registry, rootId: "project", folderRelative: "Data", type: "DataDefinition", name: "Weapon",
        dataDefinition: { kind: "dataDefinition", fields: loadingFields },
      });
      const definitionGuid = definition.header.guid;
      const schema = { name: "Weapon", fields: loadingFields };
      const typeSchemas: TypeSchemas = { structs: { [definitionGuid]: schema }, dataDefinitions: { [definitionGuid]: schema }, enums: {} };
      const entry = createDataEntryForDefinition(definitionGuid, loadingFields, typeSchemas, "Sword", "sword");
      const tree = await createProjectAsset({ registry, rootId: "project", folderRelative: "Data", type: "DataTree", name: "Weapons", defaultDefinitionGuid: definitionGuid, typeSchemas,
        dataTree: { kind: "dataTree", defaultDefinitionGuid: definitionGuid, entries: [entry] },
      });
      await project.saveDocument("data-tree", tree.path, { kind: "dataTree", defaultDefinitionGuid: definitionGuid, entries: [{ ...entry, values: { Mesh: "sword-mesh", Icon: "sword-icon" } }] });

      const hero = await createProjectAsset({ registry, rootId: "project", folderRelative: "", type: "Class", name: "Hero" });
      const members = [
        { id: "weapon", kind: "variable", name: "Weapon", typeId: "asset", typeClassId: "Model", loading: "hard", defaultValue: "hero-weapon" },
        { id: "trophy", kind: "variable", name: "Trophy", typeId: "asset", typeClassId: "Model", defaultValue: "hero-trophy" },
      ];
      await project.saveDocument("graph", hero.path, { nodes: [], edges: [], members } as never);
      await project.remountRegistry();

      expect(await project.loadDocument("data-definition", definition.path)).toMatchObject({ fields: [{ id: "mesh", loading: "hard" }, { id: "icon" }] });
      expect((await project.loadDocument("data-definition", definition.path) as { fields: object[] }).fields[1]).not.toHaveProperty("loading");
      expect((await project.loadDocument("graph", hero.path) as { members: unknown[] }).members).toEqual(members);

      const treeHeader = project.registry!.getByGuid(tree.header.guid)!.header;
      expect(treeHeader.dependencies).toEqual(expect.arrayContaining(["sword-mesh", "sword-icon"]));
      expect(treeHeader.requiredDependencies).toContain("sword-mesh");
      expect(treeHeader.requiredDependencies).not.toContain("sword-icon");
      const heroHeader = project.registry!.getByGuid(hero.header.guid)!.header;
      expect(heroHeader.requiredDependencies).toEqual(["hero-weapon"]);
      expect(heroHeader.dependencies).toEqual(["hero-trophy", "hero-weapon"]);
      expect(heroHeader.requiredVariableNames).toEqual(["Weapon"]);
      expect(heroHeader.payload.variables).toMatchObject([{ id: "weapon", loading: "hard" }, { id: "trophy" }]);

      // A Structure declares Loading for the struct-typed variables that use it.
      const kit = await createProjectAsset({ registry: project.registry!, rootId: "project", folderRelative: "", type: "Structure", name: "Kit" });
      await project.saveDocument("structure", kit.path, { kind: "structure", guid: kit.header.guid, name: "Kit", fields: [
        { id: "sound", name: "Sound", typeId: "asset", typeClassId: "Audio", loading: "hard" },
        { id: "skin", name: "Skin", typeId: "asset", typeClassId: "Texture" },
      ] });
      const rig = await createProjectAsset({ registry: project.registry!, rootId: "project", folderRelative: "", type: "Class", name: "Rig" });
      await project.saveDocument("graph", rig.path, { nodes: [], edges: [], members: [
        { id: "kit", kind: "variable", name: "Kit", typeId: "struct", typeClassId: kit.header.guid, defaultValue: { Sound: "kit-sound", Skin: "kit-skin" } },
      ] } as never);
      const rigHeader = project.registry!.getByGuid(rig.header.guid)!.header;
      expect(rigHeader.dependencies).toEqual(expect.arrayContaining(["kit-sound", "kit-skin"]));
      expect(rigHeader.requiredDependencies).toContain("kit-sound");
      expect(rigHeader.requiredDependencies).not.toContain("kit-skin");
    } finally { project.dispose(); }
  });
});
