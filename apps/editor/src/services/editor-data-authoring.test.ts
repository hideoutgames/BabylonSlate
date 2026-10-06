import { describe, expect, it } from "vitest";
import { AssetRegistry, dataAssetDependencies, decodeAssetDocument, encodeAssetDocument, projectContentRoot } from "@babylonslate/assets";
import { documentId, type DataDefinitionField, type DataSheetAsset, type DocumentRef } from "@babylonslate/core";
import { EditSession, SetAssetDocumentCommand } from "@babylonslate/edit";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { reconcileDataRow } from "@babylonslate/scripting";
import { collectGraphTypeAssets, typeSchemasFromGraphAssets } from "../lib/logic-graph-document";
import { DocumentService } from "./document-service";
import type { ProjectService } from "./project-service";
import { createEditorDataAuthoringApi } from "./editor-data-authoring";
import { createEditorDataReader } from "./editor-data-reader";

const itemFields: DataDefinitionField[] = [
  { id: "price", name: "Price", typeId: "float", defaultValue: 5 },
  { id: "label", name: "Label", typeId: "string", defaultValue: "Unnamed" },
];

async function fixture() {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("data.babproject");
  await storage.mkdir("assets", true);
  for (const guid of ["item", "other", "stats"]) {
    const definition = { kind: "dataDefinition", fields: itemFields };
    await storage.writeBinary(`assets/${guid}.datadefinition.babasset`, await encodeAssetDocument({
      guid, name: guid, type: "DataDefinition", version: 1, payload: definition,
    }, { headerPayload: definition }));
  }
  const structure = { kind: "structure", guid: "legacy-structure", name: "Legacy Structure", fields: itemFields };
  await storage.writeBinary("assets/legacy.structure.babasset", await encodeAssetDocument({
    guid: "legacy-structure", name: "Legacy Structure", type: "Structure", version: 1, payload: structure,
  }, { headerPayload: structure }));
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
  const sheetId = (guid: string) => documentId({ kind: "data-sheet", path: registry.getByGuid(guid)!.path });
  const sheet = (guid: string) => documents.getDocument(sheetId(guid))!.content as unknown as DataSheetAsset;
  const schemas = () => typeSchemasFromGraphAssets(collectGraphTypeAssets({ assets: registry.list(), openDocuments: host.getOpenDocuments() }));
  const changeDefinition = async (fields: DataDefinitionField[]) => {
    const id = await host.ensureAssetDocument({ kind: "data-definition", path: "assets/item.datadefinition.babasset", label: "Item" });
    await host.applyAssetDocumentChange(id, { kind: "dataDefinition", fields });
  };
  const changeNestedDefinition = async (fields: DataDefinitionField[]) => {
    const id = await host.ensureAssetDocument({ kind: "data-definition", path: "assets/stats.datadefinition.babasset", label: "Stats" });
    await host.applyAssetDocumentChange(id, { kind: "dataDefinition", fields });
  };
  const migrate = async (guid: string) => {
    const current = sheet(guid);
    const types = schemas();
    await host.applyAssetDocumentChange(sheetId(guid), { ...current,
      rows: current.rows.map((row) => reconcileDataRow(row, current.definitionGuid!, types.dataDefinitions![current.definitionGuid!]!.fields, types).row),
    });
  };
  return { api, registry, documents, edits, disk, host, sheet, sheetId, changeDefinition, changeNestedDefinition, migrate,
    stop: () => { active = false; }, block: () => { blocked = true; } };
}

