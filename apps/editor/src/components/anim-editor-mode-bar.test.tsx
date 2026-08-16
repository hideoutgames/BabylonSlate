import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { AnimEditorModeBar } from "./anim-editor-mode-bar";

describe("AnimEditorModeBar", () => {
  it("toggles State Machine and Animation Object", () => {
    const onModeChange = vi.fn();
    const { getByTestId, rerender } = render(
      <AnimEditorModeBar mode="stateMachine" onModeChange={onModeChange} />,
    );
    expect(getByTestId("anim-editor-mode-bar")).toBeTruthy();
    fireEvent.click(getByTestId("anim-editor-mode-animation-object"));
    expect(onModeChange).toHaveBeenCalledWith("animationObject");
    rerender(
      <AnimEditorModeBar mode="animationObject" onModeChange={onModeChange} />,
    );
    fireEvent.click(getByTestId("anim-editor-mode-state-machine"));
    expect(onModeChange).toHaveBeenCalledWith("stateMachine");
  });
});
