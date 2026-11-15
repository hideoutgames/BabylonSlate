import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineSession } from "@haptic/render";
const { createSession } = vi.hoisted(() => ({ createSession: vi.fn() }));
vi.mock("@haptic/render", () => ({ createEngineSession: createSession }));
import { GameSessionOwner, type GameSessionMode, type GameSessionStopResult } from "../services/game-session-owner";
import { createProjectEngineController, type ProjectEngineRequest } from "./project-engine";
import { RenderingRetryError, retryProjectRendering } from "./project-rendering-recovery";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const request: ProjectEngineRequest = { projectGuid: "project", prepare: async () => {} };

// The real controller and session owner; only the GPU session and the game's
// native release are stand-ins.
describe("project rendering recovery", () => {
  const sessions: EngineSession[] = [];
  beforeEach(() => {
    vi.resetAllMocks();
    createSession.mockImplementation(async () => {
      const engine = { isDisposed: false };
      const session = {
        engine,
        dispose: vi.fn(() => { engine.isDisposed = true; }),
      } as unknown as EngineSession;
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

  it("asks the user to stop a running Preview Build before Retry instead of stopping it", async () => {
    const engine = createProjectEngineController();
    const owner = new GameSessionOwner<GameSessionStopResult>();
    await engine.sync(request);
    const stop = running(owner, "preview", Promise.resolve({ quarantined: false }));

    const failure = await retryProjectRendering({ projectEngine: engine, sessionOwner: owner, request })
      .then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ retryable: true, message: expect.stringMatching(/Stop Preview Build, then choose Retry/) });
    expect(stop).not.toHaveBeenCalled();
    expect(owner.getSnapshot().lifecycle).toBe("running");
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("waits for the stopped game to release the Engine, then replaces it", async () => {
    const engine = createProjectEngineController();
    const owner = new GameSessionOwner<GameSessionStopResult>();
    await engine.sync(request);
    const previous = engine.getSnapshot().session!;
    const release = deferred<{ quarantined: boolean }>();
    const stop = running(owner, "play", release.promise);

    const retry = retryProjectRendering({ projectEngine: engine, sessionOwner: owner, request });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    expect(createSession).toHaveBeenCalledTimes(1);
    release.resolve({ quarantined: false });
    await retry;
    expect(previous.engine.isDisposed).toBe(true);
    expect(engine.getSnapshot().phase).toBe("ready");
    expect(engine.getSnapshot().session).not.toBe(previous);
    expect(owner.canStart()).toBe(true);
  });

  it.each([
    ["never confirms its release", Promise.resolve({ quarantined: true }), false, /reload the editor/],
    ["is still releasing after the wait", new Promise<{ quarantined: boolean }>(() => {}), true, /still releasing/],
  ] as const)("reports a Retry whose game %s and allocates nothing", async (_case, release, retryable, message) => {
    const engine = createProjectEngineController();
    const owner = new GameSessionOwner<GameSessionStopResult>();
    await engine.sync(request);
    const session = engine.getSnapshot().session;
    running(owner, "play", release);

    const failure = await retryProjectRendering({ projectEngine: engine, sessionOwner: owner, request, releaseWaitMs: 20 })
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(RenderingRetryError);
    expect(failure).toMatchObject({ retryable, message: expect.stringMatching(message) });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(engine.getSnapshot()).toMatchObject({ phase: "ready", session });
  });
});
