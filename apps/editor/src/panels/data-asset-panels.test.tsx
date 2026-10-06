import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { IndexedAsset } from "@babylonslate/assets";
import { documentId, isDataSheetAsset, type DataDefinitionField, type DocumentRef } from "@babylonslate/core";
import { createDataRowForDefinition } from "@babylonslate/scripting";
import { TagProvider } from "@babylonslate/editor-kit";
import type { OpenDocument } from "../services/document-service";
import { DataAssetEditingProvider } from "../context/data-asset-editing-context";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { DataSheetValuesPanel, DataSheetRowsPanel, DataSheetValidationPanel } from "./data-asset-panels";
import { collectGraphTypeAssets, typeSchemasFromGraphAssets } from "../lib/logic-graph-document";

const state = vi.hoisted(() => ({
  documents: [] as OpenDocument[], assets: [] as IndexedAsset[], apply: vi.fn(), open: vi.fn(), locked: false,
}));
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: state.documents, getOpenDocuments: () => state.documents,
  applyAssetDocumentChange: state.apply, openDocument: state.open,
  assetRegistry: {
    list: () => state.assets,
    getByGuid: (guid: string) => state.assets.find((entry) => entry.header.guid === guid),
    getRoot: () => ({ readOnly: state.locked }),
  },
})));
const props = {} as IDockviewPanelProps;
const fields: DataDefinitionField[] = [{ id: "damage", name: "Damage", typeId: "float", defaultValue: 10 }];
const sheetPath = "assets/Weapons.datasheet.babasset";
const sheetId = `data-sheet:${sheetPath}`;
function indexed(guid: string, name: string, type: string, payload: Record<string, unknown>, path = `assets/${name}.babasset`): IndexedAsset {
  return { rootId: "project", path, header: { guid, name, type, version: 1, engineVersion: "0.0.0", mode: "thin", dependencies: [], payload, chunks: [] } };
}
function opened(kind: DocumentRef["kind"], path: string, content: Record<string, unknown>): OpenDocument {
  return { id: documentId({ kind, path }), ref: { kind, path, label: path }, content, layout: null, dirty: false };
}
function SheetView() {
  return <DocumentWorkspaceProvider documentId={sheetId}><DataAssetEditingProvider><DataSheetRowsPanel {...props} /><DataSheetValuesPanel {...props} /><DataSheetValidationPanel {...props} /></DataAssetEditingProvider></DocumentWorkspaceProvider>;
}
function sheet() {
  const content = state.documents[0]?.content;
  if (!isDataSheetAsset(content)) throw new Error("Expected the sheet fixture");
  return content;
}
function configureRows(nextFields: DataDefinitionField[], rows: Array<{ id: string; name: string; values: Record<string, unknown> }>) {
  state.assets[0]!.header.payload = { kind: "dataDefinition", fields: nextFields };
  const schemas = typeSchemasFromGraphAssets(collectGraphTypeAssets({ assets: state.assets, openDocuments: [] }));
  state.documents[0]!.content = { kind: "dataSheet", definitionGuid: "stats", rows: rows.map((row) => ({ ...createDataRowForDefinition("stats", nextFields, schemas, row.name, row.id), values: row.values })) };
}
beforeEach(() => {
  state.locked = false;
  state.assets = [indexed("stats", "Stats", "DataDefinition", { kind: "dataDefinition", fields }), indexed("weapons", "Weapons", "DataSheet", { kind: "dataSheet", definitionGuid: "stats", rows: [] }, sheetPath)];
  state.documents = [opened("data-sheet", sheetPath, { kind: "dataSheet", definitionGuid: "stats", rows: [] })];
  configureRows(fields, [{ id: "sword", name: "Sword", values: { Damage: 25 } }]);
  state.apply.mockImplementation(async (id: string, next: Record<string, unknown>) => {
    state.documents = state.documents.map((doc) => doc.id === id ? { ...doc, content: next, dirty: true } : doc);
    return true;
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("edits owned rows through one sheet document and shares live values between cells and Values", async () => {
  configureRows(fields, [{ id: "sword", name: "Sword", values: { Damage: 60, Retired: "keep" } }]);
  const view = render(<SheetView />);
  fireEvent.change(screen.getByRole("textbox", { name: "Sword Damage" }), { target: { value: "75" } });
  await waitFor(() => expect(sheet().rows[0]?.values).toEqual({ Damage: 75, Retired: "keep" }));
  expect(state.apply).toHaveBeenLastCalledWith(sheetId, expect.objectContaining({ rows: [expect.objectContaining({ id: "sword" })] }), "data:sword:damage");
  view.rerender(<SheetView />);
  expect((screen.getByLabelText("Damage") as HTMLInputElement).value).toBe("75");
  fireEvent.click(screen.getByRole("button", { name: "Reset Damage" }));
  await waitFor(() => expect(sheet().rows[0]?.values).toEqual({ Damage: 10, Retired: "keep" }));
  expect(state.documents).toHaveLength(1);
  expect(state.open).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /Undo|Redo/ })).toBeNull();
});

it("adds defaulted rows, duplicates independent values, renames stable IDs, and removes only the selected row", async () => {
  const view = render(<SheetView />);
  fireEvent.click(screen.getByRole("button", { name: "New Row" }));
  await waitFor(() => expect(sheet().rows).toHaveLength(2));
  const addedId = sheet().rows[1]!.id;
  expect(sheet().rows[1]).toMatchObject({ name: "New Entry", values: { Damage: 10 } });
  view.rerender(<SheetView />);
  fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
  await waitFor(() => expect(sheet().rows).toHaveLength(3));
  expect(sheet().rows[2]).toMatchObject({ name: "New Entry Copy", values: { Damage: 10 } });
  expect(sheet().rows[2]!.id).not.toBe(addedId);
  expect(sheet().rows[2]!.values).not.toBe(sheet().rows[1]!.values);
  view.rerender(<SheetView />);
  const duplicateId = sheet().rows[2]!.id;
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "sWORD" } });
  fireEvent.click(screen.getByTestId("name-prompt-confirm"));
  expect(screen.getByText("A row with this name already exists.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Axe" } });
  fireEvent.click(screen.getByTestId("name-prompt-confirm"));
  await waitFor(() => expect(sheet().rows[2]).toMatchObject({ id: duplicateId, name: "Axe" }));
  view.rerender(<SheetView />);
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(sheet().rows.map((row) => row.id)).toEqual(["sword", addedId]));
});

