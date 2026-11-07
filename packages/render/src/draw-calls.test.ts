import { describe, expect, it } from "vitest";
import {
  beginEngineDrawCallFrame,
  readEngineDrawCalls,
} from "./draw-calls";

describe("readEngineDrawCalls", () => {
  it("reads Babylon _drawCalls.current", () => {
    expect(
      readEngineDrawCalls({
        _drawCalls: { current: 3 },
      }),
    ).toBe(3);
  });

  it("returns 0 when the counter is absent", () => {
    expect(readEngineDrawCalls({})).toBe(0);
  });
});

describe("beginEngineDrawCallFrame", () => {
  it("resets the PerfCounter so the next frame is not cumulative", () => {
    const engine = {
      _drawCalls: {
        current: 7,
        fetchNewFrame() {
          this.current = 0;
        },
      },
    };
    beginEngineDrawCallFrame(engine);
    expect(engine._drawCalls.current).toBe(0);
  });
});
