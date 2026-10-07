import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDiagnostics, type DiagnosticOperationRequest } from "./session-diagnostics";
import { summarizePerformanceColumn, type PerformanceFrameSample, type PerformanceIdentity } from "./performance-recorder";

const identity: PerformanceIdentity = { sessionId: "test", mode: "preview", sourceSha: null, buildId: "pack",
  sceneId: "world", backend: "webgl2", renderPath: "frameGraph", runtimeHost: "worker", quality: "Low",
  frameCap: 60, dynamicResolution: false, enabledDiagnostics: ["performance"], gpuTiming: "disabled" };

describe("SessionDiagnostics", () => {
  afterEach(() => vi.useRealTimers());

  it("flushes final runtime ticks before completing a finite recording and detaches frame collection", async () => {
    vi.useFakeTimers();
    let now = 0;
    let frames: ((sample: PerformanceFrameSample) => void) | undefined;
    const requests: DiagnosticOperationRequest[] = [];
    const session = new SessionDiagnostics({ mode: "preview", identity: () => identity, now: () => now,
      observeFrames: (listener) => { frames = listener; return () => { frames = undefined; }; },
      captureFrame: async () => "frame",
      runtimeOperation: async (request) => {
        requests.push(request);
        if (request.action === "stop") session.receiveTicks({ recordingId: request.recordingId, sequence: 0,
          rows: new Float64Array([600, 9999, 2, 3, 1, 0]) });
        return { success: true };
      },
    });
    expect(await session.startProfile()).toEqual({ success: true });
    expect(frames).toBeDefined();
    now = 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(frames).toBeUndefined();
    expect(session.active).toBeNull();
    expect(session.lastProfile?.stopReason).toBe("duration");
    expect(session.lastProfile?.durationMs).toBe(10_000);
    expect(summarizePerformanceColumn(session.lastProfile!.ticks, "scriptMs").count).toBe(1);
    expect(requests.map((request) => request.action)).toEqual(["start", "stop"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses Simulation and simultaneous expensive operations before subscribing", async () => {
    const observeFrames = vi.fn(() => () => {});
    const runtimeOperation = vi.fn(async () => ({ success: true }));
    const ports = { identity: () => identity, observeFrames, runtimeOperation, captureFrame: async () => "frame" };
    const simulation = new SessionDiagnostics({ ...ports, mode: "simulate" });
    expect(await simulation.startProfile()).toMatchObject({ success: false, reason: expect.stringContaining("Use Play or Preview Build") });
    await expect(simulation.captureFrame()).rejects.toThrow("Use Play or Preview Build");
    expect(runtimeOperation).not.toHaveBeenCalled();
    expect(observeFrames).not.toHaveBeenCalled();
    const play = new SessionDiagnostics({ ...ports, mode: "play" });
    await play.startProfile();
    await expect(play.captureFrame()).rejects.toThrow("active diagnostic");
    await play.dispose();
    expect(play.lastProfile?.stopReason).toBe("session-ended");
  });

  it("releases a denied acquisition and marks chunk sequence loss as an error", async () => {
    const requests: DiagnosticOperationRequest[] = [];
    let deny = true;
    const session = new SessionDiagnostics({ mode: "play", identity: () => identity,
      observeFrames: () => () => {}, captureFrame: async () => "frame",
      runtimeOperation: async (request) => { requests.push(request); return { success: !deny, reason: deny ? "Trace active" : undefined }; },
    });
    expect(await session.startProfile()).toMatchObject({ success: false, reason: "Trace active" });
    expect(session.active).toBeNull();
    deny = false;
    await session.startProfile();
    expect(session.receiveTicks({ recordingId: "obsolete", sequence: 0, rows: new Float64Array(6) })).toBe(false);
    expect(session.receiveTicks({ recordingId: requests.at(-1)!.recordingId, sequence: 1, rows: new Float64Array(6) })).toBe(false);
    await session.stopProfile();
    expect(session.lastProfile?.stopReason).toBe("error");
  });
});
