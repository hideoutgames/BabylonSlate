import { describe, expect, it } from "vitest";
import {
  holdEncodeQueuePause,
  onEncodeQueuePause,
  setEncodeQueuePauseReason,
} from "./encode-queue-pause";

describe("encode queue pause reasons", () => {
  it("stays paused while any reason remains", () => {
    const seen: boolean[] = [];
    const unsub = onEncodeQueuePause((paused) => seen.push(paused));
    setEncodeQueuePauseReason("visibility", true);
    setEncodeQueuePauseReason("play", true);
    expect(seen.at(-1)).toBe(true);
    setEncodeQueuePauseReason("play", false);
    expect(seen.at(-1)).toBe(true);
    setEncodeQueuePauseReason("visibility", false);
    expect(seen.at(-1)).toBe(false);
    unsub();
  });

  it("keeps overlapping holds of one reason, and reasons, paused until each ends", () => {
    const seen: boolean[] = [];
    const unsub = onEncodeQueuePause((paused) => seen.push(paused));
    const first = holdEncodeQueuePause("scene-load");
    const second = holdEncodeQueuePause("scene-load");
    setEncodeQueuePauseReason("play", true);
    first();
    first();
    expect(seen.at(-1)).toBe(true);
    setEncodeQueuePauseReason("play", false);
    expect(seen.at(-1)).toBe(true);
    second();
    expect(seen.at(-1)).toBe(false);
    // A release that already ran changes nothing later.
    const count = seen.length;
    second();
    expect(seen).toHaveLength(count);
    unsub();
  });
});
