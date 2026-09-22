import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useRef, type ReactNode } from "react";
import { RefreshCwIcon } from "lucide-react";
import { TooltipProvider } from "@babylonslate/ui/components/tooltip";
import { ActionFeedbackButton } from "../components/action-feedback-button";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import {
  MaterialEditingProvider,
  MANUAL_RENDER_COOLDOWN_MS,
  useMaterialEditing,
} from "./material-editing-context";
import {
  MaterialRenderControlProvider,
  useMaterialRenderControl,
} from "./material-render-control-context";

function sampledRock() {
  const doc = createDefaultMaterialDocument("Rock");
  doc.nodes.push({
    id: "sample",
    type: "texture.sample",
    position: { x: 0, y: 0 },
    properties: { textureGuid: "tex-1" },
  });
  doc.edges = doc.edges.filter((edge) => edge.id !== "e-color-output");
  doc.edges.push({
    id: "e-sample",
    sourceNodeId: "sample",
    sourcePinId: "rgb",
    targetNodeId: "output",
    targetPinId: "baseColor",
  });
  return doc;
}

const harness = vi.hoisted(() => ({
  functionAssets: [] as Array<{ path: string; header: { guid: string; type: string; payload: unknown } }>,
  playing: false,
  engine: {
    registerView: vi.fn(),
    unRegisterView: vi.fn(),
    runRenderLoop: vi.fn(),
    stopRenderLoop: vi.fn(),
    resize: vi.fn(),
    views: [] as unknown[],
    onContextRestoredObservable: {
      add: (cb: () => void) => {
        harness.contextRestored = cb;
        return { cb };
      },
      remove: vi.fn(),
    },
  },
  contextRestored: null as (() => void) | null,
  createScene: vi.fn(),
  createPresenter: vi.fn(),
  setRenderSettings: vi.fn(),
  attachGestures: vi.fn(),
  acquireResult: {
    ok: true,
    material: {},
    hash: "hash",
  } as
    | { ok: true; material: object; hash: string }
    | { ok: false; diagnostics: [] },
  host: {
    scene: { render: vi.fn(), dispose: vi.fn() },
    camera: {
      attachControl: vi.fn(),
      radius: 4,
      outputRenderTarget: null as unknown,
    },
    mesh: {},
    setMesh: vi.fn(),
    applyMaterial: vi.fn(),
    applyPostProcess: vi.fn(),
    dispose: vi.fn(),
  },
  presenter: {
    present: vi.fn(),
    setFrozen: vi.fn(),
    dispose: vi.fn(),
  },
  installPreviewEnvironment: vi.fn(),
  gestures: { dispose: vi.fn() },
  libraryOptions: null as {
    acquireTexture?: (guid: string) => { resource: unknown; release(): void } | null;
    functions?: () => unknown;
  } | null,
  acquireCalls: 0,
  invalidateCalls: 0,
  releaseGpuCalls: 0,
  cacheDisposeCalls: 0,
  content: null as ReturnType<typeof createDefaultMaterialDocument> | null,
  readAssetChunk: vi.fn(
    async (_path: string, chunkId: string) =>
      chunkId === "pixels" ? new Uint8Array([1, 2, 3, 4]) : null,
  ),
  textureAsset: {
    path: "assets/albedo.babasset",
    header: { guid: "tex-1", type: "Texture", name: "albedo" },
  },
  cachedTextures: [] as Array<{ guid: string; bytes: Blob }>,
}));

const playValue = {
  get playing() {
    return harness.playing;
  },
  ensureSharedEngine: () => harness.engine,
};

vi.mock("./play-context", () => ({
  usePlay: () => playValue,
}));

const assetRegistry = {
  list: () => [harness.textureAsset, ...harness.functionAssets],
  getByGuid: (guid: string) => guid === harness.textureAsset.header.guid ? harness.textureAsset : null,
};

