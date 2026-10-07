import { unzlibSync } from "fflate";
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

function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  // jsdom's Blob implements FileReader, but not Blob.arrayBuffer().
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

const harness = vi.hoisted(() => ({
  functionAssets: [] as Array<{ path: string; header: { guid: string; type: string; payload: unknown } }>,
  registryEpoch: 0,
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
  cacheDisposeCalls: 0,
  content: null as ReturnType<typeof createDefaultMaterialDocument> | null,
  readAssetChunk: vi.fn(
    async (_path: string, chunkId: string) =>
      chunkId === "pixels" ? new Uint8Array([1, 2, 3, 4]) : null,
  ),
  textureAsset: {
    path: "assets/albedo.babasset",
    header: { guid: "tex-1", type: "Texture", name: "albedo", payload: {}, chunks: [{ id: "pixels", sha256: "original-pixels" }] },
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

vi.mock("./document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
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
  get registryEpoch() {
    return harness.registryEpoch;
  },
  projectDocument: { settings: { playFrameCap: 60 } },
  readAssetChunk: harness.readAssetChunk,
})));

vi.mock("@babylonslate/render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@babylonslate/render")>();
  const cache = {
    acquireTexture(guid: string, _engine: unknown, bytes: Blob) {
      harness.cachedTextures.push({ guid, bytes });
      return {
        resource: { name: guid, isDisposed: () => false }, key: guid, release: vi.fn(),
      };
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

function PreviewStateProbe() {
  const { previewState } = useMaterialEditing();
  return <output data-testid="preview-state">{previewState.status}</output>;
}

function materialTree(active = true, children?: ReactNode) {
  return (
    <MaterialRenderControlProvider>
      <MaterialEditingProvider
        documentId="material:assets/Rock.material.babasset"
        active={active}
      >
        {children ?? <AttachCanvas />}
      </MaterialEditingProvider>
    </MaterialRenderControlProvider>
  );
}

function mount(active = true, children?: ReactNode) {
  return render(materialTree(active, children));
}

describe("MaterialEditingProvider preview isolation", () => {
  beforeEach(() => {
    harness.functionAssets = [];
    harness.registryEpoch = 0;
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
    harness.cacheDisposeCalls = 0;
    harness.contextRestored = null;
    harness.cachedTextures = [];
    harness.content = createDefaultMaterialDocument("Rock");
    harness.textureAsset = {
      path: "assets/albedo.babasset",
      header: { guid: "tex-1", type: "Texture", name: "albedo", payload: {}, chunks: [{ id: "pixels", sha256: "original-pixels" }] },
    };
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
    harness.content!.nodes.push({ id: "call", type: "function.call", position: { x: 0, y: 0 }, properties: { functionGuid: "wave" } });
    harness.functionAssets = [{ path: "assets/Wave.material-function.babasset", header: { guid: "wave", type: "MaterialFunction", payload: {} } }];
    harness.readAssetChunk.mockImplementation(async (_path, chunkId) => chunkId === "document" ? new TextEncoder().encode(JSON.stringify({ name: "Saved Wave", nodes: [], edges: [], inputs: [], outputs: [] })) : null);
    mount();
    await waitFor(() => expect(harness.libraryOptions?.functions?.()).toMatchObject({ wave: { name: "Saved Wave" } }));
  });

  it("does not reload saved Material Functions when the registry epoch advances without function changes", async () => {
    harness.content!.nodes.push({ id: "call", type: "function.call", position: { x: 0, y: 0 }, properties: { functionGuid: "wave" } });
    const asset = {
      path: "assets/Wave.material-function.babasset",
      header: { guid: "wave", type: "MaterialFunction", payload: {} },
    };
    harness.functionAssets = [asset];
    harness.readAssetChunk.mockImplementation(async (_path, chunkId) =>
      chunkId === "document"
        ? new TextEncoder().encode(
            JSON.stringify({ name: "Saved Wave", nodes: [], edges: [], inputs: [], outputs: [] }),
          )
        : null,
    );
    const view = mount();
    await waitFor(() => expect(harness.readAssetChunk).toHaveBeenCalledTimes(1));

    harness.registryEpoch += 1;
    view.rerender(materialTree());
    await act(async () => {
      await Promise.resolve();
    });
    expect(harness.readAssetChunk).toHaveBeenCalledTimes(1);

    harness.functionAssets = [{ ...asset, header: { ...asset.header } }];
    harness.registryEpoch += 1;
    view.rerender(materialTree());
    await waitFor(() => expect(harness.readAssetChunk).toHaveBeenCalledTimes(2));
  });

  it("keeps unused functions unread and deduplicates a cyclic required function closure", async () => {
    harness.content!.nodes.push({ id: "call", type: "function.call", position: { x: 0, y: 0 }, properties: { functionGuid: "outer" } });
    harness.functionAssets = ["outer", "inner", "unused"].map((guid) => ({
      path: `assets/${guid}.material-function.babasset`, header: { guid, type: "MaterialFunction", payload: {} },
    }));
    harness.readAssetChunk.mockImplementation(async (path) => new TextEncoder().encode(JSON.stringify({
      name: path, nodes: [{ id: "call", type: "function.call", position: { x: 0, y: 0 }, properties: { functionGuid: path.includes("outer") ? "inner" : "outer" } }],
      edges: [], inputs: [], outputs: [],
    })));
    mount();
    await waitFor(() => expect(Object.keys(harness.libraryOptions?.functions?.() ?? {})).toEqual(["outer", "inner"]));
    expect(harness.readAssetChunk.mock.calls.map(([path]) => path)).toEqual([
      "assets/outer.material-function.babasset", "assets/inner.material-function.babasset",
    ]);
  });

  it("leaves a cold restored material tab and its function library unrealized", async () => {
    harness.content = null;
    harness.functionAssets = [{ path: "assets/Unused.material-function.babasset", header: { guid: "unused", type: "MaterialFunction", payload: {} } }];
    mount(false);
    await act(async () => { await Promise.resolve(); });
    expect(harness.readAssetChunk).not.toHaveBeenCalled();
    expect(harness.createScene).not.toHaveBeenCalled();
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
        { ownerDocumentId: "material:assets/Rock.material.babasset" },
      );
    });
    await waitFor(() => {
      expect(harness.readAssetChunk).toHaveBeenCalledWith(
        "assets/albedo.babasset",
        "source",
        { ownerDocumentId: "material:assets/Rock.material.babasset" },
      );
    });
    await waitFor(() => {
      expect(harness.libraryOptions?.acquireTexture?.("tex-1")?.resource).toEqual(
        expect.objectContaining({ name: "tex-1" }),
      );
    });
    expect(harness.cachedTextures).toHaveLength(1);
    expect(harness.cachedTextures[0]!.guid).toBe("tex-1");
    expect(await readBlobBytes(harness.cachedTextures[0]!.bytes)).toEqual(new Uint8Array([9, 9, 9]));
  });

  it("finishes one manual Render after a cold Texture arrives for an expensive preview", async () => {
    const material = createDefaultMaterialDocument("Rock", "postProcess");
    material.nodes.push({ id: "sample", type: "texture.sample", position: { x: 0, y: 0 }, properties: { textureGuid: "tex-1" } });
    material.edges = [{ id: "sample-output", sourceNodeId: "sample", sourcePinId: "rgba", targetNodeId: "output", targetPinId: "color" }];
    harness.content = material;
    let finishRead!: (bytes: Uint8Array) => void;
    harness.readAssetChunk.mockImplementation(() => new Promise<Uint8Array>((resolve) => { finishRead = resolve; }));
    mount(true, <><AttachCanvas /><RenderProbe /><PreviewStateProbe /></>);
    await waitFor(() => expect(harness.readAssetChunk).toHaveBeenCalled());
    const renderButton = screen.getByRole("button", { name: "Render" });
    await waitFor(() => expect(renderButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(renderButton);
    expect(screen.getByTestId("preview-state").textContent).toBe("queued");
    expect(harness.acquireCalls).toBe(0);
    await act(async () => finishRead(new Uint8Array([9, 9, 9])));
    await waitFor(() => expect(screen.getByTestId("preview-state").textContent).toBe("ready"));
    expect(harness.acquireCalls).toBe(1);
    expect(harness.host.applyPostProcess).toHaveBeenCalledWith(harness.acquireResult.ok ? harness.acquireResult.material : null);
  });

  it("resolves RenderTargetTexture samples to opaque black without reading image chunks", async () => {
    harness.content = sampledRock();
    harness.textureAsset.header.type = "RenderTargetTexture";
    const view = mount();
    await waitFor(() => expect(harness.acquireCalls).toBeGreaterThan(0));

    expect(harness.libraryOptions?.acquireTexture?.("tex-1")).not.toBeNull();
    expect(harness.readAssetChunk).not.toHaveBeenCalled();
    const png = await readBlobBytes(harness.cachedTextures[0]!.bytes);
    const data = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const compressed: Uint8Array[] = [];
    for (let offset = 8; offset < png.length;) {
      const length = data.getUint32(offset);
      const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
      if (type === "IHDR") {
        expect([data.getUint32(offset + 8), data.getUint32(offset + 12)]).toEqual([1, 1]);
      }
      if (type === "IDAT") compressed.push(png.subarray(offset + 8, offset + 8 + length));
      offset += length + 12;
    }
    // One unfiltered RGBA texel: opaque black, not transparent or missing.
    const pixels = unzlibSync(new Uint8Array(compressed.flatMap((chunk) => [...chunk])));
    expect([...pixels]).toEqual([0, 0, 0, 0, 255]);

    // A later registry change must not hide missing ordinary image data.
    harness.textureAsset.header.type = "Texture";
    harness.readAssetChunk.mockResolvedValue(null);
    harness.registryEpoch += 1;
    const compiled = harness.acquireCalls;
    view.rerender(materialTree());
    await waitFor(() => expect(harness.acquireCalls).toBeGreaterThan(compiled));
    expect(harness.libraryOptions?.acquireTexture?.("tex-1")).toBeNull();
  });

  it("keeps loaded Texture bytes across edits and reloads them when the Texture's registry entry changes", async () => {
    harness.content = sampledRock();
    const pixelReads = () =>
      harness.readAssetChunk.mock.calls.filter(([, chunk]) => chunk === "pixels").length;
    const view = mount();
    await waitFor(() => expect(harness.acquireCalls).toBeGreaterThan(0));
    expect(pixelReads()).toBe(1);

    // A different document saving or encode progress advancing the catalog
    // must not discard this preview's prepared bytes or render request.
    harness.registryEpoch += 1;
    const beforeUnrelatedChange = harness.acquireCalls;
    view.rerender(materialTree());
    await act(async () => { await Promise.resolve(); });
    expect(pixelReads()).toBe(1);
    expect(harness.acquireCalls).toBe(beforeUnrelatedChange);

    // Edits replace the content and the open-document list, as the provider
    // does on every edit, but leave the registry epoch alone.
    for (const alphaCutoff of [0.25, 0.75]) {
      harness.content = { ...sampledRock(), alphaCutoff };
      view.rerender(materialTree());
      await act(async () => {
        await Promise.resolve();
      });
    }
    expect(pixelReads()).toBe(1);

    // A re-encode or reimport replaces the Texture's index entry.
    harness.textureAsset = {
      ...harness.textureAsset,
      header: { ...harness.textureAsset.header, chunks: [{ id: "pixels", sha256: "reimported-pixels" }] },
    };
    harness.registryEpoch += 1;
    const compiled = harness.acquireCalls;
    view.rerender(materialTree());
    await waitFor(() => expect(pixelReads()).toBe(2));
    // The preview recompiles with the reloaded bytes.
    await waitFor(() => expect(harness.acquireCalls).toBeGreaterThan(compiled));
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
