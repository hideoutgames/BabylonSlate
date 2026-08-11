import { describe, expect, it } from "vitest";
import {
  isEncodeQueuePauseRequested,
  onEncodeQueuePause,
  setEncodeQueuePauseReason,
} from "./encode-queue-pause";

describe("encode queue pause reasons", () => {
  it("stays paused while any reason remains", () => {
    const seen: boolean[] = [];
    const unsub = onEncodeQueuePause((paused) => seen.push(paused));
    setEncodeQueuePauseReason("visibility", true);
    setEncodeQueuePauseReason("play", true);
    expect(isEncodeQueuePauseRequested()).toBe(true);
    setEncodeQueuePauseReason("play", false);
    expect(isEncodeQueuePauseRequested()).toBe(true);
    setEncodeQueuePauseReason("visibility", false);
    expect(isEncodeQueuePauseRequested()).toBe(false);
    unsub();
    expect(seen.includes(true)).toBe(true);
    expect(seen.at(-1)).toBe(false);
  });
});
