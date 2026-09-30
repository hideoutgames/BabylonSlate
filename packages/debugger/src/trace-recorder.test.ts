import { describe, expect, it } from "vitest";
import { TraceRecorder, type TraceFrame } from "./trace-recorder";

function frame(tickIndex: number, snapshotText?: string): TraceFrame {
  return {
    tickIndex,
    scriptMs: 0,
    physicsMs: 0,
    logs: [],
    prints: [],
    ...(snapshotText === undefined ? {} : { snapshotText }),
  };
}

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

  it("retains a multi-megabyte recording with the default budget", () => {
    const recorder = new TraceRecorder();
    recorder.start({ seed: 7, dt: 1 / 60 });
    const snapshotText = "x".repeat(512 * 1024);
    for (let tick = 1; tick <= 16; tick++) {
      recorder.recordFrame(frame(tick, snapshotText));
    }
    const payload = recorder.stop()!;
    expect(payload.frames).toHaveLength(16);
    expect(payload.frames[0]?.tickIndex).toBe(1);
    expect(payload.frames.at(-1)?.snapshotText).toBe(snapshotText);
  });

  it.each([
    { byteBudget: 158, retained: [2, 3] },
    { byteBudget: 157, retained: [3] },
  ])(
    "evicts oldest frames at the $byteBudget-byte boundary and resets between recordings",
    ({ byteBudget, retained }) => {
      const recorder = new TraceRecorder({ byteBudget });
      // The empty payload is 29 bytes; each frame is 64 bytes plus separating commas.
      for (let recording = 0; recording < 2; recording++) {
        recorder.start({ seed: 7, dt: 1 });
        for (let tick = 1; tick <= 3; tick++) recorder.recordFrame(frame(tick));
        const payload = recorder.stop()!;
        expect(payload.frames.map((entry) => entry.tickIndex)).toEqual(retained);
        expect(
          new TextEncoder().encode(JSON.stringify(payload)).byteLength,
        ).toBeLessThanOrEqual(byteBudget);
      }
    },
  );

  it("accounts for UTF-8 snapshot bytes rather than JavaScript string length", () => {
    const recorder = new TraceRecorder({ byteBudget: 300 });
    recorder.start({ seed: 7, dt: 1 });
    recorder.recordFrame(frame(1, "\u{1F600}".repeat(20)));
    recorder.recordFrame(frame(2, "\u{1F600}".repeat(20)));
    expect(recorder.stop()?.frames.map((entry) => entry.tickIndex)).toEqual([2]);
  });

  it("keeps the newest oversized frame and resumes normal retention afterward", () => {
    const recorder = new TraceRecorder({ byteBudget: 158 });
    recorder.start({ seed: 7, dt: 1 });
    recorder.recordFrame(frame(1, "x".repeat(1024)));
    expect(recorder.stop()?.frames.map((entry) => entry.tickIndex)).toEqual([1]);

    recorder.start({ seed: 7, dt: 1 });
    recorder.recordFrame(frame(1, "x".repeat(1024)));
    recorder.recordFrame(frame(2));
    recorder.recordFrame(frame(3));
    expect(recorder.stop()?.frames.map((entry) => entry.tickIndex)).toEqual([2, 3]);
  });
});
