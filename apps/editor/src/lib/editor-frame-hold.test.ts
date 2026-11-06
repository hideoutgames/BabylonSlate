import { describe, expect, it } from "vitest";
import { subscribeEditorViewportFrameHold, withEditorViewportFramesHeld } from "./editor-frame-hold";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("editor viewport frame hold", () => {
  it("stays held until the last overlapping hold settles, whether each resolves or rejects", async () => {
    const first = deferred();
    const second = deferred();
    const firstHold = withEditorViewportFramesHeld(() => first.promise);
    const seen: boolean[] = [];
    // A registry mounted during a hold starts held.
    const unsubscribe = subscribeEditorViewportFrameHold((held) => seen.push(held));
    try {
      const secondHold = withEditorViewportFramesHeld(() => second.promise);
      first.resolve();
      await firstHold;
      expect(seen).toEqual([true]);
      second.reject(new Error("Storage unavailable"));
      await expect(secondHold).rejects.toThrow("Storage unavailable");
      expect(seen).toEqual([true, false]);
    } finally {
      unsubscribe();
    }
  });
});
