import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MultilineTextField } from "./multiline-text-field";
import { flushTextDrafts } from "./text-draft";

describe("MultilineTextField", () => {
  afterEach(() => {
    cleanup();
  });

  it("edits inline and commits once when focus leaves the field, not per keystroke", () => {
    const onChange = vi.fn();
    render(<MultilineTextField label="Text" value="Hello" onChange={onChange} data-testid="ml" />);
    const editor = screen.getByTestId("ml-editor") as HTMLTextAreaElement;
    expect(editor.tagName).toBe("TEXTAREA");
    expect(editor.value).toBe("Hello");
    fireEvent.change(editor, { target: { value: "Hello W" } });
    fireEvent.change(editor, { target: { value: "Hello World" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(editor, { relatedTarget: document.body });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("Hello World");
    // A second blur with the same draft does not commit again.
    fireEvent.blur(editor, { relatedTarget: document.body });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not commit an unchanged draft or a blur that stays inside the field", () => {
    const onChange = vi.fn();
    render(
      <MultilineTextField
        label="Text"
        value="Same"
        onChange={onChange}
        renderEditor={(value, set) => (
          <>
            <textarea aria-label="Body" value={value} onChange={(event) => set(event.target.value)} />
            <button type="button">Completion</button>
          </>
        )}
        data-testid="ml"
      />,
    );
    const editor = screen.getByLabelText("Body");
    fireEvent.blur(editor, { relatedTarget: document.body });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(editor, { target: { value: "Other" } });
    // Focus moving to a completion list inside the field is not leaving it.
    fireEvent.blur(editor, { relatedTarget: screen.getByRole("button", { name: "Completion" }) });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows markup text in a plain fixed-height textarea, without the tag catalog", () => {
    render(<MultilineTextField label="Text" value="[b]Hi[/b]" onChange={() => {}} markup data-testid="ml" />);
    const editor = screen.getByTestId("ml-editor") as HTMLTextAreaElement;
    expect(editor.tagName).toBe("TEXTAREA");
    expect(editor.value).toBe("[b]Hi[/b]");
    expect(editor.className).toContain("h-24");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("commits a pending draft before opening the tab", () => {
    const calls: string[] = [];
    render(
      <MultilineTextField label="Text" value="Old" onChange={(value) => calls.push(`commit:${value}`)}
        onOpenInTab={() => calls.push("open")} data-testid="ml" />,
    );
    fireEvent.change(screen.getByTestId("ml-editor"), { target: { value: "New" } });
    fireEvent.click(screen.getByTestId("ml-open-tab"));
    expect(calls).toEqual(["commit:New", "open"]);
  });

  it("commits every mounted pending draft on flushTextDrafts, keeping focus", () => {
    const onChange = vi.fn();
    render(<MultilineTextField label="Text" value="A" onChange={onChange} data-testid="ml" />);
    const editor = screen.getByTestId("ml-editor") as HTMLTextAreaElement;
    editor.focus();
    fireEvent.change(editor, { target: { value: "B" } });
    flushTextDrafts();
    expect(onChange.mock.calls).toEqual([["B"]]);
    expect(document.activeElement).toBe(editor);
    flushTextDrafts();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("adopts an external value change even with a draft typed", () => {
    const onChange = vi.fn();
    const view = render(<MultilineTextField label="Text" value="First" onChange={onChange} data-testid="ml" />);
    fireEvent.change(screen.getByTestId("ml-editor"), { target: { value: "Typed" } });
    view.rerender(<MultilineTextField label="Text" value="Second" onChange={onChange} data-testid="ml" />);
    expect((screen.getByTestId("ml-editor") as HTMLTextAreaElement).value).toBe("Second");
    fireEvent.blur(screen.getByTestId("ml-editor"), { relatedTarget: document.body });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("commits a pending draft on unmount through the latest onChange", () => {
    const first = vi.fn();
    const latest = vi.fn();
    const view = render(<MultilineTextField label="Text" value="A" onChange={first} data-testid="ml" />);
    fireEvent.change(screen.getByTestId("ml-editor"), { target: { value: "B" } });
    view.rerender(<MultilineTextField label="Text" value="A" onChange={latest} data-testid="ml" />);
    view.unmount();
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith("B");
  });

  it("shows the Open in Tab button in the label row only with onOpenInTab, also when disabled", () => {
    const view = render(<MultilineTextField label="Formula" value="" onChange={() => {}} data-testid="ml" />);
    expect(screen.queryByTestId("ml-open-tab")).toBeNull();
    const onOpenInTab = vi.fn();
    view.rerender(
      <MultilineTextField label="Formula" value="" onChange={() => {}} disabled onOpenInTab={onOpenInTab} data-testid="ml" />,
    );
    const button = screen.getByRole("button", { name: "Open Formula in Tab" });
    expect(button.getAttribute("data-testid")).toBe("ml-open-tab");
    const row = screen.getByTestId("ml-label-row");
    expect(row.contains(button)).toBe(true);
    expect(row.textContent).toContain("Formula");
    // Directly after the label, not pushed to the far end.
    expect(button.previousElementSibling?.textContent).toBe("Formula");
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("ml-editor") as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(onOpenInTab).toHaveBeenCalledTimes(1);
  });

  it("labels the inline editor and hosts a custom editor with the draft", () => {
    const onChange = vi.fn();
    render(
      <MultilineTextField
        label="Function Body"
        id="body"
        value="return 1;"
        onChange={onChange}
        code
        renderEditor={(value, set) => (
          <textarea aria-label="Custom" value={value} onChange={(event) => set(event.target.value)} />
        )}
        data-testid="ml"
      />,
    );
    const custom = screen.getByLabelText("Custom") as HTMLTextAreaElement;
    expect(custom.value).toBe("return 1;");
    fireEvent.change(custom, { target: { value: "return 2;" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(custom, { relatedTarget: document.body });
    expect(onChange).toHaveBeenCalledWith("return 2;");
  });
});
