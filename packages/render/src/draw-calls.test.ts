import { describe, expect, it } from "vitest";
import {
  beginEngineDrawCallFrame,
  readEngineDrawCalls,
} from "./draw-calls";

describe("readEngineDrawCalls", () => {
  it("reads Babylon _drawCalls.current when engine.drawCalls is unset", () => {
    // Babylon 9 has no public drawCalls number; Play used to return 0 via `?? 0`.
    expect(
      readEngineDrawCalls({
        _drawCalls: { current: 3 },
      }),
    ).toBe(3);
  });

  it("returns 0 when neither counter is present", () => {
    expect(readEngineDrawCalls({})).toBe(0);
  });

  it("prefers the PerfCounter over a stale drawCalls field", () => {
    expect(
      readEngineDrawCalls({
        drawCalls: 0,
        _drawCalls: { current: 5 },
      }),
    ).toBe(5);
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