it("searches values and sorts visible rows without reordering stored data", () => {
  configureRows([...fields, { id: "label", name: "Label", typeId: "string" }], [
    { id: "sword", name: "Sword", values: { Damage: 50, Label: "Training" } },
    { id: "axe", name: "Axe", values: { Damage: 15, Label: "Heavy" } },
  ]);
  render(<SheetView />);
  fireEvent.click(screen.getByRole("button", { name: "Sort By Damage" }));
  const rows = within(screen.getByRole("grid", { name: "Data Rows" })).getAllByRole("row");
  expect(rows[1]?.getAttribute("data-testid")).toBe("data-sheet-row-axe");
  expect(sheet().rows.map((row) => row.id)).toEqual(["sword", "axe"]);
  fireEvent.change(screen.getByRole("textbox", { name: "Search Rows" }), { target: { value: "training" } });
  expect(screen.getByTestId("data-sheet-row-sword")).toBeTruthy();
  expect(screen.queryByTestId("data-sheet-row-axe")).toBeNull();
  expect(state.apply).not.toHaveBeenCalled();
});

it("hides columns and validation selects and reveals the affected row and field", async () => {
  configureRows(fields, [{ id: "sword", name: "Sword", values: { Damage: "invalid" } }, { id: "axe", name: "Axe", values: { Damage: 15 } }]);
  render(<SheetView />);
  fireEvent.click(screen.getByRole("button", { name: "View" }));
  fireEvent.click(screen.getByTestId("context-menu-item-columns"));
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Damage" }));
  fireEvent.keyDown(screen.getByRole("menuitemcheckbox", { name: "Damage" }), { key: "Escape" });
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("columnheader", { name: /Damage/ })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Search Rows" }), { target: { value: "Axe" } });
  expect(screen.queryByTestId("data-sheet-row-sword")).toBeNull();
  fireEvent.click(screen.getByTestId("data-validation-issue"));
  await waitFor(() => expect(screen.getByTestId("data-sheet-row-sword").getAttribute("aria-selected")).toBe("true"));
  expect(screen.getByRole("columnheader", { name: /Damage/ })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByLabelText("Damage"));
});

it("requires explicit field reconciliation after a Definition rename and retains values", async () => {
  state.assets[0]!.header.payload = { kind: "dataDefinition", fields: [{ id: "damage", name: "Power", typeId: "float", defaultValue: 100 }] };
  const view = render(<SheetView />);
  fireEvent.click(screen.getByTestId("data-sheet-row-sword"));
  expect((screen.getByLabelText("Power") as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText("Power") as HTMLInputElement).value).toBe("25");
  fireEvent.click(screen.getByRole("button", { name: "Review Changes" }));
  fireEvent.click(await screen.findByRole("button", { name: "Apply Changes" }));
  await waitFor(() => expect(sheet().rows[0]?.values).toEqual({ Power: 25 }));
  view.rerender(<SheetView />);
  expect((screen.getByLabelText("Power") as HTMLInputElement).disabled).toBe(false);
  expect(screen.queryByRole("button", { name: "Review Changes" })).toBeNull();
});

