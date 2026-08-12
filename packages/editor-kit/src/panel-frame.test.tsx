import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PanelFrame } from "./panel-frame";

afterEach(() => {
  cleanup();
});

describe("PanelFrame", () => {
  it("omits the header when title and toolbar are absent", () => {
    const { getByTestId, queryByRole } = render(
      <PanelFrame data-testid="frame">
        <p>Body</p>
      </PanelFrame>,
    );

    expect(getByTestId("frame").querySelector("header")).toBeNull();
    expect(queryByRole("heading")).toBeNull();
  });

  it("renders a toolbar-only header without a duplicate title", () => {
    const { getByTestId, queryByRole } = render(
      <PanelFrame
        data-testid="frame"
        toolbar={<button type="button">Add</button>}
      >
        <p>Body</p>
      </PanelFrame>,
    );

    expect(getByTestId("frame").querySelector("header")).not.toBeNull();
    expect(queryByRole("heading")).toBeNull();
    expect(getByTestId("frame").querySelector("header")?.textContent).toContain(
      "Add",
    );
  });

  it("renders a title heading when provided", () => {
    const { getByRole } = render(
      <PanelFrame title="Outliner">
        <p>Body</p>
      </PanelFrame>,
    );

    expect(getByRole("heading", { name: "Outliner" })).toBeTruthy();
  });
});
