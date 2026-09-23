import { receiveActiveAppSettingsUpdate } from "../context/app-settings-context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { ViewportPanel } from "./viewport-panel";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { syncEditorPlayState } from "@babylonslate/render";
import { createActor, createDefaultScene, createEmptyProject, engineCommandBus, type SerializedScene } from "@babylonslate/core";
import { areaEmissionChunkId, encodeAssetDocument, readAssetDocumentHeader, type AssetRegistry, type AreaEmissionPixels } from "@babylonslate/assets";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { playAudioLibraryFromAssets } from "../lib/play-audio";

const { createEngineMock, play, documents, handle, selection } = vi.hoisted(() => {
  const handle = {
    engine: {
      onContextRestoredObservable: { add: vi.fn((callback: () => void) => callback), remove: vi.fn() },
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
    loadSceneAsync: vi.fn(async () => {}),
    resize: vi.fn(),
    dispose: vi.fn(),
    resourceCache: {},
    registerFonts: vi.fn(async () => {}),
    setMeshAssets: vi.fn(),
    setRenderSettings: vi.fn(),
    setMaterialDocuments: vi.fn(),
    whenEditorModelsReady: vi.fn(async () => {}),
    whenMaterialTexturesReady: vi.fn(async () => {}),
    prewarmSceneMaterials: vi.fn(async () => {}),
    presentFirstFrame: vi.fn(async () => {}),
  };
  const createEngineMock = vi.fn<
    (
      canvas?: unknown,
      options?: { overlayTransformBox?: boolean; sharedEngine?: unknown; editorViewportId?: string },
    ) => typeof handle
  >();
  createEngineMock.mockReturnValue(handle);
  const sharedEngine = { isDisposed: false };
  return {
    createEngineMock,
    handle,
    selection: { actorIds: [] as string[], mode: "3d" as "2d" | "3d" },
    documents: {
      projectDocument: null as ReturnType<typeof createEmptyProject> | null,
      assetRegistry: null as Pick<AssetRegistry, "list" | "getByGuid"> | null,
      applySceneChange: vi.fn<(id: string, scene: SerializedScene) => Promise<boolean>>(async () => true),
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
      collectPlayTextureBytes: vi.fn<(sprites?: unknown, tilesets?: unknown, guids?: readonly string[]) => Promise<Map<string, Uint8Array>>>(async () => new Map()),
      collectPlayTexturePixelSizes: vi.fn(() => new Map()),
      collectPlayFontFacetypeBytes: vi.fn(async () => new Map()),
      collectPlayAreaEmissions: vi.fn(async (): Promise<Map<string, AreaEmissionPixels>> => new Map()),
      collectPlayFontMsdfPair: vi.fn(async () => new Map()),
      collectPlayFontFaceEntries: vi.fn(async () => []),
      collectPlayFontCssStacks: vi.fn(() => ({
        fontCssStack: "sans-serif",
        fontCssStackByGuid: new Map(),
      })),
      collectPlayModelBytes: vi.fn(async () => new Map()),
      collectPlayModelPayloads: vi.fn(async () => new Map()),
      collectPlayAudio: vi.fn<() => Promise<{
        library: import("../lib/play-audio").PlayAudioLibrary;
        loadSourceBytes: import("../lib/play-audio").PlayAudioSourceLoader;
      }>>(),
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
    projectDocument: documents.projectDocument,
    collectPlaySpritePayloads: documents.collectPlaySpritePayloads,
    collectPlayTilemapContent: documents.collectPlayTilemapContent,
    collectPlayTextureBytes: documents.collectPlayTextureBytes,
    collectPlayTexturePixelSizes: documents.collectPlayTexturePixelSizes,
    collectPlayFontFacetypeBytes: documents.collectPlayFontFacetypeBytes,
    collectPlayAreaEmissions: documents.collectPlayAreaEmissions,
    collectPlayFontMsdfPair: documents.collectPlayFontMsdfPair,
    collectPlayFontFaceEntries: documents.collectPlayFontFaceEntries,
    collectPlayFontCssStacks: documents.collectPlayFontCssStacks,
    collectPlayModelBytes: documents.collectPlayModelBytes,
    collectPlayModelPayloads: documents.collectPlayModelPayloads,
    collectPlayAudio: documents.collectPlayAudio,
    collectPlayMaterialLibrary: documents.collectPlayMaterialLibrary,
    readAssetChunk: documents.readAssetChunk,
    assetRegistry: documents.assetRegistry,
  }),
}));

