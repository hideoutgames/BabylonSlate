import { describe, expect, it } from "vitest";
import { TraceRecorder } from "./trace-recorder";

describe("TraceRecorder", () => {
  it("captures seed, input, stats, logs and snapshots while recording", () => {
    const recorder = new TraceRecorder({ byteBudget: 64 * 1024 });
    recorder.start({ seed: 7, dt: 1 / 60 });
    recorder.recordFrame({
      tickIndex: 1,
      scriptMs: 1.5,
      physicsMs: 0.5,
      logs: [{ severity: "log", category: "game", message: "tick" }],
      prints: [],
      snapshotText: "tick=1",
      inputEvents: [{ type: "key", code: "KeyW", down: true, tick: 1 }],
      bt: [
        {
          slotId: 0,
          status: "running",
          btNodeId: "wait",
          lastResults: { wait: "running" },
          blackboard: { alert: false },
          stack: [{ nodeId: "wait", childIndex: 0, opened: true }],
        },
      ],
    });
    const payload = recorder.stop();
    expect(payload).not.toBeNull();
    expect(payload!.seed).toBe(7);
    expect(payload!.dt).toBeCloseTo(1 / 60);
    expect(payload!.frames).toHaveLength(1);
    expect(payload!.frames[0]?.snapshotText).toBe("tick=1");
    expect(payload!.frames[0]?.inputEvents?.[0]).toMatchObject({ code: "KeyW" });
    expect(payload!.frames[0]?.bt?.[0]).toMatchObject({
      btNodeId: "wait",
      blackboard: { alert: false },
    });
  });

  it("is a no-op when not recording", () => {
    const recorder = new TraceRecorder();
    recorder.recordFrame({
      tickIndex: 0,
      scriptMs: 0,
      physicsMs: 0,
      logs: [],
      prints: [],
    });
    expect(recorder.stop()).toBeNull();
  });
});
