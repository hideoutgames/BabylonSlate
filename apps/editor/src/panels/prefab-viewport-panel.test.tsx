import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { createMeshComponent, engineCommandBus } from "@babylonslate/core";
import {
  encodeAssetDocument,
  readAssetDocumentHeader,
} from "@babylonslate/assets";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { PrefabViewportPanel } from "./prefab-viewport-panel";
import { PREFAB_ROOT_ID } from "../lib/prefab-preview";

const {
  createEngineMock,
  play,
  dispose,
  handle,
  prefabState,
  collectPlayMaterialLibrary,
  collectPlaySpritePayloads,
  collectPlayTilemapContent,
  collectPlayTextureBytes,
  collectPlayTexturePixelSizes,
  collectPlayFontFacetypeBytes,
  collectPlayFontMsdfPair,
  collectPlayFontFaceEntries,
  collectPlayFontCssStacks,
  collectPlayModelBytes,
  collectPlayModelPayloads,
  prefabDocs,
  commitComponentTransforms,
} = vi.hoisted(() => {
  const disposeFn = vi.fn();
  const handle = {
    engine: { id: "created" },
    editor: {
      camera: {
        importSessionState: vi.fn(),
        exportSessionState: vi.fn(() => ({})),
        setPivotAroundCenter: vi.fn(),
      },
      setPreviewCanvas: vi.fn(),
      setViewportMode: vi.fn(),
      setViewportShadingMode: vi.fn(),
      setDrawMeshCollision: vi.fn(),
      setSelectedActors: vi.fn(),
      syncSelectionDebug: vi.fn(),
      gizmos: { setTool: vi.fn(), setSnap: vi.fn() },
      grid: { setVisible: vi.fn() },
      setGridSettings: vi.fn(),
    },
    scheduler: {
      setAlwaysRender: vi.fn(),
      setPaused: vi.fn(),
      invalidate: vi.fn(),
    },
    scaling: {},
    setPaused: vi.fn(),
    setPostProcessingEnabled: vi.fn(),
    loadScene: vi.fn(),
    whenEditorModelsReady: vi.fn(async () => {}),
    setMaterialDocuments: vi.fn(),
    setEditingMaterialGuids: vi.fn(),
    setMeshAssets: vi.fn(),
    registerFonts: vi.fn(async () => {}),
    resize: vi.fn(),
    dispose: disposeFn,
    resourceCache: {},
  };
  const createEngineMock =
    vi.fn<
      (
        canvas?: unknown,
        options?: { sharedEngine?: unknown; present?: string },
      ) => typeof handle
    >();
  createEngineMock.mockReturnValue(handle);
  return {
    dispose: disposeFn,
    handle,
    createEngineMock,
    commitComponentTransforms: vi.fn(),
    collectPlayMaterialLibrary: vi.fn(async () => ({
      documents: new Map(),
      functions: new Map(),
      textureGuids: [] as string[],
    })),
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
    prefabState: {
      selectedIds: [] as string[],
      components: [
        {
          id: "prefab-mesh",
          classId: "MeshComponent",
          properties: { meshKind: "box", assetGuid: null, materialGuid: null },
          parentId: null,
          transform: {
            position: [0, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
      ],
    } as {
      components: import("@babylonslate/core").SerializedComponent[];
      selectedIds: string[];
    },
    prefabDocs: {
      openDocuments: [] as Array<{
        id: string;
        ref: { kind: string; path: string; label: string };
      }>,
      assetRegistry: null as {
        list: () => Array<{
          path: string;
          header: { type: string; name: string; parentClass?: string | null };
        }>;
      } | null,
    },
    play: {
      ensureSharedEngine: vi.fn(() => ({ id: "shared-engine" })),
      sharedEngineGeneration: 1,
      registerScheduler: vi.fn(() => () => {}),
      playing: false,
      preparing: false,
    },
  };
});

vi.mock("@babylonslate/render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@babylonslate/render")>();
  return {
    ...actual,
    createEngine: (
      canvas: HTMLCanvasElement,
      options?: { sharedEngine?: unknown; present?: string },
    ) => createEngineMock(canvas, options),
  };
});

vi.mock("../context/play-context", () => ({
  usePlay: () => play,
}));

vi.mock("../context/prefab-editing-context", () => ({
  usePrefabEditing: () => ({
    components: prefabState.components,
    selectedId: prefabState.selectedIds.at(-1) ?? null,
    selectedIds: prefabState.selectedIds,
    setSelectedId: vi.fn(),
    updateComponentTransform: vi.fn(),
    commitComponentGizmo: vi.fn(),
    commitComponentTransforms,
    applyPivotTransform: vi.fn(),
  }),
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    collectPlaySpritePayloads,
    collectPlayTilemapContent,
    collectPlayTextureBytes,
    collectPlayTexturePixelSizes,
    collectPlayFontFacetypeBytes,
    collectPlayFontMsdfPair,
    collectPlayFontFaceEntries,
    collectPlayFontCssStacks,
    collectPlayModelBytes,
    collectPlayModelPayloads,
    collectPlayMaterialLibrary,
    projectDocument: null,
    openDocuments: prefabDocs.openDocuments,
    assetRegistry: prefabDocs.assetRegistry,
  }),
}));

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({
    documentId: "graph:assets/Hero.class.babasset",
  }),
}));

