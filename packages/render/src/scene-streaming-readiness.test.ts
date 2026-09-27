import { describe, expect, it, vi } from "vitest";
import { createSceneStreamingReadiness } from "./scene-streaming-readiness";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  const batches = new Map<number, ReturnType<typeof deferred>>();
  const signals = new Map<number, AbortSignal>();
  const onReady = vi.fn();
  const onFailed = vi.fn();
  const onProgress = vi.fn();
  const readiness = createSceneStreamingReadiness({
    handle: { prepareSceneStream: async (slots, signal, progress) => {
      const batch = deferred(); batches.set(slots[0]!, batch); signals.set(slots[0]!, signal);
      progress?.(0.75);
      await batch.promise;
    } }, onReady, onFailed, onProgress,
  });
  const receive = (type: string, actorGuid: string, streamLoadId: number, slotIds?: number[]) =>
    readiness.receive({ type, actorGuid, streamLoadId, slotIds });
  return { batches, signals, onReady, onFailed, onProgress, readiness, receive };
}

describe("additive scene readiness", () => {
  it("acknowledges each complete batch independently and never an incomplete assignment batch", async () => {
    const f = fixture();
    f.receive("sceneStreamLoading", "left", 1);
    f.receive("sceneStreamLoading", "right", 2);
    expect(f.batches.size).toBe(0);
    f.receive("sceneStreamRealized", "left", 1, [10]);
    f.receive("sceneStreamRealized", "right", 2, [20]);
    f.receive("sceneStreamRealized", "right", 2, [20]);
    f.batches.get(20)!.resolve();
    await vi.waitFor(() => expect(f.onReady).toHaveBeenCalledTimes(1));
    expect(f.onReady).toHaveBeenCalledWith(expect.objectContaining({ actorGuid: "right", streamLoadId: 2 }));
    expect(f.onProgress).toHaveBeenCalledWith(expect.objectContaining({ actorGuid: "left" }), 0.75);
    f.batches.get(10)!.resolve();
    await vi.waitFor(() => expect(f.onReady).toHaveBeenCalledTimes(2));
    f.readiness.dispose();
  });

  it("unloading and reloading ignores late success or failure from an obsolete instance", async () => {
    const f = fixture();
    f.receive("sceneStreamLoading", "left", 1);
    f.receive("sceneStreamRealized", "left", 1, [10]);
    f.receive("sceneStreamRemoved", "left", 1);
    expect(f.signals.get(10)!.aborted).toBe(true);
    f.receive("sceneStreamLoading", "left", 2);
    f.receive("sceneStreamRealized", "left", 1, [30]);
    f.receive("sceneStreamRealized", "left", 2, [20]);
    f.receive("sceneStreamRemoved", "left", 1);
    expect(f.signals.get(20)!.aborted).toBe(false);
    f.batches.get(10)!.reject(new Error("old asset failed"));
    f.batches.get(20)!.resolve();
    await vi.waitFor(() => expect(f.onReady).toHaveBeenCalledTimes(1));
    expect(f.onReady).toHaveBeenCalledWith(expect.objectContaining({ actorGuid: "left", streamLoadId: 2 }));
    expect(f.onFailed).not.toHaveBeenCalled();
    f.readiness.dispose();
  });

  it("reports resource failure without ready and cancels pending work on scene replacement or teardown", async () => {
    const f = fixture();
    for (const [actor, id] of [["left", 1], ["right", 2]] as const) {
      f.receive("sceneStreamLoading", actor, id);
      f.receive("sceneStreamRealized", actor, id, [id]);
    }
    const failure = new Error("model missing");
    f.batches.get(1)!.reject(failure);
    await vi.waitFor(() => expect(f.onFailed).toHaveBeenCalledWith(expect.objectContaining({ actorGuid: "left" }), failure));
    f.readiness.receive({ type: "sceneLoading" });
    expect(f.signals.get(2)!.aborted).toBe(true);
    f.batches.get(2)!.resolve();
    f.readiness.dispose();
    f.receive("sceneStreamLoading", "after-stop", 3);
    f.receive("sceneStreamRealized", "after-stop", 3, [3]);
    await Promise.resolve();
    expect(f.onReady).not.toHaveBeenCalled();
    expect(f.batches.has(3)).toBe(false);
  });
});
