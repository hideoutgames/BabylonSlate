import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IDockviewPanelProps } from "dockview-react";
import {
  MAIN_CLASS_FILE,
  createText3DComponent,
  documentId,
  type SerializedGraph,
} from "@babylonslate/core";
import {
  DocumentProvider,
  useDocumentActions,
  useDocuments,
  type DocumentActions,
} from "../context/document-context";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { GraphDebugProvider, useGraphDebugStore } from "../context/graph-debug-context";
import { GraphEditingProvider } from "../context/graph-editing-context";
import type { GraphDebugStore } from "../services/graph-debug-store";
import { classIdForGraphPath } from "../services/script-compiler";
import { ValidationProvider } from "../context/validation-context";
import { createProjectAsset } from "../lib/create-project-asset";
import {
  addClassMember,
  patchClassMember,
  removeClassMember,
} from "../lib/class-members";
import {
  installMemoryOpfs,
  unmountDocumentProvider,
} from "../testing/real-document-provider";
import { GraphPanel } from "./graph-panel";

// jsdom has no PointerEvent; the palette's Base UI checkbox dispatches one on click.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

// Stand-ins shared by real-provider tests: see ../testing/real-document-provider.
const provider = vi.hoisted(() => () => import("../testing/real-document-provider"));
vi.mock("../lib/engine-plugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/engine-plugins")>()),
  ensureEnginePluginStorage: (await provider()).emptyEngineStorage,
}));
vi.mock("../lib/engine-plugin-library", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/engine-plugin-library")>()),
  ensureEnginePluginLibrary: (await provider()).emptyEngineLibrary,
}));
vi.mock("../lib/engine-extensions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/engine-extensions")>()),
  ensureEngineExtensionStorage: (await provider()).emptyEngineStorage,
}));
vi.mock("../lib/engine-extension-library", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/engine-extension-library")>()),
  ensureEngineExtensionLibrary: (await provider()).emptyEngineLibrary,
}));
vi.mock("@babylonslate/render/ktx2-transcoder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@babylonslate/render/ktx2-transcoder")>()),
  probeKtx2TranscoderAvailable: async () => false,
}));
vi.mock("@babylonslate/render/scene-load-readiness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@babylonslate/render/scene-load-readiness")>()),
  waitForSceneLoadingPaint: async () => {},
}));
// Play is not running; the panel only reads the focused debugger node.
vi.mock("../context/play-context", () => ({
  usePlay: () => ({ focusedNodeId: null }),
}));

const MAIN_CLASS_ID = documentId({ kind: "graph", path: MAIN_CLASS_FILE });

const seen: {
  actions: DocumentActions | null;
  documents: ReturnType<typeof useDocuments> | null;
  panelProps: IDockviewPanelProps;
  graphId: string;
} = { actions: null, documents: null, panelProps: {} as IDockviewPanelProps, graphId: MAIN_CLASS_ID };

/** The Class graph panel for `seen.graphId` (Main by default), mounted once its tab is open. */
function MainClassGraph() {
  seen.actions = useDocumentActions();
  seen.documents = useDocuments();
  const graphId = seen.graphId;
  if (!seen.documents.openDocuments.some((doc) => doc.id === graphId)) {
    return null;
  }
  return (
    <ValidationProvider>
      <GraphEditingProvider>
        <DocumentWorkspaceProvider documentId={graphId}>
          <GraphPanel {...seen.panelProps} />
        </DocumentWorkspaceProvider>
      </GraphEditingProvider>
    </ValidationProvider>
  );
}

function openContent<T>(id: string): T {
  const doc = seen.documents!.openDocuments.find((entry) => entry.id === id);
  if (!doc?.content) throw new Error(`${id} is not open.`);
  return doc.content as T;
}

beforeEach(installMemoryOpfs);

afterEach(async () => {
  await unmountDocumentProvider(seen.documents, seen.actions);
  seen.actions = null;
  seen.documents = null;
  seen.panelProps = {} as IDockviewPanelProps;
  seen.graphId = MAIN_CLASS_ID;
});

