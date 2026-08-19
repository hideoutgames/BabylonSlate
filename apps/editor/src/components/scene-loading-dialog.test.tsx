import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SceneLoadingDialog } from "./scene-loading-dialog";

afterEach(() => {
  cleanup();
});

describe("SceneLoadingDialog", () => {
  it("shows uncancelable determinate progress while a scene remounts", () => {
    render(
      <SceneLoadingDialog open progress={50} phase="Loading Models" />,
    );
    const dialog = screen.getByTestId("scene-loading-dialog");
    expect(dialog.textContent).toContain("Loading Scene");
    expect(dialog.textContent).toContain("Loading Models");
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
    expect(dialog.querySelector("[data-slot='progress']")).not.toBeNull();
  });

  it("hides when closed", () => {
    render(
      <SceneLoadingDialog open={false} progress={100} phase="Loading Models" />,
    );
    expect(screen.queryByTestId("scene-loading-dialog")).toBeNull();
  });
});