vi.mock("../context/scene-editing-context", () => ({
  useSceneEditing: () => ({
    gizmoTool: "translate",
    snapEnabled: false,
    viewportMode: "3d",
    joystickEnabled: false,
    gridVisible: true,
    saveEditorCameraPose: vi.fn(),
    loadEditorCameraPose: vi.fn(() => null),
    pivotAroundCenter: false,
    viewportShadingMode: "pbr",
    collisionsVisible: false,
    setFrameActorHandler: vi.fn(),
  }),
}));

vi.mock("../components/viewport-toolbar", () => ({
  ViewportToolbar: ({
    onDrop,
    dropDisabled,
  }: {
    onDrop?: () => void;
    dropDisabled?: boolean;
  }) => (
    <button type="button" onClick={onDrop} disabled={dropDisabled}>
      Drop
    </button>
  ),
}));

vi.mock("../components/viewport-joystick", () => ({
  ViewportJoystick: () => null,
}));

vi.mock("../lib/viewport-render-gate", () => ({
  attachViewportRenderGate: () => () => {},
  ENGINE_SETTINGS_CHANGED_EVENT: "babylonslate:engine-settings",
}));

describe("PrefabViewportPanel engine", () => {
  afterEach(() => {
    cleanup();
    createEngineMock.mockClear();
    dispose.mockClear();
    handle.loadScene.mockClear();
    handle.editor.setGridSettings.mockClear();
    handle.setMaterialDocuments.mockClear();
    handle.setMeshAssets.mockClear();
    handle.whenEditorModelsReady.mockReset().mockResolvedValue();
    commitComponentTransforms.mockClear();
    collectPlayMaterialLibrary.mockClear();
    prefabState.components = [createMeshComponent("prefab-mesh", "box")];
    prefabState.selectedIds = [];
    prefabDocs.openDocuments = [];
    prefabDocs.assetRegistry = null;
    play.ensureSharedEngine.mockClear();
    play.sharedEngineGeneration = 1;
    play.ensureSharedEngine.mockReturnValue({ id: "shared-engine" });
  });

  it("drops every selected component through its viewport and commits the returned transforms once", async () => {
    prefabState.components.push(createMeshComponent("second-mesh", "box"));
    prefabState.selectedIds = ["prefab-mesh", PREFAB_ROOT_ID, "second-mesh"];
    const requests: string[][] = [];
    const unsubscribe = engineCommandBus.subscribe((command) => {
      if (command.type !== "editor.drop") return;
      const viewportId = (
        createEngineMock.mock.calls.at(-1)?.[1] as { editorViewportId?: string }
      ).editorViewportId;
      if (command.viewportId !== viewportId) return;
      requests.push([...command.actorIds]);
      engineCommandBus.dispatch({
        type: "editor.drop.result",
        viewportId: command.viewportId,
        requestId: command.requestId,
        transforms: [
          {
            actorId: "prefab-mesh",
            position: [0, -2, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
          {
            actorId: "second-mesh",
            position: [3, -5, 4],
            rotation: [0, 1, 0, 0],
            scale: [2, 3, 4],
          },
        ],
      });
    });
    try {
      render(<PrefabViewportPanel {...({} as IDockviewPanelProps)} />);
      await waitFor(() => expect(handle.setMeshAssets).toHaveBeenCalled());
      fireEvent.click(screen.getByRole("button", { name: "Drop" }));
      expect(requests).toEqual([["prefab-mesh", "second-mesh"]]);
      expect(commitComponentTransforms).toHaveBeenCalledExactlyOnceWith([
        {
          componentId: "prefab-mesh",
          transform: {
            position: [0, -2, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
        {
          componentId: "second-mesh",
          transform: {
            position: [3, -5, 4],
            rotation: [0, 1, 0, 0],
            scale: [2, 3, 4],
          },
        },
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("does not create a graph edit when the collision query returns no drops", async () => {
    prefabState.selectedIds = ["prefab-mesh"];
    render(<PrefabViewportPanel {...({} as IDockviewPanelProps)} />);
    await waitFor(() => expect(handle.setMeshAssets).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Drop" }));
    expect(commitComponentTransforms).not.toHaveBeenCalled();
  });

  it("disables Drop until models are ready and for root-only or empty selections", async () => {
    let finishModels!: () => void;
    handle.whenEditorModelsReady.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishModels = resolve;
      }),
    );
    prefabState.selectedIds = ["prefab-mesh"];
    const { rerender } = render(
      <PrefabViewportPanel {...({} as IDockviewPanelProps)} />,
    );
    await waitFor(() => expect(handle.setMeshAssets).toHaveBeenCalled());
    expect(
      (screen.getByRole("button", { name: "Drop" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    finishModels();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Drop" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    prefabState.selectedIds = [PREFAB_ROOT_ID];
    rerender(<PrefabViewportPanel {...({} as IDockviewPanelProps)} />);
    expect(
      (screen.getByRole("button", { name: "Drop" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    prefabState.selectedIds = [];
    rerender(<PrefabViewportPanel {...({} as IDockviewPanelProps)} />);
    expect(
      (screen.getByRole("button", { name: "Drop" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("pushes 2D camera bounds after the prefab engine is created", async () => {
    render(<PrefabViewportPanel {...({} as IDockviewPanelProps)} />);
    await waitFor(() => {
      expect(handle.editor.setGridSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          cameraBounds2D: { width: 16, height: 9 },
        }),
      );
    });
  });

  it("creates Prefab on the app-lifetime Engine with rtt present", () => {
    const engine = { id: "shared-engine" };
    play.ensureSharedEngine.mockReturnValue(engine);
    render(<PrefabViewportPanel {...({} as IDockviewPanelProps)} />);
    expect(createEngineMock).toHaveBeenCalled();
    const options = createEngineMock.mock.calls[0]?.[1] as {
      sharedEngine: unknown;
      present?: string;
    };
    expect(options.sharedEngine).toBe(engine);
    expect(options.present).toBe("rtt");
    expect(handle.editor.setDrawMeshCollision).toHaveBeenCalledWith(false);
  });

  it("requests the overlay transform box for SceneLayerActor prefabs", () => {
    prefabDocs.openDocuments = [
      {
        id: "graph:assets/Hero.class.babasset",
        ref: {
          kind: "class",
          path: "assets/Hero.class.babasset",
          label: "Hero",
        },
      },
    ];
    prefabDocs.assetRegistry = {
      list: () => [
        {
          path: "assets/Hero.class.babasset",
          header: {
            type: "Class",
            name: "Hero",
            parentClass: "SceneLayerActor",
          },
        },
      ],
    };
    render(<PrefabViewportPanel {...({} as IDockviewPanelProps)} />);
    expect(createEngineMock).toHaveBeenCalledWith(
      expect.any(HTMLCanvasElement),
      expect.objectContaining({ overlayTransformBox: true }),
    );
  });

  it("rebinds Prefab when the shared Engine generation changes", () => {
    const first = { id: "engine-1" };
    const second = { id: "engine-2" };
    play.ensureSharedEngine.mockReturnValue(first);
    play.sharedEngineGeneration = 1;
    const { rerender } = render(
      <PrefabViewportPanel {...({} as IDockviewPanelProps)} />,
    );
    expect(createEngineMock.mock.calls[0]?.[1]).toMatchObject({
      sharedEngine: first,
      present: "rtt",
    });
    play.ensureSharedEngine.mockReturnValue(second);
    play.sharedEngineGeneration = 2;
    rerender(<PrefabViewportPanel {...({} as IDockviewPanelProps)} />);
    expect(dispose).toHaveBeenCalled();
    expect(createEngineMock.mock.calls.at(-1)?.[1]).toMatchObject({
      sharedEngine: second,
      present: "rtt",
    });
  });

  it("loads the preview after the shared Engine is ready with a stable component list", async () => {
    render(<PrefabViewportPanel {...({} as IDockviewPanelProps)} />);
    await waitFor(() => {
      expect(handle.loadScene).toHaveBeenCalled();
      expect(collectPlayMaterialLibrary).toHaveBeenCalled();
    });
  });

  it("does not restart material collection when components is a new array of the same payload", async () => {
    const { rerender } = render(
      <PrefabViewportPanel {...({} as IDockviewPanelProps)} />,
    );
    await waitFor(() => expect(collectPlayMaterialLibrary).toHaveBeenCalled());
    const loads = collectPlayMaterialLibrary.mock.calls.length;
    prefabState.components = prefabState.components.map((component) => ({
      ...component,
      properties: { ...component.properties },
    }));
    rerender(<PrefabViewportPanel {...({} as IDockviewPanelProps)} />);
    await Promise.resolve();
    await Promise.resolve();
    expect(collectPlayMaterialLibrary.mock.calls.length).toBe(loads);
  });

  it("refreshes a saved Material while its prefab stays mounted", async () => {
    const savedAsset = async (value: number) => ({
      path: "assets/Surface.material.babasset",
      header: readAssetDocumentHeader(
        await encodeAssetDocument({
          type: "Material",
          guid: "surface",
          name: "Surface",
          version: 1,
          payload: { value },
        }),
      ),
    });
    let asset = await savedAsset(1);
    prefabDocs.assetRegistry = { list: () => [asset] };
    const { rerender } = render(
      <PrefabViewportPanel {...({} as IDockviewPanelProps)} />,
    );
    await waitFor(() => expect(handle.setMeshAssets).toHaveBeenCalled());
    const initialLoads = handle.loadScene.mock.calls.length;
    const updatedDocuments = new Map([
      ["surface", createDefaultMaterialDocument("Saved Surface")],
    ]);
    collectPlayMaterialLibrary.mockResolvedValueOnce({
      documents: updatedDocuments,
      functions: new Map(),
      textureGuids: [],
    });
    asset = await savedAsset(2);
    rerender(<PrefabViewportPanel {...({} as IDockviewPanelProps)} />);
    await waitFor(() =>
      expect(handle.setMaterialDocuments).toHaveBeenLastCalledWith(
        updatedDocuments,
        new Map(),
      ),
    );
    expect(handle.loadScene).toHaveBeenCalledTimes(initialLoads);
  });
});
