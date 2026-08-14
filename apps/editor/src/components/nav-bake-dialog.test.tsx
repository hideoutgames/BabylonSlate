import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { NavBakeDialog } from "./nav-bake-dialog";

afterEach(() => {
  cleanup();
});

describe("NavBakeDialog", () => {
  it("is non-dismissable while collecting geometry", () => {
    const { getByTestId } = render(
      <NavBakeDialog open phase="collecting" cancellable={false} />,
    );
    const dialog = getByTestId("nav-bake-dialog");
    expect(dialog.textContent).toMatch(/collecting geometry/i);
    expect(dialog.querySelector("[data-testid='nav-bake-cancel']")).toBeNull();
  });

  it("shows a cancel control once generate is in the worker", () => {
    const { getByTestId } = render(
      <NavBakeDialog
        open
        phase="generating"
        cancellable
        onCancel={() => {}}
      />,
    );
    expect(getByTestId("nav-bake-phase").textContent).toMatch(/generating/i);
    expect(getByTestId("nav-bake-cancel")).toBeTruthy();
  });
});
