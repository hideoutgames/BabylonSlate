import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAIN_CLASS_FILE,
  documentId,
  type SerializedGraph,
} from "@babylonslate/core";
import { createMemoryOpfsRoot } from "../../../../packages/vfs/src/test-support/memory-opfs";
import {
  DocumentProvider,
  useDocumentActions,
  useDocuments,
  type DocumentActions,
} from "../context/document-context";
import { createProjectAsset } from "../lib/create-project-asset";
import {
  defaultNodeRegistry,
  scriptPaletteNodes,
} from "../services/graph-validation";
import { classIdForGraphPath } from "../services/script-compiler";
import { useGraphPanelCatalogs } from "./graph-panel-catalogs";

// The real DocumentProvider fetches engine plugins and extensions from the
// app's public folder; projects here start without any.
const engine = vi.hoisted(() => ({
  storage: async () => {
    const { MemoryStorageAdapter, createReadOnlyProjectStorage } = await import(
      "@babylonslate/vfs"
    );
    const storage = new MemoryStorageAdapter("opfs");
    await storage.openDocumentsProject("engine");
    return createReadOnlyProjectStorage(storage);
  },
}));
vi.mock("../lib/engine-plugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/engine-plugins")>()),
  ensureEnginePluginStorage: engine.storage,
}));
vi.mock("../lib/engine-plugin-library", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/engine-plugin-library")>()),
  ensureEnginePluginLibrary: async () => ({ createStorageSnapshot: engine.storage }),
}));
vi.mock("../lib/engine-extensions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/engine-extensions")>()),
  ensureEngineExtensionStorage: engine.storage,
}));
vi.mock("../lib/engine-extension-library", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/engine-extension-library")>()),
  ensureEngineExtensionLibrary: async () => ({ createStorageSnapshot: engine.storage }),
}));
// The KTX2 transcoder probe and the scene loading paint wait need a GPU page.
vi.mock("@babylonslate/render", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@babylonslate/render")>()),
  probeKtx2TranscoderAvailable: async () => false,
  waitForSceneLoadingPaint: async () => {},
}));

const seen: {
  actions: DocumentActions | null;
  documents: ReturnType<typeof useDocuments> | null;
  catalogs: ReturnType<typeof useGraphPanelCatalogs> | null;
} = { actions: null, documents: null, catalogs: null };

function Probe() {
  seen.actions = useDocumentActions();
  seen.documents = useDocuments();
  seen.catalogs = useGraphPanelCatalogs();
  return null;
}

/** Palette node ids the Main Class graph offers, built as its panel builds them. */
function mainClassPaletteIds(): string[] {
  const catalogs = seen.catalogs!;
  return scriptPaletteNodes(defaultNodeRegistry, {
    classId: classIdForGraphPath(MAIN_CLASS_FILE),
    parentClass: "Actor",
    parentOf: catalogs.parentOf,
    otherClassGraphs: catalogs.otherClassGraphs,
    functionLibraries: catalogs.functionLibraries,
    scriptInterfaces: catalogs.scriptInterfaces,
    subsystemClasses: catalogs.subsystemClasses,
    sceneDocuments: catalogs.sceneDocuments,
    structures: catalogs.typeAssets.structures,
    enums: catalogs.typeAssets.enums,
    inputAssets: catalogs.inputAssets,
  }).map((node) => node.id);
}

function openContent<T>(id: string): T {
  const doc = seen.documents!.openDocuments.find((entry) => entry.id === id);
  if (!doc?.content) throw new Error(`${id} is not open.`);
  return doc.content as T;
}

beforeEach(() => {
  const root = createMemoryOpfsRoot();
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: { getDirectory: async () => root },
  });
});

afterEach(async () => {
  // Clears the autosave timer and the recovery journal before unmounting.
  if (seen.documents?.projectDocument) {
    await act(() => seen.actions!.forceCloseProject());
  }
  cleanup();
  seen.actions = null;
  seen.documents = null;
  seen.catalogs = null;
  localStorage.clear();
  delete (navigator as { storage?: unknown }).storage;
});

describe("Graph panel catalogs", () => {
  it("offer a function added in another open Class tab before it is saved", async () => {
    render(
      <DocumentProvider>
        <Probe />
      </DocumentProvider>,
    );
    await waitFor(() => expect(seen.documents?.homepageReady).toBe(true));
    const actions = seen.actions!;
    await act(() => actions.createEmptyProject("Palette", { kind: "2d" }));
    const helper = await act(() =>
      createProjectAsset({
        registry: seen.documents!.assetRegistry!,
        rootId: "project",
        folderRelative: "",
        type: "Class",
        name: "Helper",
      }),
    );
    act(() => actions.noteAssetsCreated());
    const helperId = documentId({ kind: "graph", path: helper.path });
    await act(() =>
      actions.openDocument({ kind: "graph", path: MAIN_CLASS_FILE, label: "Main" }),
    );
    await act(() =>
      actions.openDocument({ kind: "graph", path: helper.path, label: "Helper" }),
    );
    const callLaunch = `functions.call:${classIdForGraphPath(helper.path)}:Launch`;
    expect(mainClassPaletteIds()).not.toContain(callLaunch);

    const graph = openContent<SerializedGraph>(helperId);
    await act(() =>
      actions.applyGraphChange(helperId, {
        ...graph,
        members: [
          ...(graph.members ?? []),
          { id: "launch", kind: "function", name: "Launch" },
        ],
      }),
    );
    // Unsaved: only the Helper tab is dirty.
    expect(seen.documents!.dirtyDocuments.map((doc) => doc.id)).toEqual([helperId]);
    expect(mainClassPaletteIds()).toContain(callLaunch);
  });
});
