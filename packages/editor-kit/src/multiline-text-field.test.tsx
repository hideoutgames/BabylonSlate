import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MultilineTextField } from "./multiline-text-field";

describe("MultilineTextField", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows a read-only trigger and edits in a large modal", async () => {
    const onChange = vi.fn();
    render(
      <MultilineTextField
        value="Hello overlay"
        onChange={onChange}
        title="Text"
        data-testid="ml"
      />,
    );
    const trigger = screen.getByTestId("ml");
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.textContent).toContain("Hello overlay");
    expect(screen.queryByTestId("ml-editor")).toBeNull();

    fireEvent.click(trigger);
    const editor = screen.getByTestId("ml-editor") as HTMLTextAreaElement;
    expect(editor.value).toBe("Hello overlay");
    fireEvent.change(editor, { target: { value: "World" } });
    fireEvent.click(screen.getByTestId("ml-done"));
    expect(onChange).toHaveBeenCalledWith("World");
    await waitFor(() => {
      expect(screen.queryByTestId("ml-editor")).toBeNull();
    });
  });

  it("hosts markup autocomplete inside the modal", () => {
    render(
      <MultilineTextField
        value="["
        onChange={() => {}}
        title="Rich Text"
        markup
        data-testid="rich"
      />,
    );
    fireEvent.click(screen.getByTestId("rich"));
    expect(screen.getByTestId("rich-editor-suggestions")).toBeTruthy();
    expect(screen.getByTestId("search-item-tag:b")).toBeTruthy();
  });
});
