import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IDockviewPanelProps } from "dockview-react";
import {
  MAIN_CLASS_FILE,
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
import { GraphEditingProvider } from "../context/graph-editing-context";
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
vi.mock("@babylonslate/render", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@babylonslate/render")>()),
  probeKtx2TranscoderAvailable: async () => false,
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
} = { actions: null, documents: null, panelProps: {} as IDockviewPanelProps };

/** The Main Class graph panel, mounted once its tab is open. */
function MainClassGraph() {
  seen.actions = useDocumentActions();
  seen.documents = useDocuments();
  if (!seen.documents.openDocuments.some((doc) => doc.id === MAIN_CLASS_ID)) {
    return null;
  }
  return (
    <ValidationProvider>
      <GraphEditingProvider>
        <DocumentWorkspaceProvider documentId={MAIN_CLASS_ID}>
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
