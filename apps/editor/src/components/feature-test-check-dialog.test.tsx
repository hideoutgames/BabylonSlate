import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FeatureTestCheckReport, runFeatureTestCheck } from "../services/feature-test-check";
import { FeatureTestCheckDialog } from "./feature-test-check-dialog";

const harness = vi.hoisted(() => ({
  run: vi.fn<typeof runFeatureTestCheck>(),
  requestPlay: vi.fn(async () => {}),
}));
// The runner has its own tests; the dialog's contract is which mode and scenes it asks it to run.
vi.mock("../services/feature-test-check", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/feature-test-check")>(),
  runFeatureTestCheck: harness.run,
}));
vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({ projectName: "Feature Test", listedProjects: [] })));
vi.mock("../context/play-context", () => ({
  usePlay: () => ({ requestPlay: harness.requestPlay, playFromScene: true, setPlayFromScene: () => {}, sessionOwner: { canStart: () => true } }),
}));

describe("FeatureTestCheckDialog", () => {
  beforeEach(() => {
    localStorage.clear();
    harness.run.mockReset();
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("offers Profile, which runs the check on the main scene only and shows its report", async () => {
    const report: FeatureTestCheckReport = { mode: "profile", startedAt: 1_000, durationMs: 240_000, cancelled: false, scenes: [], pageErrors: [] };
    harness.run.mockResolvedValue(report);
    const onOpenChange = vi.fn();
    render(<FeatureTestCheckDialog open onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByTestId("feature-test-check-profile"));
    expect(screen.getByTestId("feature-test-check-profile").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/^Plays the main scene at this device's quality settings/)).toBeTruthy();
    // Breakdown's own options stay with Breakdown.
    expect(screen.queryByTestId("feature-test-check-breakdown-ab")).toBeNull();
    fireEvent.click(screen.getByTestId("feature-test-check-start"));
    await waitFor(() => expect(harness.run).toHaveBeenCalledTimes(1));
    const options = harness.run.mock.calls[0]![0];
    expect(options.mode).toBe("profile");
    expect(options.scenes).toEqual([{ name: "main", path: "assets/main.scene.hasset" }]);
    expect(options.breakdown).toBeUndefined();
    const text = await screen.findByTestId("feature-test-check-report");
    expect((text as HTMLTextAreaElement).value).toMatch(/^Haptic Feature Test Check \(Profile\)/);
  });

  it("offers a Water Breakdown, which measures FT_World's water from the Medium tier", async () => {
    harness.run.mockResolvedValue({ mode: "breakdown", startedAt: 1_000, durationMs: 1_000, cancelled: false, scenes: [], pageErrors: [] });
    render(<FeatureTestCheckDialog open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId("feature-test-check-breakdown"));
    fireEvent.click(screen.getByTestId("feature-test-check-breakdown-water"));
    fireEvent.click(screen.getByTestId("feature-test-check-start"));
    await waitFor(() => expect(harness.run).toHaveBeenCalledTimes(1));
    const options = harness.run.mock.calls[0]![0];
    expect(options.scenes.map((scene) => scene.name)).toEqual(["FT_World"]);
    expect(options.breakdown).toMatchObject({ method: "water", tier: "medium" });
  });
});
