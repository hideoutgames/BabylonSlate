import { afterEach, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useGraphPanelCatalogs } from "./graph-panel-catalogs";

const SAVE_PATH = "assets/Progress.hasset";
const docs = vi.hoisted(() => ({
  projectDocument: { settings: { saveGame: { definitionGuid: "save-asset" } } },
  assetRegistry: {
    list: () => [{ rootId: "project", path: "assets/Progress.hasset", header: { guid: "save-asset", type: "SaveGame", name: "Progress", payload: {} } }],
  },
  registryEpoch: 1,
  openDocuments: [] as unknown[],
}));
vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => docs));

function saveGameTab(fieldName: string) {
  return {
    id: `save-game:${SAVE_PATH}`,
    ref: { kind: "save-game", path: SAVE_PATH, label: "Progress" },
    content: { id: "progress", schemaVersion: 1, fields: [{ id: "coins-id", name: fieldName, type: "int", defaultValue: 5 }] },
    layout: null,
    dirty: true,
  };
}

afterEach(() => {
  cleanup();
  docs.openDocuments = [];
});

it("follows unsaved edits to the open Save Game tab and keeps its definition between unrelated renders", () => {
  docs.openDocuments = [saveGameTab("Coins")];
  const { result, rerender } = renderHook(() => useGraphPanelCatalogs());
  const first = result.current.saveGameDefinition;
  expect(first?.fields.map((field) => field.name)).toEqual(["Coins"]);

  rerender();
  expect(result.current.saveGameDefinition).toBe(first);

  docs.openDocuments = [saveGameTab("Gold")];
  rerender();
  expect(result.current.saveGameDefinition?.fields.map((field) => field.name)).toEqual(["Gold"]);
});
