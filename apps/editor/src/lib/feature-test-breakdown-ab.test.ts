import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureTestBenchmarkSample, FeatureTestBreakdownInfo, FeatureTestCheckReport, FeatureTestCheckSceneResult } from "../services/feature-test-check";
import {
  BREAKDOWN_RESUME_MAX_AGE_MS,
  beginSecondPass,
  cancelPlannedReload,
  finishSecondPass,
  planSecondPass,
  resumeAfterLoad,
  secondPassInfo,
  type BreakdownAbDeps,
} from "./feature-test-breakdown-ab";
import { loadSavedCheck, saveUnfinishedCheck } from "./feature-test-check-record";
import type { ListedProject } from "./listed-projects";

const KEY = "haptic:feature-test-check:breakdown-resume";
const PROJECT = { id: "opfs-ft", name: "ft", tier: "opfs" as const, label: "Feature Test" };
const SCENES = [{ name: "FT_World", path: "assets/FeatureTest/Scenes/FT_World.scene.hasset" }];
const RESTORED_ON = "preserveDrawingBuffer is stored as on again, as before the A/B; it applies when the editor next reloads or the project is reopened.";

function baseline(preserve: string): FeatureTestBenchmarkSample {
  return {
    label: "baseline 1", baseline: true, frames: null, runtimeFps: null, cpuMs: null, gpuMs: null, drawCalls: 0, resolution: null, failed: [],
    settings: { shadows: "medium 2048", "presentation.preserve": preserve },
  };
}

function scene(pass: number, preserve: string): FeatureTestCheckSceneResult {
  return {
    name: "FT_World", path: SCENES[0]!.path, pass, passed: true, problems: [],
    editor: { status: "ready", ms: 1000, phase: null, frames: null, error: null, gpu: null },
    play: { status: "loaded", ms: 2000, phase: null, frames: null, runtimeFps: null, snapshot: null, firstDraws: null, commands: [], logs: [],
      benchmark: [baseline(preserve)] },
    session: null,
  };
}

function pass(breakdown: FeatureTestBreakdownInfo, scenes: FeatureTestCheckSceneResult[], extra: Partial<FeatureTestCheckReport> = {}): FeatureTestCheckReport {
  return { mode: "breakdown", startedAt: 1_000, durationMs: 300_000, cancelled: false, scenes, pageErrors: [], breakdown, ...extra };
}

const firstInfo: FeatureTestBreakdownInfo = { method: "remove-one", tier: "medium", warmMinutes: 4, passes: [{ preserveDrawingBuffer: true }], notes: [] };

