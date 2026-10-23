import { afterEach, describe, expect, it, vi } from "vitest";
import { createPreviewDiagnosticServer } from "@haptic/exporter";
import { PerformanceRecorder } from "@haptic/debugger";
import { createPreviewDiagnostics } from "./preview-diagnostics";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Preview diagnostics lifecycle", () => {
  it("does not contact or load diagnostics when an untouched Preview stops", async () => {
    const postMessage = vi.fn();
    const adapter = createPreviewDiagnostics({ source: () => ({ postMessage }) as unknown as Window,
      origin: window.location.origin, onProfile: vi.fn(), onError: vi.fn() });
    await adapter.finish();
    adapter.dispose();
    expect(postMessage).not.toHaveBeenCalled();
    expect((await adapter.startProfile()).success).toBe(false);
  });

  it("settles an accepted start and retains the final transferred result before closing", async () => {
    const events: string[] = [];
    let acceptStart!: () => void;
    const startBoundary = new Promise<void>((resolve) => { acceptStart = resolve; });
    const parent = {};
    const origin = window.location.origin;
    const player = { postMessage: (data: unknown) => server.receive({ source: parent, origin, data }) } as unknown as Window;
    const recorder = new PerformanceRecorder({ now: () => 0 });
    recorder.start({ sessionId: "packaged-player", mode: "preview", sourceSha: null, buildId: null,
      sceneId: "scene", backend: "webgl2", renderPath: "frameGraph", runtimeHost: "worker",
      quality: "Low", frameCap: 60, dynamicResolution: false, enabledDiagnostics: ["performance"], gpuTiming: "unavailable" });
    recorder.recordTick({ tickId: 14, elapsedMs: 0, scriptMs: 2, physicsMs: 1, publishMs: 0.1, otherMs: 0,
      gameInstanceMs: 0, sceneSubsystemsMs: 0, actorsMs: 2, componentsMs: 0, postPhysicsMs: 0, sceneSystemsMs: 0 });
    recorder.recordMemory({ sampledAtMs: 0, textureBytes: 4096, geometryBytes: 1024 });
    recorder.recordLongTask({ startedAtMs: 0, durationMs: 75 });
    const result = recorder.stop()!;
    const { frames, ticks, gpu, memory, longTasks, ...header } = result;
    const server = createPreviewDiagnosticServer({ source: () => parent, origin: () => origin,
      send: (data) => window.dispatchEvent(new MessageEvent("message", { source: player, origin, data })) }, {
      async execute(operation) {
        events.push(operation);
        if (operation === "profile-start") await startBoundary;
        if (operation === "profile-stop") await server.publishProfile({
          metadata: { ...header, frames: { columns: frames.columns, count: frames.count }, ticks: { columns: ticks.columns, count: ticks.count },
            gpu: { columns: gpu.columns, count: gpu.count }, memory: { columns: memory.columns, count: memory.count },
            longTasks: { columns: longTasks.columns, count: longTasks.count } },
          frames: frames.chunks, ticks: ticks.chunks, gpu: gpu.chunks, memory: memory.chunks, longTasks: longTasks.chunks,
        });
        return { success: true };
      },
      close: () => { events.push("closed"); },
    });
    const onProfile = vi.fn(() => { events.push("received"); });
    const onError = vi.fn();
    const adapter = createPreviewDiagnostics({ source: () => player, origin, onProfile, onError });
    const start = adapter.startProfile();
    await vi.waitFor(() => expect(events).toEqual(["profile-start"]));
    const finish = adapter.finish();
    expect(events).toEqual(["profile-start"]);
    acceptStart();
    await start;
    await finish;
    expect(events).toEqual(["profile-start", "profile-stop", "received", "closed"]);
    expect(adapter.lastProfile?.ticks.count).toBe(1);
    expect(adapter.lastProfile?.ticks.chunks[0]?.[0]).toBe(14);
    expect(adapter.lastProfile?.memory.chunks[0]?.[1]).toBe(4096);
    expect(adapter.lastProfile?.longTasks.chunks[0]?.[1]).toBe(75);
    expect(onProfile).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    adapter.dispose();
    expect(events.filter((event) => event === "closed")).toHaveLength(1);
  });

  it("fails Stop when the profile transfer failed and accepts the next recording", async () => {
    const parent = {};
    const origin = window.location.origin;
    const player = { postMessage: (data: unknown) => server.receive({ source: parent, origin, data }) } as unknown as Window;
    const recorder = new PerformanceRecorder({ now: () => 0 });
    recorder.start({ sessionId: "packaged-player", mode: "preview", sourceSha: null, buildId: null,
      sceneId: "scene", backend: "webgl2", renderPath: "frameGraph", runtimeHost: "worker",
      quality: "Low", frameCap: 60, dynamicResolution: false, enabledDiagnostics: ["performance"], gpuTiming: "unavailable" });
    const { frames, ticks, gpu, memory, longTasks, ...header } = recorder.stop()!;
    const server = createPreviewDiagnosticServer({ source: () => parent, origin: () => origin,
      send: (data) => window.dispatchEvent(new MessageEvent("message", { source: player, origin, data })) }, {
      async execute(operation) {
        // A chunk over the transport limit makes the publisher send profile-error;
        // the player answers Stop with that transfer outcome.
        if (operation === "profile-stop") return server.publishProfile({
          metadata: { ...header, frames: { columns: frames.columns, count: frames.count }, ticks: { columns: ticks.columns, count: ticks.count },
            gpu: { columns: gpu.columns, count: gpu.count }, memory: { columns: memory.columns, count: memory.count },
            longTasks: { columns: longTasks.columns, count: longTasks.count } },
          frames: [new Float64Array(8192)], ticks: ticks.chunks, gpu: gpu.chunks, memory: memory.chunks, longTasks: longTasks.chunks,
        });
        return { success: true };
      },
      close: () => {},
    });
    const onProfile = vi.fn();
    const onError = vi.fn();
    const adapter = createPreviewDiagnostics({ source: () => player, origin, onProfile, onError });

    expect((await adapter.startProfile()).success).toBe(true);
    const stopped = await adapter.stopProfile();

    expect(stopped).toMatchObject({ success: false, reason: expect.stringContaining("transport budget") });
    expect(onError).toHaveBeenCalledOnce();
    expect(onProfile).not.toHaveBeenCalled();
    expect(adapter.lastProfile).toBeNull();
    expect((await adapter.startProfile()).success).toBe(true);
    // Closing Preview reports the second failed transfer once, through onError only.
    await expect(adapter.finish()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("bounds Stop while a player is unresponsive and clears pending transport timers", async () => {
    vi.useFakeTimers();
    const adapter = createPreviewDiagnostics({ source: () => ({ postMessage: vi.fn() }) as unknown as Window,
      origin: window.location.origin, onProfile: vi.fn(), onError: vi.fn() });
    const start = adapter.startProfile();
    const finished = expect(adapter.finish()).rejects.toThrow("incomplete result was discarded");
    await vi.advanceTimersByTimeAsync(3000);
    await finished;
    expect((await start).success).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("serializes modal input ownership without starting an expensive diagnostic operation", async () => {
    const parent = {};
    const origin = window.location.origin;
    const operations: Array<[string, boolean | undefined]> = [];
    const player = { postMessage: (data: unknown) => server.receive({ source: parent, origin, data }) } as unknown as Window;
    const server = createPreviewDiagnosticServer({ source: () => parent, origin: () => origin,
      send: (data) => window.dispatchEvent(new MessageEvent("message", { source: player, origin, data })) }, {
      execute: async (operation, settings) => { operations.push([operation, settings.inputSuppressed]); return { success: true }; },
      close: () => {},
    });
    const adapter = createPreviewDiagnostics({ source: () => player, origin, onProfile: vi.fn(), onError: vi.fn() });
    await adapter.setInputSuppressed(false);
    expect(operations).toEqual([]);
    const opened = adapter.setInputSuppressed(true);
    const closed = adapter.setInputSuppressed(false);
    await opened; await closed;
    expect(operations).toEqual([["input", true], ["input", false]]);
    await adapter.finish();
  });
});
