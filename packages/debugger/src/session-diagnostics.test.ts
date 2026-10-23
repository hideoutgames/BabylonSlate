import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDiagnostics, type DiagnosticOperationRequest } from "./session-diagnostics";
import { STATS_COMMAND_INTERVAL_MS } from "./stats";
import { PERFORMANCE_SCRIPT_COLUMNS, PERFORMANCE_TICK_COLUMNS, summarizePerformanceColumn, type PerformanceFrameSample, type PerformanceGpuSample,
  type PerformanceIdentity, type PerformanceTickSample } from "./performance-recorder";

const identity: PerformanceIdentity = { sessionId: "test", mode: "preview", sourceSha: null, buildId: "pack",
  sceneId: "world", backend: "webgl2", renderPath: "frameGraph", runtimeHost: "worker", quality: "Low",
  frameCap: 60, dynamicResolution: false, enabledDiagnostics: ["performance"], gpuTiming: "disabled" };

/** One runtime tick row in `PERFORMANCE_TICK_COLUMNS` order; unnamed timings are 0. */
const tickRow = (tickId: number, elapsedMs: number, timings: Partial<PerformanceTickSample> = {}) =>
  PERFORMANCE_TICK_COLUMNS.map((column) => column === "tickId" ? tickId : column === "elapsedMs" ? elapsedMs : timings[column] ?? 0);