describe("the Breakdown's preserveDrawingBuffer A/B", () => {
  let store: Map<string, string>;
  let stored: boolean;
  let clock: number;
  const deps: BreakdownAbDeps = { preserve: () => stored, setPreserve: (enabled) => { stored = enabled; }, now: () => clock };
  const marker = () => JSON.parse(store.get(KEY)!) as { stage: string };

  beforeEach(() => {
    store = new Map();
    stored = true;
    clock = 1_790_000_000_000;
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reloads into a second pass at the switched setting, then stores the user's setting again and reports both passes", () => {
    const first = pass(firstInfo, [scene(1, "true")]);
    const plan = planSecondPass(first, { project: PROJECT, scenes: SCENES }, deps);
    expect(plan.kind).toBe("reload");
    // Switched for the Engine the reload creates, with the first pass kept across it.
    expect(stored).toBe(false);
    expect(marker().stage).toBe("reload");

    clock += 40_000;
    const listed: ListedProject[] = [{ ...PROJECT, lastOpenedAt: "2026-10-31T10:00:00.000Z" }];
    const action = resumeAfterLoad(listed, deps);
    expect(action).toMatchObject({ kind: "reopen", project: { id: PROJECT.id } });
    expect(marker().stage).toBe("reopen");

    // Another project's dialog does not take it; this project's starts it once.
    expect(beginSecondPass("opfs-other", deps)).toBeNull();
    const resumed = beginSecondPass(PROJECT.id, deps)!;
    expect(resumed.scenes).toEqual(SCENES);
    expect(beginSecondPass(PROJECT.id, deps)).toBeNull();
    expect(marker().stage).toBe("second-pass");

    const info = secondPassInfo(resumed);
    expect(info.passes).toEqual([{ preserveDrawingBuffer: true }, { preserveDrawingBuffer: false }]);
    expect(info.warmMinutes).toBe(4);
    const report = finishSecondPass(resumed, pass(info, [scene(2, "false")], { startedAt: 900_000, durationMs: 290_000 }), deps);
    expect(stored).toBe(true);
    expect(store.has(KEY)).toBe(false);
    expect(report.scenes.map((entry) => [entry.pass, entry.play.benchmark[0]!.settings!["presentation.preserve"]])).toEqual([[1, "true"], [2, "false"]]);
    expect(report).toMatchObject({ startedAt: 1_000, durationMs: 590_000, cancelled: false });
    expect(report.breakdown!.notes).toEqual([RESTORED_ON]);
  });

  it.each([
    ["the first pass was cancelled", pass(firstInfo, [scene(1, "true")], { cancelled: true }), PROJECT, "the first was cancelled"],
    ["it measured no baseline", pass(firstInfo, []), PROJECT, "the first measured no baseline"],
    ["WebGPU has no such attribute", pass(firstInfo, [scene(1, "n/a")]), PROJECT, "WebGPU has no preserveDrawingBuffer"],
    ["the project cannot be found to reopen", pass(firstInfo, [scene(1, "true")]), null, "the open project was not found in the project list, to reopen after a reload"],
  ])("runs one pass when %s, and leaves the setting alone", (_case, first, project, reason) => {
    const plan = planSecondPass(first, { project, scenes: SCENES }, deps);
    expect(plan.kind).toBe("done");
    expect(plan.kind === "done" && plan.report.breakdown!.notes).toEqual([`The preserveDrawingBuffer A/B ran one pass: ${reason}.`]);
    expect(stored).toBe(true);
    expect(store.has(KEY)).toBe(false);
  });

  it("runs one pass when storage cannot carry the first pass across the reload", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("full"); }, removeItem: () => undefined });
    const plan = planSecondPass(pass(firstInfo, [scene(1, "true")]), { project: PROJECT, scenes: SCENES }, deps);
    expect(plan.kind === "done" && plan.report.breakdown!.notes).toEqual(["The preserveDrawingBuffer A/B ran one pass: browser storage could not keep the first pass across a reload."]);
    expect(stored).toBe(true);
  });

  it("stores the setting back when the reload is cancelled", () => {
    const plan = planSecondPass(pass(firstInfo, [scene(1, "true")]), { project: PROJECT, scenes: SCENES }, deps);
    const report = cancelPlannedReload(plan.kind === "reload" ? plan.marker : (undefined as never), "cancelled before the reload", deps);
    expect(stored).toBe(true);
    expect(store.has(KEY)).toBe(false);
    expect(report.breakdown!.notes).toEqual(["The preserveDrawingBuffer A/B ran one pass: cancelled before the reload."]);
  });

  it("discards a stale marker on load, stores the user's setting again and keeps the first pass's report for the dialog", () => {
    planSecondPass(pass(firstInfo, [scene(1, "true")]), { project: PROJECT, scenes: SCENES }, deps);
    clock += BREAKDOWN_RESUME_MAX_AGE_MS + 1;
    expect(resumeAfterLoad([PROJECT], deps)).toEqual({ kind: "abandoned", reason: "the reload it waited for was too long ago", reported: true });
    expect(stored).toBe(true);
    expect(store.has(KEY)).toBe(false);
    const saved = loadSavedCheck()!;
    expect(saved.unfinished).toBeUndefined();
    expect(saved.breakdown!.notes).toEqual(["The second pass did not finish: the reload it waited for was too long ago.", RESTORED_ON]);
  });

  it("discards an unreadable marker, storing the user's setting again when it can still read it", () => {
    store.set(KEY, "{not json");
    stored = false;
    expect(resumeAfterLoad([PROJECT], deps)).toEqual({ kind: "abandoned", reason: "its saved state was unreadable", reported: false });
    expect(store.has(KEY)).toBe(false);
    expect(stored).toBe(false);
    store.set(KEY, JSON.stringify({ version: 99, originalPreserve: true }));
    expect(resumeAfterLoad([PROJECT], deps)).toMatchObject({ kind: "abandoned", reported: false });
    expect(stored).toBe(true);
    expect(resumeAfterLoad([PROJECT], deps)).toEqual({ kind: "none" });
  });

  it("abandons the second pass when its project left the project list", () => {
    planSecondPass(pass(firstInfo, [scene(1, "true")]), { project: PROJECT, scenes: SCENES }, deps);
    expect(resumeAfterLoad([], deps)).toEqual({ kind: "abandoned", reason: "Feature Test is no longer in the project list", reported: true });
    expect(stored).toBe(true);
    expect(loadSavedCheck()!.scenes.map((entry) => entry.pass)).toEqual([1]);
  });

  it("never retries an attempt that stopped while reopening the project", () => {
    planSecondPass(pass(firstInfo, [scene(1, "true")]), { project: PROJECT, scenes: SCENES }, deps);
    expect(resumeAfterLoad([PROJECT], deps).kind).toBe("reopen");
    // The app reloaded again before the dialog started the second pass.
    expect(resumeAfterLoad([PROJECT], deps)).toMatchObject({ kind: "abandoned", reason: "the editor stopped while reopening the project" });
    expect(stored).toBe(true);
    expect(beginSecondPass(PROJECT.id, deps)).toBeNull();
  });

  it("reports both passes when the app stopped during the second, with the notes on its unfinished record", () => {
    planSecondPass(pass(firstInfo, [scene(1, "true")]), { project: PROJECT, scenes: SCENES }, deps);
    resumeAfterLoad([PROJECT], deps);
    const resumed = beginSecondPass(PROJECT.id, deps)!;
    // The dialog's crash record during the second pass holds both passes.
    saveUnfinishedCheck({ step: "FT_World: measuring shadows off", report: pass(secondPassInfo(resumed), [scene(1, "true"), scene(2, "false")]), resources: [] });
    expect(resumeAfterLoad([PROJECT], deps)).toMatchObject({ kind: "abandoned", reason: "the editor stopped during it", reported: true });
    expect(stored).toBe(true);
    const saved = loadSavedCheck()!;
    expect(saved.unfinished?.step).toBe("FT_World: measuring shadows off");
    expect(saved.scenes.map((entry) => entry.pass)).toEqual([1, 2]);
    expect(saved.breakdown!.notes).toEqual(["The second pass did not finish: the editor stopped during it.", RESTORED_ON]);
  });
});
