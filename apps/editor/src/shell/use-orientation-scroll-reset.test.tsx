import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOrientationScrollReset } from "./use-orientation-scroll-reset";

function Host() {
  useOrientationScrollReset();
  return (
    <div id="root">
      <input aria-label="Name" />
      <div data-testid="panel">Scrollable Panel</div>
    </div>
  );
}

function moveShell() {
  for (const element of [
    document.documentElement,
    document.body,
    document.getElementById("root")!,
  ]) {
    element.scrollTop = 400;
    element.scrollLeft = 20;
  }
}

function shellOffsets() {
  return [
    document.documentElement,
    document.body,
    document.getElementById("root")!,
  ].map((element) => [element.scrollLeft, element.scrollTop]);
}

describe("orientation scroll recovery", () => {
  let orientation: EventTarget;
  let viewport: EventTarget;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ],
    });
    orientation = new EventTarget();
    viewport = new EventTarget();
    vi.stubGlobal("screen", { orientation });
    vi.stubGlobal("visualViewport", viewport);
    // jsdom does not implement the browser's document scrolling command.
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    document.documentElement.scrollTop = 0;
    document.documentElement.scrollLeft = 0;
    document.body.scrollTop = 0;
    document.body.scrollLeft = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["window", "screen"])(
    "recovers shell offsets after %s orientation without moving panel content or focus",
    (source) => {
      const { getByTestId, getByRole } = render(<Host />);
      const panel = getByTestId("panel");
      panel.scrollTop = 75;
      const input = getByRole("textbox");
      input.focus();
      moveShell();

      if (source === "window")
        window.dispatchEvent(new Event("orientationchange"));
      else orientation.dispatchEvent(new Event("change"));
      vi.advanceTimersToNextFrame();

      expect(shellOffsets()).toEqual([
        [0, 0],
        [0, 0],
        [0, 0],
      ]);
      expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
      expect(panel.scrollTop).toBe(75);
      expect(document.activeElement).toBe(input);
    },
  );

  it("recovers offsets from delayed window and visual viewport resize events", () => {
    render(<Host />);
    window.dispatchEvent(new Event("orientationchange"));
    vi.advanceTimersToNextFrame();

    for (const target of [window, viewport]) {
      vi.advanceTimersByTime(200);
      moveShell();
      target.dispatchEvent(new Event("resize"));
      vi.advanceTimersToNextFrame();
      expect(shellOffsets()).toEqual([
        [0, 0],
        [0, 0],
        [0, 0],
      ]);
    }
  });

  it("leaves keyboard and ordinary resize offsets alone outside rotation recovery", () => {
    render(<Host />);
    moveShell();
    window.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("resize"));
    vi.advanceTimersToNextFrame();
    expect(shellOffsets()).toEqual([
      [20, 400],
      [20, 400],
      [20, 400],
    ]);

    orientation.dispatchEvent(new Event("change"));
    vi.advanceTimersByTime(2_000);
    moveShell();
    window.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("resize"));
    vi.advanceTimersToNextFrame();
    expect(shellOffsets()).toEqual([
      [20, 400],
      [20, 400],
      [20, 400],
    ]);
  });

  it("cancels pending recovery and removes listeners when unmounted", () => {
    const { unmount } = render(<Host />);
    moveShell();
    window.dispatchEvent(new Event("orientationchange"));
    unmount();
    window.dispatchEvent(new Event("orientationchange"));
    orientation.dispatchEvent(new Event("change"));
    viewport.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(2_000);
    expect(document.documentElement.scrollTop).toBe(400);
    expect(document.body.scrollTop).toBe(400);
    expect(window.scrollTo).not.toHaveBeenCalled();
  });
});
