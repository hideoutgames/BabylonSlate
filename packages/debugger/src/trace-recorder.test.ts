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
    expect(payload!.retention).toEqual({
      byteBudget: 64 * 1024, droppedFrames: 0, complete: true, stopReason: "requested",
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
    { byteBudget: 270, retained: [2, 3] },
    { byteBudget: 269, retained: [3] },
  ])(
    "evicts oldest frames at the $byteBudget-byte boundary and resets between recordings",
    ({ byteBudget, retained }) => {
      const recorder = new TraceRecorder({ byteBudget });
      // Terminal metadata reserves 141 bytes; two 64-byte frames plus their comma fit at 270.
      for (let recording = 0; recording < 2; recording++) {
        recorder.start({ seed: 7, dt: 1 });
        for (let tick = 1; tick <= 3; tick++) recorder.recordFrame(frame(tick));
        const payload = recorder.stop()!;
        expect(payload.frames.map((entry) => entry.tickIndex)).toEqual(retained);
        expect(payload.retention).toEqual({
          byteBudget, droppedFrames: 3 - retained.length, complete: false, stopReason: "requested",
        });
        expect(
          new TextEncoder().encode(JSON.stringify(payload)).byteLength,
        ).toBeLessThanOrEqual(byteBudget);
      }
    },
  );

  it("accounts for UTF-8 snapshot bytes rather than JavaScript string length", () => {
    const recorder = new TraceRecorder({ byteBudget: 400 });
    recorder.start({ seed: 7, dt: 1 });
    recorder.recordFrame(frame(1, "\u{1F600}".repeat(20)));
    recorder.recordFrame(frame(2, "\u{1F600}".repeat(20)));
    expect(recorder.stop()?.frames.map((entry) => entry.tickIndex)).toEqual([2]);
  });

  it("stops before an oversized frame can evict complete frames or exceed the retained budget", () => {
    const recorder = new TraceRecorder({ byteBudget: 270 });
    recorder.start({ seed: 7, dt: 1 });
    for (let tick = 1; tick <= 3; tick++) recorder.recordFrame(frame(tick));
    recorder.recordFrame(frame(4, "x".repeat(1024)));
    expect(recorder.isRecording).toBe(false);
    recorder.recordFrame(frame(5));
    const payload = recorder.stop("session-ended")!;
    expect(payload.frames.map((entry) => entry.tickIndex)).toEqual([2, 3]);
    expect(payload.retention).toEqual({
      byteBudget: 270, droppedFrames: 2, complete: false, stopReason: "oversized-frame",
    });
    expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeLessThanOrEqual(270);
    expect(recorder.stop()).toBeNull();

    recorder.start({ seed: 7, dt: 1 });
    recorder.recordFrame(frame(1));
    const restarted = recorder.stop()!;
    expect(restarted.frames.map((entry) => entry.tickIndex)).toEqual([1]);
    expect(restarted.retention).toEqual({
      byteBudget: 270, droppedFrames: 0, complete: true, stopReason: "requested",
    });
  });

  it("reports an oversized first frame without retaining a truncated frame", () => {
    const recorder = new TraceRecorder({ byteBudget: 270 });
    recorder.start({ seed: 7, dt: 1 });
    recorder.recordFrame(frame(1, "x".repeat(1024)));
    const payload = recorder.stop()!;
    expect(payload.frames).toEqual([]);
    expect(payload.retention).toEqual({
      byteBudget: 270, droppedFrames: 1, complete: false, stopReason: "oversized-frame",
    });
    expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeLessThanOrEqual(270);
  });

  it("rejects a budget too small to report a complete recording outcome", () => {
    const recorder = new TraceRecorder({ byteBudget: 1 });
    expect(() => recorder.start({ seed: 7, dt: 1 })).toThrow(/metadata/);
    expect(recorder.isRecording).toBe(false);
    expect(recorder.stop()).toBeNull();
  });
});
