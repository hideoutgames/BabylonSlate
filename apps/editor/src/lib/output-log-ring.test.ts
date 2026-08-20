import { describe, expect, it } from "vitest";
import {
  appendOutputLogLine,
  OUTPUT_LOG_RING_CAP,
} from "./output-log-ring";

describe("appendOutputLogLine", () => {
  it("keeps at most 500 lines and drops the oldest when the ring is full", () => {
    const full = Array.from(
      { length: OUTPUT_LOG_RING_CAP },
      (_, i) => `line ${i}`,
    );
    const next = appendOutputLogLine(full, "line newest");
    expect(next).toHaveLength(500);
    expect(next[0]).toBe("line 1");
    expect(next[499]).toBe("line newest");
  });
});