it.each(["edit", "reset"] as const)("allows %s to repair an incompatible field type after applying Definition changes", async (repair) => {
  sheet().rows[0] = { id: "sword", name: "Sword", values: { Damage: "previous text", Retired: "material-guid" }, schema: [{ id: "damage", name: "Damage", typeId: "string" }, { id: "retired", name: "Retired", typeId: "asset", typeClassId: "Material" }] };
  const view = render(<SheetView />);
  fireEvent.click(screen.getByTestId("data-sheet-row-sword"));
  fireEvent.click(screen.getByRole("button", { name: "Review Changes" }));
  fireEvent.click(await screen.findByRole("button", { name: "Apply Changes" }));
  await waitFor(() => expect(state.apply).toHaveBeenCalled());
  view.rerender(<SheetView />);
  expect((screen.getByLabelText("Damage") as HTMLInputElement).disabled).toBe(false);
  if (repair === "edit") fireEvent.change(screen.getByLabelText("Damage"), { target: { value: "15" } });
  else fireEvent.click(screen.getByRole("button", { name: "Reset Damage" }));
  await waitFor(() => expect(sheet().rows[0]).toMatchObject({ values: { Damage: repair === "edit" ? 15 : 10, Retired: "material-guid" }, schema: [{ id: "damage", name: "Damage", typeId: "float" }, { id: "retired", name: "Retired", typeId: "asset", typeClassId: "Material" }] }));
  view.rerender(<SheetView />);
  expect(screen.queryByRole("button", { name: "Review Changes" })).toBeNull();
});

it("edits nested tag-keyed maps and arrays while retaining retired values", async () => {
  state.assets.push(indexed("settings", "Settings", "DataDefinition", { kind: "dataDefinition", fields: [
    { id: "weights", name: "Weights", typeId: "float", container: "array" }, { id: "material", name: "Material", typeId: "asset", typeClassId: "Material" },
  ] }), indexed("material", "Stone", "Material", {}));
  configureRows([{ id: "rewards", name: "Rewards", typeId: "struct", typeClassId: "settings", container: "map", keyTypeId: "tag" }], [{ id: "sword", name: "Sword", values: { Rewards: [{ key: 0, value: { Weights: [1], Material: "", Retired: "keep" } }] } }]);
  const tags = [{ id: 7, path: "Reward", parentId: 0 }];
  const view = render(<TagProvider entries={tags}><SheetView /></TagProvider>);
  fireEvent.click(screen.getByTestId("data-sheet-row-sword"));
  fireEvent.change(screen.getByLabelText("Rewards Value 1 Weights Item 1"), { target: { value: "3" } });
  await waitFor(() => expect(sheet().rows[0]?.values).toMatchObject({ Rewards: [{ key: 0, value: { Weights: [3], Material: "", Retired: "keep" } }] }));
  view.rerender(<TagProvider entries={tags}><SheetView /></TagProvider>);
  fireEvent.click(screen.getByLabelText("Rewards Key 1"));
  fireEvent.keyDown(screen.getByRole("tree", { name: "Tags" }), { key: "ArrowDown" });
  fireEvent.keyDown(screen.getByRole("tree", { name: "Tags" }), { key: "Enter" });
  await waitFor(() => expect(sheet().rows[0]?.values).toMatchObject({ Rewards: [{ key: 7, value: { Weights: [3], Retired: "keep" } }] }));
  view.rerender(<TagProvider entries={tags}><SheetView /></TagProvider>);
  fireEvent.click(screen.getByLabelText("Rewards Value 1 Material"));
  fireEvent.click(await screen.findByRole("option", { name: /Stone/ }));
  await waitFor(() => expect(sheet().rows[0]?.values).toMatchObject({ Rewards: [{ key: 7, value: { Weights: [3], Material: "material", Retired: "keep" } }] }));
});

