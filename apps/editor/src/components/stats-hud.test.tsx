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
    expect(screen.getByTestId("stats-hud-draws").textContent).toContain("12");
    expect(screen.getByTestId("stats-hud-draws").getAttribute("data-draws")).toBe(
      "12",
    );
    expect(screen.getByTestId("stats-hud-graph")).toBeTruthy();
  });

  it("stays quiet when the tick is inside budget", () => {
    render(<StatsHud fps={60} scriptMs={3} physicsMs={2} />);
    expect(screen.getByTestId("stats-hud-within-budget")).toBeTruthy();
    expect(screen.queryByTestId("stats-hud-over-budget")).toBeNull();
    expect(screen.getByTestId("play-physics-ms").getAttribute("data-ms")).toBe(
      "2",
    );
    expect(screen.getByTestId("play-fps").getAttribute("data-fps")).toBe("60");
  });

  it("warns when draw calls exceed the ceiling", () => {
    render(<StatsHud fps={60} scriptMs={1} physicsMs={1} draws={401} />);
    expect(screen.getByTestId("stats-hud-draw-warn")).toBeTruthy();
  });

  it("warns when accounted geometry bytes exceed the ceiling", () => {
    render(
      <StatsHud
        fps={60}
        scriptMs={1}
        physicsMs={1}
        geometryBytes={512 * 1024 * 1024 + 1}
      />,
    );
    expect(screen.getByTestId("stats-hud-geo").textContent).toMatch(/geo/i);
    expect(screen.getByTestId("stats-hud-geo-warn")).toBeTruthy();
  });

  it("marks the highlighted stats row", () => {
    render(
      <StatsHud fps={60} scriptMs={1} physicsMs={1} draws={12} highlight="unit" />,
    );
    expect(screen.getByTestId("stats-hud").getAttribute("data-highlight")).toBe(
      "unit",
    );
  });
});
