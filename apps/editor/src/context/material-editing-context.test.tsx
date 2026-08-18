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

const harness = vi.hoisted(() => ({
  playing: false,
  engine: {
    registerView: vi.fn(),
    unRegisterView: vi.fn(),
    runRenderLoop: vi.fn(),
    stopRenderLoop: vi.fn(),
    resize: vi.fn(),
    views: [] as unknown[],
  },
  createScene: vi.fn(),
  createPresenter: vi.fn(),
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
  gestures: { dispose: vi.fn() },
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

vi.mock("./document-context", () => ({
  useDocuments: () => ({
    openDocuments: [
      {
        id: "material:assets/Rock.material.babasset",
        ref: { kind: "material", path: "assets/Rock.material.babasset" },
        content: createDefaultMaterialDocument("Rock"),
      },
    ],
    assetRegistry: { list: () => [], getByGuid: () => null },
    projectDocument: { settings: { playFrameCap: 60 } },
    readAssetChunk: vi.fn(),
  }),
}));

vi.mock("@babylonslate/render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@babylonslate/render")>();
  return {
    ...actual,
    MaterialLibrary: class {
      acquire() {
        return harness.acquireResult;
      }
      dispose() {}
    },
    createMaterialPreviewScene: (...args: unknown[]) =>
      harness.createScene(...args),
    createMaterialPreviewPresenter: (...args: unknown[]) =>
      harness.createPresenter(...args),
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
    <button
      type="button"
      disabled={control?.disabled ?? true}
      onClick={() => control?.requestRender()}
    >
      Render
    </button>
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
    harness.gestures.dispose.mockReset();
  });

  afterEach(() => {
    cleanup();
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
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(button.hasAttribute("disabled")).toBe(true);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(MANUAL_RENDER_COOLDOWN_MS - 1);
        });
        expect(button.hasAttribute("disabled")).toBe(true);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1);
        });
        expect(button.hasAttribute("disabled")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
