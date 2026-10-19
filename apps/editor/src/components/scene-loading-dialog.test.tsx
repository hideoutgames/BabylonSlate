import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SceneLoadingDialog } from "./scene-loading-dialog";
import { blockingSceneLoadOpen } from "../lib/blocking-scene-loads";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SceneLoadingDialog", () => {
  it("offers Copy Error on a failure only when a copy handler is given, and copies its text", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const props = { open: true, progress: 40, phase: "Loading Models" as const, failed: true, onRetry: () => {}, onDismiss: () => {} };
    const { rerender } = render(<SceneLoadingDialog {...props} />);
    expect(screen.queryByRole("button", { name: "Copy Error" })).toBeNull();

    rerender(<SceneLoadingDialog {...props} onCopyDetails={() => "Error: shader compile failed"} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy Error" }));
    expect(writeText).toHaveBeenCalledWith("Error: shader compile failed");
    await waitFor(() => expect(screen.getByTestId("scene-loading-copy").textContent).toBe("Copied"));
  });

  // Background captures on the shared Engine wait while it holds the load.
  it("holds a blocking scene load while it shows a load's progress, not a failure, a rendering update or closed", () => {
    const props = { progress: 40, phase: "Loading Models" as const, onRetry: () => {}, onDismiss: () => {} };
    const { rerender, unmount } = render(<SceneLoadingDialog {...props} open />);
    expect(blockingSceneLoadOpen()).toBe(true);
    rerender(<SceneLoadingDialog {...props} open failed />);
    expect(blockingSceneLoadOpen()).toBe(false);
    rerender(<SceneLoadingDialog {...props} open rendering />);
    expect(blockingSceneLoadOpen()).toBe(false);
    rerender(<SceneLoadingDialog {...props} open />);
    expect(blockingSceneLoadOpen()).toBe(true);
    rerender(<SceneLoadingDialog {...props} open={false} />);
    expect(blockingSceneLoadOpen()).toBe(false);
    rerender(<SceneLoadingDialog {...props} open />);
    unmount();
    expect(blockingSceneLoadOpen()).toBe(false);
  });

  it("offers Copy Details while a scene is still loading", () => {
    render(<SceneLoadingDialog open progress={45} phase="Loading Models" onStop={() => {}} onCopyDetails={() => "details"} />);
    expect(screen.getByRole("button", { name: "Copy Details" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });
});
