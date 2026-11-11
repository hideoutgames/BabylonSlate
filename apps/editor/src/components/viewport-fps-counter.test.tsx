import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FPS_UPDATE_MS, fpsTone, framesPerSecond } from "../lib/viewport-fps";
import { ViewportFpsCounter } from "./viewport-fps-counter";

const prefs = vi.hoisted(() => ({ showFps: true }));
vi.mock("../lib/viewport-engine-prefs", () => ({
  useEditorViewportPrefs: () => ({ showFps: prefs.showFps }),
}));

describe("fpsTone", () => {
  it("is green from 55, yellow from 25, orange from 15 and red below", () => {
    expect([90, 55, 54, 25, 24, 15, 14, 0].map(fpsTone)).toEqual(
      ["good", "good", "fair", "fair", "poor", "poor", "bad", "bad"]);
  });
});

describe("framesPerSecond", () => {
  it("rounds frames over the sampled span to a whole number", () => {
    expect(framesPerSecond([{ at: 0, frames: 0 }, { at: 1000, frames: 59.6 }])).toBe(60);
    expect(framesPerSecond([{ at: 0, frames: 10 }, { at: 250, frames: 17 }, { at: 500, frames: 25 }])).toBe(30);
  });

  it("has no reading from a single sample", () => {
    expect(framesPerSecond([{ at: 0, frames: 0 }])).toBeNull();
  });
});

describe("ViewportFpsCounter", () => {
  let frames = 0;
  const scheduler = () => ({ stats: () => ({ renderedFrames: frames }) });

  beforeEach(() => {
    vi.useFakeTimers();
    frames = 0;
    prefs.showFps = true;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const tick = (rendered: number) => act(() => {
    frames += rendered;
    vi.advanceTimersByTime(FPS_UPDATE_MS);
  });

  it("updates four times a second with whole frames per second and its tone", () => {
    render(<ViewportFpsCounter scheduler={scheduler} />);
    expect(screen.queryByTestId("viewport-fps")).toBeNull();
    tick(15);
    expect(screen.getByTestId("viewport-fps").textContent).toBe("60 FPS");
    expect(screen.getByTestId("viewport-fps").getAttribute("data-tone")).toBe("good");
    tick(2);
    tick(2);
    tick(2);
    // 21 frames over the last second.
    expect(screen.getByTestId("viewport-fps").textContent).toBe("21 FPS");
    expect(screen.getByTestId("viewport-fps").getAttribute("data-tone")).toBe("poor");
  });

  it("keeps its samples when the host re-renders with a new scheduler getter", () => {
    const { rerender } = render(<ViewportFpsCounter scheduler={() => scheduler()} />);
    tick(15);
    rerender(<ViewportFpsCounter scheduler={() => scheduler()} />);
    expect(screen.getByTestId("viewport-fps").textContent).toBe("60 FPS");
  });

  it("shows nothing while Show FPS is off or the Engine is not running", () => {
    prefs.showFps = false;
    const { rerender } = render(<ViewportFpsCounter scheduler={scheduler} />);
    tick(15);
    expect(screen.queryByTestId("viewport-fps")).toBeNull();
    prefs.showFps = true;
    rerender(<ViewportFpsCounter scheduler={() => null} />);
    tick(15);
    expect(screen.queryByTestId("viewport-fps")).toBeNull();
  });
});