vi.mock("../context/scene-editing-context", () => ({
  FALLBACK_PLACE_POSITION: [0, 0, 0],
  useSceneEditing: () => ({
    selectedActorIds: selection.actorIds,
    selectActor: vi.fn(),
    setSelectedActorIds: vi.fn(),
    gizmoTool: "translate",
    snapEnabled: false,
    viewportMode: selection.mode,
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
  ViewportToolbar: ({ onDrop, dropDisabled }: { onDrop?: () => void; dropDisabled?: boolean }) => (
    <button type="button" onClick={onDrop} disabled={dropDisabled}>Drop</button>
  ),
}));

vi.mock("../components/viewport-joystick", () => ({
  ViewportJoystick: () => null,
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
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "clientWidth", "get").mockReturnValue(256);
    vi.spyOn(HTMLCanvasElement.prototype, "clientHeight", "get").mockReturnValue(256);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    receiveActiveAppSettingsUpdate({ viewportDropDistance: 10_000 });
    createEngineMock.mockClear();
    handle.editor.setGridSettings.mockClear();
    play.registerSharedEngine.mockClear();
    play.playing = false;
    play.preparing = false;
    documents.openDocuments = [];
    documents.assetRegistry = null;
    documents.projectDocument = null;
    selection.actorIds = [];
    documents.applySceneChange.mockClear();
    handle.loadScene.mockClear();
    handle.loadSceneAsync.mockReset().mockResolvedValue(undefined);
    handle.setMeshAssets.mockClear();
    handle.setMaterialDocuments.mockClear();
    handle.dispose.mockClear();
    handle.engine.onContextRestoredObservable.add.mockClear();
    handle.engine.onContextRestoredObservable.remove.mockClear();
    handle.whenEditorModelsReady.mockReset().mockResolvedValue(undefined);
    handle.whenMaterialTexturesReady.mockReset().mockResolvedValue(undefined);
    handle.setRenderSettings.mockClear();
    handle.editor.camera.importSessionState.mockClear();
    handle.editor.camera.exportSessionState.mockClear();
    handle.prewarmSceneMaterials.mockReset().mockResolvedValue(undefined);
    handle.presentFirstFrame.mockReset().mockResolvedValue(undefined);
    documents.collectPlayMaterialLibrary.mockReset().mockResolvedValue({
      documents: new Map(),
      functions: new Map(),
      textureGuids: [],
    });
    documents.collectPlayTextureBytes.mockReset().mockResolvedValue(new Map());
    documents.collectPlaySpritePayloads.mockReset().mockResolvedValue([]);
    documents.collectPlayAudio.mockReset();
    handle.editor.syncSelectionDebug.mockClear();
  });

  it("supplies attenuation metadata for selected scene audio without loading source clips", async () => {
    const audioActor = createActor("speaker", "Speaker", { components: [{
      id: "audio", classId: "AudioComponent", properties: { audioAssetGuid: "sound" },
    }] });
    documents.openDocuments = [{
      id: "scene:S", ref: { kind: "scene", path: "assets/S.scene.babasset", label: "S" },
      content: { ...createDefaultScene(), actors: [audioActor] },
    }];
    const library = playAudioLibraryFromAssets({ mixerGuid: null, assets: [
      { guid: "sound", type: "Audio", payload: { soundAttenuationGuid: "near" } },
      { guid: "near", type: "SoundAttenuation", payload: { innerRadius: 3, maxRadius: 12 } },
    ] });
    const loadSourceBytes = vi.fn(async () => null);
    documents.collectPlayAudio.mockResolvedValue({ library, loadSourceBytes });
    selection.actorIds = ["speaker"];
    renderViewport();
    await waitFor(() => expect(handle.editor.syncSelectionDebug).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedActorIds: ["speaker"], audioLibrary: library }),
    ));
    expect(loadSourceBytes).not.toHaveBeenCalled();
  });

  it("defers a hidden dock canvas without blocking its sibling, then waits for a real presentation", async () => {
    documents.openDocuments = [{
      id: "scene:S", ref: { kind: "scene", path: "assets/S.scene.babasset", label: "S" },
      content: createDefaultScene(),
    }];
    const width = vi.spyOn(HTMLCanvasElement.prototype, "clientWidth", "get").mockReturnValue(0);
    const callbacks = new Set<() => void>();
    vi.stubGlobal("ResizeObserver", class {
      readonly callback: () => void;
      constructor(callback: () => void) { this.callback = callback; }
      observe() { callbacks.add(this.callback); }
      disconnect() { callbacks.delete(this.callback); }
    });
    let present!: () => void;
    handle.presentFirstFrame.mockReturnValueOnce(new Promise<void>((resolve) => { present = resolve; }));
    renderViewport();
    await waitFor(() => expect(callbacks.size).toBeGreaterThan(0));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(createEngineMock).not.toHaveBeenCalled();
    expect(handle.loadScene).not.toHaveBeenCalled();
    expect(handle.presentFirstFrame).not.toHaveBeenCalled();
    await act(async () => {
      width.mockReturnValue(256);
      for (const callback of [...callbacks]) callback();
    });
    await waitFor(() => expect(handle.presentFirstFrame).toHaveBeenCalledOnce());
    expect(screen.getByRole("dialog").textContent).toContain("Presenting First Frame");
    expect(screen.getByTestId("viewport-panel").getAttribute("data-scene-ready")).toBe("false");
    await act(async () => present());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("viewport-panel").getAttribute("data-scene-ready")).toBe("true");
  });

  it("cancels a first frame when its tab hides and retries only after activation", async () => {
    documents.openDocuments = [{
      id: "scene:S", ref: { kind: "scene", path: "assets/S.scene.babasset", label: "S" },
      content: createDefaultScene(),
    }];
    const width = vi.spyOn(HTMLCanvasElement.prototype, "clientWidth", "get").mockReturnValue(256);
    const callbacks = new Set<() => void>();
    vi.stubGlobal("ResizeObserver", class {
      readonly callback: () => void;
      constructor(callback: () => void) { this.callback = callback; }
      observe() { callbacks.add(this.callback); }
      disconnect() { callbacks.delete(this.callback); }
    });
    let failPresentation!: (error: Error) => void;
    handle.presentFirstFrame.mockReturnValueOnce(new Promise<void>((_resolve, reject) => { failPresentation = reject; }));
    handle.dispose.mockImplementationOnce(() => failPresentation(new Error("Loading viewport disposed")));
    renderViewport();
    await waitFor(() => expect(handle.presentFirstFrame).toHaveBeenCalledOnce());
    await act(async () => {
      width.mockReturnValue(0);
      for (const callback of [...callbacks]) callback();
    });
    expect(handle.dispose).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(createEngineMock).toHaveBeenCalledOnce();
    expect(screen.getByTestId("viewport-panel").getAttribute("data-scene-ready")).toBe("false");
    await act(async () => {
      width.mockReturnValue(256);
      for (const callback of [...callbacks]) callback();
    });
    await waitFor(() => expect(handle.presentFirstFrame).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("viewport-panel").getAttribute("data-scene-ready")).toBe("true"));
    expect(createEngineMock).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => {
      width.mockReturnValue(0);
      for (const callback of [...callbacks]) callback();
      width.mockReturnValue(256);
      for (const callback of [...callbacks]) callback();
    });
    expect(handle.dispose).toHaveBeenCalledOnce();
    expect(createEngineMock).toHaveBeenCalledTimes(2);
  });

  it("mounts blocking UI before scene creation and keeps it until the first frame", async () => {
    const scene = createDefaultScene();
    scene.settings.postProcessStack = [{
      id: "masked-pass", materialGuid: "mask-material", enabled: false,
      parameters: { Mask: { kind: "texture", textureAssetGuid: "entry-mask" } },
    }];
    const maskBytes = new Uint8Array([1, 2, 3, 4]);
    documents.collectPlayTextureBytes.mockImplementationOnce(async (_sprites, _tilesets, guids) =>
      new Map(guids?.includes("entry-mask") ? [["entry-mask", maskBytes]] : []));
    documents.openDocuments = [{
      id: "scene:S", ref: { kind: "scene", path: "assets/S.scene.babasset", label: "S" },
      content: scene,
    }];
    createEngineMock.mockImplementationOnce(() => {
      expect(screen.getByRole("dialog").textContent).toContain("Loading Scene");
      return handle;
    });
    let present!: () => void;
    handle.presentFirstFrame.mockReturnValueOnce(new Promise<void>((resolve) => { present = resolve; }));
    renderViewport();
    expect(createEngineMock).not.toHaveBeenCalled();
    expect(handle.loadScene).not.toHaveBeenCalled();
    await waitFor(() => expect(handle.presentFirstFrame).toHaveBeenCalledOnce());
    expect(handle.loadSceneAsync).toHaveBeenCalledWith(scene, expect.objectContaining({
      assets: expect.objectContaining({ textureBytes: new Map([["entry-mask", maskBytes]]) }),
    }));
    expect(screen.getByRole("dialog").textContent).toContain("Presenting First Frame");
    expect(screen.getByTestId("viewport-panel").getAttribute("data-scene-ready")).toBe("false");
    await act(async () => present());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("viewport-panel").getAttribute("data-scene-ready")).toBe("true");
  });

  it("collects once and waits for chunked realization before model readiness", async () => {
    documents.openDocuments = [{
      id: "scene:S", ref: { kind: "scene", path: "assets/S.scene.babasset", label: "S" }, content: createDefaultScene(),
    }];
    let finish!: () => void;
    handle.loadSceneAsync.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    renderViewport();
    await waitFor(() => expect(handle.loadSceneAsync).toHaveBeenCalledOnce());
    expect(documents.collectPlayMaterialLibrary).toHaveBeenCalledOnce();
    expect(handle.setMaterialDocuments).not.toHaveBeenCalled();
    expect(handle.setMeshAssets).not.toHaveBeenCalled();
    expect(handle.loadScene).not.toHaveBeenCalled();
    expect(handle.whenEditorModelsReady).not.toHaveBeenCalled();
    expect(screen.getByTestId("viewport-panel").getAttribute("data-scene-ready")).toBe("false");
    await act(async () => finish());
    await waitFor(() => expect(screen.getByTestId("viewport-panel").getAttribute("data-scene-ready")).toBe("true"));
  });

  it.each(["create", "realize", "assets", "shaders", "present"] as const)(
    "keeps %s failures unready and retries with a fresh transition", async (stage) => {
      documents.openDocuments = [{
        id: "scene:S", ref: { kind: "scene", path: "assets/S.scene.babasset", label: "S" },
        content: createDefaultScene(),
      }];
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      const failure = new Error("Unavailable scene resource");
      if (stage === "create") createEngineMock.mockImplementationOnce(() => { throw failure; });
      if (stage === "realize") handle.loadSceneAsync.mockRejectedValueOnce(failure);
      if (stage === "assets") documents.collectPlayTextureBytes.mockRejectedValueOnce(failure);
      if (stage === "shaders") handle.prewarmSceneMaterials.mockRejectedValueOnce(failure);
      if (stage === "present") handle.presentFirstFrame.mockRejectedValueOnce(failure);
      try {
        renderViewport();
        await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("Scene Loading Failed"));
        expect(screen.getByTestId("viewport-panel").getAttribute("data-scene-ready")).toBe("false");
        if (stage !== "create") expect(handle.dispose).toHaveBeenCalledOnce();
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        await waitFor(() => expect(screen.getByTestId("viewport-panel").getAttribute("data-scene-ready")).toBe("true"));
        expect(createEngineMock).toHaveBeenCalledTimes(2);
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      } finally {
        errorLog.mockRestore();
      }
    },
  );

  it("applies compatible settings behind blocking progress without replacing the scene or camera", async () => {
    const scene = createDefaultScene();
    const document = {
      id: "scene:S", ref: { kind: "scene", path: "assets/S.scene.babasset", label: "S" },
      content: scene,
    };
    documents.openDocuments = [document];
    const view = renderViewport();
    await waitFor(() => expect(screen.getByTestId("viewport-panel").getAttribute("data-scene-ready")).toBe("true"));
    let present!: () => void;
    handle.presentFirstFrame.mockReturnValueOnce(new Promise<void>((resolve) => { present = resolve; }));
    documents.openDocuments = [{ ...document, content: {
      ...scene, settings: { ...scene.settings, shadowOverrides: { distance: 80 } },
    } }];
    view.rerender(<DocumentWorkspaceProvider documentId="scene:S"><ViewportPanel {...({} as IDockviewPanelProps)} /></DocumentWorkspaceProvider>);
    expect(handle.loadSceneAsync).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(handle.presentFirstFrame).toHaveBeenCalledTimes(2));
    expect(createEngineMock).toHaveBeenCalledOnce();
    expect(handle.dispose).not.toHaveBeenCalled();
    expect(handle.editor.camera.importSessionState).toHaveBeenCalledOnce();
    expect(handle.editor.camera.exportSessionState).not.toHaveBeenCalled();
    expect(handle.setRenderSettings).toHaveBeenCalledWith(expect.objectContaining({ shadows: expect.objectContaining({ distance: 80 }) }));
    expect(screen.getByRole("dialog").textContent).toContain("Updating Rendering");
    expect(screen.getByRole("dialog").textContent).toContain("Presenting First Frame");
    expect(screen.getByTestId("viewport-panel").getAttribute("data-scene-ready")).toBe("false");
    await act(async () => present());
    await waitFor(() => expect(screen.getByTestId("viewport-panel").getAttribute("data-scene-ready")).toBe("true"));
    documents.openDocuments = [...documents.openDocuments];
    view.rerender(<DocumentWorkspaceProvider documentId="scene:S"><ViewportPanel {...({} as IDockviewPanelProps)} /></DocumentWorkspaceProvider>);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)); });
    expect(createEngineMock).toHaveBeenCalledOnce();
    expect(handle.presentFirstFrame).toHaveBeenCalledTimes(2);
  });

  it("recreates compiled material ownership when shading changes while keeping the project Engine", async () => {
    documents.projectDocument = createEmptyProject("Rendering");
    documents.openDocuments = [{
      id: "scene:S", ref: { kind: "scene", path: "assets/S.scene.babasset", label: "S" },
      content: createDefaultScene(),
    }];
    const view = renderViewport();
    await waitFor(() => expect(screen.getByTestId("viewport-panel").getAttribute("data-scene-ready")).toBe("true"));
    const project = documents.projectDocument;
    documents.projectDocument = { ...project, settings: { ...project.settings, render: { ...project.settings.render, mode: "cel" } } };
    view.rerender(<DocumentWorkspaceProvider documentId="scene:S"><ViewportPanel {...({} as IDockviewPanelProps)} /></DocumentWorkspaceProvider>);
    await waitFor(() => expect(createEngineMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("viewport-panel").getAttribute("data-scene-ready")).toBe("true"));
    expect(handle.dispose).toHaveBeenCalledOnce();
    expect(handle.editor.camera.exportSessionState).toHaveBeenCalledOnce();
    expect(createEngineMock.mock.calls[1]?.[1]?.sharedEngine).toBe(createEngineMock.mock.calls[0]?.[1]?.sharedEngine);
  });

  it("rejects stale same-handle asset completion while the replacement waits for presentation", async () => {
    const document = {
      id: "scene:S", ref: { kind: "scene", path: "assets/S.scene.babasset", label: "S" },
      content: createDefaultScene(),
    };
    documents.openDocuments = [document];
    let finishOldAssets!: () => void;
    documents.collectPlaySpritePayloads.mockReturnValueOnce(new Promise<[]>((resolve) => { finishOldAssets = () => resolve([]); }));
    let present!: () => void;
    handle.presentFirstFrame.mockReturnValueOnce(new Promise<void>((resolve) => { present = resolve; }));
    const view = renderViewport();
    await waitFor(() => expect(documents.collectPlaySpritePayloads).toHaveBeenCalledOnce());
    documents.openDocuments = [{ ...document, content: { ...document.content, name: "Replacement" } }];
    view.rerender(<DocumentWorkspaceProvider documentId="scene:S"><ViewportPanel {...({} as IDockviewPanelProps)} /></DocumentWorkspaceProvider>);
    await waitFor(() => expect(handle.presentFirstFrame).toHaveBeenCalledOnce());
    await act(async () => finishOldAssets());
    expect(handle.loadSceneAsync).toHaveBeenCalledOnce();
    expect(handle.setMeshAssets).not.toHaveBeenCalled();
    expect(screen.getByTestId("viewport-panel").getAttribute("data-scene-ready")).toBe("false");
    expect(screen.getByRole("dialog").textContent).toContain("Presenting First Frame");
    await act(async () => present());
    await waitFor(() => expect(screen.getByTestId("viewport-panel").getAttribute("data-scene-ready")).toBe("true"));
    expect(createEngineMock).toHaveBeenCalledOnce();
  });

  it("drops the selected actors in one scene edit and leaves no-hit actors untouched", async () => {
    const a = createActor("a", "Box A");
    const b = createActor("b", "Box B");
    const miss = createActor("miss", "No Surface");
    const scene = { ...createDefaultScene(), actors: [a, b, miss] };
    documents.openDocuments = [{
      id: "scene:S",
      ref: { kind: "scene", path: "assets/S.scene.babasset", label: "S" },
      content: scene,
    }];
    selection.actorIds = [a.id, b.id, miss.id];
    const stop = engineCommandBus.subscribe((command) => {
      if (command.type !== "editor.drop") return;
      expect(command.maxDistance).toBe(25_000.5);
      expect(command.viewportId).toBe(createEngineMock.mock.calls.at(-1)?.[1]?.editorViewportId);
      expect(command.actorIds).toEqual([a.id, b.id, miss.id]);
      engineCommandBus.dispatch({
        type: "editor.drop.result",
        viewportId: command.viewportId,
        requestId: command.requestId,
        transforms: [
          { actorId: a.id, ...a.transform, position: [0, -3, 0] },
          { actorId: b.id, ...b.transform, position: [0, -8, 0] },
        ],
      });
    });
    try {
      renderViewport();
      await waitFor(() => expect(screen.getByTestId("viewport-panel").getAttribute("data-scene-ready")).toBe("true"));
      act(() => receiveActiveAppSettingsUpdate({ viewportDropDistance: 25_000.5 }));
      fireEvent.click(screen.getByRole("button", { name: "Drop" }));
      expect(documents.applySceneChange).toHaveBeenCalledTimes(1);
      const next = documents.applySceneChange.mock.calls[0]![1];
      expect(next.actors.map((actor: typeof a) => actor.transform.position)).toEqual([[0, -3, 0], [0, -8, 0], [0, 0, 0]]);
      expect(next.actors[2]).toBe(miss);
    } finally {
      stop();
    }
  });

  it("does not dirty the scene when Drop has no surface or editing is unavailable", async () => {
    const actor = createActor("a", "Box");
    documents.openDocuments = [{
      id: "scene:S",
      ref: { kind: "scene", path: "assets/S.scene.babasset", label: "S" },
      content: { ...createDefaultScene(), actors: [actor] },
    }];
    selection.actorIds = [actor.id];
    const view = renderViewport();
    await waitFor(() => expect(screen.getByTestId("viewport-panel").getAttribute("data-scene-ready")).toBe("true"));
    fireEvent.click(screen.getByRole("button", { name: "Drop" }));
    expect(documents.applySceneChange).not.toHaveBeenCalled();
    play.playing = true;
    view.rerender(<DocumentWorkspaceProvider documentId="scene:S"><ViewportPanel {...({} as IDockviewPanelProps)} /></DocumentWorkspaceProvider>);
    expect((screen.getByRole("button", { name: "Drop" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables Drop while changed scene models are loading", async () => {
    const actor = createActor("a", "Box");
    const document = {
      id: "scene:S",
      ref: { kind: "scene", path: "assets/S.scene.babasset", label: "S" },
      content: { ...createDefaultScene(), actors: [actor] },
    };
    documents.openDocuments = [document];
    selection.actorIds = [actor.id];
    const view = renderViewport();
    const button = () => screen.getByRole("button", { name: "Drop" }) as HTMLButtonElement;
    await waitFor(() => expect(button().disabled).toBe(false));
    let finishModels!: () => void;
    handle.whenEditorModelsReady.mockReturnValueOnce(new Promise<void>((resolve) => { finishModels = resolve; }));
    documents.openDocuments = [{ ...document, content: { ...document.content, actors: [{ ...actor, name: "Updated Box" }] } }];
    view.rerender(<DocumentWorkspaceProvider documentId="scene:S"><ViewportPanel {...({} as IDockviewPanelProps)} /></DocumentWorkspaceProvider>);
    try {
      expect(button().disabled).toBe(true);
      fireEvent.click(button());
      expect(documents.applySceneChange).not.toHaveBeenCalled();
    } finally {
      finishModels();
    }
    await waitFor(() => expect(button().disabled).toBe(false));
  });

  it("does not recreate the Engine when applySceneChange identity changes", async () => {
    const { rerender } = renderViewport();
    await waitFor(() => expect(createEngineMock).toHaveBeenCalledTimes(1));
    documents.applySceneChange = vi.fn(async () => false);
    rerender(
      <DocumentWorkspaceProvider documentId="scene:S">
        <ViewportPanel {...({} as IDockviewPanelProps)} />
      </DocumentWorkspaceProvider>,
    );
    expect(createEngineMock).toHaveBeenCalledTimes(1);
  });

  it("creates the viewport Scene on the project Engine", async () => {
    renderViewport();
    await waitFor(() => expect(createEngineMock).toHaveBeenCalledOnce());
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

  it("requests the overlay transform box for SceneLayer documents", async () => {
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
    await waitFor(() => expect(createEngineMock).toHaveBeenCalledOnce());
    expect(createEngineMock).toHaveBeenCalledWith(
      expect.any(HTMLCanvasElement),
      expect.objectContaining({ overlayTransformBox: true }),
    );
  });

  it("remounts the engine when a SceneLayer document appears", async () => {
    const { rerender } = renderViewport();
    await waitFor(() => expect(createEngineMock).toHaveBeenCalledOnce());
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
    await waitFor(() => expect(createEngineMock).toHaveBeenCalledTimes(2));
    expect(createEngineMock.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({ overlayTransformBox: true }),
    );
  });

  it("pushes independent 2D grid, movement snap, and camera bounds after engine creation", async () => {
    selection.mode = "2d";
    const scene = {
      name: "HUD",
      viewportMode: "2d" as const,
      settings: {
        grid: { tileSize: 4, tileSubdivisions: 4, snapTranslate: 0.5 },
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
          tileSize: 4,
          cameraBounds2D: { width: 32, height: 18 },
        }),
      );
    });
    expect(handle.editor.gizmos.setSnap).toHaveBeenLastCalledWith(
      expect.objectContaining({ translate: 0.5 }),
    );
    selection.mode = "3d";
  });

  it("pauses the editor viewport while Preview Build is preparing", async () => {
    const { rerender } = renderViewport();
    await waitFor(() => expect(createEngineMock).toHaveBeenCalledOnce());
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
    documents.assetRegistry = { list: () => [asset], getByGuid: () => asset };
    documents.openDocuments = [{
      id: "scene:S",
      ref: { kind: "scene", path: "assets/S.scene.babasset", label: "S" },
      content: createDefaultScene(),
    }];
    const { rerender } = renderViewport();
    await waitFor(() => expect(screen.getByTestId("viewport-panel").getAttribute("data-scene-ready")).toBe("true"));
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

  it("refreshes a prepared emission asset without rebuilding the scene or reacting to unchanged registry content", async () => {
    const sourceHash = "a".repeat(64);
    const asset = {
      rootId: "project", path: "assets/Emitter.texture.babasset",
      header: readAssetDocumentHeader(await encodeAssetDocument({ type: "Texture", guid: "emission", name: "Emitter", version: 1, payload: {} })),
    };
    asset.header.chunks.push({ id: "pixels", kind: "pixels", mime: "image/png", sha256: sourceHash, locator: { inline: { offset: 0, length: 4 } } });
    documents.assetRegistry = { list: () => [asset], getByGuid: (guid) => guid === "emission" ? asset : undefined };
    const scene = createDefaultScene();
    scene.actors = [createActor("emitter", "Emitter", { components: [{ id: "area", classId: "AreaRectLightComponent", properties: { textureGuid: "emission" } }] })];
    documents.openDocuments = [{ id: "scene:S", ref: { kind: "scene", path: "assets/S.scene.babasset", label: "S" }, content: scene }];
    const view = renderViewport();
    await waitFor(() => expect(screen.getByTestId("viewport-panel").getAttribute("data-scene-ready")).toBe("true"));
    const loads = handle.loadScene.mock.calls.length;
    const collects = documents.collectPlayAreaEmissions.mock.calls.length;
    const refresh = () => view.rerender(<DocumentWorkspaceProvider documentId="scene:S"><ViewportPanel {...({} as IDockviewPanelProps)} /></DocumentWorkspaceProvider>);
    asset.header.chunks.push({ id: areaEmissionChunkId(sourceHash), kind: "area-emission", mime: "application/octet-stream", sha256: "b".repeat(64), locator: { inline: { offset: 4, length: 8 } } });
    refresh();
    await waitFor(() => expect(documents.collectPlayAreaEmissions).toHaveBeenCalledTimes(collects + 1));
    await waitFor(() => expect(screen.getByTestId("viewport-panel").getAttribute("data-scene-ready")).toBe("true"));
    expect(handle.loadScene).toHaveBeenCalledTimes(loads);
    refresh();
    await act(async () => {});
    expect(documents.collectPlayAreaEmissions).toHaveBeenCalledTimes(collects + 1);
    // Replacing the source invalidates the old prepared representation.
    asset.header.chunks.find((chunk) => chunk.id === "pixels")!.sha256 = "c".repeat(64);
    refresh();
    await waitFor(() => expect(documents.collectPlayAreaEmissions).toHaveBeenCalledTimes(collects + 2));
  });
});
