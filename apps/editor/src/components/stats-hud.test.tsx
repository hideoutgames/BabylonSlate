import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StatsHud } from "./stats-hud";

describe("StatsHud", () => {
  afterEach(() => {
    cleanup();
  });

  it("flags a combined tick over the 8ms budget", () => {
    render(
      <StatsHud
        fps={60}
        scriptMs={5}
        physicsMs={4}
        memoryBytes={2048}
        meshCount={3}
        textureCount={2}
        draws={12}
        bridgeMessagesPerSec={40}
      />,
    );
    expect(screen.getByTestId("stats-hud-over-budget")).toBeTruthy();
    expect(screen.getByTestId("stats-hud-memory").textContent).toContain("KB");
    expect(screen.getByTestId("stats-hud-graph")).toBeTruthy();
  });

  it("stays quiet when the tick is inside budget", () => {
    render(<StatsHud fps={60} scriptMs={3} physicsMs={2} />);
    expect(screen.getByTestId("stats-hud-within-budget")).toBeTruthy();
    expect(screen.queryByTestId("stats-hud-over-budget")).toBeNull();
  });
});