vi.mock("./document-context", () => ({
  useDocuments: () => ({
    openDocuments: [
      {
        id: "material:assets/Rock.material.babasset",
        ref: { kind: "material", path: "assets/Rock.material.babasset" },
        get content() {
          return harness.content;
        },
      },
    ],
    assetRegistry,
    projectDocument: { settings: { playFrameCap: 60 } },
    readAssetChunk: harness.readAssetChunk,
  }),
}));

vi.mock("@babylonslate/render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@babylonslate/render")>();
  const cache = {
    acquireTexture(guid: string, _engine: unknown, bytes: Blob) {
      harness.cachedTextures.push({ guid, bytes });
      return {
        resource: { name: guid, isDisposed: () => false }, key: guid, release: vi.fn(),
      };
    },
    releaseGpuTextures() {
      harness.releaseGpuCalls += 1;
    },
    dispose() {
      harness.cacheDisposeCalls += 1;
    },
  };
  return {
    ...actual,
    setSceneRenderSettings: harness.setRenderSettings,
    ResourceCache: class {
      acquireTexture = cache.acquireTexture;
      releaseGpuTextures = cache.releaseGpuTextures;
      dispose = cache.dispose;
    },
    resourceCacheForEngine: () => cache,
    MaterialLibrary: class {
      constructor(options: {
        acquireTexture?: (guid: string) => { resource: unknown; release(): void } | null;
        functions?: () => unknown;
      }) {
        harness.libraryOptions = options;
      }
      acquire() {
        harness.acquireCalls += 1;
        return harness.acquireResult.ok
          ? { ...harness.acquireResult, ready: Promise.resolve([]) }
          : harness.acquireResult;
      }
      dispose() {}
      materialFor() { return null; }
      release() {}
      markDirty() {}
      cancelPending() {}
      releaseScene() {}
      invalidate() {
        harness.invalidateCalls += 1;
      }
    },
    createMaterialPreviewScene: (...args: unknown[]) =>
      harness.createScene(...args),
    createMaterialPreviewPresenter: (...args: unknown[]) =>
      harness.createPresenter(...args),
    installPreviewEnvironment: (...args: unknown[]) =>
      harness.installPreviewEnvironment(...args),
    attachMaterialPreviewGestures: (...args: unknown[]) =>
      harness.attachGestures(...args),
  };
});

function AttachCanvas() {
  const editing = useMaterialEditing();
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (canvas) {
      Object.defineProperty(canvas, "clientWidth", { value: 320, configurable: true });
      Object.defineProperty(canvas, "clientHeight", { value: 180, configurable: true });
    }
    editing.attachPreviewCanvas(canvas);
    return () => editing.attachPreviewCanvas(null);
  }, [editing]);
  return <canvas data-testid="material-preview-canvas" ref={ref} />;
}

function RenderProbe() {
  const { control } = useMaterialRenderControl();
  return (
    <TooltipProvider><ActionFeedbackButton
      label="Render"
      icon={RefreshCwIcon}
      feedback={control?.feedback}
      disabled={control?.disabled ?? true}
      onAction={() => control?.requestRender()}
    /></TooltipProvider>
  );
}

function mount(active = true, children?: ReactNode) {
  return render(
    <MaterialRenderControlProvider>
      <MaterialEditingProvider
        documentId="material:assets/Rock.material.babasset"
        active={active}
      >
        {children ?? <AttachCanvas />}
      </MaterialEditingProvider>
    </MaterialRenderControlProvider>,
  );
}