it("uses project Tag and TagContainer controls without dropping unavailable IDs on another edit", async () => {
  configureRows([{ id: "tag", name: "Category", typeId: "tag" }, { id: "tags", name: "Categories", typeId: "struct", typeClassId: "engine:TagContainer" }], [{ id: "sword", name: "Sword", values: { Category: 7, Categories: { Tags: [7, 99] } } }]);
  const tags = [{ id: 7, path: "Reward", parentId: 0 }];
  const view = render(<TagProvider entries={tags}><SheetView /></TagProvider>);
  fireEvent.click(screen.getByTestId("data-sheet-row-sword"));
  expect(screen.getByRole("button", { name: "Category" }).textContent).toContain("Reward");
  fireEvent.click(screen.getByRole("button", { name: "Category" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear Selection" }));
  await waitFor(() => expect(sheet().rows[0]?.values).toEqual({ Category: 0, Categories: { Tags: [7, 99] } }));
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  view.rerender(<TagProvider entries={tags}><SheetView /></TagProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Categories" }));
  fireEvent.click(screen.getByRole("button", { name: "Deselect All" }));
  await waitFor(() => expect(sheet().rows[0]?.values).toEqual({ Category: 0, Categories: { Tags: [] } }));
});

it("keeps locked sheets read-only including collection actions", () => {
  configureRows([{ id: "amounts", name: "Amounts", typeId: "float", container: "array" }], [{ id: "sword", name: "Sword", values: { Amounts: [10] } }]);
  state.locked = true;
  render(<SheetView />);
  fireEvent.click(screen.getByTestId("data-sheet-row-sword"));
  expect((screen.getByRole("button", { name: "New Row" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText("Amounts Item 1") as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Add Item" }));
  expect(state.apply).not.toHaveBeenCalled();
});

it("reports recursive Definitions without recursing through property controls", () => {
  state.assets[0]!.header.payload = { kind: "dataDefinition", fields: [{ id: "self", name: "Self", typeId: "struct", typeClassId: "stats" }] };
  sheet().rows[0] = { id: "sword", name: "Sword", values: { Self: {} } };
  render(<SheetView />);
  fireEvent.click(screen.getByTestId("data-sheet-row-sword"));
  expect(screen.getByText("Recursive Definition")).toBeTruthy();
  expect(screen.queryByLabelText("Self Self")).toBeNull();
});

it("pastes a typed 2 by 2 table over sorted visible rows as one sheet change", async () => {
  configureRows([...fields, { id: "enabled", name: "Enabled", typeId: "bool" }], [
    { id: "sword", name: "Sword", values: { Damage: 50, Enabled: false } },
    { id: "axe", name: "Axe", values: { Damage: 15, Enabled: true } },
  ]);
  render(<SheetView />);
  fireEvent.click(screen.getByRole("button", { name: "Sort By Damage" }));
  fireEvent.paste(screen.getByRole("textbox", { name: "Axe Damage" }), { clipboardData: { getData: () => "25\ttrue\r\n10\tfalse\r\n" } });
  await waitFor(() => expect(sheet().rows.map((row) => [row.id, row.values])).toEqual([
    ["sword", { Damage: 10, Enabled: false }], ["axe", { Damage: 25, Enabled: true }],
  ]));
  expect(state.apply).toHaveBeenCalledTimes(1);
  expect(state.apply).toHaveBeenCalledWith(sheetId, expect.objectContaining({ rows: expect.any(Array) }), undefined);
});

it.each(["invalid", "100"])("rejects an invalid batch paste atomically when a later row contains %s", async (value) => {
  configureRows([{ ...fields[0]!, max: 60 }, { id: "enabled", name: "Enabled", typeId: "bool" }], [
    { id: "sword", name: "Sword", values: { Damage: 50, Enabled: false } },
    { id: "axe", name: "Axe", values: { Damage: 15, Enabled: true } },
  ]);
  const before = structuredClone(sheet());
  render(<SheetView />);
  fireEvent.paste(screen.getByRole("textbox", { name: "Sword Damage" }), { clipboardData: { getData: () => `25\ttrue\n${value}\tfalse` } });
  await waitFor(() => expect(screen.getByText("Data Edit Failed")).toBeTruthy());
  expect(sheet()).toEqual(before);
  expect(state.apply).not.toHaveBeenCalled();
});

it("diagnoses duplicate row identities and disables every row mutation without silently replacing IDs", () => {
  configureRows(fields, [{ id: "same", name: "Sword", values: { Damage: 25 } }, { id: "same", name: "Axe", values: { Damage: 15 } }]);
  const before = structuredClone(sheet());
  render(<SheetView />);
  expect(screen.getByText("Entries need unique, non-empty identities without surrounding whitespace.")).toBeTruthy();
  fireEvent.click(screen.getAllByTestId("data-sheet-row-same")[0]!);
  expect(screen.getByText("Invalid Row Identities")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Sword Damage" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "New Row" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(state.apply).not.toHaveBeenCalled();
  expect(sheet()).toEqual(before);
});
