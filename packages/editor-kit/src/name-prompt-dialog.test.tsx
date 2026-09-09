import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NamePromptDialog } from "./name-prompt-dialog";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

afterEach(() => {
  cleanup();
});

describe("NamePromptDialog", () => {
  it("starts renames with the existing name and resets an abandoned edit on reopen", () => {
    const props = { onOpenChange: vi.fn(), onSubmit: vi.fn(), title: "Rename Event", label: "Event Name", initialValue: "On Hit" };
    const { rerender } = render(<NamePromptDialog {...props} open />);
    expect((screen.getByLabelText("Event Name") as HTMLInputElement).value).toBe("On Hit");
    fireEvent.change(screen.getByLabelText("Event Name"), { target: { value: "Abandoned" } });
    rerender(<NamePromptDialog {...props} open={false} />);
    rerender(<NamePromptDialog {...props} initialValue="On Damage" open />);
    expect((screen.getByLabelText("Event Name") as HTMLInputElement).value).toBe("On Damage");
  });

  it("keeps the prompt open with an accessible error when the host rejects the name", () => {
    const onSubmit = vi.fn();
    const onOpenChange = vi.fn();
    render(<NamePromptDialog open onOpenChange={onOpenChange} title="Name Parameter" label="Parameter Name" onSubmit={onSubmit} validate={(name) => name === "Tint" ? "Choose a unique name" : null} />);
    fireEvent.change(screen.getByTestId("name-prompt-input"), { target: { value: "Tint" } });
    fireEvent.click(screen.getByTestId("name-prompt-confirm"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByText("Choose a unique name")).toBeTruthy();
    expect(screen.getByTestId("name-prompt-input").getAttribute("aria-invalid")).toBe("true");
  });
  it("submits a trimmed name and ignores empty drafts", () => {
    const onSubmit = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <NamePromptDialog
        open
        onOpenChange={onOpenChange}
        title="Add Function"
        label="Function Name"
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(screen.getByTestId("name-prompt-confirm"));
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("name-prompt-input"), {
      target: { value: "  Jump  " },
    });
    fireEvent.click(screen.getByTestId("name-prompt-confirm"));
    expect(onSubmit).toHaveBeenCalledWith("Jump");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
