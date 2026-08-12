import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PlayPrepareDialog } from "./play-prepare-dialog";

afterEach(() => {
  cleanup();
});

describe("PlayPrepareDialog", () => {
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
