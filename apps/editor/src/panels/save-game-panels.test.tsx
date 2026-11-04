import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { SaveGameDefinition } from "@haptic/core";
import { ENGINE_ENUMS } from "@haptic/scripting";
import { SaveGameFieldsPanel, SaveGameDefinitionPanel } from "./save-game-panels";
import { SaveGameEditingProvider } from "../context/save-game-editing-context";
import { dispatchPointerEvent } from "../../../../packages/editor-kit/src/test-support/pointer-events";

// Base UI forwards native checkbox/switch activation through PointerEvent.
if (typeof window.PointerEvent === "undefined") {
  window.PointerEvent = MouseEvent as unknown as typeof PointerEvent;
}

const harness = vi.hoisted(() => ({
  definition: {} as SaveGameDefinition,
  apply: vi.fn<(id: string, definition: SaveGameDefinition) => Promise<boolean>>(),
  settings: vi.fn(),
  defaultGuid: null as string | null,
  assets: [] as Array<{ path: string; header: { guid: string; name: string; type: string; payload: Record<string, unknown> } }>,
}));
vi.mock("../context/document-workspace-context", () => ({ useDocumentWorkspace: () => ({ documentId: "progress" }) }));
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: [{ id: "progress", ref: { kind: "save-game", path: "Progress.savegame.hasset" }, content: harness.definition }],
  assetRegistry: { getByPath: () => ({ header: { guid: "definition" } }), getByGuid: () => undefined, list: () => harness.assets },
  projectDocument: { settings: { saveGame: { definitionGuid: harness.defaultGuid, defaultProfile: "player", defaultSlot: "checkpoint", wipeOnPlay: false } } },
  applyAssetDocumentChange: harness.apply,
  updateProjectSettings: harness.settings,
})));
const props = {} as IDockviewPanelProps;
function editor() {
  return <SaveGameEditingProvider><SaveGameFieldsPanel {...props} /><SaveGameDefinitionPanel {...props} /></SaveGameEditingProvider>;
}
beforeEach(() => {
  harness.definition = { id: "definition", schemaVersion: 1, fields: [{ id: "score-id", name: "Score", type: "int", defaultValue: 5 }] };
  harness.defaultGuid = null;
  harness.assets = [];
  harness.apply.mockReset(); harness.settings.mockClear();
  harness.apply.mockImplementation(async (_id, definition) => { harness.definition = definition; return true; });
});
afterEach(cleanup);

