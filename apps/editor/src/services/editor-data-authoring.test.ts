import { describe, expect, it } from "vitest";
import { AssetRegistry, dataAssetDependencies, decodeAssetDocument, encodeAssetDocument, projectContentRoot } from "@babylonslate/assets";
import { documentId, type DataObjectAsset, type DocumentRef } from "@babylonslate/core";
import { EditSession, SetAssetDocumentCommand } from "@babylonslate/edit";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { reconcileDataObject } from "@babylonslate/scripting";
import { DocumentService } from "./document-service";
import type { ProjectService } from "./project-service";
import { createEditorDataAuthoringApi } from "./editor-data-authoring";
import { createEditorDataReader } from "./editor-data-reader";

async function fixture() {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("data.babproject");
  await storage.mkdir("assets", true);
  for (const guid of ["item", "other"]) {
    const structure = { kind: "structure", guid, name: guid, fields: [
      { id: "price", name: "Price", typeId: "float", defaultValue: 5 },
      { id: "label", name: "Label", typeId: "string", defaultValue: "Unnamed" },
    ] };
    await storage.writeBinary(`assets/${guid}.structure.babasset`, await encodeAssetDocument({
      guid, name: guid, type: "Structure", version: 1, payload: structure,
    }, { headerPayload: structure }));
  }
  const registry = new AssetRegistry(storage);
  await registry.mountRoot(projectContentRoot());
  const documents = new DocumentService();
  documents.ensureContentBrowserTab();
  const edits = new EditSession();
  const disk = async (path: string) => (await decodeAssetDocument(await storage.readBinary(path), {
    blobs: registry.blobsFor(registry.getByPath(path)!.rootId),
  })).payload;
  const project = { loadDocument: (_kind: string, path: string) => disk(path) } as unknown as ProjectService;
  let active = true;
  let blocked = false;
  const host = {
    assetRegistry: registry,
    getOpenDocuments: () => documents.getOpenDocumentsOrdered(),
    loadAssetDocument: async (kind: DocumentRef["kind"], path: string) => documents.getDocument(documentId({ kind, path }))?.content ?? disk(path),
    ensureAssetDocument: (ref: DocumentRef) => documents.openDocument(project, ref, null, false, { background: true }),
    applyAssetDocumentChange: async (id: string, next: Record<string, unknown>) => {
      if (blocked) return false;
      const current = documents.getDocument(id)!.content as Record<string, unknown>;
      documents.updateAssetDocument(id, edits.apply(id, current, new SetAssetDocumentCommand(current, next)).doc);
      return true;
    },
    noteAssetsCreated: () => {},
  };
  const api = createEditorDataAuthoringApi(() => host, () => active);
  return { api, registry, documents, edits, disk, host, stop: () => { active = false; }, block: () => { blocked = true; } };
}

