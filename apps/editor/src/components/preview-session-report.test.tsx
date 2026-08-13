import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PreviewSessionReport } from "./preview-session-report";

describe("PreviewSessionReport", () => {
  afterEach(() => {
    cleanup();
  });

  it("opens as a centered dialog, not a bottom dock", () => {
    const onNavigate = vi.fn();
    render(
      <PreviewSessionReport
        open
        entries={[
          {
            severity: "error",
            code: "RUNTIME",
            message: "boom",
            count: 1,
            assetGuid: "asset-1",
            nodeId: "throw-node",
            frameId: 0,
            firstFrameId: 0,
            lastFrameId: 0,
          },
        ]}
        dropped={0}
        onOpenChange={() => {}}
        onNavigate={onNavigate}
      />,
    );

    const root = screen.getByTestId("preview-session-report");
    expect(root.getAttribute("data-slot")).toBe("dialog-content");
    expect(root.className).not.toMatch(/inset-x-0/);
    expect(root.className).not.toMatch(/bottom-0/);

    screen.getByTestId("session-report-row").click();
    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "throw-node" }),
    );
  });
});
