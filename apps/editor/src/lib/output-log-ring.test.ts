import { describe, expect, it } from "vitest";
import {
  appendOutputLogLines,
  OUTPUT_LOG_RING_CAP,
} from "./output-log-ring";

describe("appendOutputLogLines", () => {
  const full = Array.from(
    { length: OUTPUT_LOG_RING_CAP },
    (_, i) => `line ${i}`,
  );

  it("keeps at most 500 lines and drops the oldest when the ring is full", () => {
    const next = appendOutputLogLines(full, ["line newest"]);
    expect(next).toHaveLength(500);
    expect(next[0]).toBe("line 1");
    expect(next[499]).toBe("line newest");
  });

  it("appends a batch in arrival order and drops as many of the oldest lines", () => {
    const next = appendOutputLogLines(full, ["first", "second"]);
    expect(next).toHaveLength(500);
    expect(next[0]).toBe("line 2");
    expect(next.slice(-2)).toEqual(["first", "second"]);
  });

  it("keeps only the newest lines of a batch larger than the ring", () => {
    const batch = Array.from({ length: OUTPUT_LOG_RING_CAP + 3 }, (_, i) => `batch ${i}`);
    const next = appendOutputLogLines(["old"], batch);
    expect(next).toEqual(batch.slice(3));
  });
});
