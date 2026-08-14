import { describe, expect, it, vi } from "vitest";
import { freezeLiveUiSurface, presentLiveUiIfVisible } from "./live-ui-present";

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

describe("freezeLiveUiSurface", () => {
  it("freezes when the dock tab or document workspace is hidden", () => {
    const setFrozen = vi.fn();
    freezeLiveUiSurface({ setFrozen }, { panelVisible: false, documentActive: true });
    freezeLiveUiSurface({ setFrozen }, { panelVisible: true, documentActive: false });
    expect(setFrozen.mock.calls.map((call) => call[0])).toEqual([true, true]);
  });

  it("unfreezes when the dock tab and document are visible", () => {
    const setFrozen = vi.fn();
    freezeLiveUiSurface({ setFrozen }, { panelVisible: true, documentActive: true });
    expect(setFrozen).toHaveBeenCalledWith(false);
  });
});