const WIDTH = PERFORMANCE_TICK_COLUMNS.length;

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
          rows: new Float64Array(tickRow(600, 9999, { scriptMs: 2, physicsMs: 3, publishMs: 1, actorsMs: 1.5, sceneSystemsMs: 0.5 })) });
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
    const ticks = session.lastProfile!.ticks;
    expect(summarizePerformanceColumn(ticks, "scriptMs").median).toBe(2);
    expect(summarizePerformanceColumn(ticks, "actorsMs").median).toBe(1.5);
    expect(summarizePerformanceColumn(ticks, "sceneSystemsMs").median).toBe(0.5);
    expect(requests.map((request) => request.action)).toEqual(["start", "stop"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("samples memory at the stats rate and records long tasks while recording, and names both in the profile", async () => {
    vi.useFakeTimers();
    let now = 0;
    let textureBytes = 1000;
    let longTasks: ((task: { startedAtMs: number; durationMs: number }) => void) | undefined;
    const session = new SessionDiagnostics({ mode: "play", identity: () => identity, now: () => now,
      observeFrames: () => () => {}, captureFrame: async () => "frame", runtimeOperation: async () => ({ success: true }),
      sampleMemory: () => ({ textureBytes, geometryBytes: 500 }),
      observeLongTasks: (consume) => { longTasks = consume; return () => { longTasks = undefined; }; },
    });
    expect(await session.startProfile()).toEqual({ success: true });
    now = STATS_COMMAND_INTERVAL_MS;
    textureBytes = 3000;
    await vi.advanceTimersByTimeAsync(STATS_COMMAND_INTERVAL_MS);
    longTasks!({ startedAtMs: 100, durationMs: 90 });
    const profile = await session.stopProfile();
    expect(Array.from(profile!.memory.chunks[0]!)).toEqual([0, 1000, 500, STATS_COMMAND_INTERVAL_MS, 3000, 500]);
    expect(Array.from(profile!.longTasks.chunks[0]!)).toEqual([100, 90]);
    expect(profile!.identity.enabledDiagnostics).toEqual(["performance", "memory", "long-tasks"]);
    // Both stop with the recording.
    expect(longTasks).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("records no long tasks where the browser reports none, and says so", async () => {
    const session = new SessionDiagnostics({ mode: "play", identity: () => identity,
      observeFrames: () => () => {}, captureFrame: async () => "frame", runtimeOperation: async () => ({ success: true }),
      observeLongTasks: () => null,
    });
    await session.startProfile();
    const profile = await session.stopProfile();
    expect(profile!.identity.enabledDiagnostics).toEqual(["performance"]);
    expect(profile!.longTasks.count).toBe(0);
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
    expect(session.receiveTicks({ recordingId: "obsolete", sequence: 0, rows: new Float64Array(WIDTH) })).toBe(false);
    expect(session.receiveTicks({ recordingId: requests.at(-1)!.recordingId, sequence: 1, rows: new Float64Array(WIDTH) })).toBe(false);
    await session.stopProfile();
    expect(session.lastProfile?.stopReason).toBe("error");
  });

  it("counts every tick of a chunk that a budget stop leaves unrecorded", async () => {
    const requests: DiagnosticOperationRequest[] = [];
    const session = new SessionDiagnostics({ mode: "play", identity: () => identity, now: () => 0,
      observeFrames: () => () => {}, captureFrame: async () => "frame",
      runtimeOperation: async (request) => { requests.push(request); return { success: true }; },
    });
    await session.startProfile({ byteBudget: 4096 });
    const rows = new Float64Array(256 * WIDTH);
    for (let row = 0; row < 256; row++) rows.set(tickRow(row, row, { scriptMs: 1, physicsMs: 1 }), row * WIDTH);
    expect(session.receiveTicks({ recordingId: requests[0]!.recordingId, sequence: 0, rows })).toBe(true);
    const profile = await session.stopProfile();
    expect(profile?.stopReason).toBe("budget");
    expect(profile!.ticks.count).toBeGreaterThan(0);
    expect(profile!.ticks.count + profile!.droppedRecords).toBe(256);
  });

  it("keeps a chunk's script rows with the ticks it keeps", async () => {
    const requests: DiagnosticOperationRequest[] = [];
    const session = new SessionDiagnostics({ mode: "play", identity: () => identity, now: () => 0,
      observeFrames: () => () => {}, captureFrame: async () => "frame",
      runtimeOperation: async (request) => { requests.push(request); return { success: true }; },
    });
    await session.startProfile({ durationMs: 1000 });
    // Tick 2 is stamped past the recording window, so it and its script row are left out.
    expect(session.receiveTicks({ recordingId: requests[0]!.recordingId, sequence: 0,
      rows: new Float64Array([...tickRow(1, 0, { scriptMs: 1 }), ...tickRow(2, 5000, { scriptMs: 1 })]),
      scripts: new Float64Array([1, 0, 3, 0.5, 2, 0, 3, 0.5]),
      scriptEntries: [{ assetGuid: "Door.class", classId: "Door", exportName: "onTick" }] })).toBe(true);
    const profile = await session.stopProfile();
    expect(profile!.scriptEntries).toEqual([{ assetGuid: "Door.class", classId: "Door", exportName: "onTick" }]);
    expect(profile!.scripts.count).toBe(1);
    expect(Array.from(profile!.scripts.chunks[0]!)).toEqual([1, 0, 3, 0.5]);
    expect(profile!.scripts.columns).toEqual(PERFORMANCE_SCRIPT_COLUMNS);
  });

  it("adds only the runtime's own count when the runtime stops on its budget", async () => {
    const requests: DiagnosticOperationRequest[] = [];
    const session = new SessionDiagnostics({ mode: "play", identity: () => identity, now: () => 0,
      observeFrames: () => () => {}, captureFrame: async () => "frame",
      runtimeOperation: async (request) => { requests.push(request); return { success: true }; },
    });
    await session.startProfile();
    const recordingId = requests[0]!.recordingId;
    expect(session.receiveTicks({ recordingId, sequence: 0, rows: new Float64Array(tickRow(1, 0, { scriptMs: 1, physicsMs: 1 })), droppedRecords: 1 })).toBe(true);
    session.runtimeStopped({ recordingId, reason: "budget" });
    const profile = await session.stopProfile();
    expect(profile).toMatchObject({ stopReason: "budget", droppedRecords: 1 });
    expect(profile!.ticks.count).toBe(1);
  });

  it("ends the recording as an error when a frame sample is invalid", async () => {
    let now = 0;
    let frames: ((sample: PerformanceFrameSample) => void) | undefined;
    const session = new SessionDiagnostics({ mode: "play", identity: () => identity, now: () => now,
      observeFrames: (listener) => { frames = listener; return () => { frames = undefined; }; },
      captureFrame: async () => "frame", runtimeOperation: async () => ({ success: true }),
    });
    await session.startProfile();
    const frame = { frameId: 1, tickId: 1, sceneGeneration: 1, completedAtMs: 20, preparationMs: 1,
      submissionMs: 1, copyMs: 0, drawCalls: 1, width: 64, height: 64, resolutionScale: 1 };
    now = 30;
    frames!(frame);
    expect(() => frames!({ ...frame, frameId: 2, completedAtMs: 10 })).not.toThrow();
    const profile = await session.stopProfile();
    expect(profile).toMatchObject({ stopReason: "error" });
    expect(profile!.frames.count).toBe(1);
    expect(frames).toBeUndefined();
    expect(session.active).toBeNull();
  });

  it("collects GPU values only on explicit request and releases every profile lease", async () => {
    let gpu: ((sample: PerformanceGpuSample) => void) | undefined;
    const release = vi.fn(() => { gpu = undefined; });
    const observeGpuTiming = vi.fn((consume: (sample: PerformanceGpuSample) => void) => {
      gpu = consume; return { status: "unpaired" as const, release };
    });
    const session = new SessionDiagnostics({ mode: "play", identity: () => identity, now: () => 1000,
      observeFrames: () => () => {}, observeGpuTiming, captureFrame: async () => "frame",
      runtimeOperation: async () => ({ success: true }),
    });
    await session.startProfile();
    expect(observeGpuTiming).not.toHaveBeenCalled();
    expect((await session.stopProfile())?.identity.gpuTiming).toBe("disabled");
    await session.startProfile({ gpuTiming: true });
    gpu!({ observedAtMs: 1010, durationMs: 3, querySequence: 8, coalescedQueries: 0, attribution: "engine-aggregate" });
    const result = await session.stopProfile();
    expect(result?.identity).toMatchObject({ gpuTiming: "unpaired", gpuAttribution: "engine-aggregate", enabledDiagnostics: ["performance", "gpu-timing"] });
    expect(result?.gpu.count).toBe(1);
    expect(release).toHaveBeenCalledOnce();
    expect(gpu).toBeUndefined();
    await session.startProfile({ gpuTiming: true });
    await session.dispose();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("names unsupported GPU collection and releases a query lease if frame attachment fails", async () => {
    const ports = { mode: "play" as const, identity: () => identity, now: () => 0,
      observeFrames: () => () => {}, captureFrame: async () => "frame", runtimeOperation: async () => ({ success: true }) };
    const unavailable = new SessionDiagnostics(ports);
    await unavailable.startProfile({ gpuTiming: true });
    expect((await unavailable.stopProfile())?.identity).toMatchObject({ gpuTiming: "unavailable", gpuReason: expect.stringContaining("cannot collect") });
    const release = vi.fn();
    const failing = new SessionDiagnostics({ ...ports,
      observeGpuTiming: () => ({ status: "unpaired", release }),
      observeFrames: () => { throw new Error("View ended"); },
    });
    expect(await failing.startProfile({ gpuTiming: true })).toMatchObject({ success: false, reason: "View ended" });
    expect(release).toHaveBeenCalledOnce();
    expect(failing.active).toBeNull();
  });
});
