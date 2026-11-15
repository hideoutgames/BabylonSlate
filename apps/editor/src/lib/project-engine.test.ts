import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineSession, EngineSessionOptions } from "@haptic/render";
const { createSession } = vi.hoisted(() => ({ createSession: vi.fn() }));
vi.mock("@haptic/render", () => ({ createEngineSession: createSession }));
import { createProjectEngineController, createProjectEngineSession, type ProjectEngineRequest } from "./project-engine";

function request(projectGuid = "project"): ProjectEngineRequest {
  return { projectGuid, prepare: async () => {} };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("project Engine transitions", () => {
  const sessions: EngineSession[] = [];
  beforeEach(() => {
    vi.resetAllMocks();
    createSession.mockImplementation(async (options: EngineSessionOptions) => {
      const canvas = options.createCanvas();
      canvas.style.display = "block";
      const engine = { isDisposed: false };
      const session = {
        engine,
        dispose: vi.fn(() => { engine.isDisposed = true; options.releaseCanvas(canvas); }),
      } as unknown as EngineSession;
      sessions.push(session);
      return session;
    });
  });
  afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose();
    document.body.replaceChildren();
  });

  it("keeps the constructor canvas hidden after async initialization and releases it on close", async () => {
    const session = await createProjectEngineSession(new AbortController().signal);
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
    const paint = deferred<void>();
    const next = host.sync({ ...request("next-project"), prepare: () => paint.promise });
    expect(host.getSnapshot()).toEqual({ phase: "preparing", session: null });
    expect(first.engine.isDisposed).toBe(false);
    expect(createSession).toHaveBeenCalledTimes(1);
    const factory = createSession.getMockImplementation()!;
    createSession.mockImplementationOnce((options) => {
      expect(first.engine.isDisposed).toBe(true);
      return factory(options);
    });
    paint.resolve();
    await next;
    expect(host.getSnapshot().phase).toBe("ready");
    expect(host.getSnapshot().session).not.toBe(first);
    expect(document.querySelectorAll('[data-testid="project-engine-canvas"]')).toHaveLength(1);
    await host.sync(null);
  });

  it("waits for uncancellable initialization and disposes its stale result before the latest request", async () => {
    const host = createProjectEngineController();
    const device = deferred<EngineSession>();
    const first = { engine: { isDisposed: false }, dispose: vi.fn() } as unknown as EngineSession;
    createSession.mockImplementationOnce(() => device.promise);
    const published: Array<EngineSession | null> = [];
    const unsubscribe = host.subscribe(() => published.push(host.getSnapshot().session));
    const old = host.sync(request("first-project"));
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    const latest = host.sync(request("second-project"));
    expect(createSession).toHaveBeenCalledTimes(1);
    const factory = createSession.getMockImplementation()!;
    createSession.mockImplementationOnce((options) => {
      expect(first.dispose).toHaveBeenCalledTimes(1);
      return factory(options);
    });
    device.resolve(first);
    await Promise.all([old, latest]);
    expect(published).not.toContain(first);
    expect(host.getSnapshot().phase).toBe("ready");
    expect(host.getSnapshot().session).toBe(sessions.at(-1));
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
    const paint = deferred<void>();
    const pending = host.sync({ ...request(), prepare: () => paint.promise });
    await Promise.resolve();
    const closed = host.sync(null);
    paint.resolve();
    await Promise.all([pending, closed]);
    expect(createSession).not.toHaveBeenCalled();
    await host.sync({ ...request(), projectGuid: "next-project" });
    expect(host.getSnapshot().phase).toBe("ready");
    await host.sync(null);
  });

  it("quarantines failed outgoing cleanup across Retry and project reopen", async () => {
    const host = createProjectEngineController();
    await host.sync(request());
    const outgoing = host.getSnapshot().session!;
    const dispose = vi.mocked(outgoing.dispose);
    dispose.mockImplementationOnce(() => { throw new Error("Engine cleanup failed"); });
    await host.sync(request("next-project"));
    expect(host.getSnapshot()).toMatchObject({ phase: "failed", session: null, retryable: false });
    await host.sync(request("next-project"), true);
    await host.sync(null);
    await host.sync({ ...request(), projectGuid: "another-project" });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(host.getSnapshot().error).toBeInstanceOf(Error);
  });

  it("does not allocate after stale initialization cleanup or factory cleanup fails", async () => {
    const host = createProjectEngineController();
    const device = deferred<EngineSession>();
    createSession.mockImplementationOnce(() => device.promise);
    const old = host.sync(request("first-project"));
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    const next = host.sync(request());
    device.resolve({ dispose: () => { throw new Error("Stale Engine cleanup failed"); } } as unknown as EngineSession);
    await Promise.all([old, next]);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(host.getSnapshot()).toMatchObject({ phase: "failed", retryable: false });

    const failedFactory = createProjectEngineController();
    createSession.mockRejectedValueOnce(new AggregateError([new Error("Partial context cleanup failed")]));
    await failedFactory.sync(request());
    await failedFactory.sync(request(), true);
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(failedFactory.getSnapshot()).toMatchObject({ phase: "failed", retryable: false });
  });
});
