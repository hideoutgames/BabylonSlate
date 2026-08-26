import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { ViewportPanel } from "./viewport-panel";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { syncEditorPlayState } from "@babylonslate/render";

const { createEngineMock, play, documents } = vi.hoisted(() => {
  const handle = {
    engine: {
      onContextRestoredObservable: { add: vi.fn() },
    },
    scene: {},
    editor: {
      camera: {
        importSessionState: vi.fn(),
        exportSessionState: vi.fn(() => ({})),
        setPivotAroundCenter: vi.fn(),
      },
      setPreviewCanvas: vi.fn(),
      setSelectedActors: vi.fn(),
      syncSelectionDebug: vi.fn(),
      setViewportMode: vi.fn(),
      setViewportShadingMode: vi.fn(),
      setPreviewGameCamera: vi.fn(),
      setGridSettings: vi.fn(),
      gizmos: { setTool: vi.fn(), setSnap: vi.fn() },
      grid: { setVisible: vi.fn() },
    },
    scheduler: {
      setAlwaysRender: vi.fn(),
      setPaused: vi.fn(),
      setResizing: vi.fn(),
    },
    scaling: { getLevel: vi.fn(() => 1) },
    setPaused: vi.fn(),
    setPostProcessingEnabled: vi.fn(),
    setEditingMaterialGuids: vi.fn(),
    postProcessPassCount: vi.fn(() => 0),
    loadScene: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
    resourceCache: {},
    registerFonts: vi.fn(async () => {}),
    setMeshAssets: vi.fn(),
    setMaterialDocuments: vi.fn(),
  };
  const createEngineMock = vi.fn(() => handle);
  const sharedEngine = { isDisposed: false };
  return {
    createEngineMock,
    documents: {
      applySceneChange: vi.fn(async () => true),
    },
    play: {
      registerSharedEngine: vi.fn(),
      registerScheduler: vi.fn(() => () => {}),
      ensureSharedEngine: vi.fn(() => sharedEngine),
      sharedEngineGeneration: 1,
      playing: false,
      preparing: false,
    },
  };
});

vi.mock("@babylonslate/render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@babylonslate/render")>();
  return {
    ...actual,
    createEngine: createEngineMock,
    NavMeshDebugOverlay: class {
      clear(): void {}
      dispose(): void {}
    },
    syncEditorPlayState: vi.fn(),
  };
});

vi.mock("../context/play-context", () => ({
  usePlay: () => play,
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    openDocuments: [],
    applySceneChange: documents.applySceneChange,
    projectDocument: null,
    collectPlaySpritePayloads: vi.fn(),
    collectPlayTilemapContent: vi.fn(),
    collectPlayTextureBytes: vi.fn(),
    collectPlayFontFacetypeBytes: vi.fn(),
    collectPlayFontMsdfPair: vi.fn(async () => new Map()),
    collectPlayFontFaceEntries: vi.fn(async () => []),
    collectPlayFontCssStacks: vi.fn(() => ({
      fontCssStack: "sans-serif",
      fontCssStackByGuid: new Map(),
    })),
    collectPlayModelBytes: vi.fn(),
    collectPlayModelPayloads: vi.fn(),
    collectPlayMaterialLibrary: vi.fn(),
    readAssetChunk: vi.fn(),
    assetRegistry: null,
  }),
}));

vi.mock("../context/scene-editing-context", () => ({
  FALLBACK_PLACE_POSITION: [0, 0, 0],
  useSceneEditing: () => ({
    selectedActorIds: [] as string[],
    selectActor: vi.fn(),
    setSelectedActorIds: vi.fn(),
    gizmoTool: "translate",
    snapEnabled: false,
    viewportMode: "3d",
    joystickEnabled: false,
    gridVisible: true,
    navmeshVisible: false,
    dragSelectActive: false,
    setDragSelectActive: vi.fn(),
    setFrameActorHandler: vi.fn(),
    setViewportDropApi: vi.fn(),
    previewGameCamera: false,
    saveEditorCameraPose: vi.fn(),
    loadEditorCameraPose: vi.fn(() => null),
    pivotAroundCenter: false,
    viewportShadingMode: "pbr",
  }),
}));

vi.mock("../components/viewport-toolbar", () => ({
  ViewportToolbar: () => null,
}));

vi.mock("../components/viewport-joystick", () => ({
  ViewportJoystick: () => null,
}));

vi.mock("../components/scene-loading-dialog", () => ({
  SceneLoadingDialog: () => null,
}));

vi.mock("../lib/viewport-render-gate", () => ({
  attachViewportRenderGate: () => () => {},
  ENGINE_SETTINGS_CHANGED_EVENT: "babylonslate:engine-settings",
}));

class IntersectionObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!("IntersectionObserver" in globalThis)) {
  globalThis.IntersectionObserver =
    IntersectionObserverStub as unknown as typeof IntersectionObserver;
}

function renderViewport() {
  return render(
    <DocumentWorkspaceProvider documentId="scene:S">
      <ViewportPanel {...({} as IDockviewPanelProps)} />
    </DocumentWorkspaceProvider>,
  );
}

describe("ViewportPanel engine", () => {
  afterEach(() => {
    cleanup();
    createEngineMock.mockClear();
    play.registerSharedEngine.mockClear();
    play.playing = false;
    play.preparing = false;
  });

  it("does not recreate the Engine when applySceneChange identity changes", () => {
    const { rerender } = renderViewport();
    expect(createEngineMock).toHaveBeenCalledTimes(1);
    documents.applySceneChange = vi.fn(async () => false);
    rerender(
      <DocumentWorkspaceProvider documentId="scene:S">
        <ViewportPanel {...({} as IDockviewPanelProps)} />
      </DocumentWorkspaceProvider>,
    );
    expect(createEngineMock).toHaveBeenCalledTimes(1);
  });

  it("creates the viewport Scene on the project Engine", () => {
    renderViewport();
    expect(play.ensureSharedEngine).toHaveBeenCalled();
    expect(createEngineMock).toHaveBeenCalledWith(
      expect.any(HTMLCanvasElement),
      expect.objectContaining({
        editor: true,
        sharedEngine: play.ensureSharedEngine(),
      }),
    );
  });

  it("pauses the editor viewport while Preview Build is preparing", () => {
    const { rerender } = renderViewport();
    play.preparing = true;
    rerender(
      <DocumentWorkspaceProvider documentId="scene:S">
        <ViewportPanel {...({} as IDockviewPanelProps)} />
      </DocumentWorkspaceProvider>,
    );
    expect(syncEditorPlayState).toHaveBeenCalledWith(
      expect.anything(),
      true,
    );
    play.preparing = false;
  });
});
