import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  it("offers Retry and Close after failure without showing successful progress", () => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    render(<SceneLoadingDialog open failed progress={70} phase="Warming Shaders" onRetry={onRetry} onDismiss={onDismiss} />);
    expect(screen.getByRole("dialog").textContent).toContain("Scene Loading Failed");
    expect(screen.queryByTestId("scene-loading-progress")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
