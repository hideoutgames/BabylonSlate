import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { PlayOverlayChrome } from "./play-overlay-chrome";
import { StatsHud } from "./stats-hud";
import { DiagnosticResultsStore } from "../services/diagnostic-results-store";

const diagnostics = vi.hoisted(() => ({ store: null as DiagnosticResultsStore | null }));
vi.mock("../context/diagnostic-results-context", () => ({
  useDiagnosticResultsStore: () => diagnostics.store,
}));

afterEach(() => {
  cleanup();
  diagnostics.store = null;
});

function renderChrome(
  overrides: Partial<Parameters<typeof PlayOverlayChrome>[0]> = {},
) {
  const onPauseToggle = vi.fn();
  const onStatsToggle = vi.fn();
  const onConsoleOpen = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <PlayOverlayChrome
      paused={false}
      statsOpen={false}
      onPauseToggle={onPauseToggle}
      onStatsToggle={onStatsToggle}
      onConsoleOpen={onConsoleOpen}
      onClose={onClose}
      stats={
        <StatsHud fps={60} scriptMs={1} physicsMs={2} draws={4} />
      }
      {...overrides}
    />,
  );
  return { ...view, onPauseToggle, onStatsToggle, onConsoleOpen, onClose };
}

describe("PlayOverlayChrome", () => {
  it("leaves Pause, Step and Stop to the global toolbar during Simulation", () => {
    const { getByTestId, queryByTestId } = renderChrome({ paused: true, simulating: true, onStep: vi.fn() });
    expect(queryByTestId("play-overlay-pause")).toBeNull();
    expect(queryByTestId("play-overlay-step")).toBeNull();
    expect(queryByTestId("play-overlay-close")).toBeNull();
    expect(getByTestId("play-stats-toggle")).toBeTruthy();
  });

  it("shows Recording while a recording runs, even with the Profiler button hidden, and Stop Recording opens its Summary", async () => {
    const store = new DiagnosticResultsStore();
    const stopProfile = vi.fn(async () => null);
    store.bindSession({
      mode: "play",
      startProfile: async () => {},
      stopProfile,
      captureFrame: async () => { throw new Error("Unavailable"); },
    });
    diagnostics.store = store;
    const { getByTestId, queryByTestId } = renderChrome({ showProfiler: false });
    expect(queryByTestId("play-profiler-recording")).toBeNull();

    await act(() => store.startProfile({ durationMs: 1000, byteBudget: 1 << 20 }));
    expect(getByTestId("play-profiler-recording").textContent).toContain("Recording");
    fireEvent.click(getByTestId("play-profiler-recording-stop"));
    await waitFor(() => expect(queryByTestId("play-profiler-recording")).toBeNull());
    expect(stopProfile).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toMatchObject({ open: true, view: "summary" });
  });
});
