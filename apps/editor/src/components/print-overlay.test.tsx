import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { applyPrintHudCommand } from "@haptic/core";
import { PrintOverlay } from "./print-overlay";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PrintOverlay", () => {
  it("expires a duration-0 print after one frame without a render loop", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const entries = applyPrintHudCommand(
      [],
      { message: "flash", key: "hp", duration: 0 },
      1_000,
    );
    const { queryByText } = render(<PrintOverlay entries={entries} />);
    expect(queryByText("flash")).toBeTruthy();
    expect(raf).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(queryByText("flash")).toBeNull();
  });

  it("shows an empty message as a row that keeps its line height", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const entries = applyPrintHudCommand([], { message: "", key: "gap", duration: 5 }, 1_000);
    const { getByTestId } = render(<PrintOverlay entries={entries} />);
    const rows = Array.from(getByTestId("print-overlay").children);
    expect(rows).toHaveLength(1);
    // A truly empty block collapses to its padding; a no-break space keeps one text line.
    expect(rows[0]!.textContent).toBe(" ");
  });

  it("lists the newest print first so clipping drops the oldest", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let entries = applyPrintHudCommand([], { message: "first", key: "a", duration: 5 }, 1_000);
    entries = applyPrintHudCommand(entries, { message: "second", key: "b", duration: 5 }, 1_001);
    const { getByTestId } = render(<PrintOverlay entries={entries} />);
    const lines = Array.from(getByTestId("print-overlay").children).map((line) => line.textContent);
    expect(lines).toEqual(["second", "first"]);
  });
});