describe("MaterialEditingProvider preview isolation", () => {
  beforeEach(() => {
    harness.functionAssets = [];
    harness.playing = false;
    harness.engine.registerView.mockReset();
    harness.engine.unRegisterView.mockReset();
    harness.engine.runRenderLoop.mockReset();
    harness.engine.stopRenderLoop.mockReset();
    harness.engine.resize.mockReset();
    harness.createScene.mockReset().mockReturnValue(harness.host);
    harness.createPresenter.mockReset().mockReturnValue(harness.presenter);
    harness.attachGestures.mockReset().mockReturnValue(harness.gestures);
    harness.acquireResult = { ok: true, material: {}, hash: "hash" };
    harness.host.camera.attachControl.mockReset();
    harness.presenter.present.mockReset();
    harness.presenter.setFrozen.mockReset();
    harness.presenter.dispose.mockReset();
    harness.installPreviewEnvironment.mockReset();
    harness.gestures.dispose.mockReset();
    harness.libraryOptions = null;
    harness.acquireCalls = 0;
    harness.invalidateCalls = 0;
    harness.releaseGpuCalls = 0;
    harness.cacheDisposeCalls = 0;
    harness.contextRestored = null;
    harness.cachedTextures = [];
    harness.content = createDefaultMaterialDocument("Rock");
    harness.readAssetChunk.mockClear();
    harness.readAssetChunk.mockImplementation(
      async (_path: string, chunkId: string) =>
        chunkId === "pixels" ? new Uint8Array([1, 2, 3, 4]) : null,
    );
  });

  afterEach(() => {
    cleanup();
  });

  it("loads a closed Material Function from its saved document chunk", async () => {
    harness.functionAssets = [{ path: "assets/Wave.material-function.babasset", header: { guid: "wave", type: "MaterialFunction", payload: {} } }];
    harness.readAssetChunk.mockImplementation(async (_path, chunkId) => chunkId === "document" ? new TextEncoder().encode(JSON.stringify({ name: "Saved Wave", nodes: [], edges: [], inputs: [], outputs: [] })) : null);
    mount();
    await waitFor(() => expect(harness.libraryOptions?.functions?.()).toMatchObject({ wave: { name: "Saved Wave" } }));
  });

  it("does not registerView, attachControl, resize, or runRenderLoop on the shared Engine", async () => {
    mount();
    await waitFor(() => {
      expect(harness.createScene).toHaveBeenCalled();
    });
    expect(harness.engine.registerView).not.toHaveBeenCalled();
    expect(harness.host.camera.attachControl).not.toHaveBeenCalled();
    expect(harness.engine.resize).not.toHaveBeenCalled();
    expect(harness.engine.runRenderLoop).not.toHaveBeenCalled();
    expect(harness.installPreviewEnvironment).toHaveBeenCalledWith(harness.host.scene);
    expect(harness.createPresenter).toHaveBeenCalled();
    expect(harness.attachGestures).toHaveBeenCalled();
  });

  it("freezes the presenter when the document is inactive", async () => {
    mount(false);
    await waitFor(() => {
      expect(harness.presenter.setFrozen).toHaveBeenCalledWith(true);
    });
  });

  it("freezes the presenter while Play is running", async () => {
    harness.playing = true;
    mount(true);
    await waitFor(() => {
      expect(harness.presenter.setFrozen).toHaveBeenCalledWith(true);
    });
  });

  it("does not keep a present rAF running while the document is frozen", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    mount(false);
    await waitFor(() => {
      expect(harness.createPresenter).toHaveBeenCalled();
    });
    expect(harness.presenter.present).not.toHaveBeenCalled();
  });

  it.each(["success", "error"] as const)(
    "keeps manual Render disabled for three seconds after %s",
    async (result) => {
      vi.useFakeTimers();
      try {
        mount(true, (
          <>
            <AttachCanvas />
            <RenderProbe />
          </>
        ));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(250);
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        const button = screen.getByRole("button", { name: "Render" });
        expect(button.hasAttribute("disabled")).toBe(false);

        harness.acquireResult =
          result === "success"
            ? { ok: true, material: {}, hash: "hash" }
            : { ok: false, diagnostics: [] };
        fireEvent.click(button);
        expect(button.getAttribute("aria-busy")).toBe("true");
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(button.hasAttribute("disabled")).toBe(true);
        expect(button.getAttribute("data-action-state")).toBe(result);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(MANUAL_RENDER_COOLDOWN_MS - 1);
        });
        expect(button.hasAttribute("disabled")).toBe(true);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1);
        });
        expect(button.hasAttribute("disabled")).toBe(false);
        if (result === "error") {
          fireEvent.click(button);
          expect(screen.getByRole("status").textContent).toBe("Render In Progress");
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("constructs the preview library with a texture resolver", async () => {
    mount();
    await waitFor(() => {
      expect(harness.createScene).toHaveBeenCalled();
    });
    expect(typeof harness.libraryOptions?.acquireTexture).toBe("function");
  });

  it("loads Texture pixels then source and resolves them for preview compile", async () => {
    harness.content = sampledRock();
    harness.readAssetChunk.mockImplementation(
      async (_path: string, chunkId: string) => {
        if (chunkId === "pixels") return null;
        if (chunkId === "source") return new Uint8Array([9, 9, 9]);
        return null;
      },
    );
    mount();
    await waitFor(() => {
      expect(harness.readAssetChunk).toHaveBeenCalledWith(
        "assets/albedo.babasset",
        "pixels",
      );
    });
    await waitFor(() => {
      expect(harness.readAssetChunk).toHaveBeenCalledWith(
        "assets/albedo.babasset",
        "source",
      );
    });
    await waitFor(() => {
      expect(harness.libraryOptions?.acquireTexture?.("tex-1")?.resource).toEqual(
        expect.objectContaining({ name: "tex-1" }),
      );
    });
    expect(harness.cachedTextures).toHaveLength(1);
    expect(harness.cachedTextures[0]!.guid).toBe("tex-1");
    expect(new Uint8Array(await harness.cachedTextures[0]!.bytes.arrayBuffer())).toEqual(new Uint8Array([9, 9, 9]));
  });

  it("recompiles onto a new preview Scene after the canvas remounts", async () => {
    vi.useFakeTimers();
    const remount = {
      attach: null as ((canvas: HTMLCanvasElement | null) => void) | null,
      canvas: null as HTMLCanvasElement | null,
    };
    try {
      function RemountProbe() {
        const editing = useMaterialEditing();
        const ref = useRef<HTMLCanvasElement>(null);
        useEffect(() => {
          const canvas = ref.current;
          if (canvas) {
            Object.defineProperty(canvas, "clientWidth", {
              value: 320,
              configurable: true,
            });
            Object.defineProperty(canvas, "clientHeight", {
              value: 180,
              configurable: true,
            });
          }
          remount.attach = editing.attachPreviewCanvas;
          remount.canvas = canvas;
          editing.attachPreviewCanvas(canvas);
          // Attach once; the test remounts through `remount.attach`.
        }, [editing.attachPreviewCanvas]);
        return <canvas data-testid="material-preview-canvas" ref={ref} />;
      }

      mount(true, <RemountProbe />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(harness.createScene).toHaveBeenCalledTimes(1);
      expect(harness.acquireCalls).toBeGreaterThan(0);
      const acquiresBefore = harness.acquireCalls;

      await act(async () => {
        remount.attach?.(null);
      });
      await act(async () => {
        remount.attach?.(remount.canvas);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(harness.createScene.mock.calls.length).toBeGreaterThan(1);
      expect(harness.acquireCalls).toBeGreaterThan(acquiresBefore);
      expect(harness.host.applyMaterial).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates compiled materials and GPU textures after WebGL restore", async () => {
    vi.useFakeTimers();
    try {
      mount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(harness.contextRestored).toEqual(expect.any(Function));
      const acquiresBefore = harness.acquireCalls;
      await act(async () => {
        harness.contextRestored?.();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(harness.invalidateCalls).toBeGreaterThan(0);
      expect(harness.releaseGpuCalls).toBe(0);
      expect(harness.acquireCalls).toBeGreaterThan(acquiresBefore);
      expect(harness.presenter.present).toHaveBeenCalledWith({ force: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not dispose the shared ResourceCache when the Material tab unmounts", async () => {
    const view = mount();
    await waitFor(() => {
      expect(harness.createScene).toHaveBeenCalled();
    });
    view.unmount();
    expect(harness.cacheDisposeCalls).toBe(0);
  });
});
