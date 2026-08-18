import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { PrefabViewportPanel } from "./prefab-viewport-panel";

const { createEngineMock, play, dispose } = vi.hoisted(() => {
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
      setSelectedActors: vi.fn(),
      syncSelectionDebug: vi.fn(),
      gizmos: { setTool: vi.fn(), setSnap: vi.fn() },
      grid: { setVisible: vi.fn() },
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
    setMaterialDocuments: vi.fn(),
    setMeshAssets: vi.fn(),
    resize: vi.fn(),
    dispose: disposeFn,
  };
  const createEngineMock = vi.fn<
    (
      canvas?: unknown,
      options?: { sharedEngine?: unknown; present?: string },
    ) => typeof handle
  >();
  createEngineMock.mockReturnValue(handle);
  return {
    dispose: disposeFn,
    createEngineMock,
    play: {
      ensureSharedEngine: vi.fn(() => ({ id: "shared-engine" })),
      sharedEngineGeneration: 1,
      registerScheduler: vi.fn(() => () => {}),
      playing: false,
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
    components: [],
    selectedId: null,
    setSelectedId: vi.fn(),
    updateComponentTransform: vi.fn(),
    applyPivotTransform: vi.fn(),
  }),
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    collectPlaySpritePayloads: vi.fn(async () => []),
    collectPlayTilemapContent: vi.fn(async () => ({ tilesets: [], tilemaps: [] })),
    collectPlayTextureBytes: vi.fn(async () => new Map()),
    collectPlayModelBytes: vi.fn(async () => new Map()),
    collectPlayMaterialLibrary: vi.fn(async () => ({
      documents: {},
      functions: {},
      textureGuids: [],
    })),
    projectDocument: null,
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
    setFrameActorHandler: vi.fn(),
  }),
}));

vi.mock("../components/viewport-toolbar", () => ({
  ViewportToolbar: () => null,
}));

vi.mock("../components/viewport-joystick", () => ({
  ViewportJoystick: () => null,
}));

vi.mock("../lib/viewport-render-gate", () => ({
  attachViewportRenderGate: () => () => {},
}));

describe("PrefabViewportPanel engine", () => {
  afterEach(() => {
    cleanup();
    createEngineMock.mockClear();
    dispose.mockClear();
    play.ensureSharedEngine.mockClear();
    play.sharedEngineGeneration = 1;
    play.ensureSharedEngine.mockReturnValue({ id: "shared-engine" });
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
});
