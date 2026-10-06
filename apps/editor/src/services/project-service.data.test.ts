import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { ProjectService } from "./project-service";
import { createPickerAsset, createProjectAsset } from "../lib/create-project-asset";

describe("standalone data asset persistence", () => {
  it("creates from live Structure defaults without a sheet and keeps indexed values current after save", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("StandaloneData");
    const project = new ProjectService(storage);
    try {
      await project.loadCurrentProject();
      const registry = project.registry!;
      const structure = await createProjectAsset({
        registry, rootId: "project", folderRelative: "Data", type: "Structure", name: "Weapon",
      });
      const structureGuid = structure.header.guid;
      const object = await createPickerAsset({
        registry, ownerPath: structure.path, type: "DataObject", name: "Iron Sword", structureGuid,
        openDocuments: [{ ref: { kind: "structure", path: structure.path }, content: {
          kind: "structure", guid: structureGuid, name: "Weapon",
          fields: [{ id: "damage", name: "Damage", typeId: "float", defaultValue: 24 }],
        } }],
      });
      expect(registry.list().filter(asset => asset.header.type === "DataSheet")).toHaveLength(0);
      const loaded = await project.loadDocument("data-object", object.path) as Record<string, unknown>;
      expect(loaded.values).toEqual({ Damage: 24 });
      expect(loaded.schema).toEqual([{ id: "damage", name: "Damage", typeId: "float" }]);
      const originalGuid = object.header.guid;
      await project.saveDocument("data-object", object.path, { ...loaded, values: { Damage: 36 } });
      await project.remountRegistry();
      const reopened = await project.loadDocument("data-object", object.path) as Record<string, unknown>;
      expect(reopened.values).toEqual({ Damage: 36 });
      const indexed = project.registry!.getByGuid(originalGuid)!;
      expect(indexed.header.name).toBe("Iron Sword");
      expect(indexed.header.payload.values).toEqual({ Damage: 36 });
      expect(indexed.header.payload.structureGuid).toBe(structureGuid);
      expect(indexed.header.dependencies).toContain(structureGuid);
    } finally {
      project.dispose();
    }
  });

  it("persists sheet membership as references and rejects unavailable Structure creation", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("SheetData");
    const project = new ProjectService(storage);
    try {
      await project.loadCurrentProject();
      const registry = project.registry!;
      const structure = await createProjectAsset({ registry, rootId: "project", folderRelative: "", type: "Structure", name: "Item" });
      const structureGuid = structure.header.guid;
      const typeSchemas = { structs: { [structureGuid]: { name: "Item", fields: [] } }, enums: {} };
      const object = await createProjectAsset({ registry, rootId: "project", folderRelative: "", type: "DataObject", name: "Item One", structureGuid, typeSchemas });
      const sheet = await createProjectAsset({ registry, rootId: "project", folderRelative: "", type: "DataSheet", name: "Items", structureGuid, typeSchemas,
        dataSheet: { kind: "dataSheet", structureGuid, objectGuids: [object.header.guid] },
      });
      const body = await project.loadDocument("data-sheet", sheet.path);
      expect(body).toEqual({ kind: "dataSheet", structureGuid, objectGuids: [object.header.guid] });
      await project.saveDocument("data-sheet", sheet.path, { kind: "dataSheet", structureGuid, objectGuids: [] });
      expect(registry.getByGuid(object.header.guid)).toBeDefined();
      expect(registry.getByGuid(sheet.header.guid)?.header.payload.objectGuids).toEqual([]);
      expect(registry.getByGuid(sheet.header.guid)?.header.name).toBe("Items");
      await expect(createProjectAsset({ registry, rootId: "project", folderRelative: "", type: "DataObject", name: "Invalid", structureGuid: "missing", typeSchemas })).rejects.toThrow(/Structure/);
      expect(registry.list().some(asset => asset.header.name === "Invalid")).toBe(false);
    } finally {
      project.dispose();
    }
  });
});
