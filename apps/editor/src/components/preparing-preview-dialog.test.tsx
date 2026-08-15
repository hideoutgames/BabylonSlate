import { describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";
import { PreparingPreviewDialog } from "./preparing-preview-dialog";

afterEach(() => {
  cleanup();
});

describe("PreparingPreviewDialog", () => {
  it("shows determinate phase progress", () => {
    render(
      <PreparingPreviewDialog open phase="Collecting Assets" canCancel={false} />,
    );
    expect(screen.getByTestId("preparing-preview-dialog")).toBeTruthy();
    expect(screen.getByText("Collecting Assets")).toBeTruthy();
    expect(screen.getByText("3 / 5")).toBeTruthy();
    expect(screen.queryByTestId("preparing-preview-cancel")).toBeNull();
  });
});
