import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { createActor, createDefaultScene, createTimelineClip, type SerializedScene } from "@haptic/core";
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

it("re-reads no registry and normalizes only the edited Scene, once for every panel, when an open Scene is edited", () => {
  const sceneAsset = (name: string) => ({
    rootId: "project",
    path: `assets/${name}.scene.hasset`,
    header: { guid: `${name}-guid`, type: "Scene", name, payload: { name, actors: [] } },
  });
  const registry = indexedAssetRegistry([sceneAsset("Cave"), sceneAsset("Town")]);
  const list = vi.spyOn(registry, "list");
  docs.assetRegistry = registry;
  const sceneTab = (name: string, content: SerializedScene) => ({
    id: `scene:assets/${name}.scene.hasset`,
    ref: { kind: "scene", path: `assets/${name}.scene.hasset`, label: name },
    content,
    layout: null,
    dirty: false,
  });
  const cave: SerializedScene = { ...createDefaultScene(), name: "Cave", actors: [createActor("door", "Door")] };
  const town: SerializedScene = { ...createDefaultScene(), name: "Town" };
  docs.openDocuments = [sceneTab("Cave", cave), sceneTab("Town", town)];
  revisions.documentRevisions = { scene: 1 };
  // Two graph panels, as an event graph and a function graph tab mount.
  const first = renderHook(() => useGraphPanelCatalogs());
  const second = renderHook(() => useGraphPanelCatalogs());
  const townView = first.result.current.sceneDocuments.find((scene) => scene.guid === "Town-guid");
  const timelineAssets = first.result.current.timelineAssets;
  list.mockClear();

  // A Details edit: a new Cave scene whose clips are untouched.
  docs.openDocuments = [sceneTab("Cave", { ...cave, actors: [{ ...cave.actors[0]!, name: "Gate" }] }), sceneTab("Town", town)];
  revisions.documentRevisions = { scene: 2 };
  first.rerender();
  second.rerender();
  const caveView = first.result.current.sceneDocuments.find((scene) => scene.guid === "Cave-guid");
  expect(caveView?.actors.map((actor) => actor.name)).toEqual(["Gate"]);
  expect(second.result.current.sceneDocuments.find((scene) => scene.guid === "Cave-guid")).toBe(caveView);
  expect(first.result.current.sceneDocuments.find((scene) => scene.guid === "Town-guid")).toBe(townView);
  // Neither the saved Scenes nor the Timeline index is rebuilt.
  expect(list).not.toHaveBeenCalled();
  expect(first.result.current.timelineAssets).toBe(timelineAssets);

  // A clip edit does rebuild the index.
  docs.openDocuments = [sceneTab("Cave", { ...cave, timelineClips: [createTimelineClip("intro", "Intro")] }), sceneTab("Town", town)];
  revisions.documentRevisions = { scene: 3 };
  first.rerender();
  expect(list).toHaveBeenCalled();
});
