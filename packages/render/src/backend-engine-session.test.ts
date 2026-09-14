import { beforeEach, describe, expect, it, vi } from "vitest";

const { createGl, createGpu, releaseCache } = vi.hoisted(() => ({
  createGl: vi.fn(),
  createGpu: vi.fn(),
  releaseCache: vi.fn(),
}));
vi.mock("./create-engine", () => ({ createAppEngine: createGl }));
vi.mock("./webgpu-engine", () => ({ createAppWebGpuEngine: createGpu }));
vi.mock("./resource-cache", () => ({ releaseResourceCacheForEngine: releaseCache }));
import { createBackendEngineSession } from "./backend-engine-session";

describe("backend Engine session", () => {
  beforeEach(() => vi.resetAllMocks());

  function host() {
    const canvases: HTMLCanvasElement[] = [];
    const released: HTMLCanvasElement[] = [];
    const engine = {
      isDisposed: false,
      webGLVersion: 2,
      dispose: vi.fn(() => { engine.isDisposed = true; }),
    };
    createGl.mockReturnValue(engine);
    createGpu.mockResolvedValue(engine);
    return {
      engine, canvases, released,
      options: {
        requestedBackend: "webgpu" as const,
        createCanvas: () => {
          const canvas = { width: 8, height: 8 } as HTMLCanvasElement;
          canvases.push(canvas);
          return canvas;
        },
        releaseCanvas: (canvas: HTMLCanvasElement) => { released.push(canvas); },
      },
    };
  }

  it("releases the failed canvas before WebGL2 fallback without changing the request", async () => {
    const h = host();
    createGpu.mockRejectedValue(new Error("No adapter"));
    createGl.mockImplementation(() => {
      expect(h.released).toEqual([h.canvases[0]]);
      return h.engine;
    });
    const session = await createBackendEngineSession(h.options);
    expect(session.requestedBackend).toBe("webgpu");
    expect(session.effectiveBackend).toBe("webgl2");
    expect(session.fallbackReason).toContain("No adapter");
    expect(h.canvases).toHaveLength(2);
    expect(h.canvases[0]).not.toBe(h.canvases[1]);
    session.dispose();
    session.dispose();
    expect(h.released).toEqual(h.canvases);
    expect(releaseCache).toHaveBeenCalledWith(h.engine);
    expect(h.engine.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes a superseded completion and never starts fallback after cancellation", async () => {
    const h = host();
    const controller = new AbortController();
    createGpu.mockImplementation(async () => {
      controller.abort(new Error("Project closed"));
      return h.engine;
    });
    await expect(createBackendEngineSession({ ...h.options, signal: controller.signal }))
      .rejects.toBe(controller.signal.reason);
    expect(createGl).not.toHaveBeenCalled();
    expect(h.engine.isDisposed).toBe(true);
    expect(h.released).toEqual(h.canvases);
  });

  it("reports material incompatibility before attempting WebGPU", async () => {
    const h = host();
    const reason = "Material Glass uses Custom GLSL; using WebGL2.";
    const session = await createBackendEngineSession({ ...h.options, webGpuCompatibilityReason: reason });
    expect(createGpu).not.toHaveBeenCalled();
    expect(session.effectiveBackend).toBe("webgl2");
    expect(session.fallbackReason).toBe(reason);
    session.dispose();
  });

  it("does not allocate a fallback when initialization cleanup failed", async () => {
    const h = host();
    const failure = new AggregateError([new Error("Device release failed")]);
    createGpu.mockRejectedValue(failure);
    await expect(createBackendEngineSession(h.options)).rejects.toBe(failure);
    expect(createGl).not.toHaveBeenCalled();
    expect(h.released).toEqual(h.canvases);
  });

  it("rejects a WebGL1 downgrade and releases the Engine and canvas", async () => {
    const h = host();
    h.engine.webGLVersion = 1;
    await expect(createBackendEngineSession({ ...h.options, requestedBackend: "webgl2" }))
      .rejects.toThrow("WebGL2 is required");
    expect(h.engine.isDisposed).toBe(true);
    expect(h.released).toEqual(h.canvases);
  });

  it("preserves failed cleanup after cancellation and includes canvas release failures", async () => {
    const h = host();
    const controller = new AbortController();
    const disposeFailure = new Error("Device release failed");
    const canvasFailure = new Error("Canvas release failed");
    createGpu.mockImplementation(async () => {
      controller.abort(new Error("Superseded"));
      return h.engine;
    });
    h.engine.dispose.mockImplementation(() => { throw disposeFailure; });
    const operation = createBackendEngineSession({
      ...h.options, signal: controller.signal,
      releaseCanvas: () => { throw canvasFailure; },
    });
    await expect(operation).rejects.toMatchObject({ errors: [controller.signal.reason, disposeFailure, canvasFailure] });
    expect(createGl).not.toHaveBeenCalled();
    expect(h.canvases).toHaveLength(1);
  });
});
