import { describe, expect, it } from "vitest";
import {
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
});
