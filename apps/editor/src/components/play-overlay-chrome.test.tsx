import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PlayOverlayChrome } from "./play-overlay-chrome";
import { StatsHud } from "./stats-hud";

afterEach(() => {
  cleanup();
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
});
