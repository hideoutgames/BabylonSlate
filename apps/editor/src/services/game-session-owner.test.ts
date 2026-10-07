import { describe, expect, it, vi } from "vitest";
import { GameSessionOwner, type GameSessionStopResult } from "./game-session-owner";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// This is the actual admission/release authority; only the native release promise
// is controlled to reproduce teardown races without constructing a GPU context.
describe("game session ownership", () => {
  it("keeps every other mode out until actual release, and stops exactly once", async () => {
    const owner = new GameSessionOwner<GameSessionStopResult>();
    const release = deferred<{ quarantined: boolean }>();
    const ticket = owner.begin("play")!;
    const stop = vi.fn(() => ({ released: release.promise }));
    expect(owner.attach(ticket, stop)).toBe(true);
    const first = owner.stop(ticket);
    expect(owner.stop(ticket)).toBe(first);
    await first;
    expect(stop).toHaveBeenCalledOnce();
    expect(owner.begin("preview")).toBeNull();
    expect(owner.begin("simulate")).toBeNull();
    expect(owner.getSnapshot().lifecycle).toBe("stopping");
    release.resolve({ quarantined: false });
    await release.promise;
    expect(owner.begin("simulate")?.mode).toBe("simulate");
  });

  it("rejects stale preparation and leaves a later session untouched", async () => {
    const owner = new GameSessionOwner<GameSessionStopResult>();
    const pending = deferred<string>();
    const before = owner.begin("play")!;
    const prepared = owner.awaitCurrent(before, pending.promise);
    await owner.stop(before);
    const after = owner.begin("preview")!;
    pending.resolve("old scene");
    await expect(prepared).rejects.toMatchObject({ name: "AbortError" });
    expect(owner.attach(before, () => ({ released: Promise.resolve({ quarantined: false }) }))).toBe(false);
    await owner.stop(before);
    expect(owner.isCurrent(after)).toBe(true);
  });

  it.each(["quarantine", "reject", "stop throws"])("never admits a new owner after %s", async (failure) => {
    const owner = new GameSessionOwner<GameSessionStopResult>();
    const release = deferred<{ quarantined: boolean }>();
    const ticket = owner.begin("simulate")!;
    owner.attach(ticket, () => {
      if (failure === "stop throws") throw new Error("native detach failed");
      return { released: release.promise };
    });
    await owner.stop(ticket);
    if (failure === "quarantine") release.resolve({ quarantined: true });
    if (failure === "reject") release.reject(new Error("native detach rejected"));
    await Promise.resolve();
    expect(owner.getSnapshot()).toMatchObject({ lifecycle: "failure", quarantined: true });
    await owner.stop(ticket);
    expect(owner.begin("play")).toBeNull();
    expect(owner.begin("preview")).toBeNull();
  });

  it("permits a new preparation after a failure before native allocation", () => {
    const owner = new GameSessionOwner<GameSessionStopResult>();
    const ticket = owner.begin("play")!;
    owner.fail(ticket, new Error("scene compilation failed"));
    expect(ticket.signal.aborted).toBe(true);
    expect(owner.begin("preview")).not.toBeNull();
  });
});
