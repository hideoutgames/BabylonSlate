import { afterEach, describe, expect, it, vi } from "vitest";
import { createPreviewDiagnosticServer } from "@babylonslate/exporter";
import { PerformanceRecorder } from "@babylonslate/debugger";
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
    recorder.recordTick({ tickId: 14, elapsedMs: 0, scriptMs: 2, physicsMs: 1, publishMs: 0.1, otherMs: 0 });
    const result = recorder.stop()!;
    const { frames, ticks, ...header } = result;
    const server = createPreviewDiagnosticServer({ source: () => parent, origin: () => origin,
      send: (data) => window.dispatchEvent(new MessageEvent("message", { source: player, origin, data })) }, {
      async execute(operation) {
        events.push(operation);
        if (operation === "profile-start") await startBoundary;
        if (operation === "profile-stop") await server.publishProfile({
          metadata: { ...header, frames: { columns: frames.columns, count: frames.count }, ticks: { columns: ticks.columns, count: ticks.count } },
          frames: frames.chunks, ticks: ticks.chunks,
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
    expect(onProfile).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    adapter.dispose();
    expect(events.filter((event) => event === "closed")).toHaveLength(1);
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
});
