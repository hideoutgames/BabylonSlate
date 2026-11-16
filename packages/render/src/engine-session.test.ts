import { beforeEach, describe, expect, it, vi } from "vitest";

const { createGl, releaseCache } = vi.hoisted(() => ({
  createGl: vi.fn(),
  releaseCache: vi.fn(),
}));
vi.mock("./create-engine", () => ({ createAppEngine: createGl }));
vi.mock("./resource-cache", () => ({ releaseResourceCacheForEngine: releaseCache }));
import { createEngineSession } from "./engine-session";
import { directViewPresentationAllowed } from "./direct-view-presentation";

describe("Engine session", () => {
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
    return {
      engine, canvases, released,
      options: {
        createCanvas: () => {
          const canvas = { width: 8, height: 8 } as HTMLCanvasElement;
          canvases.push(canvas);
          return canvas;
        },
        releaseCanvas: (canvas: HTMLCanvasElement) => { released.push(canvas); },
      },
    };
  }

  it("creates one Engine on its own canvas and releases the cache, the Engine and the canvas once", async () => {
    const h = host();
    const decoders = { ktx2BasePath: "/basis/" };
    const session = await createEngineSession({ ...h.options, decoders });
    expect(session.engine).toBe(h.engine);
    expect(createGl).toHaveBeenCalledWith(h.canvases[0], decoders);
    expect(h.canvases).toHaveLength(1);
    expect(h.released).toEqual([]);
    session.dispose();
    session.dispose();
    expect(h.released).toEqual(h.canvases);
    expect(releaseCache).toHaveBeenCalledTimes(1);
    expect(releaseCache).toHaveBeenCalledWith(h.engine);
    expect(h.engine.dispose).toHaveBeenCalledTimes(1);
  });

  it("lets views present directly only on a session that asks for it; others keep receiving copies", async () => {
    const plain = host();
    const copying = await createEngineSession(plain.options);
    const asking = host();
    const presenting = await createEngineSession({ ...asking.options, presentViewsDirectly: true });
    expect([directViewPresentationAllowed(copying.engine), directViewPresentationAllowed(presenting.engine)]).toEqual([false, true]);
  });

  it("allocates nothing for a request that was already cancelled", async () => {
    const h = host();
    const closed = new Error("Project closed");
    await expect(createEngineSession({ ...h.options, signal: AbortSignal.abort(closed) })).rejects.toBe(closed);
    expect(createGl).not.toHaveBeenCalled();
    expect(h.canvases).toEqual([]);
  });

  it("disposes the Engine and releases the canvas when the request is cancelled while the Engine starts", async () => {
    const h = host();
    const controller = new AbortController();
    const closed = new Error("Project closed");
    createGl.mockImplementation(() => {
      controller.abort(closed);
      return h.engine;
    });
    await expect(createEngineSession({ ...h.options, signal: controller.signal })).rejects.toBe(closed);
    expect(h.engine.isDisposed).toBe(true);
    expect(h.released).toEqual(h.canvases);
  });

  it("rejects a WebGL1 downgrade and releases the Engine and canvas", async () => {
    const h = host();
    h.engine.webGLVersion = 1;
    await expect(createEngineSession(h.options)).rejects.toThrow("WebGL2 is required");
    expect(h.engine.isDisposed).toBe(true);
    expect(h.released).toEqual(h.canvases);
  });

  it("releases the canvas when the Engine cannot start", async () => {
    const h = host();
    const failure = new Error("No graphics context");
    createGl.mockImplementation(() => { throw failure; });
    await expect(createEngineSession(h.options)).rejects.toBe(failure);
    expect(h.released).toEqual(h.canvases);
  });

  it("reports cleanup failures of a failed start together with its cause", async () => {
    const h = host();
    const controller = new AbortController();
    const disposeFailure = new Error("Context release failed");
    const canvasFailure = new Error("Canvas release failed");
    const superseded = new Error("Superseded");
    createGl.mockImplementation(() => {
      controller.abort(superseded);
      return h.engine;
    });
    h.engine.dispose.mockImplementation(() => { throw disposeFailure; });
    const operation = createEngineSession({
      ...h.options, signal: controller.signal,
      releaseCanvas: () => { throw canvasFailure; },
    });
    await expect(operation).rejects.toMatchObject({ errors: [superseded, disposeFailure, canvasFailure] });
    expect(h.canvases).toHaveLength(1);
  });
});
