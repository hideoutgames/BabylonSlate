import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { SaveGameDefinition } from "@babylonslate/core";
import { SaveGameFieldsPanel, SaveGameDefinitionPanel } from "./save-game-panels";
import { SaveGameEditingProvider } from "../context/save-game-editing-context";

// Base UI forwards native checkbox/switch activation through PointerEvent.
if (typeof window.PointerEvent === "undefined") {
  window.PointerEvent = MouseEvent as unknown as typeof PointerEvent;
}

const harness = vi.hoisted(() => ({
  definition: {} as SaveGameDefinition,
  apply: vi.fn<(id: string, definition: SaveGameDefinition) => Promise<boolean>>(),
  settings: vi.fn(),
  defaultGuid: null as string | null,
}));
vi.mock("../context/document-workspace-context", () => ({ useDocumentWorkspace: () => ({ documentId: "progress" }) }));
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: [{ id: "progress", ref: { kind: "save-game", path: "Progress.savegame.babasset" }, content: harness.definition }],
  assetRegistry: { getByPath: () => ({ header: { guid: "definition" } }), list: () => [] },
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
    await waitFor(() => expect(screen.getByText("Invalid Save Definition")).toBeTruthy());
    expect(harness.apply).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Field ID" })).toBeNull();
  });

  it("validates names before adding and selects a new field for typed defaults", async () => {
    const view = render(editor());
    fireEvent.click(screen.getByRole("button", { name: "Add Field" }));
    fireEvent.change(screen.getByLabelText("Field Name"), { target: { value: "Score" } });
    fireEvent.click(screen.getByTestId("name-prompt-confirm"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(harness.apply).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Field Name"), { target: { value: "Coins" } });
    fireEvent.click(screen.getByTestId("name-prompt-confirm"));
    await waitFor(() => expect(harness.apply).toHaveBeenCalled());
    const added = harness.apply.mock.calls.at(-1)![1];
    expect(added.fields[0]).toEqual({ id: "score-id", name: "Score", type: "int", defaultValue: 5 });
    expect(added.fields[1]).toMatchObject({ name: "Coins", type: "int", defaultValue: 0 });
    expect(added.fields[1]!.id).not.toBe("score-id");
    view.rerender(editor());
    expect(screen.getByTestId(`property-name-${added.fields[1]!.id}`)).toHaveProperty("value", "Coins");
    fireEvent.click(screen.getByTestId("save-game-field-type"));
    fireEvent.click(await screen.findByTestId("search-item-vec3"));
    await waitFor(() => expect(harness.definition.fields[1]).toMatchObject({ type: "vector3", defaultValue: { x: 0, y: 0, z: 0 } }));
    view.rerender(editor());
    fireEvent.click(screen.getByTestId("save-game-field-type"));
    fireEvent.click(await screen.findByTestId("search-item-string"));
    await waitFor(() => expect(harness.definition.fields[1]).toMatchObject({ type: "string", defaultValue: "" }));
    view.rerender(editor());
    fireEvent.click(screen.getByRole("button", { name: "Array" }));
    await waitFor(() => expect(harness.definition.fields[1]).toMatchObject({ array: true, type: "string", defaultValue: [] }));
    view.rerender(editor());
    fireEvent.click(screen.getByRole("button", { name: "Add Item" }));
    expect(harness.definition.fields[1]).toMatchObject({ defaultValue: [""] });
    expect(harness.definition.fields[0]).toEqual({ id: "score-id", name: "Score", type: "int", defaultValue: 5 });
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

  it("reorders array defaults without changing values or the field identity", () => {
    harness.definition.fields[0] = { id: "score-id", name: "Milestones", type: "int", array: true, defaultValue: [10, 20] };
    render(editor());
    fireEvent.click(screen.getByTestId("save-game-field-defaults-1-move-up"));
    expect(harness.definition.fields[0]).toEqual({ id: "score-id", name: "Milestones", type: "int", array: true, defaultValue: [20, 10] });
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
