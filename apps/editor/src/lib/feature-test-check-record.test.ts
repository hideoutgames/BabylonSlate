import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureTestCheckReport, FeatureTestStoppedSession } from "../services/feature-test-check";
import { resetSessionTrail } from "@haptic/core";
import {
  clearUnfinishedCheck, formatOtherBuildCheck, loadCheckEnded, loadSavedCheck, loadSavedCheckRecord, saveCheckEnded, saveUnfinishedCheck,
  withStoppedSessions,
} from "./feature-test-check-record";
import { formatFeatureTestCheckReport, stopCause } from "./feature-test-check-report";
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
    expect(lines[2]).toBe("Did not finish: the app stopped (a crash or reload) while main: benchmarking high; its page left no trail to say why.");
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
    type Event = FeatureTestStoppedSession["events"][number];
    /**
     * This page `laterMs` (a minute by default) after another page's trail was last renewed, with that page's record
     * in storage, and the stopped check's record naming that page as the one it ran in.
     */
    function afterAFreeze(marks: { at: number; stage: string }[], events?: Event[], laterMs = 60_000, others: Record<string, object> = {}) {
      const trails = new Map([
        ["haptic:session-trail:froze", JSON.stringify({ alive: lastAlive, marks, ...(events ? { events } : {}) })],
        ...Object.entries(others).map(([page, trail]) => [`haptic:session-trail:${page}`, JSON.stringify(trail)] as [string, string]),
      ]);
      stopTrail = startSessionTrail({
        storage: {
          get length() { return trails.size; },
          key: (index) => [...trails.keys()][index] ?? null,
          getItem: (key) => trails.get(key) ?? null,
          setItem: (key, value) => { trails.set(key, value); },
          removeItem: (key) => { trails.delete(key); },
        },
        now: () => lastAlive + laterMs,
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
    /** The record a check that stopped at `step` left, written by its page (`page`) before it stopped. */
    function stoppedCheckRanIn(page: string, step: string) {
      saveUnfinishedCheck({ step, report, resources: [] });
      const RECORD = "haptic:feature-test-check:unfinished";
      store.set(RECORD, JSON.stringify({ ...JSON.parse(store.get(RECORD)!), page }));
    }

    it("tells where the page of a stopped check was, and goes on telling until a check that ran to its end has", () => {
      const marks = [
        { at: lastAlive - 41_200, stage: "check: main: benchmarking ultra" },
        { at: lastAlive - 400, stage: "check: main: stopping Play" },
        { at: lastAlive, stage: "play: disposing" },
      ];
      afterAFreeze(marks);
      stoppedCheckRanIn("froze", "main: stopping Play");
      const restored = loadSavedCheck()!;
      expect(restored.stoppedSessions).toEqual([{ page: "froze", lastAliveAt: lastAlive, marks, events: [] }]);
      const lines = formatFeatureTestCheckReport(restored, environment).split("\n");
      const nothing = "nothing recorded: the system stopped the page (no error, reload, close or hide was recorded before it; a WebKit content process killed for memory, or a crash, looks like this)";
      expect(lines[2]).toBe(`Did not finish: the app stopped while main: stopping Play: ${nothing}.`);
      expect(lines.slice(-8)).toEqual([
        "",
        "A session stopped without closing (a freeze, a crash or a force close), last alive 2026-11-09T23:57:00.000Z.",
        `Why: ${nothing}.`,
        "Its last stages, each with how long before that it was reached:",
        "    41.2 s  check: main: benchmarking ultra",
        "     0.4 s  check: main: stopping Play",
        "     0.0 s  play: disposing",
        "It recorded no error, reload, error screen, lost context or page event.",
      ]);
      // A finished check's report tells of it once more, and it is forgotten.
      expect(withStoppedSessions(report).stoppedSessions).toHaveLength(1);
      expect(withStoppedSessions(report, true).stoppedSessions).toHaveLength(1);
      expect(withStoppedSessions(report)).toBe(report);
    });

    it("lists a stopped session's last 24 stages", () => {
      afterAFreeze(Array.from({ length: 26 }, (_, index) => ({ at: lastAlive - (25 - index) * 1_000, stage: `stage ${index}` })));
      const lines = formatFeatureTestCheckReport(withStoppedSessions(report), environment).split("\n");
      expect(lines.slice(-26, -23)).toEqual([
        "Its last stages, each with how long before that it was reached (2 earlier omitted):",
        "    23.0 s  stage 2",
        "    22.0 s  stage 3",
      ]);
      expect(lines.at(-2)).toBe("     0.0 s  stage 25");
    });

    it("names a failed chunk import and the reload it made, from the check's own page whose trail ended with a close", () => {
      const events: Event[] = [
        { at: lastAlive - 480_000, first: lastAlive - 480_000, kind: "uncaught error", detail: "TypeError: a is null", count: 1 },
        { at: lastAlive - 300, first: lastAlive - 300, kind: "chunk import failed", detail: "Failed to fetch dynamically imported module: https://example.test/assets/x-1a2b3c.js; reloading the page", count: 1 },
        { at: lastAlive - 200, first: lastAlive - 200, kind: "reload", detail: "a failed chunk import", count: 1 },
        { at: lastAlive, first: lastAlive, kind: "page", detail: "closed (pagehide, persisted false)", count: 1 },
      ];
      // Three seconds after the reload: the trail is fresh, and ends as an ordinary close does. Another page that
      // closed in the ordinary way, as long ago, is no stopped session.
      afterAFreeze([{ at: lastAlive - 2_000, stage: "check: heavy baseline 17" }, { at: lastAlive, stage: "page: closed" }], events, 3_000, {
        "closed-normally": { alive: lastAlive - 60_000, marks: [{ at: lastAlive - 60_000, stage: "page: closed" }], events: [] },
      });
      stoppedCheckRanIn("froze", "heavy baseline 17");
      const restored = loadSavedCheck()!;
      expect(restored.stoppedSessions!.map((session) => session.page)).toEqual(["froze"]);
      const lines = formatFeatureTestCheckReport(restored, environment).split("\n");
      expect(lines[2]).toBe("Did not finish: the app stopped while heavy baseline 17: a failed chunk import (Failed to fetch dynamically imported module: https://example.test/assets/x-1a2b3c.js; reloading the page), then the page reloaded itself, 0.3 s before the last sign of life.");
      expect(lines.slice(-10)).toEqual([
        "A session ended with its page closed or put away (a reload counts), last alive 2026-11-09T23:57:00.000Z.",
        "Why: a failed chunk import (Failed to fetch dynamically imported module: https://example.test/assets/x-1a2b3c.js; reloading the page), then the page reloaded itself, 0.3 s before the last sign of life.",
        "Its last stages, each with how long before that it was reached:",
        "     2.0 s  check: heavy baseline 17",
        "     0.0 s  page: closed",
        "What it recorded (errors, reloads, error screens, contexts, the page's lifecycle), each with how long before that it happened:",
        "   480.0 s  uncaught error: TypeError: a is null",
        "     0.3 s  chunk import failed: Failed to fetch dynamically imported module: https://example.test/assets/x-1a2b3c.js; reloading the page",
        "     0.2 s  reload: a failed chunk import",
        "     0.0 s  page: closed (pagehide, persisted false)",
      ]);
    });

    it("names the latest recent cause by kind, and leaves an error the page ran on after out of it", () => {
      const session = (events: Event[], last = "play: running"): FeatureTestStoppedSession => ({
        page: "p", lastAliveAt: 100_000, marks: [{ at: 99_000, stage: last }], events,
      });
      const event = (kind: string, detail: string, at: number, count = 1): Event => ({ at, first: at - 1_000 * (count - 1), kind, detail, count });
      // An error eight minutes before is not why: nothing recorded since.
      expect(stopCause(session([event("uncaught error", "TypeError: a is null", 100_000 - 480_000)])))
        .toMatch(/^nothing recorded: the system stopped the page/);
      expect(stopCause(session([event("uncaught error", "TypeError: a is null", 95_000), event("context lost", "play: loss 1 of this view", 98_000)])))
        .toBe("the WebGL context was lost (play: loss 1 of this view), 2.0 s before the last sign of life");
      expect(stopCause(session([event("context lost", "play: loss 1 of this view", 97_000), event("error screen", "Couldn't Load Haptic: Error: boom", 99_000)])))
        .toBe("the WebGL context was lost (play: loss 1 of this view), 3.0 s before the last sign of life");
      expect(stopCause(session([event("unhandled rejection", "Error: lost", 99_500, 4)])))
        .toBe("an unhandled rejection: Error: lost, 0.5 s before the last sign of life");
      expect(stopCause(session([event("page", "hidden", 99_000)], "page: hidden"))).toBe("the page was put away (hidden) and did not come back");
      expect(stopCause(session([event("page", "closed (pagehide, persisted false)", 100_000)], "page: closed")))
        .toBe("the page was closed, reloaded or navigated away by the browser or the user (closed (pagehide, persisted false)), with no reload of the editor's own");
    });
  });

  it("keeps when the last check ended for the next Breakdown's warm-device note, and nothing it cannot read", () => {
    expect(loadCheckEnded()).toBeNull();
    saveCheckEnded(1_790_000_000_000);
    expect(loadCheckEnded()).toBe(1_790_000_000_000);
    store.set("haptic:feature-test-check:ended", "soon");
    expect(loadCheckEnded()).toBeNull();
  });

  /** The text the dialog shows for a record another build left, formatted as the dialog formats it. */
  const shown = (format = (saved: FeatureTestCheckReport) => formatFeatureTestCheckReport(saved, environment)) => {
    const saved = loadSavedCheckRecord();
    if (saved?.kind !== "other build") throw new Error("no other build's record");
    return formatOtherBuildCheck(saved, format);
  };
  const environment = {
    appVersion: "1.2.3", userAgent: "iPad", platform: "iPad", touchPoints: 5, devicePixelRatio: 2, screen: "1180x820", viewport: "1180x820", cores: 6, memoryGb: null,
  };
  const RECORD = "haptic:feature-test-check:unfinished";
  /** The stored record as `build` would have written it. */
  const writtenBy = (build: string) => {
    saveUnfinishedCheck({ step: "main: benchmarking high", report, resources: [] });
    store.set(RECORD, JSON.stringify({ ...JSON.parse(store.get(RECORD)!), build }));
  };

  it("shows a check another build left, marked as another build's, and keeps it until a new Check starts or the user clears it", () => {
    writtenBy("index-0ld8u1ld.js");
    // Not this build's report: the A/B resume and the note append leave it alone.
    expect(loadSavedCheck()).toBeNull();
    const { text, report: restored } = shown();
    const lines = text.split("\n");
    expect(lines[0]).toBe("Written by another build of the editor (index-0ld8u1ld.js): this build may misread it.");
    expect(lines[2]).toBe("Result: 0/1 scenes passed · DID NOT FINISH · took 41.0 s");
    expect(lines[3]).toBe("Did not finish: the app stopped (a crash or reload) while main: benchmarking high; its page left no trail to say why.");
    expect(restored?.unfinished?.step).toBe("main: benchmarking high");
    // Shown again on the next open: nothing deleted it.
    expect(shown().text).toBe(text);
    expect(store.has(RECORD)).toBe(true);
    clearUnfinishedCheck();
    expect(loadSavedCheckRecord()).toBeNull();
  });

  it("shows another build's record as stored when this build cannot format or read it", () => {
    writtenBy("index-0ld8u1ld.js");
    const stored = JSON.stringify(JSON.parse(store.get(RECORD)!), null, 2);
    // This build's formatter throws on it (a field it reads that the older shape lacks).
    const thrown = shown(() => { throw new TypeError("Cannot read properties of undefined (reading 'materials')"); });
    expect(thrown).toEqual({
      report: null,
      text: `Written by another build of the editor (index-0ld8u1ld.js): this build may misread it.\nThis build could not format it; the stored record follows.\n${stored}`,
    });
    // A record with no report this build reads, and one that is not JSON and names no build.
    store.set(RECORD, JSON.stringify({ step: 4, build: "index-0ld8u1ld.js" }));
    expect(shown().text).toBe(
      'Written by another build of the editor (index-0ld8u1ld.js): this build may misread it.\nThis build could not read it; the stored record follows.\n{\n  "step": 4,\n  "build": "index-0ld8u1ld.js"\n}');
    store.set(RECORD, "{not json");
    expect(shown()).toEqual({
      report: null,
      text: "Written by another build of the editor (unnamed): this build may misread it.\nThis build could not read it; the stored record follows.\n{not json",
    });
    expect(store.get(RECORD)).toBe("{not json");
  });

  it("names a deploy by its hashed entry scripts, so the same deploy resumes the record and the next one shows it as another build's", () => {
    const deployed = (entry: string) => vi.stubGlobal("document", {
      querySelectorAll: () => [`/BabylonSlate/assets/${entry}`, "/BabylonSlate/sw-register.js"].map((src) => ({ getAttribute: () => src })),
    });
    deployed("index-a1b2c3d4.js");
    saveUnfinishedCheck({ step: "main: benchmarking high", report, resources: [] });
    expect(loadSavedCheck()?.unfinished?.step).toBe("main: benchmarking high");
    expect(loadSavedCheckRecord()).toMatchObject({ kind: "this build" });
    deployed("index-e5f6a7b8.js");
    expect(loadSavedCheck()).toBeNull();
    expect(loadSavedCheckRecord()).toMatchObject({ kind: "other build", build: "index-a1b2c3d4.js" });
    expect(store.has(RECORD)).toBe(true);
  });

  it("discards a record of this build it cannot read, and runs on without storage", () => {
    saveUnfinishedCheck({ step: "x", report, resources: [] });
    store.set(RECORD, JSON.stringify({ ...JSON.parse(store.get(RECORD)!), step: 4 }));
    expect(loadSavedCheckRecord()).toBeNull();
    expect(store.has(RECORD)).toBe(false);
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("denied"); } });
    expect(() => saveUnfinishedCheck({ step: "x", report, resources: [] })).not.toThrow();
    expect(loadSavedCheck()).toBeNull();
    expect(() => clearUnfinishedCheck()).not.toThrow();
  });
});
