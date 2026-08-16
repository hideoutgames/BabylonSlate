import { describe, expect, it, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { UiEditorModeBar } from "./ui-editor-mode-bar";

afterEach(() => {
  cleanup();
});

describe("UiEditorModeBar", () => {
  it("toggles Designer and Logic outside DockView", () => {
    const onModeChange = vi.fn();
    const { getByTestId, rerender } = render(
      <UiEditorModeBar mode="designer" onModeChange={onModeChange} />,
    );
    const designer = getByTestId("ui-editor-mode-designer");
    const logic = getByTestId("ui-editor-mode-logic");
    expect(designer.getAttribute("aria-pressed")).toBe("true");
    expect(logic.getAttribute("aria-pressed")).toBe("false");
    logic.click();
    expect(onModeChange).toHaveBeenCalledWith("logic");
    rerender(<UiEditorModeBar mode="logic" onModeChange={onModeChange} />);
    expect(getByTestId("ui-editor-mode-logic").getAttribute("aria-pressed")).toBe(
      "true",
    );
  });
});
