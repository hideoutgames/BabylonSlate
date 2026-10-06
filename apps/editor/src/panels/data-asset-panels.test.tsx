import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { IndexedAsset } from "@babylonslate/assets";
import { documentId, isDataTreeAsset, type DataDefinitionField, type DocumentRef } from "@babylonslate/core";
import { createDataEntryForDefinition } from "@babylonslate/scripting";
import { TagProvider } from "@babylonslate/editor-kit";
import type { OpenDocument } from "../services/document-service";
import { DataAssetEditingProvider, useDataAssetEditing } from "../context/data-asset-editing-context";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { DataTreeHierarchyPanel, DataTreeValuesPanel, DataTreeEntriesPanel, DataTreeValidationPanel } from "./data-asset-panels";
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
const treePath = "assets/Weapons.datatree.babasset";
const treeId = `data-tree:${treePath}`;
function indexed(guid: string, name: string, type: string, payload: Record<string, unknown>, path = `assets/${name}.babasset`): IndexedAsset {
  return { rootId: "project", path, header: { guid, name, type, version: 1, engineVersion: "0.0.0", mode: "thin", dependencies: [], payload, chunks: [] } };
}
function opened(kind: DocumentRef["kind"], path: string, content: Record<string, unknown>): OpenDocument {
  return { id: documentId({ kind, path }), ref: { kind, path, label: path }, content, layout: null, dirty: false };
}
let captured: ReturnType<typeof useDataAssetEditing>;
function CaptureTreeState() { captured = useDataAssetEditing(); return null; }
function TreeViewFixture() {
  return <DocumentWorkspaceProvider documentId={treeId}><DataAssetEditingProvider><CaptureTreeState /><DataTreeHierarchyPanel {...props} /><DataTreeEntriesPanel {...props} /><DataTreeValuesPanel {...props} /><DataTreeValidationPanel {...props} /></DataAssetEditingProvider></DocumentWorkspaceProvider>;
}
function tree() {
  const content = state.documents[0]?.content;
  if (!isDataTreeAsset(content)) throw new Error("Expected the tree fixture");
  return content;
}
function configureEntries(nextFields: DataDefinitionField[], rows: Array<{ id: string; name: string; values: Record<string, unknown> }>) {
  state.assets[0]!.header.payload = { kind: "dataDefinition", fields: nextFields };
  const schemas = typeSchemasFromGraphAssets(collectGraphTypeAssets({ assets: state.assets, openDocuments: [] }));
  state.documents[0]!.content = { kind: "dataTree", defaultDefinitionGuid: "stats", entries: rows.map((row) => ({ ...createDataEntryForDefinition("stats", nextFields, schemas, row.name, row.id), values: row.values })) };
}
beforeEach(() => {
  state.locked = false;
  state.assets = [indexed("stats", "Stats", "DataDefinition", { kind: "dataDefinition", fields }), indexed("weapons", "Weapons", "DataTree", { kind: "dataTree", defaultDefinitionGuid: "stats", entries: [] }, treePath)];
  state.documents = [opened("data-tree", treePath, { kind: "dataTree", defaultDefinitionGuid: "stats", entries: [] })];
  configureEntries(fields, [{ id: "sword", name: "Sword", values: { Damage: 25 } }]);
  state.apply.mockImplementation(async (id: string, next: Record<string, unknown>) => {
    state.documents = state.documents.map((doc) => doc.id === id ? { ...doc, content: next, dirty: true } : doc);
    return true;
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("edits owned entries through one tree document and shares live values between cells and Values", async () => {
  configureEntries(fields, [{ id: "sword", name: "Sword", values: { Damage: 60, Retired: "keep" } }]);
  const view = render(<TreeViewFixture />);
  fireEvent.change(screen.getByRole("textbox", { name: "Sword Damage" }), { target: { value: "75" } });
  await waitFor(() => expect(tree().entries[0]?.values).toEqual({ Damage: 75, Retired: "keep" }));
  expect(state.apply).toHaveBeenLastCalledWith(treeId, expect.objectContaining({ entries: [expect.objectContaining({ id: "sword" })] }), "data:sword:damage");
  view.rerender(<TreeViewFixture />);
  expect((screen.getByLabelText("Damage") as HTMLInputElement).value).toBe("75");
  fireEvent.click(screen.getByRole("button", { name: "Reset Damage" }));
  await waitFor(() => expect(tree().entries[0]?.values).toEqual({ Damage: 10, Retired: "keep" }));
  expect(state.documents).toHaveLength(1);
  expect(state.open).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /Undo|Redo/ })).toBeNull();
});

it("searches values and sorts visible entries without reordering stored data", () => {
  configureEntries([...fields, { id: "label", name: "Label", typeId: "string" }], [
    { id: "sword", name: "Sword", values: { Damage: 50, Label: "Training" } },
    { id: "axe", name: "Axe", values: { Damage: 15, Label: "Heavy" } },
  ]);
  render(<TreeViewFixture />);
  fireEvent.click(screen.getByRole("button", { name: "Sort By Damage" }));
  const rows = within(screen.getByRole("grid", { name: "Branch Entries" })).getAllByRole("row");
  expect(rows[1]?.getAttribute("data-testid")).toBe("data-tree-entry-axe");
  expect(tree().entries.map((row) => row.id)).toEqual(["sword", "axe"]);
  fireEvent.change(screen.getByRole("textbox", { name: "Search Entries" }), { target: { value: "training" } });
  expect(screen.getByTestId("data-tree-entry-sword")).toBeTruthy();
  expect(screen.queryByTestId("data-tree-entry-axe")).toBeNull();
  expect(state.apply).not.toHaveBeenCalled();
});

it("hides columns and validation selects and reveals the affected row and field", async () => {
  configureEntries(fields, [{ id: "sword", name: "Sword", values: { Damage: "invalid" } }, { id: "axe", name: "Axe", values: { Damage: 15 } }]);
  render(<TreeViewFixture />);
  fireEvent.click(screen.getByRole("button", { name: "View" }));
  fireEvent.click(screen.getByTestId("context-menu-item-columns"));
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Damage" }));
  fireEvent.keyDown(screen.getByRole("menuitemcheckbox", { name: "Damage" }), { key: "Escape" });
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("columnheader", { name: /Damage/ })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Search Entries" }), { target: { value: "Axe" } });
  expect(screen.queryByTestId("data-tree-entry-sword")).toBeNull();
  fireEvent.click(screen.getByTestId("data-validation-issue"));
  await waitFor(() => expect(screen.getByTestId("data-tree-entry-sword").getAttribute("aria-selected")).toBe("true"));
  expect(screen.getByRole("columnheader", { name: /Damage/ })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByLabelText("Damage"));
});

it("requires explicit field reconciliation after a Definition rename and retains values", async () => {
  state.assets[0]!.header.payload = { kind: "dataDefinition", fields: [{ id: "damage", name: "Power", typeId: "float", defaultValue: 100 }] };
  const view = render(<TreeViewFixture />);
  fireEvent.click(screen.getByTestId("data-tree-entry-sword"));
  expect((screen.getByLabelText("Power") as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText("Power") as HTMLInputElement).value).toBe("25");
  fireEvent.click(screen.getByRole("button", { name: "Review Changes" }));
  fireEvent.click(await screen.findByRole("button", { name: "Apply Changes" }));
  await waitFor(() => expect(tree().entries[0]?.values).toEqual({ Power: 25 }));
  view.rerender(<TreeViewFixture />);
  expect((screen.getByLabelText("Power") as HTMLInputElement).disabled).toBe(false);
  expect(screen.queryByRole("button", { name: "Review Changes" })).toBeNull();
});

it.each(["edit", "reset"] as const)("allows %s to repair an incompatible field type after applying Definition changes", async (repair) => {
  tree().entries[0] = { id: "sword", parentId: null, name: "Sword", values: { Damage: "previous text", Retired: "material-guid" }, schema: [{ id: "damage", name: "Damage", typeId: "string" }, { id: "retired", name: "Retired", typeId: "asset", typeClassId: "Material" }] };
  const view = render(<TreeViewFixture />);
  fireEvent.click(screen.getByTestId("data-tree-entry-sword"));
  fireEvent.click(screen.getByRole("button", { name: "Review Changes" }));
  fireEvent.click(await screen.findByRole("button", { name: "Apply Changes" }));
  await act(async () => { await Promise.resolve(); });
  view.rerender(<TreeViewFixture />);
  expect((screen.getByLabelText("Damage") as HTMLInputElement).disabled).toBe(false);
  if (repair === "edit") fireEvent.change(screen.getByLabelText("Damage"), { target: { value: "15" } });
  else fireEvent.click(screen.getByRole("button", { name: "Reset Damage" }));
  await waitFor(() => expect(tree().entries[0]).toMatchObject({ values: { Damage: repair === "edit" ? 15 : 10, Retired: "material-guid" }, schema: [{ id: "damage", name: "Damage", typeId: "float" }, { id: "retired", name: "Retired", typeId: "asset", typeClassId: "Material" }] }));
  view.rerender(<TreeViewFixture />);
  expect(screen.queryByRole("button", { name: "Review Changes" })).toBeNull();
});

it("edits nested tag-keyed maps and arrays while retaining retired values", async () => {
  state.assets.push(indexed("settings", "Settings", "DataDefinition", { kind: "dataDefinition", fields: [
    { id: "weights", name: "Weights", typeId: "float", container: "array" }, { id: "material", name: "Material", typeId: "asset", typeClassId: "Material" },
  ] }), indexed("material", "Stone", "Material", {}));
  configureEntries([{ id: "rewards", name: "Rewards", typeId: "struct", typeClassId: "settings", container: "map", keyTypeId: "tag" }], [{ id: "sword", name: "Sword", values: { Rewards: [{ key: 0, value: { Weights: [1], Material: "", Retired: "keep" } }] } }]);
  const tags = [{ id: 7, path: "Reward", parentId: 0 }];
  const view = render(<TagProvider entries={tags}><TreeViewFixture /></TagProvider>);
  fireEvent.click(screen.getByTestId("data-tree-entry-sword"));
  fireEvent.change(screen.getByLabelText("Rewards Value 1 Weights Item 1"), { target: { value: "3" } });
  await waitFor(() => expect(tree().entries[0]?.values).toMatchObject({ Rewards: [{ key: 0, value: { Weights: [3], Material: "", Retired: "keep" } }] }));
  view.rerender(<TagProvider entries={tags}><TreeViewFixture /></TagProvider>);
  fireEvent.click(screen.getByLabelText("Rewards Key 1"));
  fireEvent.keyDown(screen.getByRole("tree", { name: "Tags" }), { key: "ArrowDown" });
  fireEvent.keyDown(screen.getByRole("tree", { name: "Tags" }), { key: "Enter" });
  await waitFor(() => expect(tree().entries[0]?.values).toMatchObject({ Rewards: [{ key: 7, value: { Weights: [3], Retired: "keep" } }] }));
  view.rerender(<TagProvider entries={tags}><TreeViewFixture /></TagProvider>);
  fireEvent.click(screen.getByLabelText("Rewards Value 1 Material"));
  fireEvent.click(await screen.findByRole("option", { name: /Stone/ }));
  await waitFor(() => expect(tree().entries[0]?.values).toMatchObject({ Rewards: [{ key: 7, value: { Weights: [3], Material: "material", Retired: "keep" } }] }));
});

it("uses project Tag and TagContainer controls without dropping unavailable IDs on another edit", async () => {
  configureEntries([{ id: "tag", name: "Category", typeId: "tag" }, { id: "tags", name: "Categories", typeId: "struct", typeClassId: "engine:TagContainer" }], [{ id: "sword", name: "Sword", values: { Category: 7, Categories: { Tags: [7, 99] } } }]);
  const tags = [{ id: 7, path: "Reward", parentId: 0 }];
  const view = render(<TagProvider entries={tags}><TreeViewFixture /></TagProvider>);
  fireEvent.click(screen.getByTestId("data-tree-entry-sword"));
  expect(screen.getByRole("button", { name: "Category" }).textContent).toContain("Reward");
  fireEvent.click(screen.getByRole("button", { name: "Category" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear Selection" }));
  await waitFor(() => expect(tree().entries[0]?.values).toEqual({ Category: 0, Categories: { Tags: [7, 99] } }));
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  view.rerender(<TagProvider entries={tags}><TreeViewFixture /></TagProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Categories" }));
  fireEvent.click(screen.getByRole("button", { name: "Deselect All" }));
  await waitFor(() => expect(tree().entries[0]?.values).toEqual({ Category: 0, Categories: { Tags: [] } }));
});

it("keeps locked trees read-only including collection actions", () => {
  configureEntries([{ id: "amounts", name: "Amounts", typeId: "float", container: "array" }], [{ id: "sword", name: "Sword", values: { Amounts: [10] } }]);
  state.locked = true;
  render(<TreeViewFixture />);
  fireEvent.click(screen.getByTestId("data-tree-entry-sword"));
  expect((screen.getByRole("button", { name: "New Entry" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText("Amounts Item 1") as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Add Item" }));
  expect(state.apply).not.toHaveBeenCalled();
});

it("reports recursive Definitions without recursing through property controls", () => {
  state.assets[0]!.header.payload = { kind: "dataDefinition", fields: [{ id: "self", name: "Self", typeId: "struct", typeClassId: "stats" }] };
  tree().entries[0] = { id: "sword", parentId: null, name: "Sword", values: { Self: {} } };
  render(<TreeViewFixture />);
  fireEvent.click(screen.getByTestId("data-tree-entry-sword"));
  expect(screen.getByText("Recursive Definition")).toBeTruthy();
  expect(screen.queryByLabelText("Self Self")).toBeNull();
});

it("pastes a typed 2 by 2 table over sorted visible entries as one tree change", async () => {
  configureEntries([...fields, { id: "enabled", name: "Enabled", typeId: "bool" }], [
    { id: "sword", name: "Sword", values: { Damage: 50, Enabled: false } },
    { id: "axe", name: "Axe", values: { Damage: 15, Enabled: true } },
  ]);
  render(<TreeViewFixture />);
  fireEvent.click(screen.getByRole("button", { name: "Sort By Damage" }));
  fireEvent.paste(screen.getByRole("textbox", { name: "Axe Damage" }), { clipboardData: { getData: () => "25\ttrue\r\n10\tfalse\r\n" } });
  await waitFor(() => expect(tree().entries.map((row) => [row.id, row.values])).toEqual([
    ["sword", { Damage: 10, Enabled: false }], ["axe", { Damage: 25, Enabled: true }],
  ]));
  expect(state.apply).toHaveBeenCalledTimes(1);
  expect(state.apply).toHaveBeenCalledWith(treeId, expect.objectContaining({ entries: expect.any(Array) }), undefined);
});

it.each(["invalid", "100"])("rejects an invalid batch paste atomically when a later row contains %s", async (value) => {
  configureEntries([{ ...fields[0]!, max: 60 }, { id: "enabled", name: "Enabled", typeId: "bool" }], [
    { id: "sword", name: "Sword", values: { Damage: 50, Enabled: false } },
    { id: "axe", name: "Axe", values: { Damage: 15, Enabled: true } },
  ]);
  const before = structuredClone(tree());
  render(<TreeViewFixture />);
  fireEvent.paste(screen.getByRole("textbox", { name: "Sword Damage" }), { clipboardData: { getData: () => `25\ttrue\n${value}\tfalse` } });
  await waitFor(() => expect(screen.getByText("Data Edit Failed")).toBeTruthy());
  expect(tree()).toEqual(before);
  expect(state.apply).not.toHaveBeenCalled();
});

it("diagnoses duplicate entry identities and disables mutations without silently replacing IDs", () => {
  configureEntries(fields, [{ id: "same", name: "Sword", values: { Damage: 25 } }, { id: "same", name: "Axe", values: { Damage: 15 } }]);
  const before = structuredClone(tree());
  render(<TreeViewFixture />);
  expect(screen.getByText("Entries need unique, non-empty identities without surrounding whitespace.")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Sword Damage" })).toBeNull();
  expect((screen.getByRole("button", { name: "New Entry" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Add Root" }) as HTMLButtonElement).disabled).toBe(true);
  expect(state.apply).not.toHaveBeenCalled();
  expect(tree()).toEqual(before);
});

it("adds children with owned defaults, keeps stable identities on rename, and inherits only the Definition", async () => {
  delete tree().entries[0]!.definitionGuid;
  const view = render(<TreeViewFixture />);
  fireEvent.keyDown(screen.getByRole("tree", { name: "Data Tree" }), { key: "Home" });
  fireEvent.click(screen.getByRole("button", { name: "Add Child" }));
  await waitFor(() => expect(tree().entries).toHaveLength(2));
  const child = tree().entries[1]!;
  expect(child).toMatchObject({ parentId: "sword", name: "New Entry", values: { Damage: 10 } });
  expect(child.definitionGuid).toBeUndefined();
  expect(tree().entries[0]?.values.Damage).toBe(25);
  view.rerender(<TreeViewFixture />);
  fireEvent.change(screen.getByRole("textbox", { name: "New Entry Damage" }), { target: { value: "40" } });
  await waitFor(() => expect(tree().entries[1]?.values.Damage).toBe(40));
  expect(tree().entries[0]?.values.Damage).toBe(25);
  view.rerender(<TreeViewFixture />);
  fireEvent.click(screen.getByRole("button", { name: "Entry Menu For New Entry" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Iron Sword" } });
  fireEvent.click(screen.getByTestId("name-prompt-confirm"));
  await waitFor(() => expect(tree().entries[1]).toMatchObject({ id: child.id, parentId: "sword", name: "Iron Sword", values: { Damage: 40 } }));
  expect(state.apply).toHaveBeenCalledTimes(3);
});

it("duplicates a whole subtree with independent values and remapped parent IDs then removes it atomically", async () => {
  configureEntries(fields, [{ id: "weapons", name: "Weapons", values: { Damage: 5 } }, { id: "sword", name: "Sword", values: { Damage: 25 } }]);
  tree().entries[1]!.parentId = "weapons";
  const view = render(<TreeViewFixture />);
  fireEvent.click(screen.getByRole("button", { name: "Entry Menu For Weapons" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate Subtree" }));
  await waitFor(() => expect(tree().entries).toHaveLength(4));
  await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Duplicate Subtree" })).toBeNull());
  const copiedParent = tree().entries.find((entry) => entry.name === "Weapons Copy")!;
  const copiedChild = tree().entries.find((entry) => entry.parentId === copiedParent.id)!;
  expect(copiedParent.id).not.toBe("weapons");
  expect(copiedChild).toMatchObject({ name: "Sword", values: { Damage: 25 } });
  expect(copiedChild.id).not.toBe("sword");
  expect(copiedChild.values).not.toBe(tree().entries.find((entry) => entry.id === "sword")!.values);
  expect(state.apply).toHaveBeenCalledTimes(1);
  view.rerender(<TreeViewFixture />);
  fireEvent.click(screen.getByRole("button", { name: "Entry Menu For Weapons Copy" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Remove Subtree" }));
  expect(screen.getByText(/and 1 descendant/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(tree().entries.map((entry) => entry.id)).toEqual(["weapons", "sword"]));
  expect(state.apply).toHaveBeenCalledTimes(2);
});

it("moves entries by canonical paths, excludes descendants from destinations, and retains authored values", async () => {
  configureEntries(fields, [{ id: "weapons", name: "Weapons", values: { Damage: 5 } }, { id: "sword", name: "Sword", values: { Damage: 25 } }, { id: "armor", name: "Armor", values: { Damage: 0 } }]);
  tree().entries[1]!.parentId = "weapons";
  const view = render(<TreeViewFixture />);
  fireEvent.click(screen.getByRole("button", { name: "Entry Menu For Weapons" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Move To" }));
  expect(screen.queryByRole("option", { name: /Weapons\/Sword/ })).toBeNull();
  expect(screen.queryByRole("option", { name: /^Weapons/ })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: /Armor/ }));
  await waitFor(() => expect(tree().entries.find((entry) => entry.id === "weapons")!.parentId).toBe("armor"));
  expect(tree().entries.find((entry) => entry.id === "sword")).toMatchObject({ parentId: "weapons", values: { Damage: 25 } });
  expect(state.apply).toHaveBeenCalledTimes(1);
  view.rerender(<TreeViewFixture />);
  fireEvent.keyDown(screen.getByRole("tree", { name: "Data Tree" }), { key: "End" });
  expect(within(screen.getByTestId("data-tree-values-panel")).getByText("Armor/Weapons/Sword")).toBeTruthy();
});

it("rejects sibling name collisions and names containing path separators", async () => {
  configureEntries(fields, [{ id: "sword", name: "Sword", values: { Damage: 5 } }, { id: "axe", name: "Axe", values: { Damage: 25 } }]);
  render(<TreeViewFixture />);
  fireEvent.click(screen.getByRole("button", { name: "Entry Menu For Axe" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "sWORD" } });
  fireEvent.click(screen.getByTestId("name-prompt-confirm"));
  expect(screen.getByText(/unique among siblings/i)).toBeTruthy();
  expect(state.apply).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Sword/Child" } });
  fireEvent.click(screen.getByTestId("name-prompt-confirm"));
  expect(state.apply).not.toHaveBeenCalled();
});

it("preserves values while overriding a branch to None and returning to its inherited Definition", async () => {
  delete tree().entries[0]!.definitionGuid;
  const view = render(<TreeViewFixture />);
  fireEvent.keyDown(screen.getByRole("tree", { name: "Data Tree" }), { key: "Home" });
  expect(screen.getByText("Inherited From Tree Default")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Entry Definition" }));
  fireEvent.click(screen.getByRole("option", { name: /None/ }));
  await waitFor(() => expect(tree().entries[0]!.definitionGuid).toBeNull());
  expect(tree().entries[0]!.values).toEqual({ Damage: 25 });
  view.rerender(<TreeViewFixture />);
  expect(screen.getByText("Untyped Entry")).toBeTruthy();
  expect(screen.queryByLabelText("Damage")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Use Parent Definition" }));
  await waitFor(() => expect(tree().entries[0]!.definitionGuid).toBeUndefined());
  view.rerender(<TreeViewFixture />);
  expect((screen.getByLabelText("Damage") as HTMLInputElement).value).toBe("25");
});

it("uses a mixed Definition overview until the user filters to a homogeneous editable grid", () => {
  state.assets.push(indexed("armor", "Armor", "DataDefinition", { kind: "dataDefinition", fields: [{ id: "defense", name: "Defense", typeId: "float", defaultValue: 5 }] }));
  configureEntries(fields, [{ id: "sword", name: "Sword", values: { Damage: 25 } }, { id: "shield", name: "Shield", values: { Defense: 50 } }]);
  tree().entries[1] = { id: "shield", parentId: null, name: "Shield", definitionGuid: "armor", values: { Defense: 50 }, schema: [{ id: "defense", name: "Defense", typeId: "float" }] };
  render(<TreeViewFixture />);
  expect(screen.getByRole("columnheader", { name: "Definition" })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Sword Damage" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Filter Definition" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Stats" }));
  expect(screen.getByRole("textbox", { name: "Sword Damage" })).toBeTruthy();
  expect(screen.queryByTestId("data-tree-entry-shield")).toBeNull();
  expect(state.apply).not.toHaveBeenCalled();
});

it("keeps matching ancestors visible in tree search and reveals hidden paths from Validation", async () => {
  configureEntries(fields, [{ id: "weapons", name: "Weapons", values: { Damage: 5 } }, { id: "sword", name: "Sword", values: { Damage: "invalid" } }, { id: "armor", name: "Armor", values: { Damage: 0 } }]);
  tree().entries[1]!.parentId = "weapons";
  render(<TreeViewFixture />);
  fireEvent.change(screen.getByRole("textbox", { name: "Search Tree" }), { target: { value: "sword" } });
  expect(screen.getByTestId("tree-row-weapons")).toBeTruthy();
  expect(screen.getByTestId("tree-row-sword")).toBeTruthy();
  expect(screen.queryByTestId("tree-row-armor")).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Search Tree" }), { target: { value: "armor" } });
  fireEvent.click(screen.getByTestId("data-validation-issue"));
  await waitFor(() => expect(screen.getByTestId("tree-row-sword").getAttribute("aria-selected")).toBe("true"));
  expect(screen.getByTestId("data-tree-entry-sword").getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(screen.getByLabelText("Damage"));
});

it("rejects cyclic reparenting without applying a partial hierarchy change", async () => {
  configureEntries(fields, [{ id: "weapons", name: "Weapons", values: { Damage: 5 } }, { id: "sword", name: "Sword", values: { Damage: 25 } }]);
  tree().entries[1]!.parentId = "weapons";
  const before = structuredClone(tree());
  render(<TreeViewFixture />);
  await expect(captured.moveEntry("weapons", "sword")).rejects.toThrow(/cycle/i);
  expect(tree()).toEqual(before);
  expect(state.apply).not.toHaveBeenCalled();
});

it("serializes concurrent entry creation against the latest tree so names and values cannot be lost", async () => {
  render(<TreeViewFixture />);
  await act(async () => { await Promise.all([captured.addEntry(null), captured.addEntry(null)]); });
  expect(tree().entries.map((entry) => entry.name)).toEqual(["Sword", "New Entry", "New Entry 2"]);
  expect(tree().entries[1]?.values).toEqual({ Damage: 10 });
  expect(tree().entries[2]?.values).toEqual({ Damage: 10 });
  expect(state.apply).toHaveBeenCalledTimes(2);
});

it("rejects an edit queued for a closed and replaced tree document", async () => {
  const view = render(<TreeViewFixture />);
  const originalApply = state.apply.getMockImplementation()!;
  let release: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  state.apply.mockImplementationOnce(async (...args: unknown[]) => { await originalApply(...args); await pending; return true; });
  let first: Promise<unknown>;
  let second: Promise<unknown>;
  await act(async () => {
    first = captured.addEntry(null);
    second = captured.addEntry(null).catch((reason: unknown) => reason);
    await Promise.resolve();
  });
  const afterFirst = structuredClone(tree());
  view.unmount();
  state.documents = [opened("data-tree", treePath, { ...afterFirst })];
  release();
  await first!;
  expect(await second!).toBeInstanceOf(Error);
  expect(tree()).toEqual(afterFirst);
  expect(state.apply).toHaveBeenCalledTimes(1);
});
