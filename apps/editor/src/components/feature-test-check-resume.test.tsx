import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { preserveDrawingBufferSetting } from "@haptic/render/preserve-drawing-buffer-setting";
import type { FeatureTestCheckReport } from "../services/feature-test-check";
import { FEATURE_TEST_AB_DEPS } from "../lib/feature-test-ab-deps";
import { planSecondPass } from "../lib/feature-test-breakdown-ab";
import { loadSavedCheck } from "../lib/feature-test-check-record";
import { FeatureTestCheckResume } from "./feature-test-check-resume";

const PROJECT = { id: "opfs-ft", name: "ft", tier: "opfs" as const, label: "Feature Test" };

// Project I/O is the external side: Home's list and its open action.
const harness = vi.hoisted(() => ({
  value: {
    homepageReady: true,
    listedProjects: [{ id: "opfs-ft", name: "ft", tier: "opfs" as const, label: "Feature Test" }],
    openListedProject: vi.fn<(handle: { id: string }) => Promise<void>>(),
  },
}));
vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => harness.value));

const first: FeatureTestCheckReport = {
  mode: "breakdown", startedAt: 1_000, durationMs: 300_000, cancelled: false, pageErrors: [],
  breakdown: { method: "remove-one", tier: "medium", ab: true, warmMinutes: null, passes: [{ preserveDrawingBuffer: true }], notes: [] },
  scenes: [{
    name: "FT_World", path: "assets/FeatureTest/Scenes/FT_World.scene.hasset", pass: 1, passed: true, problems: [],
    editor: { status: "ready", ms: 1000, phase: null, frames: null, error: null, gpu: null },
    play: { status: "loaded", ms: 2000, phase: null, frames: null, runtimeFps: null, snapshot: null, firstDraws: null, commands: [], logs: [],
      benchmark: [{ label: "baseline 1", baseline: true, frames: null, runtimeFps: null, cpuMs: null, gpuMs: null, drawCalls: 0, resolution: null,
        failed: [], settings: { "presentation.preserve": "true" } }] },
    session: null,
  }],
};

/** The first pass ended and asked for the reload: the second pass waits with the setting switched. */
function awaitSecondPass() {
  const plan = planSecondPass(first, { project: PROJECT, scenes: [{ name: first.scenes[0]!.name, path: first.scenes[0]!.path }] }, FEATURE_TEST_AB_DEPS);
  expect(plan.kind).toBe("reload");
  expect(preserveDrawingBufferSetting()).toBe(false);
}

describe("FeatureTestCheckResume", () => {
  beforeEach(() => {
    localStorage.clear();
    harness.value.openListedProject.mockReset();
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("reopens the project a Breakdown waits in, and Cancel gives up the second pass with the setting stored back", async () => {
    awaitSecondPass();
    harness.value.openListedProject.mockReturnValue(new Promise(() => {}));
    render(<FeatureTestCheckResume />);
    expect(await screen.findByText("Feature Test Check · Reopening Feature Test for the Breakdown's second pass")).toBeTruthy();
    expect(harness.value.openListedProject).toHaveBeenCalledTimes(1);
    expect(harness.value.openListedProject.mock.calls[0]![0]).toMatchObject({ id: "opfs-ft" });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(preserveDrawingBufferSetting()).toBe(true);
    expect(loadSavedCheck()!.breakdown!.notes[0]).toBe("The second pass did not finish: cancelled.");
  });

  it("says why the second pass cannot run when the project does not reopen, with the setting stored back", async () => {
    awaitSecondPass();
    harness.value.openListedProject.mockRejectedValue(new Error("folder access denied"));
    render(<FeatureTestCheckResume />);
    expect(await screen.findByText(
      "Feature Test Check · The Breakdown's second pass did not run: Feature Test did not reopen (folder access denied). Its report is in Run Feature Test Check.",
    )).toBeTruthy();
    expect(preserveDrawingBufferSetting()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows nothing and opens nothing without a Breakdown waiting", () => {
    render(<FeatureTestCheckResume />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(harness.value.openListedProject).not.toHaveBeenCalled();
  });
});
