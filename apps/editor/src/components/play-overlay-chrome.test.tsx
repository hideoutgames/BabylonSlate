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
  it("keeps the stats dump collapsed until Stats is tapped", () => {
    const { getByTestId } = renderChrome();
    expect(getByTestId("stats-hud").closest("[hidden]")).toBeTruthy();
    expect(getByTestId("play-fps").getAttribute("data-fps")).toBe("60");
    expect(getByTestId("play-stats-toggle").textContent).toContain("Stats");
  });

  it("shows the full stats dump after Stats is pressed", () => {
    const { getByTestId } = renderChrome({ statsOpen: true });
    expect(getByTestId("stats-hud").closest("[hidden]")).toBeNull();
    expect(getByTestId("play-fps").textContent).toContain("fps");
  });

  it("labels Pause, Console, and Stop on 44px targets", () => {
    const { getByTestId } = renderChrome();
    const pause = getByTestId("play-overlay-pause");
    const stats = getByTestId("play-stats-toggle");
    const consoleButton = getByTestId("play-console-open");
    const close = getByTestId("play-overlay-close");
    expect(pause.textContent).toContain("Pause");
    expect(stats.textContent).toContain("Stats");
    expect(consoleButton.textContent).toContain("Console");
    expect(close.textContent).toContain("Stop");
    for (const button of [pause, stats, consoleButton, close]) {
      expect(button.className).toContain("min-h-[var(--touch-target,44px)]");
    }
  });

  it("relabels Pause to Resume while the session is paused", () => {
    const { getByTestId } = renderChrome({ paused: true });
    expect(getByTestId("play-overlay-pause").textContent).toContain("Resume");
  });

  it("invokes pause, stats, console, and close from the labeled controls", () => {
    const view = renderChrome();
    fireEvent.click(view.getByTestId("play-overlay-pause"));
    fireEvent.click(view.getByTestId("play-stats-toggle"));
    fireEvent.click(view.getByTestId("play-console-open"));
    fireEvent.click(view.getByTestId("play-overlay-close"));
    expect(view.onPauseToggle).toHaveBeenCalledTimes(1);
    expect(view.onStatsToggle).toHaveBeenCalledTimes(1);
    expect(view.onConsoleOpen).toHaveBeenCalledTimes(1);
    expect(view.onClose).toHaveBeenCalledTimes(1);
  });

  it("shows extras such as the audio unlock hint on Play chrome", () => {
    const { getByTestId } = renderChrome({
      extras: (
        <p data-testid="play-audio-unlock-hint">
          Click the game view to enable audio
        </p>
      ),
    });
    expect(getByTestId("play-audio-unlock-hint").textContent).toContain(
      "Click the game view to enable audio",
    );
  });

  it("hides the stats dump when Stats chrome is off even if Stats is open", () => {
    const { getByTestId } = renderChrome({
      statsOpen: true,
      showStats: false,
    });
    expect(getByTestId("stats-hud").closest("[hidden]")).toBeTruthy();
  });

  it("hides Stats, Console, and Inspector when overlay chrome is off", () => {
    const { queryByTestId } = renderChrome({
      showStats: false,
      showConsole: false,
      showInspector: false,
    });
    expect(queryByTestId("play-stats-toggle")).toBeNull();
    expect(queryByTestId("play-console-open")).toBeNull();
    expect(queryByTestId("play-inspector-toggle")).toBeNull();
    expect(queryByTestId("play-overlay-pause")).not.toBeNull();
    expect(queryByTestId("play-overlay-close")).not.toBeNull();
  });

  it("shows Inspector pressed while the inspector is open", () => {
    const onInspectorToggle = vi.fn();
    const { getByTestId } = renderChrome({
      inspectorOpen: true,
      onInspectorToggle,
    });
    const inspector = getByTestId("play-inspector-toggle");
    expect(inspector.textContent).toContain("Inspector");
    expect(inspector.getAttribute("aria-pressed")).toBe("true");
    expect(inspector.className).toContain("min-h-[var(--touch-target,44px)]");
    fireEvent.click(inspector);
    expect(onInspectorToggle).toHaveBeenCalledTimes(1);
  });

  it("shows Step next to Resume while paused", () => {
    const onStep = vi.fn();
    const { getByTestId } = renderChrome({ paused: true, onStep });
    const step = getByTestId("play-overlay-step");
    expect(step.textContent).toContain("Step");
    expect(step.className).toContain("min-h-[var(--touch-target,44px)]");
    fireEvent.click(step);
    expect(onStep).toHaveBeenCalledTimes(1);
  });

  it("hides Step while the session is running", () => {
    const { queryByTestId } = renderChrome({ paused: false });
    expect(queryByTestId("play-overlay-step")).toBeNull();
  });
});
