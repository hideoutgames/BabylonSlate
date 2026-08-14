import { describe, expect, it, vi } from "vitest";
import { presentLiveUiIfVisible } from "./live-ui-present";

describe("presentLiveUiIfVisible", () => {
  it("presents when the dock tab and document are visible", () => {
    const present = vi.fn();
    presentLiveUiIfVisible({
      panelVisible: true,
      documentActive: true,
      present,
    });
    expect(present).toHaveBeenCalledTimes(1);
  });

  it("freezes when the dock tab is hidden", () => {
    const present = vi.fn();
    presentLiveUiIfVisible({
      panelVisible: false,
      documentActive: true,
      present,
    });
    expect(present).not.toHaveBeenCalled();
  });

  it("freezes when the document workspace is hidden", () => {
    const present = vi.fn();
    presentLiveUiIfVisible({
      panelVisible: true,
      documentActive: false,
      present,
    });
    expect(present).not.toHaveBeenCalled();
  });
});
