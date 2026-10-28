import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureTestCheckReport } from "../services/feature-test-check";
import { clearUnfinishedCheck, loadUnfinishedCheck, saveUnfinishedCheck } from "./feature-test-check-record";
import { formatFeatureTestCheckReport } from "./feature-test-check-report";

const report: FeatureTestCheckReport = {
  mode: "benchmark", startedAt: Date.UTC(2026, 9, 28, 12), durationMs: 41_000, cancelled: false, pageErrors: [],
  scenes: [{
    name: "main", path: "assets/main.scene.hasset", passed: false, problems: [],
    editor: { status: "ready", ms: 4200, phase: null, frames: null, error: null, gpu: null },
    play: { status: "loaded", ms: 9000, phase: null, frames: null, runtimeFps: 60, snapshot: null, firstDraws: null, commands: [], logs: [],
      benchmark: [{ label: "low · forward", frames: { frames: 300, durationMs: 5000, fps: 60, p95Ms: 17, maxMs: 20, stalls: 0 }, runtimeFps: 60,
        cpuMs: 4, gpuMs: null, drawCalls: 100, resolution: "1180x820@1.00", failed: [] }] },
    session: null,
  }],
};
const sample = (atMs: number, step: string, textureMb: number) => ({
  atMs, step, effects: 300, compiling: atMs > 30_000 ? 40 : 0, textures: 120, textureBytes: textureMb * 1048576,
  playFrames: { drawn: 900, held: atMs > 30_000 ? 120 : 0 }, jsHeapBytes: null, appFootprintBytes: 1500 * 1048576,
});

describe("the unfinished Feature Test Check", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("comes back after a crash with its last step and resource samples, until cleared", () => {
    expect(loadUnfinishedCheck()).toBeNull();
    saveUnfinishedCheck({
      step: "main: benchmarking high · forward", report,
      resources: [sample(30_000, "main: benchmarking medium · forward", 400), sample(40_000, "main: benchmarking high · forward", 900)],
    });
    const restored = loadUnfinishedCheck()!;
    expect(restored.scenes[0].play.benchmark.map((entry) => entry.label)).toEqual(["low · forward"]);
    const lines = formatFeatureTestCheckReport(restored, {
      appVersion: "1.2.3", userAgent: "iPad", platform: "iPad", touchPoints: 5, devicePixelRatio: 2, screen: "1180x820", viewport: "1180x820", cores: 6, memoryGb: null,
    }).split("\n");
    expect(lines[1]).toBe("Result: 0/1 scenes passed · DID NOT FINISH · took 41.0 s");
    expect(lines[2]).toBe("Did not finish: the app stopped (a crash or reload) while main: benchmarking high · forward.");
    expect(lines.slice(-3)).toEqual([
      "Resources before it stopped (last 2 samples, oldest first):",
      "  30.0 s   300 shaders · Play drawn 900, held 0 · 120 textures (400 MB) · app 1500 MB · main: benchmarking medium · forward",
      "  40.0 s   300 shaders (40 compiling) · Play drawn 900, held 120 · 120 textures (900 MB) · app 1500 MB · main: benchmarking high · forward",
    ]);
    clearUnfinishedCheck();
    expect(loadUnfinishedCheck()).toBeNull();
  });

  it("ignores a record it cannot read, and runs on without storage", () => {
    store.set("haptic:feature-test-check:unfinished", "{not json");
    expect(loadUnfinishedCheck()).toBeNull();
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("denied"); } });
    expect(() => saveUnfinishedCheck({ step: "x", report, resources: [] })).not.toThrow();
    expect(loadUnfinishedCheck()).toBeNull();
    expect(() => clearUnfinishedCheck()).not.toThrow();
  });
});
