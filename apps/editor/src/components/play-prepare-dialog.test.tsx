import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { PlayPrepareDialog } from "./play-prepare-dialog";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("PlayPrepareDialog", () => {
  it("explains a long preparation without offering unsafe save cancellation", () => {
    vi.useFakeTimers();
    render(<PlayPrepareDialog open phase="saving" dirtyNames={["Main"]} />);
    expect(screen.queryByText(/Taking longer than usual/)).toBeNull();
    act(() => vi.advanceTimersByTime(10000));
    expect(screen.getByText(/Taking longer than usual/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
  it("lists dirty document names and the current prepare phase", () => {
    const { getByTestId } = render(
      <PlayPrepareDialog
        open
        phase="saving"
        dirtyNames={["main.graph.babasset", "main.scene.babasset"]}
      />,
    );

    const dialog = getByTestId("play-prepare-dialog");
    expect(dialog.textContent).toContain("main.graph.babasset");
    expect(dialog.textContent).toContain("main.scene.babasset");
    expect(getByTestId("play-prepare-phase").textContent).toBe("Saving…");
  });

  it("shows compiling when save is already done", () => {
    const { getByTestId } = render(
      <PlayPrepareDialog open phase="compiling" dirtyNames={[]} />,
    );

    expect(getByTestId("play-prepare-phase").textContent).toBe("Compiling…");
  });
});
