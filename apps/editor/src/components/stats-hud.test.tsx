import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { StatsHud } from "./stats-hud";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const barCount = (container: HTMLElement) =>
  container.querySelector('[data-testid="stats-hud-graph"]')!.children.length;

describe("StatsHud", () => {
  it("samples the Unit graph only while it is visible", () => {
    const hud = (visible: boolean) => (
      <StatsHud fps={60} scriptMs={1} physicsMs={2} groups={["unit"]} visible={visible} />
    );
    const view = render(hud(false));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(barCount(view.container)).toBe(1);

    view.rerender(hud(true));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(barCount(view.container)).toBe(6);

    view.rerender(hud(false));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(barCount(view.container)).toBe(6);
  });
});
