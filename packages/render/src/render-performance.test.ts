import { describe, expect, it } from "vitest";
import { RenderPerformanceFeed, type RenderPerformanceSample } from "./render-performance";

const frame = { frameId: 10, tickId: 5, sceneGeneration: 2, preparationMs: 1,
  submissionMs: 3, drawCalls: 4, width: 640, height: 480, resolutionScale: 1, loading: false };

describe("coherent render performance feed", () => {
  it("collects only explicit subscriptions and acknowledges each copied candidate once", () => {
    const feed = new RenderPerformanceFeed();
    expect(feed.begin(frame)).toBeNull();
    const samples: RenderPerformanceSample[] = [];
    const release = feed.subscribe((sample) => samples.push(sample));
    const receipt = feed.begin(frame)!;
    expect(samples).toEqual([]);
    feed.complete(receipt, 2, 20, 2);
    feed.complete(receipt, 2, 30, 2);
    expect(samples).toEqual([{ ...frame, copyMs: 2, completedAtMs: 20 }]);
    release();
    expect(feed.active).toBe(false);
  });

  it("rejects stale copy completions after replacement, unsubscribe and disposal", () => {
    const feed = new RenderPerformanceFeed();
    const samples: RenderPerformanceSample[] = [];
    const release = feed.subscribe((sample) => samples.push(sample));
    expect(() => feed.subscribe(() => {})).toThrow("already active");
    const oldScene = feed.begin(frame)!;
    feed.complete(oldScene, 1, 30, 3);
    const oldLease = feed.begin(frame)!;
    release();
    feed.subscribe((sample) => samples.push(sample));
    feed.complete(oldLease, 1, 40, 2);
    const disposed = feed.begin(frame)!;
    feed.dispose();
    feed.complete(disposed, 1, 50, 2);
    expect(samples).toEqual([]);
    expect(() => feed.subscribe(() => {})).toThrow("disposed");
  });
});
