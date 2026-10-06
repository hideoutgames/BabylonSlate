import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { IndexedAsset } from "@babylonslate/assets";
import { documentId, type DocumentRef } from "@babylonslate/core";
import { createDataObjectForStructure, type StructField } from "@babylonslate/scripting";
import { TagProvider } from "@babylonslate/editor-kit";
import type { OpenDocument } from "../services/document-service";
import { DataAssetEditingProvider } from "../context/data-asset-editing-context";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { DataObjectValuesPanel, DataSheetRowsPanel } from "./data-asset-panels";
import { collectGraphTypeAssets, typeSchemasFromGraphAssets } from "../lib/logic-graph-document";

const state = vi.hoisted(() => ({
  documents: [] as OpenDocument[],
  assets: [] as IndexedAsset[],
  apply: vi.fn(),
  ensure: vi.fn(),
  undo: vi.fn(),
}));
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: state.documents,
  getOpenDocuments: () => state.documents,
  applyAssetDocumentChange: state.apply,
  ensureAssetDocument: state.ensure,
  undoDocument: state.undo,
  canUndoDocument: () => true,
  canRedoDocument: () => false,
  assetRegistry: {
    list: () => state.assets,
    getByGuid: (guid: string) => state.assets.find((entry) => entry.header.guid === guid),
    getRoot: () => ({ readOnly: false }),
  },
})));