describe("Save Game authoring", () => {
  it("renames a field without replacing its persisted identity and rejects unsafe names", async () => {
    render(editor());
    const handle = screen.getByTestId("property-default-score-id-Default Value-scrub");
    fireEvent.pointerDown(handle, { clientX: 0 });
    fireEvent.pointerMove(handle, { clientX: 1 });
    fireEvent.pointerUp(handle, { clientX: 1 });
    // Integer rounding keeps 5; an unchanged edit must not become a failed write.
    expect(harness.apply).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(screen.getByTestId("property-name-score-id"), { target: { value: "Coins" } });
    expect(harness.apply).toHaveBeenCalledWith("progress", { id: "definition", schemaVersion: 1, fields: [{ id: "score-id", name: "Coins", type: "int", defaultValue: 5 }] });
    harness.apply.mockClear();
    fireEvent.change(screen.getByTestId("property-name-score-id"), { target: { value: "constructor" } });
    expect(screen.getByText("Choose a different field name; this name is reserved.")).toBeTruthy();
    expect(harness.apply).not.toHaveBeenCalled();
    fireEvent.blur(screen.getByTestId("property-name-score-id"));
    expect(screen.getByTestId("property-name-score-id")).toHaveProperty("value", "Coins");
    expect(screen.queryByText("Choose a different field name; this name is reserved.")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Field ID" })).toBeNull();
  });

  it("adds a field of the picked type under a free NewField name and renames it inline", async () => {
    const view = render(editor());
    fireEvent.click(screen.getByTestId("save-game-add-field"));
    fireEvent.click(await screen.findByTestId("search-item-tag"));
    await waitFor(() => expect(harness.definition.fields).toHaveLength(2));
    const added = harness.definition.fields[1]!;
    expect(harness.definition.fields[0]).toEqual({ id: "score-id", name: "Score", type: "int", defaultValue: 5 });
    expect(added).toMatchObject({ name: "NewField", type: "tag", defaultValue: 0 });
    expect(added.id).not.toBe("score-id");
    view.rerender(editor());
    // The new row opens in rename with its name selected, and the Inspector shows the new field.
    const input = await screen.findByTestId(`tree-rename-${added.id}`) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "NewField".length]);
    expect(screen.getByTestId(`property-name-${added.id}`)).toHaveProperty("value", "NewField");
    fireEvent.change(input, { target: { value: "Rank" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(harness.definition.fields[1]).toEqual({ ...added, name: "Rank" }));
    view.rerender(editor());
    fireEvent.click(screen.getByTestId("save-game-add-field"));
    fireEvent.click(await screen.findByTestId("search-item-vec2"));
    await waitFor(() => expect(harness.definition.fields).toHaveLength(3));
    fireEvent.click(screen.getByTestId("save-game-add-field"));
    fireEvent.click(await screen.findByTestId("search-item-color"));
    await waitFor(() => expect(harness.definition.fields).toHaveLength(4));
    expect(harness.definition.fields.slice(2)).toMatchObject([
      { name: "NewField", type: "vector2", defaultValue: { x: 0, y: 0 } },
      { name: "NewField_1", type: "color", defaultValue: { x: 0, y: 0, z: 0, w: 0 } },
    ]);
  });

  it("renames a field on a double tap of its name and keeps the name when another field has it", async () => {
    harness.definition.fields.push({ id: "level-id", name: "Level", type: "int", defaultValue: 1 });
    const view = render(editor());
    const label = screen.getByText("Level");
    for (let tap = 0; tap < 2; tap++) {
      dispatchPointerEvent(label, "pointerdown", { clientX: 10, clientY: 10 });
      dispatchPointerEvent(label, "pointerup", { clientX: 10, clientY: 10 });
    }
    const input = await screen.findByTestId("tree-rename-level-id");
    fireEvent.change(input, { target: { value: "Score" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("A field with this name already exists.")).toBeTruthy();
    expect(harness.apply).not.toHaveBeenCalled();
    view.rerender(editor());
    // Clicking elsewhere commits a valid name.
    fireEvent.keyDown(screen.getByRole("tree", { name: "Save Fields" }), { key: "F2" });
    fireEvent.change(await screen.findByTestId("tree-rename-level-id"), { target: { value: "Stage" } });
    fireEvent.pointerDown(document.body);
    fireEvent.blur(screen.getByTestId("tree-rename-level-id"));
    await waitFor(() => expect(harness.definition.fields[1]).toEqual({ id: "level-id", name: "Stage", type: "int", defaultValue: 1 }));
    expect(screen.queryByText("A field with this name already exists.")).toBeNull();
  });

  it("changes the type and container of a field with a typed starting value", async () => {
    const view = render(editor());
    const pick = async (type: string) => {
      view.rerender(editor());
      fireEvent.click(screen.getByTestId("save-game-field-type"));
      fireEvent.click(await screen.findByTestId(`search-item-${type}`));
    };
    await pick("vec3");
    await waitFor(() => expect(harness.definition.fields[0]).toMatchObject({ id: "score-id", type: "vector3", defaultValue: { x: 0, y: 0, z: 0 } }));
    await pick("transform");
    await waitFor(() => expect(harness.definition.fields[0]).toMatchObject({ type: "transform", defaultValue: {
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 },
    } }));
    view.rerender(editor());
    fireEvent.change(screen.getByTestId("property-default-score-id-Default Value-scale-z"), { target: { value: "2" } });
    expect(harness.definition.fields[0]!.defaultValue).toMatchObject({ scale: { x: 1, y: 1, z: 2 } });
    await pick("tagContainer");
    await waitFor(() => expect(harness.definition.fields[0]).toEqual({ id: "score-id", name: "Score", type: "struct", structId: "engine:TagContainer", defaultValue: { Tags: [] } }));
    view.rerender(editor());
    expect(screen.getByTestId("save-game-field-type").textContent).toContain("TagContainer");
    await pick("enum");
    await waitFor(() => expect(harness.definition.fields[0]).toMatchObject({ type: "enum" }));
    const field = harness.definition.fields[0]!;
    expect(field.structId).toBeUndefined();
    expect(field.defaultValue).toBe(ENGINE_ENUMS.find((entry) => entry.id === field.enumId)?.members[0]?.name);
    await pick("string");
    await waitFor(() => expect(harness.definition.fields[0]).toMatchObject({ type: "string", defaultValue: "" }));
    expect(harness.definition.fields[0]!.enumId).toBeUndefined();
    view.rerender(editor());
    fireEvent.click(screen.getByRole("button", { name: "Array" }));
    await waitFor(() => expect(harness.definition.fields[0]).toMatchObject({ container: "array", type: "string", defaultValue: [] }));
    view.rerender(editor());
    fireEvent.click(screen.getByRole("button", { name: "Add Item" }));
    expect(harness.definition.fields[0]).toMatchObject({ defaultValue: [""] });
  });

  it("turns a field into a Structure field with that Structure's defaults", async () => {
    const view = render(editor());
    fireEvent.click(screen.getByTestId("save-game-field-type"));
    fireEvent.click(await screen.findByTestId("search-item-struct"));
    await waitFor(() => expect(harness.definition.fields[0]).toMatchObject({ id: "score-id", type: "struct" }));
    const field = harness.definition.fields[0]!;
    expect(typeof field.structId).toBe("string");
    expect(field.defaultValue).toEqual(expect.any(Object));
    view.rerender(editor());
    expect(screen.getByText("Only Structures without object references can be saved.")).toBeTruthy();
  });

  it("selects search results and removes only that field, restoring remaining details", async () => {
    harness.definition.fields.push({ id: "level-id", name: "Level", type: "int", defaultValue: 1 });
    const view = render(editor());
    fireEvent.change(screen.getByRole("textbox", { name: "Search Fields" }), { target: { value: "Level" } });
    const tree = screen.getByRole("tree", { name: "Save Fields" });
    fireEvent.keyDown(tree, { key: "Home" });
    expect(screen.getByTestId("property-name-level-id")).toHaveProperty("value", "Level");
    fireEvent.change(screen.getByTestId("property-default-level-id-Default Value"), { target: { value: "4" } });
    expect(harness.definition.fields).toEqual([
      { id: "score-id", name: "Score", type: "int", defaultValue: 5 },
      { id: "level-id", name: "Level", type: "int", defaultValue: 4 },
    ]);
    view.rerender(editor());
    fireEvent.click(screen.getByRole("button", { name: "Remove Level" }));
    await waitFor(() => expect(harness.definition.fields).toHaveLength(1));
    view.rerender(editor());
    expect(screen.getByTestId("property-name-score-id")).toHaveProperty("value", "Score");
  });

  it("keeps Map defaults as entries with unique keys", async () => {
    const view = render(editor());
    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    await waitFor(() => expect(harness.definition.fields[0]).toEqual({ id: "score-id", name: "Score", type: "int", container: "map", keyType: "string", defaultValue: [] }));
    view.rerender(editor());
    fireEvent.click(screen.getByRole("button", { name: "Add Entry" }));
    view.rerender(editor());
    fireEvent.click(screen.getByRole("button", { name: "Add Entry" }));
    expect(harness.definition.fields[0]!.defaultValue).toEqual([{ key: "Key", value: 0 }, { key: "Key_1", value: 0 }]);
    view.rerender(editor());
    fireEvent.click(screen.getByTestId("save-game-field-key-type"));
    fireEvent.click(await screen.findByTestId("search-item-int"));
    await waitFor(() => expect(harness.definition.fields[0]).toMatchObject({ keyType: "int", defaultValue: [] }));
  });

  it("reorders array defaults without changing values or the field identity", () => {
    harness.definition.fields[0] = { id: "score-id", name: "Milestones", type: "int", container: "array", defaultValue: [10, 20] };
    render(editor());
    fireEvent.click(screen.getByTestId("save-game-field-defaults-1-move-up"));
    expect(harness.definition.fields[0]).toEqual({ id: "score-id", name: "Milestones", type: "int", container: "array", defaultValue: [20, 10] });
  });

  it("reports damaged definitions without substituting empty defaults", () => {
    harness.definition = { id: "definition", schemaVersion: 1, fields: [{ id: "x", name: "Score", type: "int", defaultValue: "invalid" }] };
    render(<SaveGameEditingProvider><SaveGameFieldsPanel {...props} /></SaveGameEditingProvider>);
    expect(screen.getByRole("button", { name: "Add Field" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Invalid Save Definition")).toBeTruthy();
    expect(harness.apply).not.toHaveBeenCalled();
  });

  it("sets up the project without replacing profile and slot preferences", () => {
    const view = render(editor());
    fireEvent.click(screen.getByRole("button", { name: "Use As Project Default" }));
    expect(harness.settings).toHaveBeenCalledWith({ saveGame: { definitionGuid: "definition", defaultProfile: "player", defaultSlot: "checkpoint", wipeOnPlay: false } });
    harness.defaultGuid = "definition";
    view.rerender(editor());
    fireEvent.change(screen.getByRole("textbox", { name: "Default Slot" }), { target: { value: "autosave" } });
    expect(harness.settings).toHaveBeenLastCalledWith({ saveGame: { definitionGuid: "definition", defaultProfile: "player", defaultSlot: "autosave", wipeOnPlay: false } });
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByText(/"Score": number/)).toBeTruthy();
  });
});

describe("Save Games linked to a Data Definition", () => {
  const dataDefinition = (fields: object[]) => ({
    path: "ProgressFields.datadefinition.hasset",
    header: { guid: "progress-fields", name: "ProgressFields", type: "DataDefinition", payload: { kind: "dataDefinition", fields } },
  });
  const fields = [
    { id: "coins-id", name: "Coins", typeId: "int", defaultValue: 5 },
    { id: "squad-id", name: "Squad", typeId: "struct", typeClassId: "missing-structure" },
  ];
  beforeEach(() => {
    harness.assets = [dataDefinition(fields)];
    harness.definition = { id: "definition", schemaVersion: 1, fields: [], dataDefinitionId: "progress-fields" };
  });

  it("shows the Data Definition's fields without Add Field, Name, renaming or type changes", async () => {
    render(editor());
    expect(screen.queryByRole("button", { name: "Add Field" })).toBeNull();
    expect(screen.getByTestId("save-game-open-data-definition").textContent).toBe("Open ProgressFields");
    expect(screen.queryByTestId("property-name-coins-id")).toBeNull();
    expect(screen.getByTestId("save-game-field-type").hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Remove Coins" })).toBeNull();
    const label = within(screen.getByRole("tree", { name: "Save Fields" })).getByText("Coins");
    for (let tap = 0; tap < 2; tap++) {
      dispatchPointerEvent(label, "pointerdown", { clientX: 10, clientY: 10 });
      dispatchPointerEvent(label, "pointerup", { clientX: 10, clientY: 10 });
    }
    fireEvent.keyDown(screen.getByRole("tree", { name: "Save Fields" }), { key: "F2" });
    expect(screen.queryByTestId("tree-rename-coins-id")).toBeNull();
    // A Structure field with an unknown Structure cannot be saved; the warning names it.
    expect(screen.getByTestId("save-game-skipped-fields").textContent).toContain("Squad");
  });

  it("stores default changes as overrides and resets them to the Data Definition's default", async () => {
    const view = render(editor());
    expect(screen.getByTestId("property-default-coins-id-Default Value")).toHaveProperty("value", "5");
    fireEvent.change(screen.getByTestId("property-default-coins-id-Default Value"), { target: { value: "40" } });
    expect(harness.definition).toEqual({ id: "definition", schemaVersion: 1, fields: [], dataDefinitionId: "progress-fields", defaults: { "coins-id": 40 } });
    // Renaming the field in its Data Definition keeps the override, because both use the field's ID.
    harness.assets = [dataDefinition([{ ...fields[0], name: "Gold" }])];
    view.rerender(editor());
    expect(within(screen.getByRole("tree", { name: "Save Fields" })).getByText("Gold")).toBeTruthy();
    expect(screen.getByTestId("property-default-coins-id-Default Value")).toHaveProperty("value", "40");
    fireEvent.click(screen.getByTestId("save-game-reset-default"));
    await waitFor(() => expect(harness.definition.defaults).toEqual({}));
  });

  it("asks before replacing a Save Game's own fields, and keeps the linked fields when unlinked", async () => {
    harness.definition = { id: "definition", schemaVersion: 1, fields: [{ id: "score-id", name: "Score", type: "int", defaultValue: 5 }] };
    const view = render(editor());
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    fireEvent.click(screen.getByTestId("property-progress-save-data-definition"));
    fireEvent.click(await screen.findByTestId("search-item-progress-fields"));
    expect(await screen.findByText("Replace 1 Field?")).toBeTruthy();
    expect(harness.apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("save-game-link-confirm"));
    await waitFor(() => expect(harness.definition).toEqual({ id: "definition", schemaVersion: 1, fields: [], dataDefinitionId: "progress-fields" }));
    view.rerender(editor());
    expect(within(screen.getByRole("tree", { name: "Save Fields" })).getByText("Coins")).toBeTruthy();
    fireEvent.click(screen.getByTestId("property-progress-save-data-definition"));
    fireEvent.click(await screen.findByTestId("search-item-__none__"));
    await waitFor(() => expect(harness.definition).toEqual({ id: "definition", schemaVersion: 1, fields: [{ id: "coins-id", name: "Coins", type: "int", defaultValue: 5 }] }));
  });
});
