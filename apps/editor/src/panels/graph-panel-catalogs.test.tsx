import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useGraphPanelCatalogs } from "./graph-panel-catalogs";
import { indexedAssetRegistry } from "../testing/indexed-asset-registry";

const SAVE_PATH = "assets/Progress.hasset";
const docs = vi.hoisted(() => ({
  projectDocument: { settings: { saveGame: { definitionGuid: "save-asset" } } },
  assetRegistry: null as unknown,
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

/** Per-kind revisions a test sets; while absent, every kind advances as `openDocuments` is replaced. */
const revisions = docs as { documentRevisions?: Record<string, number> };

beforeEach(() => {
  docs.assetRegistry = indexedAssetRegistry([
    { rootId: "project", path: "assets/Progress.hasset", header: { guid: "save-asset", type: "SaveGame", name: "Progress", payload: {} } },
  ]);
});

afterEach(() => {
  cleanup();
  docs.openDocuments = [];
  delete revisions.documentRevisions;
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

it("overlays an edited Class tab without re-reading any Class header", () => {
  const classAsset = (name: string, parentClass: string) => ({
    rootId: "project",
    path: `assets/${name}.class.hasset`,
    header: { guid: `${name}-guid`, type: "Class", name, parentClass, payload: { functions: [{ id: "f1", name: "Ring", inputs: [], outputs: [] }] } },
  });
  const registry = indexedAssetRegistry([classAsset("Door", "Actor"), classAsset("Lamp", "Actor"), classAsset("Tools", "FunctionLibrary")]);
  const list = vi.spyOn(registry, "list");
  docs.assetRegistry = registry;
  const doorTab = (memberNames: string[]) => ({
    id: "graph:assets/Door.class.hasset",
    ref: { kind: "graph", path: "assets/Door.class.hasset", label: "Door" },
    content: { nodes: [], edges: [], members: memberNames.map((name) => ({ id: name, kind: "variable", name, typeId: "bool" })) },
    layout: null,
    dirty: true,
  });
  docs.openDocuments = [doorTab(["Open"])];
  revisions.documentRevisions = { graph: 1 };
  const { result, rerender } = renderHook(() => useGraphPanelCatalogs());
  expect(Object.keys(result.current.otherClassGraphs).sort()).toEqual(["Door", "Lamp", "Tools"]);
  expect(result.current.functionLibraries.map((library) => library.classId)).toEqual(["Tools"]);
  const subsystems = result.current.subsystemClasses;
  list.mockClear();

  docs.openDocuments = [doorTab(["Open", "Locked"])];
  revisions.documentRevisions = { graph: 2 };
  rerender();
  // The open tab wins with its unsaved members; every header graph is the one already parsed.
  expect(result.current.otherClassGraphs.Door?.members.map((member) => member.name)).toEqual(["Open", "Locked"]);
  expect(result.current.otherClassGraphs.Lamp).toBeDefined();
  expect(list).not.toHaveBeenCalled();
  // Subsystems read only which Classes are open, so an edit keeps them.
  expect(result.current.subsystemClasses).toBe(subsystems);
});
