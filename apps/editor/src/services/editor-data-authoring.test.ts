import { describe, expect, it } from "vitest";
import { AssetRegistry, dataAssetDependencies, decodeAssetDocument, encodeAssetDocument, projectContentRoot } from "@babylonslate/assets";
import { buildDataTreeIndex, documentId, type DataDefinitionField, type DataTreeAsset, type DocumentRef } from "@babylonslate/core";
import { EditSession, SetAssetDocumentCommand } from "@babylonslate/edit";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { reconcileDataEntry } from "@babylonslate/scripting";
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
  const treeId = (guid: string) => documentId({ kind: "data-tree", path: registry.getByGuid(guid)!.path });
  const tree = (guid: string) => documents.getDocument(treeId(guid))!.content as unknown as DataTreeAsset;
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
    const current = tree(guid);
    const types = schemas();
    const index = buildDataTreeIndex(current).index!;
    await host.applyAssetDocumentChange(treeId(guid), { ...current,
      entries: current.entries.map((entry) => {
        const definition = index.effectiveDefinitionById.get(entry.id);
        return definition ? reconcileDataEntry(entry, definition, types.dataDefinitions![definition]!.fields, types).entry : entry;
      }),
    });
  };
  return { api, registry, documents, edits, disk, host, tree, treeId, changeDefinition, changeNestedDefinition, migrate,
    stop: () => { active = false; }, block: () => { blocked = true; } };
}

