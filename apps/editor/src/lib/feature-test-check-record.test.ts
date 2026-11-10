import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureTestCheckReport } from "../services/feature-test-check";
import { resetSessionTrail } from "@haptic/core";
import { clearUnfinishedCheck, loadCheckEnded, loadSavedCheck, saveCheckEnded, saveUnfinishedCheck, withStoppedSessions } from "./feature-test-check-record";
import { formatFeatureTestCheckReport } from "./feature-test-check-report";
import { startSessionTrail } from "./session-trail-record";

const report: FeatureTestCheckReport = {
  mode: "benchmark", startedAt: Date.UTC(2026, 9, 28, 12), durationMs: 41_000, cancelled: false, pageErrors: [],
  scenes: [{
    name: "main", path: "assets/main.scene.hasset", passed: false, problems: [],
    editor: { status: "ready", ms: 4200, phase: null, frames: null, error: null, gpu: null },
    play: { status: "loaded", ms: 9000, phase: null, frames: null, runtimeFps: 60, snapshot: null, presentation: null, firstDraws: null, commands: [], logs: [],
      benchmark: [{ label: "low", frames: { frames: 300, durationMs: 5000, fps: 60, medianMs: 16.7, meanMs: 5000 / 300, vsync: [1, 0, 0, 0], p95Ms: 17, maxMs: 20, stalls: 0 }, runtimeFps: 60,
        cpuMs: 4, gpuMs: null, drawCalls: 100, resolution: "1180x820@1.00", failed: [] }] },
    session: null,
  }],
};
const sample = (atMs: number, step: string, textureMb: number) => ({
  atMs, step, effects: 300, compiling: atMs > 30_000 ? 40 : 0, textures: 120, textureBytes: textureMb * 1048576,
  playFrames: { drawn: 900, held: atMs > 30_000 ? 120 : 0, contextLosses: atMs > 30_000 ? 1 : 0 }, jsHeapBytes: null, appFootprintBytes: 1500 * 1048576,
  // The device's free memory falls as the web content and GPU processes grow; the app's headroom is unreported here.
  deviceAvailableBytes: (atMs > 30_000 ? 300 : 900) * 1048576, appAvailableBytes: null,
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
    expect(loadSavedCheck()).toBeNull();
    saveUnfinishedCheck({
      step: "main: benchmarking high", report,
      resources: [sample(30_000, "main: benchmarking medium", 400), sample(40_000, "main: benchmarking high", 900)],
    });
    const restored = loadSavedCheck()!;
    expect(restored.scenes[0].play.benchmark.map((entry) => entry.label)).toEqual(["low"]);
    const lines = formatFeatureTestCheckReport(restored, {
      appVersion: "1.2.3", userAgent: "iPad", platform: "iPad", touchPoints: 5, devicePixelRatio: 2, screen: "1180x820", viewport: "1180x820", cores: 6, memoryGb: null,
    }).split("\n");
    expect(lines[1]).toBe("Result: 0/1 scenes passed · DID NOT FINISH · took 41.0 s");
    expect(lines[2]).toBe("Did not finish: the app stopped (a crash or reload) while main: benchmarking high.");
    expect(lines.slice(-3)).toEqual([
      "Resources before it stopped (last 2 samples, oldest first):",
      "  30.0 s   300 shaders · Play drawn 900, held 0 · 120 textures (400 MB) · app 1500 MB · device free 900 MB · main: benchmarking medium",
      "  40.0 s   300 shaders (40 compiling) · Play drawn 900, held 120, CONTEXT LOST 1x · 120 textures (900 MB) · app 1500 MB · device free 300 MB · main: benchmarking high",
    ]);
    clearUnfinishedCheck();
    expect(loadSavedCheck()).toBeNull();
  });

  describe("with sessions that stopped without closing", () => {
    const environment = {
      appVersion: "1.2.3", userAgent: "iPad", platform: "iPad", touchPoints: 5, devicePixelRatio: 2, screen: "1180x820", viewport: "1180x820", cores: 6, memoryGb: null,
    };
    const lastAlive = Date.UTC(2026, 10, 9, 23, 57, 0);
    let stopTrail: (() => void) | undefined;
    /** This page a minute after another page's trail was last renewed, with that page's record in storage. */
    function afterAFreeze(marks: { at: number; stage: string }[]) {
      const trails = new Map([["haptic:session-trail:froze", JSON.stringify({ alive: lastAlive, marks })]]);
      stopTrail = startSessionTrail({
        storage: {
          get length() { return trails.size; },
          key: (index) => [...trails.keys()][index] ?? null,
          getItem: (key) => trails.get(key) ?? null,
          setItem: (key, value) => { trails.set(key, value); },
          removeItem: (key) => { trails.delete(key); },
        },
        now: () => lastAlive + 60_000,
        setInterval: () => 0,
        clearInterval: () => {},
        watchPage: () => () => {},
        newPageId: () => "this-page",
      });
    }
    afterEach(() => {
      stopTrail?.();
      stopTrail = undefined;
      resetSessionTrail();
    });

    it("tells where the page of a stopped check was, and goes on telling until a check that ran to its end has", () => {
      const marks = [
        { at: lastAlive - 41_200, stage: "check: main: benchmarking ultra" },
        { at: lastAlive - 400, stage: "check: main: stopping Play" },
        { at: lastAlive, stage: "play: disposing" },
      ];
      afterAFreeze(marks);
      saveUnfinishedCheck({ step: "main: stopping Play", report, resources: [] });
      const restored = loadSavedCheck()!;
      expect(restored.stoppedSessions).toEqual([{ lastAliveAt: lastAlive, marks }]);
      expect(formatFeatureTestCheckReport(restored, environment).split("\n").slice(-6)).toEqual([
        "",
        "A session stopped without closing (a freeze, a crash or a force close), last alive 2026-11-09T23:57:00.000Z.",
        "Its last stages, each with how long before that it was reached:",
        "    41.2 s  check: main: benchmarking ultra",
        "     0.4 s  check: main: stopping Play",
        "     0.0 s  play: disposing",
      ]);
      // A finished check's report tells of it once more, and it is forgotten.
      expect(withStoppedSessions(report).stoppedSessions).toHaveLength(1);
      expect(withStoppedSessions(report, true).stoppedSessions).toHaveLength(1);
      expect(withStoppedSessions(report)).toBe(report);
    });

    it("lists a stopped session's last 24 stages", () => {
      afterAFreeze(Array.from({ length: 26 }, (_, index) => ({ at: lastAlive - (25 - index) * 1_000, stage: `stage ${index}` })));
      const lines = formatFeatureTestCheckReport(withStoppedSessions(report), environment).split("\n");
      expect(lines.slice(-25, -22)).toEqual([
        "Its last stages, each with how long before that it was reached (2 earlier omitted):",
        "    23.0 s  stage 2",
        "    22.0 s  stage 3",
      ]);
      expect(lines.at(-1)).toBe("     0.0 s  stage 25");
    });
  });

  it("keeps when the last check ended for the next Breakdown's warm-device note, and nothing it cannot read", () => {
    expect(loadCheckEnded()).toBeNull();
    saveCheckEnded(1_790_000_000_000);
    expect(loadCheckEnded()).toBe(1_790_000_000_000);
    store.set("haptic:feature-test-check:ended", "soon");
    expect(loadCheckEnded()).toBeNull();
  });

  it("ignores a record it cannot read, discarding a report with incomplete frame statistics, and runs on without storage", () => {
    store.set("haptic:feature-test-check:unfinished", "{not json");
    expect(loadSavedCheck()).toBeNull();
    // A sample's frames without their mean, median and pacing would format as a missing field.
    const { frames, durationMs, fps, p95Ms, maxMs, stalls } = report.scenes[0]!.play.benchmark[0]!.frames!;
    const partial = { frames, durationMs, fps, p95Ms, maxMs, stalls };
    const incomplete = { ...report, scenes: [{ ...report.scenes[0]!, play: { ...report.scenes[0]!.play,
      benchmark: [{ ...report.scenes[0]!.play.benchmark[0]!, frames: partial }] } }] };
    store.set("haptic:feature-test-check:unfinished", JSON.stringify({ finished: true, report: incomplete }));
    expect(loadSavedCheck()).toBeNull();
    expect(store.has("haptic:feature-test-check:unfinished")).toBe(false);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("denied"); } });
    expect(() => saveUnfinishedCheck({ step: "x", report, resources: [] })).not.toThrow();
    expect(loadSavedCheck()).toBeNull();
    expect(() => clearUnfinishedCheck()).not.toThrow();
  });
});
