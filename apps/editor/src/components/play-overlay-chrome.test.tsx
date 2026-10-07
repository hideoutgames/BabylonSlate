import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
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
  it("keeps Stop usable during Simulation pause acknowledgment and exposes Return To Game without Step", () => {
    const onInputModeChange = vi.fn();
    const onClose = vi.fn();
    const { getByTestId, queryByTestId } = renderChrome({
      paused: true, pausePending: true, onClose,
      simulation: { inputMode: "edit", inputPending: false, onInputModeChange },
    });
    expect((getByTestId("play-overlay-pause") as HTMLButtonElement).disabled).toBe(true);
    expect(queryByTestId("play-overlay-step")).toBeNull();
    fireEvent.click(getByTestId("simulation-input-mode"));
    expect(onInputModeChange).toHaveBeenCalledWith("game");
    fireEvent.click(getByTestId("play-overlay-close"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
