import { beforeEach, describe, expect, it, vi } from "vitest";

const { createGl, createGpu, loadWebGpu, releaseCache } = vi.hoisted(() => ({
  createGl: vi.fn(),
  createGpu: vi.fn(),
  loadWebGpu: vi.fn(),
  releaseCache: vi.fn(),
}));
vi.mock("./create-engine", () => ({ createAppEngine: createGl }));
// The on-demand WebGPU code (a separate chunk in the player) is the boundary: loading it is a fetch.
vi.mock("./webgpu-on-demand", async (importOriginal) => ({
  ...await importOriginal<typeof import("./webgpu-on-demand")>(),
  loadWebGpuEngineModule: loadWebGpu,
}));
vi.mock("./resource-cache", () => ({ releaseResourceCacheForEngine: releaseCache }));
import { createBackendEngineSession } from "./backend-engine-session";
import { directViewPresentationAllowed } from "./direct-view-presentation";

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
    loadWebGpu.mockResolvedValue({ createAppWebGpuEngine: createGpu, whenWebGpuDeviceLost: () => null });
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

  it("loads the WebGPU code only for a WebGPU attempt", async () => {
    const h = host();
    for (const requestedBackend of ["webgl2", "auto"] as const) {
      const session = await createBackendEngineSession({ ...h.options, requestedBackend });
      expect(session.effectiveBackend).toBe("webgl2");
      session.dispose();
    }
    expect(loadWebGpu).not.toHaveBeenCalled();
    const session = await createBackendEngineSession(h.options);
    expect(session.effectiveBackend).toBe("webgpu");
    expect(loadWebGpu).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it("falls back to WebGL2 on a fresh canvas when the WebGPU code fails to load", async () => {
    const h = host();
    loadWebGpu.mockRejectedValue(new Error("Failed to fetch dynamically imported module"));
    const session = await createBackendEngineSession(h.options);
    expect(createGpu).not.toHaveBeenCalled();
    expect(session.requestedBackend).toBe("webgpu");
    expect(session.effectiveBackend).toBe("webgl2");
    expect(session.fallbackReason).toBe("WebGPU initialization failed: Failed to fetch dynamically imported module Using WebGL2.");
    expect(h.canvases).toHaveLength(2);
    expect(h.released).toEqual([h.canvases[0]]);
    session.dispose();
  });

  it("lets views present directly only on a session that asks for it, so the player's views keep receiving copies", async () => {
    const player = host();
    const copying = await createBackendEngineSession(player.options);
    const project = host();
    const presenting = await createBackendEngineSession({ ...project.options, presentViewsDirectly: true });
    expect([directViewPresentationAllowed(copying.engine), directViewPresentationAllowed(presenting.engine)]).toEqual([false, true]);
  });

  it("disposes a superseded completion and never starts fallback after cancellation", async () => {
    const h = host();
    const controller = new AbortController();
    // The WebGPU code loads before the Engine starts, so the abort lands after this call returns its promise.
    const closed = new Error("Project closed");
    createGpu.mockImplementation(async () => {
      controller.abort(closed);
      return h.engine;
    });
    await expect(createBackendEngineSession({ ...h.options, signal: controller.signal }))
      .rejects.toBe(closed);
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
    const superseded = new Error("Superseded");
    createGpu.mockImplementation(async () => {
      controller.abort(superseded);
      return h.engine;
    });
    h.engine.dispose.mockImplementation(() => { throw disposeFailure; });
    const operation = createBackendEngineSession({
      ...h.options, signal: controller.signal,
      releaseCanvas: () => { throw canvasFailure; },
    });
    await expect(operation).rejects.toMatchObject({ errors: [superseded, disposeFailure, canvasFailure] });
    expect(createGl).not.toHaveBeenCalled();
    expect(h.canvases).toHaveLength(1);
  });
});
