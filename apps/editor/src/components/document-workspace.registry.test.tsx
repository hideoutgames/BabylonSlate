import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AssetRegistry, projectContentRoot } from "@babylonslate/assets";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { DocumentWorkspace } from "./document-workspace";
import type { OpenDocument } from "../services/document-service";

const state = vi.hoisted(() => ({
  registry: null as AssetRegistry | null,
  mountedIds: new Set<string>(),
  tabs: [] as string[],
  documents: null as OpenDocument[] | null,
  passthrough: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  tabOrder: state.tabs,
  activeDocumentId: state.tabs[0],
  openDocuments: state.documents ?? state.tabs.map((id) => ({
    id,
    ref: { kind: "graph", path: `assets/${id}.class.babasset` },
    content: null,
    layout: null,
  })),
  projectDocument: { metadata: { name: "Test" } },
  assetRegistry: state.registry,
  registryEpoch: state.registry?.generation ?? 0,
  sourceControl: { enabled: false },
  captureLayoutForId: () => {},
  unregisterDockviewApi: () => {},
})));
vi.mock("../lib/document-working-set", () => ({
  useDocumentWorkingSet: () => state.mountedIds,
}));
// Isolate workspace routing from engine sessions and DockView mounting.
vi.mock("../context/audio-reverb-bake-context", () => ({
  AudioReverbBakeProvider: state.passthrough,
}));
vi.mock("../context/document-workspace-context", () => ({
  DocumentWorkspaceProvider: state.passthrough,
}));
vi.mock("../context/data-definition-editing-context", () => ({
  DataDefinitionEditingProvider: state.passthrough,
}));
vi.mock("../context/data-asset-editing-context", () => ({
  DataAssetEditingProvider: state.passthrough,
}));
vi.mock("../context/scene-tools-context", () => ({
  SceneToolsProvider: state.passthrough,
}));
vi.mock("../context/nav-bake-context", () => ({
  NavBakeProvider: state.passthrough,
}));
vi.mock("../context/prefab-editing-context", () => ({
  PrefabEditingProvider: state.passthrough,
}));
vi.mock("../context/graph-editing-context", () => ({
  GraphEditingProvider: state.passthrough,
}));
vi.mock("../context/scene-editing-context", () => ({
  SceneEditingProvider: (props: {
    documentId: string;
    initialViewportMode: string;
    initialViewportShadingMode: string;
    children: ReactNode;
  }) => (
    <div
      data-testid={props.documentId}
      data-mode={props.initialViewportMode}
      data-shading={props.initialViewportShadingMode}
    >
      {props.children}
    </div>
  ),
}));
vi.mock("../shell/dockview-shell", () => ({
  DockviewShell: ({ actorPrefab }: { actorPrefab?: boolean }) => (
    <div data-testid="prefab-docks" data-prefab={String(actorPrefab)} />
  ),
}));
vi.mock("./document-lock-banner", () => ({ DocumentLockBanner: () => null }));

/** Resave a Class with another parent, as a save or external change reindexes it. */
async function reparent(registry: AssetRegistry, name: string, parentClass: string) {
  await registry.deleteAsset(name);
  await registry.createAsset("project", `${name}.class.babasset`, {
    guid: name,
    name,
    parentClass,
    type: "Class",
    version: 1,
    dependencies: [],
    payload: {},
    chunks: [],
  });
}

async function createRegistry() {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("test.babproject");
  const registry = new AssetRegistry(storage);
  await registry.mountRoot(projectContentRoot());
  for (const [name, parentClass] of [
    ["base", "Actor"],
    ["first", "base"],
    ["second", "base"],
  ]) {
    await registry.createAsset("project", `${name}.class.babasset`, {
      guid: name,
      name,
      parentClass,
      type: "Class",
      version: 1,
      dependencies: [],
      payload: {},
      chunks: [],
    });
  }
  state.registry = registry;
  state.tabs = [
    "first",
    "second",
    ...Array.from({ length: 20 }, (_, i) => `cold-${i}`),
  ];
  return registry;
}

afterEach(() => {
  cleanup();
  state.mountedIds = new Set();
  state.documents = null;
  vi.restoreAllMocks();
});

describe("workspace registry traversal", () => {
  it("does not mount standalone workspaces for background utility trees until they are revealed", () => {
    state.tabs = ["definition", "sheet"];
    state.mountedIds = new Set(state.tabs);
    const sheet: OpenDocument = {
      id: "sheet", ref: { kind: "data-tree", path: "assets/Weapons.datatree.babasset", label: "Weapons" },
      content: { kind: "dataTree", defaultDefinitionGuid: null, entries: [] }, layout: null, dirty: true, background: true,
    };
    state.documents = [
      { id: "definition", ref: { kind: "data-definition", path: "assets/Stats.datadefinition.babasset", label: "Stats" }, content: { kind: "dataDefinition", fields: [] }, layout: null, dirty: false },
      sheet,
    ];
    const view = render(<DocumentWorkspace />);
    expect(screen.getByTestId("document-workspace-data-definition")).toBeTruthy();
    expect(screen.queryByTestId("document-workspace-data-tree")).toBeNull();
    sheet.background = false;
    view.rerender(<DocumentWorkspace />);
    expect(screen.getByTestId("document-workspace-data-tree")).toBeTruthy();
  });

  it("does no registry reads for unmounted graph workspaces", async () => {
    const registry = await createRegistry();
    const list = vi.spyOn(registry, "list");
    const lookup = vi.spyOn(registry, "getByPath");
    render(<DocumentWorkspace />);
    expect(list).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(screen.queryByTestId("document-workspace-graph")).toBeNull();
  });

  it("bounds full scans per render regardless of open or mounted tab count", async () => {
    const registry = await createRegistry();
    state.mountedIds = new Set(["first"]);
    const list = vi.spyOn(registry, "list");
    const { rerender } = render(<DocumentWorkspace />);
    expect(list.mock.calls.length).toBeLessThanOrEqual(1);
    expect(screen.getAllByTestId("document-workspace-graph")).toHaveLength(1);

    list.mockClear();
    state.mountedIds.add("second");
    rerender(<DocumentWorkspace />);
    expect(list.mock.calls.length).toBeLessThanOrEqual(1);
    expect(screen.getAllByTestId("document-workspace-graph")).toHaveLength(2);
    expect(
      screen
        .getAllByTestId("prefab-docks")
        .map((node) => node.getAttribute("data-prefab")),
    ).toEqual(["true", "true"]);
  });

  it("refreshes inherited workspace modes when the same registry changes", async () => {
    const registry = await createRegistry();
    state.mountedIds = new Set(["first"]);
    const { rerender } = render(<DocumentWorkspace />);
    expect(screen.getByTestId("first").getAttribute("data-mode")).toBe("3d");
    expect(screen.getByTestId("prefab-docks").getAttribute("data-prefab")).toBe(
      "true",
    );

    await reparent(registry, "base", "SceneLayerActor");
    rerender(<DocumentWorkspace />);
    expect(screen.getByTestId("first").getAttribute("data-mode")).toBe("2d");
    expect(screen.getByTestId("first").getAttribute("data-shading")).toBe(
      "unlit",
    );

    await reparent(registry, "base", "BObject");
    rerender(<DocumentWorkspace />);
    expect(screen.getByTestId("first").getAttribute("data-mode")).toBe("3d");
    expect(screen.getByTestId("prefab-docks").getAttribute("data-prefab")).toBe(
      "false",
    );
  });
});
