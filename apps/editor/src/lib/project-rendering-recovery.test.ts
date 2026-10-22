import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendEngineSession, BackendEngineSessionOptions, WebGpuDeviceLoss } from "@haptic/render";
const { createSession } = vi.hoisted(() => ({ createSession: vi.fn() }));
vi.mock("@haptic/render", () => ({ createBackendEngineSession: createSession }));
import { GameSessionOwner, type GameSessionMode, type GameSessionStopResult } from "../services/game-session-owner";
import { createProjectEngineController, type ProjectEngineRequest } from "./project-engine";
import { RenderingRetryError, retryProjectRendering, stopGameOnDeviceLoss } from "./project-rendering-recovery";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const request: ProjectEngineRequest = { projectGuid: "project", backend: "webgpu", prepare: async () => undefined };

// The real controller and session owner; only the GPU session and the game's
// native release are stand-ins.
describe("project rendering recovery", () => {
  const sessions: BackendEngineSession[] = [];
  let lose: (loss: WebGpuDeviceLoss) => void;
  beforeEach(() => {
    vi.resetAllMocks();
    createSession.mockImplementation(async (options: BackendEngineSessionOptions) => {
      const lost = deferred<WebGpuDeviceLoss>();
      lose = lost.resolve;
      const engine = { isDisposed: false };
      const session = {
        engine,
        requestedBackend: options.requestedBackend,
        effectiveBackend: "webgpu",
        deviceLost: lost.promise,
        dispose: vi.fn(() => { engine.isDisposed = true; }),
      } as unknown as BackendEngineSession;
      sessions.push(session);
      return session;
    });
  });
  afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose();
  });

  /** A running game whose stop reports `release` as its native release. */
  function running(owner: GameSessionOwner<GameSessionStopResult>, mode: GameSessionMode, release: Promise<{ quarantined: boolean }>) {
    const ticket = owner.begin(mode)!;
    const stop = vi.fn(() => ({ released: release }));
    owner.attach(ticket, stop);
    return stop;
  }

  it.each([["play", 1], ["simulate", 1], ["preview", 0]] as const)(
    "stops a %s session that renders on the project Engine when its device is lost",
    async (mode, stops) => {
      const engine = createProjectEngineController();
      const owner = new GameSessionOwner<GameSessionStopResult>();
      const unsubscribe = stopGameOnDeviceLoss(engine, owner);
      await engine.sync(request);
      const stop = running(owner, mode, Promise.resolve({ quarantined: false }));

      lose({ reason: "unknown", message: "Out of memory" });
      await vi.waitFor(() => expect(engine.getSnapshot().phase).toBe("failed"));
      await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(stops));
      // Preview Build renders on its own Engine and keeps running.
      await vi.waitFor(() => expect(owner.getSnapshot().lifecycle).toBe(stops ? "idle" : "running"));
      unsubscribe();
    },
  );

  it("discards Simulate's kept changes before stopping it, since their capture needs the lost Engine", async () => {
    const engine = createProjectEngineController();
    const owner = new GameSessionOwner<GameSessionStopResult>();
    // Keep Changes gates Stop on a final capture until the changes are discarded.
    const simulation = { keepChanges: true, discarded: null as string | null, discardChanges(reason?: string | null) { this.discarded = reason ?? ""; } };
    const log = vi.fn();
    const unsubscribe = stopGameOnDeviceLoss(engine, owner, { simulation: () => simulation, log });
    await engine.sync(request);
    const ticket = owner.begin("simulate")!;
    const stop = vi.fn(() => ({ released: Promise.resolve({ quarantined: false }) }));
    owner.attach(ticket, stop);
    owner.setBeforeStop(ticket, async () => simulation.discarded !== null);

    lose({ reason: "unknown", message: "Out of memory" });
    await vi.waitFor(() => expect(owner.getSnapshot().lifecycle).toBe("idle"));
    expect(stop).toHaveBeenCalledOnce();
    expect(simulation.discarded).toMatch(/graphics device was lost/);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Simulation changes were discarded/));
    unsubscribe();
  });

  it("asks the user to stop a running Preview Build before Retry instead of stopping it", async () => {
    const engine = createProjectEngineController();
    const owner = new GameSessionOwner<GameSessionStopResult>();
    await engine.sync(request);
    const stop = running(owner, "preview", Promise.resolve({ quarantined: false }));
    lose({ reason: "unknown", message: "Out of memory" });
    await vi.waitFor(() => expect(engine.getSnapshot().phase).toBe("failed"));

    const failure = await retryProjectRendering({ projectEngine: engine, sessionOwner: owner, request })
      .then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ retryable: true, message: expect.stringMatching(/Stop Preview Build, then choose Retry/) });
    expect(stop).not.toHaveBeenCalled();
    expect(owner.getSnapshot().lifecycle).toBe("running");
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("does not stop a game when the Engine is replaced for another reason", async () => {
    const engine = createProjectEngineController();
    const owner = new GameSessionOwner<GameSessionStopResult>();
    const unsubscribe = stopGameOnDeviceLoss(engine, owner);
    await engine.sync(request);
    const stop = running(owner, "play", Promise.resolve({ quarantined: false }));
    // Play's own WebGPU compatibility switch replaces the Engine while it prepares.
    await engine.sync({ ...request, prepare: async () => "Material uses Custom GLSL." }, true);
    expect(stop).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("waits for the stopped game to release the lost Engine, then replaces it", async () => {
    const engine = createProjectEngineController();
    const owner = new GameSessionOwner<GameSessionStopResult>();
    await engine.sync(request);
    const lostSession = engine.getSnapshot().session!;
    const release = deferred<{ quarantined: boolean }>();
    const stop = running(owner, "play", release.promise);
    lose({ reason: "unknown", message: "Out of memory" });
    await vi.waitFor(() => expect(engine.getSnapshot().phase).toBe("failed"));

    const retry = retryProjectRendering({ projectEngine: engine, sessionOwner: owner, request });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    expect(createSession).toHaveBeenCalledTimes(1);
    release.resolve({ quarantined: false });
    await retry;
    expect(lostSession.engine.isDisposed).toBe(true);
    expect(engine.getSnapshot().phase).toBe("ready");
    expect(engine.getSnapshot().session).not.toBe(lostSession);
    expect(owner.canStart()).toBe(true);
  });

  it.each([
    ["never confirms its release", Promise.resolve({ quarantined: true }), false, /reload the editor/],
    ["is still releasing after the wait", new Promise<{ quarantined: boolean }>(() => {}), true, /still releasing/],
  ] as const)("reports a Retry whose game %s and allocates nothing", async (_case, release, retryable, message) => {
    const engine = createProjectEngineController();
    const owner = new GameSessionOwner<GameSessionStopResult>();
    await engine.sync(request);
    running(owner, "play", release);
    lose({ reason: "unknown", message: "Out of memory" });
    await vi.waitFor(() => expect(engine.getSnapshot().phase).toBe("failed"));

    const failure = await retryProjectRendering({ projectEngine: engine, sessionOwner: owner, request, releaseWaitMs: 20 })
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(RenderingRetryError);
    expect(failure).toMatchObject({ retryable, message: expect.stringMatching(message) });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(engine.getSnapshot()).toMatchObject({ phase: "failed", session: null });
  });
});
