import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { createDataRowForDefinition, type TypeSchemas } from "@babylonslate/scripting";
import { ProjectService } from "./project-service";
import { createPickerAsset, createProjectAsset } from "../lib/create-project-asset";

const fields = [{ id: "damage", name: "Damage", typeId: "float", defaultValue: 24 }];

describe("Data Definition and sheet persistence", () => {
  it("creates independent definitions and saves owned rows without changing another sheet", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("SheetData");
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
      const row = createDataRowForDefinition(definitionGuid, fields, typeSchemas, "Iron Sword", "sword");
      const createSheet = (name: string) => createProjectAsset({ registry, rootId: "project", folderRelative: "Data", type: "DataSheet", name, definitionGuid, typeSchemas,
        dataSheet: { kind: "dataSheet", definitionGuid, rows: [row] },
      });
      const first = await createSheet("Weapons");
      const second = await createSheet("Starter Weapons");
      const loaded = await project.loadDocument("data-sheet", first.path) as Record<string, unknown>;
      expect(loaded.rows).toMatchObject([{ id: "sword", name: "Iron Sword", values: { Damage: 24 } }]);
      await project.saveDocument("data-sheet", first.path, { ...loaded, rows: [{ ...row, values: { Damage: 36 } }] });
      await project.remountRegistry();
      expect(await project.loadDocument("data-sheet", first.path)).toMatchObject({ rows: [{ id: "sword", values: { Damage: 36 } }] });
      expect(await project.loadDocument("data-sheet", second.path)).toMatchObject({ rows: [{ id: "sword", values: { Damage: 24 } }] });
      expect(await project.loadDocument("data-definition", definition.path)).toEqual({ kind: "dataDefinition", fields });
      const indexed = project.registry!.getByGuid(first.header.guid)!;
      expect(indexed.header.name).toBe("Weapons");
      expect(indexed.header.payload.rows).toMatchObject([{ id: "sword", values: { Damage: 36 } }]);
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
      const sheet = await createPickerAsset({
        registry, ownerPath: definition.path, type: "DataSheet", name: "Equipment", definitionGuid,
        openDocuments: [{ ref: { kind: "data-definition", path: definition.path }, content: { kind: "dataDefinition", fields } }],
      });
      expect(await project.loadDocument("data-sheet", sheet.path)).toEqual({ kind: "dataSheet", definitionGuid, rows: [] });
      const structure = await createProjectAsset({ registry, rootId: "project", folderRelative: "", type: "Structure", name: "Unrelated" });
      await expect(createProjectAsset({ registry, rootId: "project", folderRelative: "", type: "DataSheet", name: "Invalid", definitionGuid: structure.header.guid,
        typeSchemas: { structs: { [structure.header.guid]: { name: "Unrelated", fields: [] } }, enums: {} },
      })).rejects.toThrow(/Data Definition/);
      expect(registry.list().some(asset => asset.header.name === "Invalid")).toBe(false);
    } finally { project.dispose(); }
  });
});
