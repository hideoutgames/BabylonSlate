import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { SaveGameDefinition } from "@babylonslate/core";
import { SaveGameFieldsPanel, SaveGameDefinitionPanel } from "./save-game-panels";

// Base UI forwards native checkbox/switch activation through PointerEvent.
if (typeof window.PointerEvent === "undefined") {
  window.PointerEvent = MouseEvent as unknown as typeof PointerEvent;
}

const harness = vi.hoisted(() => ({
  definition: {} as SaveGameDefinition,
  apply: vi.fn(async () => true),
  settings: vi.fn(),
}));
vi.mock("../context/document-workspace-context", () => ({ useDocumentWorkspace: () => ({ documentId: "progress" }) }));
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: [{ id: "progress", ref: { kind: "save-game", path: "Progress.savegame.babasset" }, content: harness.definition }],
  assetRegistry: { getByPath: () => ({ header: { guid: "definition" } }), list: () => [] },
  projectDocument: { settings: { saveGame: { definitionGuid: null, defaultProfile: "player", defaultSlot: "checkpoint", wipeOnPlay: false } } },
  applyAssetDocumentChange: harness.apply,
  updateProjectSettings: harness.settings,
})));
const props = {} as IDockviewPanelProps;
beforeEach(() => {
  harness.definition = { id: "definition", schemaVersion: 1, fields: [{ id: "score-id", name: "Score", type: "int", defaultValue: 5 }] };
  harness.apply.mockClear(); harness.settings.mockClear();
});
afterEach(cleanup);

describe("Save Game authoring", () => {
  it("renames a field without replacing its persisted identity and rejects unsafe names", async () => {
    render(<SaveGameFieldsPanel {...props} />);
    fireEvent.change(screen.getByTestId("property-name-score-id"), { target: { value: "Coins" } });
    expect(harness.apply).toHaveBeenCalledWith("progress", { id: "definition", schemaVersion: 1, fields: [{ id: "score-id", name: "Coins", type: "int", defaultValue: 5 }] });
    harness.apply.mockClear();
    fireEvent.change(screen.getByTestId("property-name-score-id"), { target: { value: "constructor" } });
    await waitFor(() => expect(screen.getByText("Invalid Save Definition")).toBeTruthy());
    expect(harness.apply).not.toHaveBeenCalled();
  });

  it("adds distinct fields with typed defaults and converts an array through form controls", () => {
    render(<SaveGameFieldsPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Add Field" }));
    const added = harness.apply.mock.calls.at(-1) as unknown as [string, SaveGameDefinition];
    expect(added[1].fields[0]).toEqual(harness.definition.fields[0]);
    expect(added[1].fields[1]).toMatchObject({ name: "Field1", type: "int", defaultValue: 0 });
    expect(added[1].fields[1].id).not.toBe("score-id");
    fireEvent.click(screen.getByRole("checkbox", { name: "Array" }));
    expect(harness.apply).toHaveBeenLastCalledWith("progress", expect.objectContaining({ fields: [{ id: "score-id", name: "Score", type: "int", defaultValue: [], array: true }] }));
  });

  it("reports damaged definitions without substituting empty defaults", () => {
    harness.definition = { id: "definition", schemaVersion: 1, fields: [{ id: "x", name: "Score", type: "int", defaultValue: "invalid" }] };
    render(<SaveGameFieldsPanel {...props} />);
    expect(screen.getByRole("button", { name: "Add Field" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Invalid Save Definition")).toBeTruthy();
    expect(harness.apply).not.toHaveBeenCalled();
  });

  it("selects the project default without replacing profile and slot preferences", () => {
    render(<SaveGameDefinitionPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Use As Project Default" }));
    expect(harness.settings).toHaveBeenCalledWith({ saveGame: { definitionGuid: "definition", defaultProfile: "player", defaultSlot: "checkpoint", wipeOnPlay: false } });
    expect(screen.getByText(/"Score": number/)).toBeTruthy();
  });
});
