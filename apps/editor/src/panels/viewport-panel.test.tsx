import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { ViewportPanel } from "./viewport-panel";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { syncEditorPlayState } from "@babylonslate/render";
import { createDefaultScene } from "@babylonslate/core";
import { encodeAssetDocument, readAssetDocumentHeader, type AssetRegistry } from "@babylonslate/assets";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";

const { createEngineMock, play, documents, handle } = vi.hoisted(() => {
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
      setDrawMeshCollision: vi.fn(),
      setPreviewGameCamera: vi.fn(),
      setGridSettings: vi.fn(),
      setSortingLayers: vi.fn(),
      setPixelPerfect: vi.fn(),
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
    whenEditorModelsReady: vi.fn(async () => {}),
    prewarmSceneMaterials: vi.fn(async () => {}),
  };
  const createEngineMock = vi.fn<
    (
      canvas?: unknown,
      options?: { overlayTransformBox?: boolean; sharedEngine?: unknown },
    ) => typeof handle
  >();
  createEngineMock.mockReturnValue(handle);
  const sharedEngine = { isDisposed: false };
  return {
    createEngineMock,
    handle,
    documents: {
      assetRegistry: null as Pick<AssetRegistry, "list"> | null,
      applySceneChange: vi.fn(async () => true),
      openDocuments: [] as Array<{
        id: string;
        ref: { kind: string; path: string; label: string };
        content: unknown;
      }>,
      collectPlaySpritePayloads: vi.fn(async () => []),
      collectPlayTilemapContent: vi.fn(async () => ({
        tilesets: [],
        tilemaps: [],
      })),
      collectPlayTextureBytes: vi.fn(async () => new Map()),
      collectPlayTexturePixelSizes: vi.fn(() => new Map()),
      collectPlayFontFacetypeBytes: vi.fn(async () => new Map()),
      collectPlayFontMsdfPair: vi.fn(async () => new Map()),
      collectPlayFontFaceEntries: vi.fn(async () => []),
      collectPlayFontCssStacks: vi.fn(() => ({
        fontCssStack: "sans-serif",
        fontCssStackByGuid: new Map(),
      })),
      collectPlayModelBytes: vi.fn(async () => new Map()),
      collectPlayModelPayloads: vi.fn(async () => new Map()),
      collectPlayMaterialLibrary: vi.fn(async () => ({
        documents: new Map(),
        functions: new Map(),
        textureGuids: [] as string[],
      })),
      readAssetChunk: vi.fn(),
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
    openDocuments: documents.openDocuments,
    applySceneChange: documents.applySceneChange,
    projectDocument: null,
    collectPlaySpritePayloads: documents.collectPlaySpritePayloads,
    collectPlayTilemapContent: documents.collectPlayTilemapContent,
    collectPlayTextureBytes: documents.collectPlayTextureBytes,
    collectPlayTexturePixelSizes: documents.collectPlayTexturePixelSizes,
    collectPlayFontFacetypeBytes: documents.collectPlayFontFacetypeBytes,
    collectPlayFontMsdfPair: documents.collectPlayFontMsdfPair,
    collectPlayFontFaceEntries: documents.collectPlayFontFaceEntries,
    collectPlayFontCssStacks: documents.collectPlayFontCssStacks,
    collectPlayModelBytes: documents.collectPlayModelBytes,
    collectPlayModelPayloads: documents.collectPlayModelPayloads,
    collectPlayMaterialLibrary: documents.collectPlayMaterialLibrary,
    readAssetChunk: documents.readAssetChunk,
    assetRegistry: documents.assetRegistry,
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
    collisionsVisible: false,
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
    handle.editor.setGridSettings.mockClear();
    play.registerSharedEngine.mockClear();
    play.playing = false;
    play.preparing = false;
    documents.openDocuments = [];
    documents.assetRegistry = null;
    handle.loadScene.mockClear();
    handle.setMeshAssets.mockClear();
    handle.setMaterialDocuments.mockClear();
    documents.collectPlayMaterialLibrary.mockReset().mockResolvedValue({
      documents: new Map(),
      functions: new Map(),
      textureGuids: [],
    });
    documents.collectPlayTextureBytes.mockReset().mockResolvedValue(new Map());
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
    expect(createEngineMock.mock.results[0]?.value.editor.setDrawMeshCollision).toHaveBeenCalledWith(
      false,
    );
  });

  it("requests the overlay transform box for SceneLayer documents", () => {
    documents.openDocuments = [
      {
        id: "scene:S",
        ref: {
          kind: "scene-layer",
          path: "assets/HUD.overlay.babasset",
          label: "HUD",
        },
        content: null,
      },
    ];
    renderViewport();
    expect(createEngineMock).toHaveBeenCalledWith(
      expect.any(HTMLCanvasElement),
      expect.objectContaining({ overlayTransformBox: true }),
    );
  });

  it("remounts the engine when a SceneLayer document appears", () => {
    const { rerender } = renderViewport();
    expect(createEngineMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ overlayTransformBox: false }),
    );
    documents.openDocuments = [
      {
        id: "scene:S",
        ref: {
          kind: "scene-layer",
          path: "assets/HUD.overlay.babasset",
          label: "HUD",
        },
        content: null,
      },
    ];
    rerender(
      <DocumentWorkspaceProvider documentId="scene:S">
        <ViewportPanel {...({} as IDockviewPanelProps)} />
      </DocumentWorkspaceProvider>,
    );
    expect(createEngineMock).toHaveBeenCalledTimes(2);
    expect(createEngineMock.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({ overlayTransformBox: true }),
    );
  });

  it("pushes cameraBounds2D after the viewport engine is created", async () => {
    const scene = {
      name: "HUD",
      viewportMode: "2d" as const,
      settings: {
        grid: { tileSize: 1, tileSubdivisions: 4 },
        cameraBounds2D: { width: 32, height: 18 },
      },
      actors: [],
      folders: [],
    };
    documents.openDocuments = [
      {
        id: "scene:S",
        ref: {
          kind: "scene-layer",
          path: "assets/HUD.overlay.babasset",
          label: "HUD",
        },
        content: scene,
      },
    ];
    renderViewport();
    await waitFor(() => {
      expect(handle.editor.setGridSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          cameraBounds2D: { width: 32, height: 18 },
        }),
      );
    });
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

  it.each(["Material", "MaterialFunction"])("refreshes a saved %s without reloading the scene", async (type) => {
    const savedAsset = async (value: number) => ({
      rootId: "project",
      path: "assets/Surface.material.babasset",
      header: readAssetDocumentHeader(await encodeAssetDocument({
        type,
        guid: "saved-material",
        name: "Surface",
        version: 1,
        payload: { value },
      })),
    });
    let asset = await savedAsset(1);
    documents.assetRegistry = { list: () => [asset] };
    documents.openDocuments = [{
      id: "scene:S",
      ref: { kind: "scene", path: "assets/S.scene.babasset", label: "S" },
      content: createDefaultScene(),
    }];
    const { rerender } = renderViewport();
    await waitFor(() => expect(handle.setMeshAssets).toHaveBeenCalled());
    const initialLoads = handle.loadScene.mock.calls.length;
    const initialMaterials = handle.setMaterialDocuments.mock.calls.length;
    const updatedDocument = { ...createDefaultMaterialDocument(), name: "Saved Surface" };
    const updatedDocuments = new Map([["surface", updatedDocument]]);
    const newTexture = new Uint8Array([1, 2, 3, 4]);
    documents.collectPlayMaterialLibrary.mockResolvedValueOnce({
      documents: updatedDocuments,
      functions: new Map(),
      textureGuids: ["new-texture"],
    });
    documents.collectPlayTextureBytes.mockResolvedValueOnce(new Map([["new-texture", newTexture]]));
    asset = await savedAsset(2);
    rerender(
      <DocumentWorkspaceProvider documentId="scene:S">
        <ViewportPanel {...({} as IDockviewPanelProps)} />
      </DocumentWorkspaceProvider>,
    );
    await waitFor(() => {
      expect(handle.setMaterialDocuments).toHaveBeenLastCalledWith(updatedDocuments, new Map());
      expect(handle.setMeshAssets).toHaveBeenLastCalledWith(expect.objectContaining({
        textureBytes: new Map([["new-texture", newTexture]]),
      }));
    });
    expect(handle.loadScene).toHaveBeenCalledTimes(initialLoads);
    expect(handle.setMaterialDocuments).toHaveBeenCalledTimes(initialMaterials + 1);

    // An unchanged Save All / registry reindex must not trigger another load.
    asset = await savedAsset(2);
    documents.openDocuments = [...documents.openDocuments];
    rerender(
      <DocumentWorkspaceProvider documentId="scene:S">
        <ViewportPanel {...({} as IDockviewPanelProps)} />
      </DocumentWorkspaceProvider>,
    );
    await Promise.resolve();
    expect(handle.setMaterialDocuments).toHaveBeenCalledTimes(initialMaterials + 1);
  });
});