describe("Editor Utility data authoring", () => {
  it("persists empty sheets, owns rows inline, and keeps concurrent edits and Undo on the sheet", async () => {
    const { api, registry, documents, edits, disk, sheet, sheetId } = await fixture();
    const created = await api.createSheet("Shop", "item", "Weapons");
    expect(created.success).toBe(true);
    const guid = created.value!;
    const asset = registry.getByGuid(guid)!;
    expect(await disk(asset.path)).toEqual({ kind: "dataSheet", definitionGuid: "item", rows: [] });
    const active = documents.getState().activeDocumentId;
    const first = (await api.addRow(guid, "item", "  Sword  ", { Price: 12 })).value!;
    const second = (await api.addRow(guid, "item", "Axe")).value!;
    expect(first).not.toBe(second);
    expect(sheet(guid).rows.map((row) => [row.id, row.name])).toEqual([[first, "Sword"], [second, "Axe"]]);
    const results = await Promise.all([
      api.updateRow(guid, first, "item", { Label: "Blade" }),
      api.updateRow(guid, first, "item", { Price: 18 }),
    ]);
    expect(results.every((result) => result.success)).toBe(true);
    expect(await api.readRow(guid, first, "item")).toMatchObject({ success: true, value: { Price: 18, Label: "Blade" } });
    expect(await disk(asset.path)).toMatchObject({ rows: [] });
    expect(documents.getState().activeDocumentId).toBe(active);
    const doc = documents.getDocument(sheetId(guid))!;
    expect(doc.dirty).toBe(true);
    expect(doc.background).toBe(true);
    expect(documents.buildLayouts().tabOrder).toEqual(["content-browser"]);
    const undone = edits.getStack<Record<string, unknown>>(doc.id).undo(doc.content as Record<string, unknown>)!;
    documents.updateAssetDocument(doc.id, undone.doc);
    expect((await api.readRow(guid, first)).value).toEqual({ Price: 12, Label: "Blade" });
    expect((await api.reorderRows(guid, "item", [second, first])).success).toBe(true);
    expect((await api.readSheet(guid)).value).toEqual([second, first]);
    expect(sheet(guid).rows[1]!.name).toBe("Sword");
    expect((await api.removeRow(guid, second, "item")).value).toBe(second);
    const removed = documents.getDocument(doc.id)!;
    documents.updateAssetDocument(doc.id, edits.getStack<Record<string, unknown>>(doc.id).undo(removed.content as Record<string, unknown>)!.doc);
    expect((await api.readSheet(guid)).value).toEqual([second, first]);
    expect(registry.list().filter((entry) => !["DataDefinition", "Structure"].includes(entry.header.type))).toHaveLength(1);
  });

  it("rejects wrong definitions, cross-sheet rows, duplicate names and invalid reorder without changing data", async () => {
    const { api, sheet } = await fixture();
    const guid = (await api.createSheet("Shop", "item")).value!;
    const other = (await api.createSheet("Loot", "item")).value!;
    const first = (await api.addRow(guid, "item", "Sword")).value!;
    const foreign = (await api.addRow(other, "item", "Sword")).value!;
    const before = structuredClone(sheet(guid));
    expect((await api.addRow(guid, "item", " sWoRd ")).success).toBe(false);
    expect((await api.addRow(guid, "item", " ")).success).toBe(false);
    expect((await api.addRow(guid, "other", "Wrong Definition")).success).toBe(false);
    expect((await api.updateRow(guid, first, "item", { Price: Infinity })).success).toBe(false);
    expect((await api.updateRow(guid, first, "other", { Price: 2 })).success).toBe(false);
    expect((await api.updateRow(guid, foreign, "item", { Price: 2 })).success).toBe(false);
    expect((await api.removeRow(guid, foreign, "item")).success).toBe(false);
    for (const order of [[], [first, first], [foreign]]) {
      expect((await api.reorderRows(guid, "item", order)).success).toBe(false);
    }
    expect((await api.readRow(guid, first, "other")).success).toBe(false);
    expect((await api.createSheet("Not A Definition", "legacy-structure")).success).toBe(false);
    expect(sheet(guid)).toEqual(before);
    expect((await api.listSheets("item")).value).toEqual(expect.arrayContaining([guid, other]));
    expect((await api.listSheets("other")).value).toEqual([]);
  });

  it("refuses overwrites, invalid destinations, blocked edits and stale queued work", async () => {
    const { api, registry, block, stop, sheet } = await fixture();
    const guid = (await api.createSheet("Shop", "item")).value!;
    const row = (await api.addRow(guid, "item", "Sword")).value!;
    expect((await api.createSheet("Shop", "item")).success).toBe(false);
    for (const folder of ["../Outside", "/absolute", "Nested/../../Outside", "C:\\Outside"]) {
      expect((await api.createSheet("Invalid", "item", folder)).success).toBe(false);
    }
    block();
    expect((await api.updateRow(guid, row, "item", { Price: 20 })).success).toBe(false);
    expect((await api.addRow(guid, "item", "Blocked")).success).toBe(false);
    expect(sheet(guid).rows).toHaveLength(1);
    expect((await api.readRow(guid, row)).value).toEqual({ Price: 5, Label: "Unnamed" });
    const pending = api.createSheet("Cancelled", "item");
    stop();
    expect((await pending).success).toBe(false);
    expect(registry.list().filter((asset) => asset.header.type === "DataSheet")).toHaveLength(1);
  });

  it("captures script arguments before yielding and returns detached values and row lists", async () => {
    const { api, sheet } = await fixture();
    const guid = (await api.createSheet("Shop", "item")).value!;
    const values = { Price: 21 };
    const pending = api.addRow(guid, "item", "Sword", values);
    values.Price = 200;
    const row = (await pending).value!;
    const read = await api.readRow(guid, row);
    expect(read.value).toMatchObject({ Price: 21 });
    read.value!.Price = 400;
    (await api.readSheet(guid)).value!.push("external");
    expect((await api.readRow(guid, row)).value).toMatchObject({ Price: 21 });
    expect(sheet(guid).rows.map((entry) => entry.id)).toEqual([row]);
  });

  it("rejects invalid definitions before creating sheets or changing rows", async () => {
    const { api, changeDefinition, sheet } = await fixture();
    const guid = (await api.createSheet("Shop", "item")).value!;
    await api.addRow(guid, "item", "Sword");
    const before = structuredClone(sheet(guid));
    await changeDefinition([{ id: "legacy", name: "Legacy", typeId: "struct", typeClassId: "legacy-structure" }]);
    expect((await api.createSheet("Invalid", "item")).success).toBe(false);
    expect((await api.addRow(guid, "item", "Axe")).success).toBe(false);
    expect(sheet(guid)).toEqual(before);
    await changeDefinition([{ id: "invalid", name: "Invalid", typeId: "float", min: 10, max: 1 }]);
    expect((await api.createSheet("Invalid Bounds", "item")).success).toBe(false);
  });

  it("keeps ordinary graph reads current after utility writes, order changes, removal and host shutdown", async () => {
    const { api, host } = await fixture();
    let active = true;
    const reader = createEditorDataReader(() => host, () => active);
    const sheet = (await api.createSheet("Shop", "item")).value!;
    const first = (await api.addRow(sheet, "item", "Sword", { Price: 9 })).value!;
    const second = (await api.addRow(sheet, "item", "Axe")).value!;
    expect(reader.readRow(sheet, first, "item")).toEqual({ Price: 9, Label: "Unnamed" });
    expect(reader.getSheetRows(sheet, "item")).toEqual([first, second]);
    await api.updateRow(sheet, first, "item", { Price: 14 });
    expect(reader.readRow(sheet, first, "item")).toEqual({ Price: 14, Label: "Unnamed" });
    await api.reorderRows(sheet, "item", [second, first]);
    expect(reader.getSheetRows(sheet)).toEqual([second, first]);
    await api.removeRow(sheet, first, "item");
    expect(reader.hasSheet(sheet, "item")).toBe(true);
    expect(reader.hasRow(sheet, first)).toBe(false);
    expect(reader.hasRow(sheet, second, "other")).toBe(false);
    active = false;
    expect(reader.readRow(sheet, second)).toBeNull();
    expect(reader.hasSheet(sheet)).toBe(false);
  });

  it("preserves retained nested asset references through migration and typed read-modify-update", async () => {
    const { api, sheet, changeDefinition, changeNestedDefinition, migrate } = await fixture();
    const related = (await api.createSheet("Related", "other")).value!;
    const nested = [{ id: "power", name: "Power", typeId: "float", defaultValue: 3 }];
    await changeNestedDefinition([...nested, { id: "related", name: "Related", typeId: "asset", typeClassId: "DataSheet", defaultValue: "" }]);
    await changeDefinition([{ id: "stats", name: "Stats", typeId: "struct", typeClassId: "stats" }]);
    const guid = (await api.createSheet("Shop", "item")).value!;
    const row = (await api.addRow(guid, "item", "Sword", { Stats: { Related: related } })).value!;
    expect((await api.readRow(guid, row)).value).toEqual({ Stats: { Power: 3, Related: related } });
    await changeNestedDefinition(nested);
    await migrate(guid);
    const read = (await api.readRow(guid, row)).value!;
    expect(read).toEqual({ Stats: { Power: 3 } });
    (read.Stats as Record<string, unknown>).Power = 11;
    expect((await api.updateRow(guid, row, "item", read)).success).toBe(true);
    expect(sheet(guid).rows[0]!.values).toEqual({ Stats: { Power: 11, Related: related } });
    expect(dataAssetDependencies("DataSheet", sheet(guid))).toContain(related);
  });

  it("repairs invalid imported values without accepting incomplete repairs", async () => {
    const { api, host, sheet, sheetId } = await fixture();
    const guid = (await api.createSheet("Shop", "item")).value!;
    const row = (await api.addRow(guid, "item", "Sword")).value!;
    const current = sheet(guid);
    await host.applyAssetDocumentChange(sheetId(guid), { ...current,
      rows: [{ ...current.rows[0]!, values: { ...current.rows[0]!.values, Price: "invalid imported value" } }],
    });
    expect((await api.readRow(guid, row)).success).toBe(false);
    expect((await api.updateRow(guid, row, "item", { Label: "Incomplete Repair" })).success).toBe(false);
    expect(sheet(guid).rows[0]!.values.Label).toBe("Unnamed");
    expect((await api.updateRow(guid, row, "item", { Price: 8 })).success).toBe(true);
    expect((await api.readRow(guid, row)).value).toEqual({ Price: 8, Label: "Unnamed" });
  });

  it("repairs incompatible changed fields and advances their retained schema snapshot", async () => {
    const { api, sheet, changeDefinition, migrate } = await fixture();
    const guid = (await api.createSheet("Shop", "item")).value!;
    const row = (await api.addRow(guid, "item", "Sword", { Label: "Old text" })).value!;
    await changeDefinition([itemFields[0]!, { id: "label", name: "Label", typeId: "float", defaultValue: 1 }]);
    await migrate(guid);
    expect(sheet(guid).rows[0]!.schema?.find((field) => field.id === "label")?.typeId).toBe("string");
    expect((await api.updateRow(guid, row, "item", { Price: 7 })).success).toBe(false);
    expect((await api.updateRow(guid, row, "item", { Label: 12 })).success).toBe(true);
    expect(sheet(guid).rows[0]!.values).toEqual({ Price: 5, Label: 12 });
    expect(sheet(guid).rows[0]!.schema?.find((field) => field.id === "label")?.typeId).toBe("float");
    expect((await api.readRow(guid, row)).value).toEqual({ Price: 5, Label: 12 });
  });

  it("requires explicit reconciliation for added fields without changing existing defaults", async () => {
    const { api, sheet, changeDefinition, migrate } = await fixture();
    const guid = (await api.createSheet("Shop", "item")).value!;
    const first = (await api.addRow(guid, "item", "Sword")).value!;
    await changeDefinition([{ ...itemFields[0]!, defaultValue: 70 }, itemFields[1]!, { id: "count", name: "Count", typeId: "int", defaultValue: 2 }]);
    expect((await api.updateRow(guid, first, "item", { Price: 8 })).success).toBe(false);
    expect(sheet(guid).rows[0]!.values).toEqual({ Price: 5, Label: "Unnamed" });
    await migrate(guid);
    expect((await api.updateRow(guid, first, "item", { Price: 8 })).success).toBe(true);
    expect((await api.readRow(guid, first)).value).toEqual({ Price: 8, Label: "Unnamed", Count: 2 });
    const second = (await api.addRow(guid, "item", "Axe")).value!;
    expect((await api.readRow(guid, second)).value).toEqual({ Price: 70, Label: "Unnamed", Count: 2 });
  });

  it("authors Tags and typed collections, stores portable maps, and replaces supplied collections", async () => {
    const { api, sheet, changeDefinition } = await fixture();
    await changeDefinition([
      { id: "tag", name: "Tag", typeId: "tag", defaultValue: 0 },
      { id: "tags", name: "Tags", typeId: "struct", typeClassId: "engine:TagContainer" },
      { id: "entries", name: "Entries", typeId: "struct", typeClassId: "stats", container: "array" },
      { id: "named", name: "Named", typeId: "struct", typeClassId: "stats", container: "map", keyTypeId: "tag" },
    ]);
    const guid = (await api.createSheet("Collection", "item")).value!;
    const created = await api.addRow(guid, "item", "Entries", {
      Tag: 42, Tags: { Tags: [42, 900] },
      Entries: [{ Price: 2, Label: "First" }, { Price: 4, Label: "Second" }],
      Named: new Map([[42, { Price: 6, Label: "Mapped" }], [900, { Price: 8, Label: "Removed" }]]),
    });
    expect(created.success).toBe(true);
    const row = created.value!;
    expect(sheet(guid).rows[0]).toMatchObject({ values: {
      Tag: 42, Tags: { Tags: [42, 900] },
      Named: [{ key: 42, value: { Price: 6, Label: "Mapped" } }, { key: 900, value: { Price: 8, Label: "Removed" } }],
    }, schema: expect.arrayContaining([
      expect.objectContaining({ name: "Entries", typeId: "struct", typeClassId: "stats", container: "array" }),
      expect.objectContaining({ name: "Named", container: "map", keyTypeId: "tag" }),
    ]) });
    const value = (await api.readRow(guid, row)).value!;
    expect(value.Named).toBeInstanceOf(Map);
    const named = value.Named as Map<number, { Price: number; Label: string }>;
    named.get(42)!.Price = 11;
    named.delete(900);
    value.Entries = [{ Price: 4, Label: "Second" }];
    expect((await api.updateRow(guid, row, "item", value)).success).toBe(true);
    expect(sheet(guid).rows[0]!.values.Named).toEqual([{ key: 42, value: { Price: 11, Label: "Mapped" } }]);
    expect(sheet(guid).rows[0]!.values.Entries).toEqual([{ Price: 4, Label: "Second" }]);
    expect((await api.updateRow(guid, row, "item", { Tag: -1 })).success).toBe(false);
    expect((await api.updateRow(guid, row, "item", { Tags: { Tags: [1.5] } })).success).toBe(false);
    expect((await api.updateRow(guid, row, "item", { Named: new Map([[42, { Price: "Invalid", Label: "Mapped" }]]) })).success).toBe(false);
    expect((await api.readRow(guid, row)).value?.Named).toEqual(new Map([[42, { Price: 11, Label: "Mapped" }]]));
  });
});
