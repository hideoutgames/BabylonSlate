import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendEngineSession, BackendEngineSessionOptions } from "@babylonslate/render";
const { createSession } = vi.hoisted(() => ({ createSession: vi.fn() }));
vi.mock("@babylonslate/render", () => ({ createBackendEngineSession: createSession }));
import { createProjectEngineController, createProjectEngineSession, type ProjectEngineRequest } from "./project-engine";

function request(backend: ProjectEngineRequest["backend"] = "webgl2"): ProjectEngineRequest {
  return { projectGuid: "project", backend, prepare: async () => undefined };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("project Engine transitions", () => {
  const sessions: BackendEngineSession[] = [];
  beforeEach(() => {
    vi.resetAllMocks();
    createSession.mockImplementation(async (options: BackendEngineSessionOptions) => {
      const canvas = options.createCanvas();
      canvas.style.display = "block";
      const engine = { isDisposed: false };
      const session = {
        engine,
        requestedBackend: options.requestedBackend,
        effectiveBackend: options.requestedBackend === "webgpu" ? "webgpu" : "webgl2",
        dispose: vi.fn(() => { engine.isDisposed = true; options.releaseCanvas(canvas); }),
      } as unknown as BackendEngineSession;
      sessions.push(session);
      return session;
    });
  });
  afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose();
    document.body.replaceChildren();
  });

  it("keeps the constructor canvas hidden after async initialization and releases it on close", async () => {
    const session = await createProjectEngineSession("webgpu", new AbortController().signal);
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="project-engine-canvas"]')!;
    expect(canvas.isConnected).toBe(true);
    expect(canvas.style.display).toBe("none");
    session.dispose();
    expect(canvas.isConnected).toBe(false);
  });

  it("reuses a live session and does not allocate for a closed project", async () => {
    const host = createProjectEngineController();
    await host.sync(null);
    expect(createSession).not.toHaveBeenCalled();
    await host.sync(request());
    const first = host.getSnapshot().session;
    await host.sync(request());
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(host.getSnapshot().session).toBe(first);
    await host.sync(null);
    expect(first?.engine.isDisposed).toBe(true);
    expect(host.getSnapshot()).toEqual({ phase: "idle", session: null });
  });

  it("detaches clients before preparation and releases the old Engine before allocating its replacement", async () => {
    const host = createProjectEngineController();
    await host.sync(request());
    const first = host.getSnapshot().session!;
    const paint = deferred<string | undefined>();
    const next = host.sync({ ...request("webgpu"), prepare: () => paint.promise });
    expect(host.getSnapshot()).toEqual({ phase: "preparing", session: null });
    expect(first.engine.isDisposed).toBe(false);
    expect(createSession).toHaveBeenCalledTimes(1);
    const factory = createSession.getMockImplementation()!;
    createSession.mockImplementationOnce((options) => {
      expect(first.engine.isDisposed).toBe(true);
      return factory(options);
    });
    paint.resolve(undefined);
    await next;
    expect(host.getSnapshot().session?.effectiveBackend).toBe("webgpu");
    expect(document.querySelectorAll('[data-testid="project-engine-canvas"]')).toHaveLength(1);
    await host.sync(null);
  });

  it("waits for uncancellable initialization and disposes its stale result before the latest request", async () => {
    const host = createProjectEngineController();
    const device = deferred<BackendEngineSession>();
    const first = { engine: { isDisposed: false }, dispose: vi.fn() } as unknown as BackendEngineSession;
    createSession.mockImplementationOnce(() => device.promise);
    const published: Array<BackendEngineSession | null> = [];
    const unsubscribe = host.subscribe(() => published.push(host.getSnapshot().session));
    const old = host.sync(request("webgpu"));
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    const latest = host.sync(request("webgl2"));
    expect(createSession).toHaveBeenCalledTimes(1);
    const factory = createSession.getMockImplementation()!;
    createSession.mockImplementationOnce((options) => {
      expect(first.dispose).toHaveBeenCalledTimes(1);
      return factory(options);
    });
    device.resolve(first);
    await Promise.all([old, latest]);
    expect(published).not.toContain(first);
    expect(host.getSnapshot().session?.effectiveBackend).toBe("webgl2");
    unsubscribe();
    await host.sync(null);
  });

  it("keeps failed initialization unready and retries explicitly", async () => {
    const host = createProjectEngineController();
    const failure = new Error("Initialization failed");
    createSession.mockRejectedValueOnce(failure);
    await host.sync(request());
    expect(host.getSnapshot()).toEqual({ phase: "failed", session: null, error: failure });
    await host.sync(request());
    expect(createSession).toHaveBeenCalledTimes(1);
    await host.sync(request(), true);
    expect(host.getSnapshot().phase).toBe("ready");
    await host.sync(null);
  });

  it("closes during preparation without creating an Engine and permits a later project", async () => {
    const host = createProjectEngineController();
    const paint = deferred<string | undefined>();
    const pending = host.sync({ ...request(), prepare: () => paint.promise });
    await Promise.resolve();
    const closed = host.sync(null);
    paint.resolve(undefined);
    await Promise.all([pending, closed]);
    expect(createSession).not.toHaveBeenCalled();
    await host.sync({ ...request(), projectGuid: "next-project" });
    expect(host.getSnapshot().phase).toBe("ready");
    await host.sync(null);
  });
});