const props = {} as IDockviewPanelProps;
const fields = [{ id: "damage", name: "Damage", typeId: "float", defaultValue: 10 }];
const objectPath = "assets/Sword.dataobject.babasset";
const sheetPath = "assets/Weapons.datasheet.babasset";
const objectId = `data-object:${objectPath}`;
const sheetId = `data-sheet:${sheetPath}`;
function indexed(guid: string, name: string, type: string, payload: Record<string, unknown>, path = `assets/${name}.babasset`): IndexedAsset {
  return { rootId: "project", path, header: { guid, name, type, version: 1, engineVersion: "0.0.0", mode: "thin", dependencies: [], payload, chunks: [] } };
}
function opened(kind: DocumentRef["kind"], path: string, content: Record<string, unknown>): OpenDocument {
  return { id: documentId({ kind, path }), ref: { kind, path, label: path }, content, layout: null, dirty: false };
}
function ObjectView({ id = objectId }: { id?: string }) {
  return <DocumentWorkspaceProvider documentId={id}><DataAssetEditingProvider><DataObjectValuesPanel {...props} /></DataAssetEditingProvider></DocumentWorkspaceProvider>;
}
function SheetView() {
  return <DocumentWorkspaceProvider documentId={sheetId}><DataAssetEditingProvider><DataSheetRowsPanel {...props} /><DataObjectValuesPanel {...props} /></DataAssetEditingProvider></DocumentWorkspaceProvider>;
}
function configureObject(nextFields: StructField[], values: Record<string, unknown>) {
  state.assets[0]!.header.payload = { kind: "structure", guid: "stats", name: "Stats", fields: nextFields };
  const schemas = typeSchemasFromGraphAssets(collectGraphTypeAssets({ assets: state.assets, openDocuments: [] }));
  const object = { ...createDataObjectForStructure("stats", nextFields, schemas), values };
  state.documents[0]!.content = object;
  state.assets[1]!.header.payload = object;
}
beforeEach(() => {
  const object = { kind: "dataObject", structureGuid: "stats", values: { Damage: 25 }, schema: fields };
  const sheet = { kind: "dataSheet", structureGuid: "stats", objectGuids: ["sword"] };
  state.assets = [
    indexed("stats", "Stats", "Structure", { kind: "structure", guid: "stats", name: "Stats", fields }),
    indexed("sword", "Sword", "DataObject", object, objectPath),
    indexed("weapons", "Weapons", "DataSheet", sheet, sheetPath),
  ];
  state.documents = [opened("data-object", objectPath, structuredClone(object)), opened("data-sheet", sheetPath, structuredClone(sheet))];
  state.apply.mockImplementation(async (id: string, next: Record<string, unknown>) => {
    state.documents = state.documents.map((doc) => doc.id === id ? { ...doc, content: next, dirty: true } : doc);
    return true;
  });
  state.ensure.mockImplementation(async (ref: DocumentRef) => {
    const id = documentId(ref);
    if (!state.documents.some((doc) => doc.id === id)) {
      const asset = state.assets.find((entry) => entry.path === ref.path)!;
      state.documents = [...state.documents, opened(ref.kind, ref.path, structuredClone(asset.header.payload!))];
    }
    return id;
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("edits a standalone object without requiring sheet membership and resets to authored Structure defaults", async () => {
  state.documents = state.documents.filter((doc) => doc.id === objectId);
  state.assets = state.assets.filter((asset) => asset.header.type !== "DataSheet");
  render(<ObjectView />);
  fireEvent.change(screen.getByLabelText("Damage"), { target: { value: "42" } });
  await waitFor(() => expect(state.apply).toHaveBeenLastCalledWith(objectId, expect.objectContaining({ values: { Damage: 42 } }), "data:damage"));
  expect(state.ensure).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Reset Damage" }));
  await waitFor(() => expect(state.documents[0]?.content).toMatchObject({ values: { Damage: 10 } }));
});

it("sheet cells use the shared unsaved object, preserve other edits, and keep membership separate", async () => {
  state.documents[0]!.content = { kind: "dataObject", structureGuid: "stats", values: { Damage: 60, Retired: "keep" }, schema: fields };
  const view = render(<SheetView />);
  expect((screen.getByRole("textbox", { name: "Sword Damage" }) as HTMLInputElement).value).toBe("60");
  fireEvent.change(screen.getByRole("textbox", { name: "Sword Damage" }), { target: { value: "75" } });
  await waitFor(() => expect(state.documents.find((doc) => doc.id === objectId)?.content).toMatchObject({ values: { Damage: 75, Retired: "keep" } }));
  expect(state.documents.find((doc) => doc.id === sheetId)?.content).toMatchObject({ objectGuids: ["sword"] });
  view.rerender(<SheetView />);
  fireEvent.click(screen.getByRole("button", { name: "Undo Object" }));
  expect(state.undo).toHaveBeenCalledWith(objectId);
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(state.documents.find((doc) => doc.id === sheetId)?.content).toMatchObject({ objectGuids: [] }));
  expect(state.documents.find((doc) => doc.id === objectId)?.content).toMatchObject({ values: { Damage: 75, Retired: "keep" } });
});

it("adds only matching standalone objects and filters names without mutating membership", async () => {
  state.assets.push(
    indexed("axe", "Axe", "DataObject", { kind: "dataObject", structureGuid: "stats", values: { Damage: 15 }, schema: fields }),
    indexed("other", "Unrelated", "DataObject", { kind: "dataObject", structureGuid: "other", values: {} }),
  );
  render(<SheetView />);
  fireEvent.click(screen.getByRole("button", { name: "Add Existing" }));
  expect(await screen.findByRole("option", { name: /Axe/ })).toBeTruthy();
  expect(screen.queryByRole("option", { name: /Unrelated|Sword/ })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: /Axe/ }));
  await waitFor(() => expect(state.documents.find((doc) => doc.id === sheetId)?.content).toMatchObject({ objectGuids: ["sword", "axe"] }));
  fireEvent.change(screen.getByRole("textbox", { name: "Filter Objects" }), { target: { value: "missing" } });
  expect(screen.queryByTestId("data-sheet-row-sword")).toBeNull();
  expect(state.documents.find((doc) => doc.id === sheetId)?.content).toMatchObject({ objectGuids: ["sword", "axe"] });
});

it("requires an explicit schema update before renaming fields and preserves the authored value", async () => {
  state.assets[0]!.header.payload = { kind: "structure", guid: "stats", name: "Stats", fields: [{ id: "damage", name: "Power", typeId: "float", defaultValue: 100 }] };
  const view = render(<ObjectView />);
  expect((screen.getByLabelText("Power") as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText("Power") as HTMLInputElement).value).toBe("25");
  fireEvent.click(screen.getByRole("button", { name: "Review Changes" }));
  fireEvent.click(await screen.findByRole("button", { name: "Apply Changes" }));
  await waitFor(() => expect(state.documents[0]?.content).toMatchObject({ values: { Power: 25 } }));
  view.rerender(<ObjectView />);
  expect((screen.getByLabelText("Power") as HTMLInputElement).disabled).toBe(false);
  expect(screen.queryByRole("button", { name: "Review Changes" })).toBeNull();
});

it.each(["edit", "reset"] as const)("allows %s to repair an incompatible field type after applying Structure changes", async (repair) => {
  state.assets[0]!.header.payload = { kind: "structure", guid: "stats", name: "Stats", fields: [{ id: "damage", name: "Damage", typeId: "float", defaultValue: 0 }] };
  state.documents[0]!.content = {
    kind: "dataObject", structureGuid: "stats", values: { Damage: "previous text", Retired: "material-guid" },
    schema: [{ id: "damage", name: "Damage", typeId: "string" }, { id: "retired", name: "Retired", typeId: "asset", typeClassId: "Material" }],
  };
  const view = render(<ObjectView />);
  fireEvent.click(screen.getByRole("button", { name: "Review Changes" }));
  fireEvent.click(await screen.findByRole("button", { name: "Apply Changes" }));
  await waitFor(() => expect(state.apply).toHaveBeenCalled());
  view.rerender(<ObjectView />);
  expect((screen.getByLabelText("Damage") as HTMLInputElement).disabled).toBe(false);
  if (repair === "edit") fireEvent.change(screen.getByLabelText("Damage"), { target: { value: "15" } });
  else fireEvent.click(screen.getByRole("button", { name: "Reset Damage" }));
  await waitFor(() => expect(state.documents[0]?.content).toMatchObject({
    values: { Damage: repair === "edit" ? 15 : 0, Retired: "material-guid" },
    schema: [{ id: "damage", name: "Damage", typeId: "float" }, { id: "retired", name: "Retired", typeId: "asset", typeClassId: "Material" }],
  }));
  view.rerender(<ObjectView />);
  expect(screen.queryByRole("button", { name: "Review Changes" })).toBeNull();
});

it.each(["string", "float"] as const)("reports and repairs invalid scalar values from a sheet cell with a %s snapshot", async (typeId) => {
  state.documents[0]!.content = { kind: "dataObject", structureGuid: "stats", values: { Damage: "previous text" }, schema: [{ id: "damage", name: "Damage", typeId }] };
  const view = render(<SheetView />);
  expect(screen.getByText(typeId === "string" ? "Review Value Type" : "Invalid Values")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Sword Damage" }), { target: { value: "18" } });
  await waitFor(() => expect(state.documents[0]?.content).toMatchObject({ values: { Damage: 18 }, schema: [{ id: "damage", name: "Damage", typeId: "float" }] }));
  view.rerender(<SheetView />);
  expect(screen.queryByText("Invalid Values")).toBeNull();
  expect(screen.queryByText("Review Value Type")).toBeNull();
});

it("editing a nested field preserves retired nested values and avoids an endless migration prompt", async () => {
  const nestedFields = [{ id: "weight", name: "Weight", typeId: "float" }];
  state.assets.push(indexed("settings", "Settings", "Structure", { kind: "structure", guid: "settings", name: "Settings", fields: nestedFields }));
  state.assets[0]!.header.payload = { kind: "structure", guid: "stats", name: "Stats", fields: [{ id: "settings", name: "Settings", typeId: "struct", typeClassId: "settings" }] };
  state.documents[0]!.content = { kind: "dataObject", structureGuid: "stats", values: { Settings: { Weight: 2, Retired: "keep" } }, schema: [{ id: "settings", name: "Settings", typeId: "struct", typeClassId: "settings", fields: nestedFields }] };
  render(<ObjectView />);
  expect(screen.queryByRole("button", { name: "Review Changes" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Settings Weight"), { target: { value: "3" } });
  await waitFor(() => expect(state.documents[0]?.content).toMatchObject({ values: { Settings: { Weight: 3, Retired: "keep" } } }));
});

it("reports recursive Structures without recursing through property controls", () => {
  state.assets[0]!.header.payload = { kind: "structure", guid: "stats", name: "Stats", fields: [{ id: "self", name: "Self", typeId: "struct", typeClassId: "stats" }] };
  state.documents[0]!.content = { kind: "dataObject", structureGuid: "stats", values: { Self: {} } };
  render(<ObjectView />);
  expect(screen.getByText("Recursive Structure")).toBeTruthy();
  expect(screen.queryByLabelText("Self Self")).toBeNull();
});

it("edits, reorders, adds and removes array entries through Values while sheet cells preserve the collection", async () => {
  configureObject([{ id: "amounts", name: "Amounts", typeId: "float", container: "array", defaultValue: [5] }], { Amounts: [10, 20], Retired: "keep" });
  const view = render(<SheetView />);
  expect(screen.queryByRole("textbox", { name: "Sword Amounts" })).toBeNull();
  fireEvent.click(screen.getByTestId("data-sheet-row-sword"));
  fireEvent.change(await screen.findByLabelText("Amounts Item 1"), { target: { value: "12" } });
  await waitFor(() => expect(state.documents[0]?.content).toMatchObject({ values: { Amounts: [12, 20], Retired: "keep" } }));
  view.rerender(<SheetView />);
  fireEvent.click(within(screen.getByRole("group", { name: "Amounts" })).getByRole("button", { name: "Move row 1 down" }));
  await waitFor(() => expect(state.documents[0]?.content).toMatchObject({ values: { Amounts: [20, 12] } }));
  view.rerender(<SheetView />);
  fireEvent.click(screen.getByRole("button", { name: "Add Item" }));
  await waitFor(() => expect(state.documents[0]?.content).toMatchObject({ values: { Amounts: [20, 12, 0] } }));
  view.rerender(<SheetView />);
  fireEvent.click(screen.getByRole("button", { name: "Remove row 2" }));
  await waitFor(() => expect(state.documents[0]?.content).toMatchObject({ values: { Amounts: [20, 0] } }));
  view.rerender(<SheetView />);
  fireEvent.click(screen.getByRole("button", { name: "Reset Amounts" }));
  await waitFor(() => expect(state.documents[0]?.content).toMatchObject({ values: { Amounts: [5], Retired: "keep" } }));
});

it("edits tag-keyed maps with nested typed collection values and keeps retired nested fields", async () => {
  state.assets.push(indexed("settings", "Settings", "Structure", { kind: "structure", guid: "settings", name: "Settings", fields: [
    { name: "Weights", typeId: "float", container: "array" },
    { name: "Material", typeId: "asset", typeClassId: "Material" },
  ] }), indexed("material", "Stone", "Material", {}));
  configureObject([{ id: "rewards", name: "Rewards", typeId: "struct", typeClassId: "settings", container: "map", keyTypeId: "tag" }], {
    Rewards: [{ key: 0, value: { Weights: [1], Material: "", Retired: "keep" } }],
  });
  const content = <TagProvider entries={[{ id: 7, path: "Reward", parentId: 0 }]}><ObjectView /></TagProvider>;
  const view = render(content);
  fireEvent.change(screen.getByLabelText("Rewards Value 1 Weights Item 1"), { target: { value: "3" } });
  await waitFor(() => expect(state.documents[0]?.content).toMatchObject({ values: { Rewards: [{ key: 0, value: { Weights: [3], Material: "", Retired: "keep" } }] } }));
  view.rerender(<TagProvider entries={[{ id: 7, path: "Reward", parentId: 0 }]}><ObjectView /></TagProvider>);
  fireEvent.click(screen.getByLabelText("Rewards Key 1"));
  fireEvent.keyDown(screen.getByRole("tree", { name: "Tags" }), { key: "ArrowDown" });
  fireEvent.keyDown(screen.getByRole("tree", { name: "Tags" }), { key: "Enter" });
  await waitFor(() => expect(state.documents[0]?.content).toMatchObject({ values: { Rewards: [{ key: 7, value: { Weights: [3], Retired: "keep" } }] } }));
  view.rerender(<TagProvider entries={[{ id: 7, path: "Reward", parentId: 0 }]}><ObjectView /></TagProvider>);
  fireEvent.click(screen.getByLabelText("Rewards Value 1 Material"));
  fireEvent.click(await screen.findByRole("option", { name: /Stone/ }));
  await waitFor(() => expect(state.documents[0]?.content).toMatchObject({ values: { Rewards: [{ key: 7, value: { Weights: [3], Material: "material", Retired: "keep" } }] } }));
});

it("uses the project tag controls for Tag and TagContainer values without dropping unavailable IDs on another edit", async () => {
  configureObject([{ id: "tag", name: "Category", typeId: "tag" }, { id: "tags", name: "Categories", typeId: "struct", typeClassId: "engine:TagContainer" }], { Category: 7, Categories: { Tags: [7, 99] } });
  const view = render(<TagProvider entries={[{ id: 7, path: "Reward", parentId: 0 }]}><ObjectView /></TagProvider>);
  expect(screen.getByRole("button", { name: "Category" }).textContent).toContain("Reward");
  fireEvent.click(screen.getByRole("button", { name: "Category" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear Selection" }));
  await waitFor(() => expect(state.documents[0]?.content).toMatchObject({ values: { Category: 0, Categories: { Tags: [7, 99] } } }));
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  view.rerender(<TagProvider entries={[{ id: 7, path: "Reward", parentId: 0 }]}><ObjectView /></TagProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Categories" }));
  fireEvent.click(screen.getByRole("button", { name: "Deselect All" }));
  await waitFor(() => expect(state.documents[0]?.content).toMatchObject({ values: { Category: 0, Categories: { Tags: [] } } }));
});