describe("Editor Utility data authoring", () => {
  it("persists empty trees, owns entries inline, and keeps concurrent edits and Undo on the tree", async () => {
    const { api, registry, documents, edits, disk, tree, treeId } = await fixture();
    const created = await api.createTree("Shop", "item", "Weapons");
    expect(created.success).toBe(true);
    const guid = created.value!;
    const asset = registry.getByGuid(guid)!;
    expect(await disk(asset.path)).toEqual({ kind: "dataTree", defaultDefinitionGuid: "item", entries: [] });
    const active = documents.getState().activeDocumentId;
    const first = (await api.addEntry(guid, "", "Sword", "item", { Price: 12 })).value!;
    const second = (await api.addEntry(guid, "", "Axe", "item")).value!;
    expect([first, second]).toEqual(["Sword", "Axe"]);
    const ids = tree(guid).entries.map((row) => row.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toEqual([first, second]);
    const results = await Promise.all([
      api.updateEntry(guid, first, "item", { Label: "Blade" }),
      api.updateEntry(guid, first, "item", { Price: 18 }),
    ]);
    expect(results.every((result) => result.success)).toBe(true);
    expect(results.map((result) => result.value)).toEqual(["Sword", "Sword"]);
    expect(await api.readEntry(guid, first, "item")).toMatchObject({ success: true, value: { Price: 18, Label: "Blade" } });
    expect(await disk(asset.path)).toMatchObject({ entries: [] });
    expect(documents.getState().activeDocumentId).toBe(active);
    const doc = documents.getDocument(treeId(guid))!;
    expect(doc.dirty).toBe(true);
    expect(doc.background).toBe(true);
    expect(documents.buildLayouts().tabOrder).toEqual(["content-browser"]);
    const undone = edits.getStack<Record<string, unknown>>(doc.id).undo(doc.content as Record<string, unknown>)!;
    documents.updateAssetDocument(doc.id, undone.doc);
    expect((await api.readEntry(guid, first)).value).toEqual({ Price: 12, Label: "Blade" });
    expect((await api.reorderChildren(guid, "", [second, first])).success).toBe(true);
    expect((await api.readTree(guid)).value).toEqual([second, first]);
    expect(tree(guid).entries.map((row) => row.id)).toEqual([ids[1], ids[0]]);
    expect(tree(guid).entries[1]!.name).toBe("Sword");
    expect((await api.removeEntry(guid, second)).value).toBe(second);
    const removed = documents.getDocument(doc.id)!;
    documents.updateAssetDocument(doc.id, edits.getStack<Record<string, unknown>>(doc.id).undo(removed.content as Record<string, unknown>)!.doc);
    expect((await api.readTree(guid)).value).toEqual([second, first]);
    expect(tree(guid).entries.map((row) => row.id)).toEqual([ids[1], ids[0]]);
    expect(registry.list().filter((entry) => !["DataDefinition", "Structure"].includes(entry.header.type))).toHaveLength(1);
  });

  it("rejects wrong definitions, cross-tree entries, duplicate names and invalid reorder without changing data", async () => {
    const { api, tree } = await fixture();
    const guid = (await api.createTree("Shop", "item")).value!;
    const other = (await api.createTree("Loot", "item")).value!;
    const first = (await api.addEntry(guid, "", "Sword", "item")).value!;
    const foreign = (await api.addEntry(other, "", "Shield", "item")).value!;
    await api.addEntry(other, "", "Sword", "item", { Price: 30 });
    expect((await api.readEntry(other, "Sword")).value?.Price).toBe(30);
    expect((await api.readEntry(guid, "Sword")).value?.Price).toBe(5);
    const before = structuredClone(tree(guid));
    expect((await api.addEntry(guid, "", " sWoRd ", "item")).success).toBe(false);
    expect((await api.addEntry(guid, "", " ", "item")).success).toBe(false);
    expect((await api.addEntry(guid, "", "Wrong Definition", "legacy-structure")).success).toBe(false);
    expect((await api.updateEntry(guid, first, "item", { Price: Infinity })).success).toBe(false);
    expect((await api.updateEntry(guid, first, "other", { Price: 2 })).success).toBe(false);
    expect((await api.updateEntry(guid, foreign, "item", { Price: 2 })).success).toBe(false);
    expect((await api.removeEntry(guid, foreign)).success).toBe(false);
    for (const order of [[], [first, first], [foreign]]) {
      expect((await api.reorderChildren(guid, "", order)).success).toBe(false);
    }
    expect((await api.readEntry(guid, first, "other")).success).toBe(false);
    expect((await api.createTree("Not A Definition", "legacy-structure")).success).toBe(false);
    expect(tree(guid)).toEqual(before);
    expect((await api.listTrees("item")).value).toEqual(expect.arrayContaining([guid, other]));
    expect((await api.listTrees("other")).value).toEqual([]);
  });

  it("refuses overwrites, invalid destinations, blocked edits and stale queued work", async () => {
    const { api, registry, block, stop, tree } = await fixture();
    const guid = (await api.createTree("Shop", "item")).value!;
    const row = (await api.addEntry(guid, "", "Sword", "item")).value!;
    expect((await api.createTree("Shop", "item")).success).toBe(false);
    for (const folder of ["../Outside", "/absolute", "Nested/../../Outside", "C:\\Outside"]) {
      expect((await api.createTree("Invalid", "item", folder)).success).toBe(false);
    }
    block();
    expect((await api.updateEntry(guid, row, "item", { Price: 20 })).success).toBe(false);
    expect((await api.addEntry(guid, "", "Blocked", "item")).success).toBe(false);
    expect(tree(guid).entries).toHaveLength(1);
    expect((await api.readEntry(guid, row)).value).toEqual({ Price: 5, Label: "Unnamed" });
    const pending = api.createTree("Cancelled", "item");
    stop();
    expect((await pending).success).toBe(false);
    expect(registry.list().filter((asset) => asset.header.type === "DataTree")).toHaveLength(1);
  });

  it("captures script arguments before yielding and returns detached values and row lists", async () => {
    const { api, tree } = await fixture();
    const guid = (await api.createTree("Shop", "item")).value!;
    const values = { Price: 21 };
    const pending = api.addEntry(guid, "", "Sword", "item", values);
    values.Price = 200;
    const row = (await pending).value!;
    const read = await api.readEntry(guid, row);
    expect(read.value).toMatchObject({ Price: 21 });
    read.value!.Price = 400;
    (await api.readTree(guid)).value!.push("external");
    expect((await api.readEntry(guid, row)).value).toMatchObject({ Price: 21 });
    expect(tree(guid).entries.map((entry) => entry.name)).toEqual([row]);
  });

  it("matches exact current names and leaves old names unresolved after a rename while retaining IDs", async () => {
    const { api, host, tree, treeId } = await fixture();
    const guid = (await api.createTree("Shop", "item")).value!;
    expect((await api.addEntry(guid, "", "Sword", "item")).value).toBe("Sword");
    const original = tree(guid).entries[0]!;
    for (const wrong of [original.id, "sword", " Sword "]) {
      expect((await api.readEntry(guid, wrong)).success).toBe(false);
      expect((await api.updateEntry(guid, wrong, "item", { Price: 20 })).success).toBe(false);
      expect((await api.removeEntry(guid, wrong)).success).toBe(false);
      expect((await api.reorderChildren(guid, "", [wrong])).success).toBe(false);
    }
    const reader = createEditorDataReader(() => host, () => true);
    expect(reader.hasEntry(guid, "Sword")).toBe(true);
    await host.applyAssetDocumentChange(treeId(guid), { ...tree(guid), entries: [{ ...original, name: "Blade" }] });
    expect((await api.readTree(guid)).value).toEqual(["Blade"]);
    expect((await api.readEntry(guid, "Sword")).success).toBe(false);
    expect((await api.readEntry(guid, original.id)).success).toBe(false);
    expect(reader.hasEntry(guid, "Sword")).toBe(false);
    expect(reader.hasEntry(guid, original.id)).toBe(false);
    expect(reader.getChildren(guid)).toEqual(["Blade"]);
    expect((await api.updateEntry(guid, "Blade", "item", { Price: 18 })).value).toBe("Blade");
    expect(tree(guid).entries[0]).toMatchObject({ id: original.id, name: "Blade", values: { Price: 18 } });
    expect(reader.readEntry(guid, "Blade")).toEqual({ Price: 18, Label: "Unnamed" });
    expect((await api.removeEntry(guid, "Blade")).value).toBe("Blade");
    expect(tree(guid).entries).toEqual([]);
  });

  it("rejects ambiguous imported names before reading or editing either row", async () => {
    const { api, host, tree, treeId } = await fixture();
    const guid = (await api.createTree("Shop", "item")).value!;
    await api.addEntry(guid, "", "Sword", "item");
    await api.addEntry(guid, "", "Axe", "item");
    const current = tree(guid);
    await host.applyAssetDocumentChange(treeId(guid), { ...current, entries: [current.entries[0]!, { ...current.entries[1]!, name: "sword" }] });
    const before = structuredClone(tree(guid));
    expect((await api.readTree(guid)).success).toBe(false);
    expect((await api.readEntry(guid, "Sword")).success).toBe(false);
    expect((await api.updateEntry(guid, "Sword", "item", { Price: 12 })).success).toBe(false);
    expect((await api.removeEntry(guid, "Sword")).success).toBe(false);
    expect((await api.reorderChildren(guid, "", ["Sword", "sword"])).success).toBe(false);
    expect(tree(guid)).toEqual(before);
  });

  it("rejects invalid definitions before creating trees or changing entries", async () => {
    const { api, changeDefinition, tree } = await fixture();
    const guid = (await api.createTree("Shop", "item")).value!;
    await api.addEntry(guid, "", "Sword", "item");
    const before = structuredClone(tree(guid));
    await changeDefinition([{ id: "legacy", name: "Legacy", typeId: "struct", typeClassId: "legacy-structure" }]);
    expect((await api.createTree("Invalid", "item")).success).toBe(false);
    expect((await api.addEntry(guid, "", "Axe", "item")).success).toBe(false);
    expect(tree(guid)).toEqual(before);
    await changeDefinition([{ id: "invalid", name: "Invalid", typeId: "float", min: 10, max: 1 }]);
    expect((await api.createTree("Invalid Bounds", "item")).success).toBe(false);
  });

  it("keeps ordinary graph reads current after utility writes, order changes, removal and host shutdown", async () => {
    const { api, host } = await fixture();
    let active = true;
    const reader = createEditorDataReader(() => host, () => active);
    const tree = (await api.createTree("Shop", "item")).value!;
    const first = (await api.addEntry(tree, "", "Sword", "item", { Price: 9 })).value!;
    const second = (await api.addEntry(tree, "", "Axe", "item")).value!;
    expect(reader.readEntry(tree, first, "item")).toEqual({ Price: 9, Label: "Unnamed" });
    expect(reader.getChildren(tree)).toEqual([first, second]);
    await api.updateEntry(tree, first, "item", { Price: 14 });
    expect(reader.readEntry(tree, first, "item")).toEqual({ Price: 14, Label: "Unnamed" });
    await api.reorderChildren(tree, "", [second, first]);
    expect(reader.getChildren(tree)).toEqual([second, first]);
    await api.removeEntry(tree, first);
    expect(reader.hasTree(tree)).toBe(true);
    expect(reader.hasEntry(tree, first)).toBe(false);
    expect(reader.canReadEntry(tree, second, "other")).toBe(false);
    active = false;
    expect(reader.readEntry(tree, second)).toBeNull();
    expect(reader.hasTree(tree)).toBe(false);
  });

  it("navigates mixed branches and copies effective Definition defaults without inheriting parent values", async () => {
    const { api, host, tree } = await fixture();
    const guid = (await api.createTree("Catalog", "item")).value!;
    expect((await api.addEntry(guid, "", "Weapons", undefined, { Price: 99 })).value).toBe("Weapons");
    expect((await api.addEntry(guid, "Weapons", "Sword")).value).toBe("Weapons/Sword");
    await api.addEntry(guid, "", "Groups", null, { Note: "Retained grouping data" });
    await api.addEntry(guid, "Groups", "Untyped");
    await api.addEntry(guid, "Groups", "Loot", "other", { Price: 12 });
    await api.addEntry(guid, "Groups/Loot", "Shield");
    expect((await api.readEntry(guid, "Weapons/Sword", "item")).value).toEqual({ Price: 5, Label: "Unnamed" });
    expect((await api.readEntry(guid, "Groups/Loot/Shield", "other")).value).toEqual({ Price: 5, Label: "Unnamed" });
    expect((await api.readEntry(guid, "Groups")).success).toBe(false);
    expect((await api.readEntry(guid, "Groups/Untyped")).success).toBe(false);
    expect((await api.getChildren(guid)).value).toEqual(["Weapons", "Groups"]);
    expect((await api.getChildren(guid, "Groups")).value).toEqual(["Groups/Untyped", "Groups/Loot"]);
    expect((await api.getDescendants(guid, "Groups")).value).toEqual(["Groups/Untyped", "Groups/Loot", "Groups/Loot/Shield"]);
    expect((await api.getParent(guid, "Weapons")).value).toBe("");
    expect((await api.getParent(guid, "Groups/Loot/Shield")).value).toBe("Groups/Loot");
    expect((await api.getParent(guid, "")).success).toBe(false);
    for (const path of ["Sword", "weapons/Sword", "/Weapons/Sword", "Weapons/Sword/", "Weapons/ Sword"]) {
      expect((await api.readEntry(guid, path)).success).toBe(false);
      expect((await api.getChildren(guid, path)).success).toBe(false);
    }
    expect(tree(guid).entries.find((entry) => entry.name === "Sword")?.definitionGuid).toBeUndefined();
    expect(tree(guid).entries.find((entry) => entry.name === "Groups")).toMatchObject({ definitionGuid: null, values: { Note: "Retained grouping data" } });
    expect((await api.listTrees("other")).value).toEqual([guid]);
    const reader = createEditorDataReader(() => host, () => true);
    expect(reader.hasTree(guid)).toBe(true);
    expect(reader.hasEntry(guid, "Groups")).toBe(true);
    expect(reader.canReadEntry(guid, "Groups")).toBe(false);
    expect(reader.hasEntry(guid, "")).toBe(false);
    expect(reader.getParent(guid, "Weapons")).toBe("");
    expect(reader.getDescendants(guid)).toEqual((await api.readTree(guid)).value);
    expect(reader.getChildren(guid, "Groups/Untyped")).toEqual([]);
    const untyped = (await api.createTree("Untyped")).value!;
    expect((await api.addEntry(untyped, "", "Grouping")).success).toBe(true);
    expect((await api.readEntry(untyped, "Grouping")).success).toBe(false);
  });

  it("moves, reorders and removes complete subtrees atomically with stable identities and one-step Undo", async () => {
    const { api, host, tree, treeId, documents, edits } = await fixture();
    const guid = (await api.createTree("Catalog", "item")).value!;
    await api.addEntry(guid, "", "Weapons");
    await api.addEntry(guid, "", "Loot", "other");
    await api.addEntry(guid, "Weapons", "Swords");
    await api.addEntry(guid, "Weapons/Swords", "Iron", undefined, { Price: 25 });
    await api.addEntry(guid, "Loot", "Shield");
    const original = structuredClone(tree(guid));
    const before = buildDataTreeIndex(original).index!;
    const swords = before.idByPath.get("Weapons/Swords")!;
    const iron = before.idByPath.get("Weapons/Swords/Iron")!;
    expect((await api.moveEntry(guid, "Weapons/Swords", "Loot", 0)).value).toBe("Loot/Swords");
    const moved = buildDataTreeIndex(tree(guid)).index!;
    expect(moved.pathById.get(iron)).toBe("Loot/Swords/Iron");
    expect(moved.byId.get(iron)).toEqual(before.byId.get(iron));
    expect(moved.effectiveDefinitionById.get(iron)).toBe("other");
    expect(moved.byId.get(swords)?.parentId).toBe(moved.idByPath.get("Loot"));
    expect((await api.getChildren(guid, "Loot")).value).toEqual(["Loot/Swords", "Loot/Shield"]);
    expect((await api.readEntry(guid, "Weapons/Swords/Iron")).success).toBe(false);
    expect((await api.readEntry(guid, "Loot/Swords/Iron", "other")).value?.Price).toBe(25);
    expect((await api.reorderChildren(guid, "Loot", ["Loot/Shield", "Loot/Swords"])).success).toBe(true);
    expect((await api.getDescendants(guid, "Loot")).value).toEqual(["Loot/Shield", "Loot/Swords", "Loot/Swords/Iron"]);
    const ordered = structuredClone(tree(guid));
    expect((await api.removeEntry(guid, "Loot/Swords")).value).toBe("Loot/Swords");
    expect((await api.readTree(guid)).value).toEqual(["Weapons", "Loot", "Loot/Shield"]);
    const id = treeId(guid);
    documents.updateAssetDocument(id, edits.getStack<Record<string, unknown>>(id).undo(documents.getDocument(id)!.content as Record<string, unknown>)!.doc);
    expect(tree(guid)).toEqual(ordered);
    const reader = createEditorDataReader(() => host, () => true);
    expect(reader.getChildren(guid, "Loot")).toEqual(["Loot/Shield", "Loot/Swords"]);
    const state = structuredClone(tree(guid));
    for (const [path, parent, position] of [
      ["Loot", "Loot/Swords/Iron", undefined], ["Loot", "Loot", undefined],
      ["Loot/Swords", "Missing", undefined], ["Loot/Swords", "", -1],
      ["Loot/Swords", "", 99], ["Loot/Swords", "", 1.5], ["", "Loot", undefined],
    ] as const) expect((await api.moveEntry(guid, path, parent, position)).success).toBe(false);
    expect((await api.removeEntry(guid, "")).success).toBe(false);
    expect((await api.reorderChildren(guid, "Loot", ["Loot/Shield", "Loot/Swords/Iron"])).success).toBe(false);
    expect(tree(guid)).toEqual(state);
    await api.addEntry(guid, "Weapons", "sWoRdS");
    const collision = structuredClone(tree(guid));
    expect((await api.moveEntry(guid, "Loot/Swords", "Weapons")).success).toBe(false);
    expect(tree(guid)).toEqual(collision);
  });

  it("rejects invalid names and corrupt parent topology without partially repairing or editing it", async () => {
    const { api, host, tree, treeId } = await fixture();
    const guid = (await api.createTree("Catalog", "item")).value!;
    await api.addEntry(guid, "", "Valid");
    const valid = structuredClone(tree(guid));
    for (const name of [".", "..", "Path/Child", " Space", "Trailing ", "Control\n", ""]) {
      expect((await api.addEntry(guid, "", name)).success).toBe(false);
    }
    expect(tree(guid)).toEqual(valid);
    for (const parentId of ["missing", valid.entries[0]!.id]) {
      await host.applyAssetDocumentChange(treeId(guid), { ...valid, entries: [{ ...valid.entries[0]!, parentId }] });
      const corrupt = structuredClone(tree(guid));
      expect((await api.readTree(guid)).success).toBe(false);
      expect((await api.addEntry(guid, "", "Blocked")).success).toBe(false);
      expect((await api.removeEntry(guid, "Valid")).success).toBe(false);
      expect((await api.moveEntry(guid, "Valid", "")).success).toBe(false);
      expect(tree(guid)).toEqual(corrupt);
    }
  });

  it("preserves retained nested asset references through migration and typed read-modify-update", async () => {
    const { api, tree, changeDefinition, changeNestedDefinition, migrate } = await fixture();
    const related = (await api.createTree("Related", "other")).value!;
    const nested = [{ id: "power", name: "Power", typeId: "float", defaultValue: 3 }];
    await changeNestedDefinition([...nested, { id: "related", name: "Related", typeId: "asset", typeClassId: "DataTree", defaultValue: "" }]);
    await changeDefinition([{ id: "stats", name: "Stats", typeId: "struct", typeClassId: "stats" }]);
    const guid = (await api.createTree("Shop", "item")).value!;
    const row = (await api.addEntry(guid, "", "Sword", "item", { Stats: { Related: related } })).value!;
    expect((await api.readEntry(guid, row)).value).toEqual({ Stats: { Power: 3, Related: related } });
    await changeNestedDefinition(nested);
    await migrate(guid);
    const read = (await api.readEntry(guid, row)).value!;
    expect(read).toEqual({ Stats: { Power: 3 } });
    (read.Stats as Record<string, unknown>).Power = 11;
    expect((await api.updateEntry(guid, row, "item", read)).success).toBe(true);
    expect(tree(guid).entries[0]!.values).toEqual({ Stats: { Power: 11, Related: related } });
    expect(dataAssetDependencies("DataTree", tree(guid))).toContain(related);
  });

  it("repairs invalid imported values without accepting incomplete repairs", async () => {
    const { api, host, tree, treeId } = await fixture();
    const guid = (await api.createTree("Shop", "item")).value!;
    const row = (await api.addEntry(guid, "", "Sword", "item")).value!;
    const current = tree(guid);
    await host.applyAssetDocumentChange(treeId(guid), { ...current,
      entries: [{ ...current.entries[0]!, values: { ...current.entries[0]!.values, Price: "invalid imported value" } }],
    });
    expect((await api.readEntry(guid, row)).success).toBe(false);
    expect((await api.updateEntry(guid, row, "item", { Label: "Incomplete Repair" })).success).toBe(false);
    expect(tree(guid).entries[0]!.values.Label).toBe("Unnamed");
    expect((await api.updateEntry(guid, row, "item", { Price: 8 })).success).toBe(true);
    expect((await api.readEntry(guid, row)).value).toEqual({ Price: 8, Label: "Unnamed" });
  });

  it("repairs incompatible changed fields and advances their retained schema snapshot", async () => {
    const { api, tree, changeDefinition, migrate } = await fixture();
    const guid = (await api.createTree("Shop", "item")).value!;
    const row = (await api.addEntry(guid, "", "Sword", "item", { Label: "Old text" })).value!;
    await changeDefinition([itemFields[0]!, { id: "label", name: "Label", typeId: "float", defaultValue: 1 }]);
    await migrate(guid);
    expect(tree(guid).entries[0]!.schema?.find((field) => field.id === "label")?.typeId).toBe("string");
    expect((await api.updateEntry(guid, row, "item", { Price: 7 })).success).toBe(false);
    expect((await api.updateEntry(guid, row, "item", { Label: 12 })).success).toBe(true);
    expect(tree(guid).entries[0]!.values).toEqual({ Price: 5, Label: 12 });
    expect(tree(guid).entries[0]!.schema?.find((field) => field.id === "label")?.typeId).toBe("float");
    expect((await api.readEntry(guid, row)).value).toEqual({ Price: 5, Label: 12 });
  });

  it("requires explicit reconciliation for added fields without changing existing defaults", async () => {
    const { api, tree, changeDefinition, migrate } = await fixture();
    const guid = (await api.createTree("Shop", "item")).value!;
    const first = (await api.addEntry(guid, "", "Sword", "item")).value!;
    await changeDefinition([{ ...itemFields[0]!, defaultValue: 70 }, itemFields[1]!, { id: "count", name: "Count", typeId: "int", defaultValue: 2 }]);
    expect((await api.updateEntry(guid, first, "item", { Price: 8 })).success).toBe(false);
    expect(tree(guid).entries[0]!.values).toEqual({ Price: 5, Label: "Unnamed" });
    await migrate(guid);
    expect((await api.updateEntry(guid, first, "item", { Price: 8 })).success).toBe(true);
    expect((await api.readEntry(guid, first)).value).toEqual({ Price: 8, Label: "Unnamed", Count: 2 });
    const second = (await api.addEntry(guid, "", "Axe", "item")).value!;
    expect((await api.readEntry(guid, second)).value).toEqual({ Price: 70, Label: "Unnamed", Count: 2 });
  });

  it("authors Tags and typed collections, stores portable maps, and replaces supplied collections", async () => {
    const { api, tree, changeDefinition } = await fixture();
    await changeDefinition([
      { id: "tag", name: "Tag", typeId: "tag", defaultValue: 0 },
      { id: "tags", name: "Tags", typeId: "struct", typeClassId: "engine:TagContainer" },
      { id: "entries", name: "Entries", typeId: "struct", typeClassId: "stats", container: "array" },
      { id: "named", name: "Named", typeId: "struct", typeClassId: "stats", container: "map", keyTypeId: "tag" },
    ]);
    const guid = (await api.createTree("Collection", "item")).value!;
    const created = await api.addEntry(guid, "", "Entries", "item", {
      Tag: 42, Tags: { Tags: [42, 900] },
      Entries: [{ Price: 2, Label: "First" }, { Price: 4, Label: "Second" }],
      Named: new Map([[42, { Price: 6, Label: "Mapped" }], [900, { Price: 8, Label: "Removed" }]]),
    });
    expect(created.success).toBe(true);
    const row = created.value!;
    expect(tree(guid).entries[0]).toMatchObject({ values: {
      Tag: 42, Tags: { Tags: [42, 900] },
      Named: [{ key: 42, value: { Price: 6, Label: "Mapped" } }, { key: 900, value: { Price: 8, Label: "Removed" } }],
    }, schema: expect.arrayContaining([
      expect.objectContaining({ name: "Entries", typeId: "struct", typeClassId: "stats", container: "array" }),
      expect.objectContaining({ name: "Named", container: "map", keyTypeId: "tag" }),
    ]) });
    const value = (await api.readEntry(guid, row)).value!;
    expect(value.Named).toBeInstanceOf(Map);
    const named = value.Named as Map<number, { Price: number; Label: string }>;
    named.get(42)!.Price = 11;
    named.delete(900);
    value.Entries = [{ Price: 4, Label: "Second" }];
    expect((await api.updateEntry(guid, row, "item", value)).success).toBe(true);
    expect(tree(guid).entries[0]!.values.Named).toEqual([{ key: 42, value: { Price: 11, Label: "Mapped" } }]);
    expect(tree(guid).entries[0]!.values.Entries).toEqual([{ Price: 4, Label: "Second" }]);
    expect((await api.updateEntry(guid, row, "item", { Tag: -1 })).success).toBe(false);
    expect((await api.updateEntry(guid, row, "item", { Tags: { Tags: [1.5] } })).success).toBe(false);
    expect((await api.updateEntry(guid, row, "item", { Named: new Map([[42, { Price: "Invalid", Label: "Mapped" }]]) })).success).toBe(false);
    expect((await api.readEntry(guid, row)).value?.Named).toEqual(new Map([[42, { Price: 11, Label: "Mapped" }]]));
  });
});