describe("Graph panel", () => {
  it("offers a function added in another open Class tab before it is saved", async () => {
    render(
      <DocumentProvider>
        <MainClassGraph />
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
    expect(screen.getByTestId("graph-panel")).toBeTruthy();
    await act(() =>
      actions.openDocument({ kind: "graph", path: helper.path, label: "Helper" }),
    );

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

    // The Main graph has stayed mounted since before the edit. Calls on
    // another class need a Target, so Context Sensitive hides them.
    fireEvent.click(screen.getByTestId("graph-add-node"));
    fireEvent.click(screen.getByTestId("node-palette-context-sensitive"));
    fireEvent.change(screen.getByTestId("node-palette-search"), {
      target: { value: "Launch" },
    });
    expect(
      await within(screen.getByTestId("node-palette")).findByText("Call Launch"),
    ).toBeTruthy();
  });

  it("offers a Get row for a component its parent Class adds", async () => {
    render(
      <DocumentProvider>
        <MainClassGraph />
      </DocumentProvider>,
    );
    await waitFor(() => expect(seen.documents?.homepageReady).toBe(true));
    const actions = seen.actions!;
    await act(() => actions.createEmptyProject("Inherited", { kind: "2d" }));
    const create = (name: string, parentClass: string) =>
      createProjectAsset({
        registry: seen.documents!.assetRegistry!,
        rootId: "project",
        folderRelative: "",
        type: "Class",
        name,
        parentClass,
      });
    const base = await act(() => create("Base", "Actor"));
    const child = await act(() => create("Child", "Base"));
    act(() => actions.noteAssetsCreated());
    const baseId = documentId({ kind: "graph", path: base.path });
    await act(() => actions.openDocument({ kind: "graph", path: base.path, label: "Base" }));
    const baseGraph = openContent<SerializedGraph>(baseId);
    await act(() =>
      actions.applyGraphChange(baseId, {
        ...baseGraph,
        components: [...(baseGraph.components ?? []), createText3DComponent("label")],
      }),
    );
    seen.graphId = documentId({ kind: "graph", path: child.path });
    await act(() => actions.openDocument({ kind: "graph", path: child.path, label: "Child" }));

    fireEvent.click(screen.getByTestId("graph-add-node"));
    fireEvent.change(screen.getByTestId("node-palette-search"), {
      target: { value: "Get 3D Text" },
    });
    expect(
      await within(screen.getByTestId("node-palette")).findByText("Get 3D Text"),
    ).toBeTruthy();
  });

  it("duplicates a custom event under a free name and leaves a second Event Tick out", async () => {
    render(
      <DocumentProvider>
        <MainClassGraph />
      </DocumentProvider>,
    );
    await waitFor(() => expect(seen.documents?.homepageReady).toBe(true));
    const actions = seen.actions!;
    await act(() => actions.createEmptyProject("Events", { kind: "2d" }));
    await act(() =>
      actions.openDocument({ kind: "graph", path: MAIN_CLASS_FILE, label: "Main" }),
    );
    const tick = {
      id: "tick",
      type: "flow.event.tick",
      position: { x: 80, y: 400 },
      data: { title: "Event Tick", __nodeType: "flow.event.tick" },
    };
    await act(() =>
      actions.applyGraphChange(
        MAIN_CLASS_ID,
        addClassMember(
          { ...openContent<SerializedGraph>(MAIN_CLASS_ID), nodes: [tick], edges: [] },
          "event",
          "Open Door",
          () => "open-door",
        ),
      ),
    );
    await waitFor(() => expect(document.querySelector('[data-id="open-door"]')).toBeTruthy());

    fireEvent.pointerDown(screen.getByTestId("graph-editor"));
    fireEvent.keyDown(document.body, { key: "Control", code: "ControlLeft" });
    for (const id of ["open-door", "tick"]) {
      fireEvent.click(document.querySelector(`.react-flow__node[data-id="${id}"]`)!);
    }
    fireEvent.keyUp(document.body, { key: "Control", code: "ControlLeft" });
    fireEvent.keyDown(document.body, { key: "d", code: "KeyD", ctrlKey: true });
    fireEvent.keyUp(document.body, { key: "d", code: "KeyD", ctrlKey: true });

    await waitFor(() => expect(openContent<SerializedGraph>(MAIN_CLASS_ID).nodes).toHaveLength(3));
    const nodes = openContent<SerializedGraph>(MAIN_CLASS_ID).nodes;
    expect(
      nodes.filter((node) => node.type === "flow.event.custom").map((node) => node.data.name),
    ).toEqual(["Open Door", "Open Door Copy"]);
    expect(nodes.filter((node) => node.type === "flow.event.tick")).toHaveLength(1);
    expect(screen.getByTestId("graph-notice").textContent).toBe("Event Tick is already in this graph.");
  });

  it("shows its function in a function tab, retitles on rename, and closes on delete", async () => {
    render(
      <DocumentProvider>
        <MainClassGraph />
      </DocumentProvider>,
    );
    await waitFor(() => expect(seen.documents?.homepageReady).toBe(true));
    const actions = seen.actions!;
    await act(() => actions.createEmptyProject("Tabs", { kind: "2d" }));
    await act(() =>
      actions.openDocument({ kind: "graph", path: MAIN_CLASS_FILE, label: "Main" }),
    );
    const panelApi = {
      isActive: true,
      isVisible: true,
      title: "Jump",
      onDidActiveChange: () => ({ dispose: () => {} }),
      onDidVisibilityChange: () => ({ dispose: () => {} }),
      setTitle: vi.fn((title: string) => {
        panelApi.title = title;
      }),
      close: vi.fn(),
    };
    // The Class panel opens the tab once the function exists.
    seen.panelProps = {
      params: { functionId: "fn-jump" },
      api: panelApi,
    } as unknown as IDockviewPanelProps;
    await act(() =>
      actions.applyGraphChange(
        MAIN_CLASS_ID,
        addClassMember(
          openContent<SerializedGraph>(MAIN_CLASS_ID),
          "function",
          "Jump",
          () => "fn-jump",
        ),
      ),
    );
    expect(document.querySelector('[data-id="fn-jump-input"]')).toBeTruthy();

    await act(() =>
      actions.applyGraphChange(
        MAIN_CLASS_ID,
        patchClassMember(openContent<SerializedGraph>(MAIN_CLASS_ID), "fn-jump", {
          name: "Leap",
        }),
      ),
    );
    expect(panelApi.title).toBe("Leap");
    expect(panelApi.close).not.toHaveBeenCalled();

    await act(() =>
      actions.applyGraphChange(
        MAIN_CLASS_ID,
        removeClassMember(openContent<SerializedGraph>(MAIN_CLASS_ID), "fn-jump"),
      ),
    );
    expect(panelApi.close).toHaveBeenCalled();
  });
});

describe("Graph panel run tips", () => {
  it("shows a pin's last value only while a Simulation debugs the Class", async () => {
    let debug: GraphDebugStore | null = null;
    function DebugProbe() {
      debug = useGraphDebugStore();
      return null;
    }
    const { container } = render(
      <DocumentProvider>
        <GraphDebugProvider>
          <DebugProbe />
          <MainClassGraph />
        </GraphDebugProvider>
      </DocumentProvider>,
    );
    await waitFor(() => expect(seen.documents?.homepageReady).toBe(true));
    const actions = seen.actions!;
    await act(() => actions.createEmptyProject("Debugged", { kind: "2d" }));
    await act(() => actions.openDocument({ kind: "graph", path: MAIN_CLASS_FILE, label: "Main" }));
    const graph = openContent<SerializedGraph>(MAIN_CLASS_ID);
    await act(() =>
      actions.applyGraphChange(MAIN_CLASS_ID, {
        ...graph,
        nodes: [{ id: "tick", type: "flow.event.tick", position: { x: 0, y: 0 }, data: {} }],
        edges: [],
      }),
    );
    const pin = await waitFor(() => {
      const found = container.querySelector('[data-id="tick"] [data-pin-side="out"][data-pin-id="deltaSeconds"]');
      expect(found).not.toBeNull();
      return found!;
    });

    // Editing a Class shows no run tips.
    fireEvent.pointerOver(pin);
    expect(screen.queryByTestId("graph-pin-value-tip")).toBeNull();

    act(() => debug!.setTarget({ kind: "class", classId: classIdForGraphPath(MAIN_CLASS_FILE) }));
    fireEvent.pointerOver(pin);
    expect(screen.getByTestId("graph-pin-value-tip").textContent).toBe("No value yet");
  });
});