describe("Editor Utility data authoring", () => {
  it("creates standalone persisted records, edits current unsaved values, and shares them across sheets with Undo", async () => {
    const { api, registry, documents, edits, disk } = await fixture();
    const created = await api.createObject("Sword", "item", { Price: 12 }, "Weapons");
    expect(created.success).toBe(true);
    const guid = created.value!;
    const asset = registry.getByGuid(guid)!;
    expect(await disk(asset.path)).toMatchObject({ values: { Price: 12, Label: "Unnamed" }, structureGuid: "item" });
    const first = await api.createSheet("Shop", "item", [guid, guid]);
    const second = await api.createSheet("Loot", "item", [guid]);
    expect((await api.readSheet(first.value!)).value).toEqual([guid]);
    expect((await api.readSheet(second.value!)).value).toEqual([guid]);
    const active = documents.getState().activeDocumentId;
    expect((await api.updateObject(guid, "item", { Label: "Blade" })).success).toBe(true);
    expect((await api.updateObject(guid, "item", { Price: 18 })).success).toBe(true);
    expect(await api.readObject(guid, "item")).toMatchObject({ success: true, value: { Price: 18, Label: "Blade" } });
    expect(await disk(asset.path)).toMatchObject({ values: { Price: 12, Label: "Unnamed" } });
    expect(documents.getState().activeDocumentId).toBe(active);
    const id = documentId({ kind: "data-object", path: asset.path });
    const doc = documents.getDocument(id)!;
    expect(doc.dirty).toBe(true);
    expect(doc.background).toBe(true);
    expect(documents.buildLayouts().tabOrder).toEqual(["content-browser"]);
    const undone = edits.getStack<Record<string, unknown>>(id).undo(doc.content as Record<string, unknown>)!;
    documents.updateAssetDocument(id, undone.doc);
    expect((await api.readObject(guid)).value).toEqual({ Price: 12, Label: "Blade" });
    expect((await api.setSheetObjects(first.value!, "item", [])).success).toBe(true);
    expect((await api.readSheet(second.value!)).value).toEqual([guid]);
    expect((await api.readObject(guid)).success).toBe(true);
  });

  it("validates all membership before editing and rejects invalid values or wrong Structures without changing live data", async () => {
    const { api } = await fixture();
    const sword = (await api.createObject("Sword", "item")).value!;
    const other = (await api.createObject("Other", "other")).value!;
    const sheet = (await api.createSheet("Shop", "item", [sword])).value!;
    expect((await api.setSheetObjects(sheet, "item", [sword, other])).success).toBe(false);
    expect((await api.setSheetObjects(sheet, "item", [sword, "missing"])).success).toBe(false);
    expect((await api.readSheet(sheet)).value).toEqual([sword]);
    expect((await api.updateObject(sword, "item", { Price: Infinity })).success).toBe(false);
    expect((await api.updateObject(sword, "other", { Price: 2 })).success).toBe(false);
    expect((await api.readObject(sword)).value).toEqual({ Price: 5, Label: "Unnamed" });
    expect((await api.readObject(sword, "other")).success).toBe(false);
    expect((await api.listObjects("item")).value).toEqual([sword]);
    expect((await api.listSheets("item")).value).toEqual([sheet]);
  });

  it("refuses overwrites, invalid destinations, blocked edits, and stale queued work", async () => {
    const { api, registry, block, stop } = await fixture();
    const sword = (await api.createObject("Sword", "item")).value!;
    expect((await api.createObject("Sword", "item", { Price: 100 })).success).toBe(false);
    for (const folder of ["../Outside", "/absolute", "Nested/../../Outside", "C:\\Outside"]) {
      expect((await api.createObject("Invalid", "item", {}, folder)).success).toBe(false);
    }
    block();
    expect((await api.updateObject(sword, "item", { Price: 20 })).success).toBe(false);
    expect((await api.readObject(sword)).value).toEqual({ Price: 5, Label: "Unnamed" });
    const pending = api.createObject("Cancelled", "item");
    stop();
    expect((await pending).success).toBe(false);
    expect(registry.list().filter((asset) => asset.header.type === "DataObject")).toHaveLength(1);
  });

  it("captures script arguments before yielding and returns detached reads", async () => {
    const { api, registry, documents } = await fixture();
    const values = { Price: 21 };
    const pending = api.createObject("Sword", "item", values);
    values.Price = 200;
    const guid = (await pending).value!;
    const read = await api.readObject(guid);
    expect(read.value).toMatchObject({ Price: 21 });
    read.value!.Price = 400;
    expect((await api.readObject(guid)).value).toMatchObject({ Price: 21 });
    await api.updateObject(guid, "item", { Price: 22 });
    const doc = documents.getDocument(documentId({ kind: "data-object", path: registry.getByGuid(guid)!.path }))!;
    expect((doc.content as unknown as DataObjectAsset).values.Price).toBe(22);
  });

  it("keeps ordinary graph reads current after utility writes, sheet changes and host shutdown", async () => {
    const { api, host } = await fixture();
    let active = true;
    const reader = createEditorDataReader(() => host, () => active);
    const guid = (await api.createObject("Sword", "item", { Price: 9 })).value!;
    const sheet = (await api.createSheet("Shop", "item", [guid])).value!;
    expect(reader.readObject(guid, "item")).toEqual({ Price: 9, Label: "Unnamed" });
    expect(reader.getSheetObjects(sheet, "item")).toEqual([guid]);
    await api.updateObject(guid, "item", { Price: 14 });
    expect(reader.readObject(guid, "item")).toEqual({ Price: 14, Label: "Unnamed" });
    await api.setSheetObjects(sheet, "item", []);
    expect(reader.hasSheet(sheet, "item")).toBe(true);
    expect(reader.getSheetObjects(sheet, "item")).toEqual([]);
    expect(reader.hasObject(guid, "other")).toBe(false);
    active = false;
    expect(reader.readObject(guid)).toBeNull();
    expect(reader.hasSheet(sheet)).toBe(false);
  });

  it("updates remaining fields after a schema migration while preserving removed asset references", async () => {
    const { api, registry, host, documents } = await fixture();
    const related = (await api.createObject("Related", "other")).value!;
    const structureId = await host.ensureAssetDocument({ kind: "structure", path: "assets/item.structure.babasset", label: "Item" });
    const schema = { name: "Item", fields: [{ id: "price", name: "Price", typeId: "float", defaultValue: 5 }] };
    await host.applyAssetDocumentChange(structureId, { kind: "structure", guid: "item", name: "Item", fields: [
      ...schema.fields, { id: "related", name: "Related", typeId: "asset", typeClassId: "DataObject", defaultValue: "" },
    ] });
    const guid = (await api.createObject("Sword", "item", { Price: 12, Related: related })).value!;
    await host.applyAssetDocumentChange(structureId, { kind: "structure", guid: "item", ...schema });
    const objectId = await host.ensureAssetDocument({ kind: "data-object", path: registry.getByGuid(guid)!.path, label: "Sword" });
    const current = documents.getDocument(objectId)!.content as unknown as DataObjectAsset;
    const migration = reconcileDataObject(current, schema.fields, { structs: { item: schema }, enums: {} });
    await host.applyAssetDocumentChange(objectId, { ...migration.asset });
    expect((await api.updateObject(guid, "item", { Price: 24 })).success).toBe(true);
    const updated = documents.getDocument(objectId)!.content as unknown as DataObjectAsset;
    expect(updated.values).toEqual({ Price: 24, Related: related });
    expect(dataAssetDependencies("DataObject", updated)).toContain(related);
    expect((await api.readObject(guid)).value).toEqual({ Price: 24 });
  });

  it("preserves retained nested references through typed read-modify-update", async () => {
    const { api, registry, host, documents } = await fixture();
    const related = (await api.createObject("Related", "item")).value!;
    const nestedId = await host.ensureAssetDocument({ kind: "structure", path: "assets/other.structure.babasset", label: "Stats" });
    const nested = { name: "Stats", fields: [{ id: "power", name: "Power", typeId: "float", defaultValue: 3 }] };
    await host.applyAssetDocumentChange(nestedId, { kind: "structure", guid: "other", name: "Stats", fields: [
      ...nested.fields, { id: "related", name: "Related", typeId: "asset", typeClassId: "DataObject", defaultValue: "" },
    ] });
    const structureId = await host.ensureAssetDocument({ kind: "structure", path: "assets/item.structure.babasset", label: "Item" });
    const schema = { name: "Item", fields: [{ id: "stats", name: "Stats", typeId: "struct", typeClassId: "other" }] };
    await host.applyAssetDocumentChange(structureId, { kind: "structure", guid: "item", ...schema });
    // Partial nested creation keeps the other field's copied default.
    const guid = (await api.createObject("Sword", "item", { Stats: { Related: related } })).value!;
    expect((await api.readObject(guid)).value).toEqual({ Stats: { Power: 3, Related: related } });
    await host.applyAssetDocumentChange(nestedId, { kind: "structure", guid: "other", ...nested });
    const objectId = await host.ensureAssetDocument({ kind: "data-object", path: registry.getByGuid(guid)!.path, label: "Sword" });
    const current = documents.getDocument(objectId)!.content as unknown as DataObjectAsset;
    const migration = reconcileDataObject(current, schema.fields, { structs: { item: schema, other: nested }, enums: {} });
    await host.applyAssetDocumentChange(objectId, { ...migration.asset });
    const read = (await api.readObject(guid)).value!;
    expect(read).toEqual({ Stats: { Power: 3 } });
    (read.Stats as Record<string, unknown>).Power = 11;
    expect((await api.updateObject(guid, "item", read)).success).toBe(true);
    const updated = documents.getDocument(objectId)!.content as unknown as DataObjectAsset;
    expect(updated.values).toEqual({ Stats: { Power: 11, Related: related } });
    expect(dataAssetDependencies("DataObject", updated)).toContain(related);
  });

  it("lets utilities repair invalid stored values while rejecting incomplete repairs", async () => {
    const { api, registry, host, documents } = await fixture();
    const guid = (await api.createObject("Sword", "item")).value!;
    const id = await host.ensureAssetDocument({ kind: "data-object", path: registry.getByGuid(guid)!.path, label: "Sword" });
    const current = documents.getDocument(id)!.content as unknown as DataObjectAsset;
    await host.applyAssetDocumentChange(id, { ...current, values: { ...current.values, Price: "invalid imported value" } });
    expect((await api.readObject(guid)).success).toBe(false);
    expect((await api.updateObject(guid, "item", { Label: "Incomplete Repair" })).success).toBe(false);
    expect((documents.getDocument(id)!.content as unknown as DataObjectAsset).values.Label).toBe("Unnamed");
    expect((await api.updateObject(guid, "item", { Price: 8 })).success).toBe(true);
    expect((await api.readObject(guid)).value).toEqual({ Price: 8, Label: "Unnamed" });
  });

  it("repairs an incompatible changed field and advances its retained schema snapshot", async () => {
    const { api, registry, host, documents } = await fixture();
    const guid = (await api.createObject("Sword", "item", { Label: "Old text" })).value!;
    const structureId = await host.ensureAssetDocument({ kind: "structure", path: "assets/item.structure.babasset", label: "Item" });
    const schema = { name: "Item", fields: [
      { id: "price", name: "Price", typeId: "float", defaultValue: 5 },
      { id: "label", name: "Label", typeId: "float", defaultValue: 1 },
    ] };
    await host.applyAssetDocumentChange(structureId, { kind: "structure", guid: "item", ...schema });
    const id = await host.ensureAssetDocument({ kind: "data-object", path: registry.getByGuid(guid)!.path, label: "Sword" });
    const current = documents.getDocument(id)!.content as unknown as DataObjectAsset;
    const migration = reconcileDataObject(current, schema.fields, { structs: { item: schema }, enums: {} });
    await host.applyAssetDocumentChange(id, { ...migration.asset });
    expect((documents.getDocument(id)!.content as unknown as DataObjectAsset).schema?.find((field) => field.id === "label")?.typeId).toBe("string");
    expect((await api.updateObject(guid, "item", { Price: 7 })).success).toBe(false);
    expect((await api.updateObject(guid, "item", { Label: 12 })).success).toBe(true);
    const updated = documents.getDocument(id)!.content as unknown as DataObjectAsset;
    expect(updated.values).toEqual({ Price: 5, Label: 12 });
    expect(updated.schema?.find((field) => field.id === "label")?.typeId).toBe("float");
    expect((await api.readObject(guid)).value).toEqual({ Price: 5, Label: 12 });
  });
});
