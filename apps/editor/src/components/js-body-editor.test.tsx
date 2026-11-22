import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { EditorReadOnlyContext } from "@haptic/editor-kit";
import { EditorView } from "@codemirror/view";
import { CodeBodyEditor } from "./js-body-editor";

afterEach(cleanup);

it("blocks code transactions during the document lock while preserving selection and source updates", () => {
  const onChange = vi.fn();
  const editor = (readOnly: boolean, value: string) =>
    <EditorReadOnlyContext.Provider value={readOnly}>
      <CodeBodyEditor language="javascript" value={value} onChange={onChange} />
    </EditorReadOnlyContext.Provider>;
  const { container, rerender } = render(editor(false, "let value = 1;"));
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!;
  act(() => view.dispatch({ changes: { from: 12, to: 13, insert: "2" } }));
  expect(onChange).toHaveBeenLastCalledWith("let value = 2;");

  rerender(editor(true, "let value = 2;"));
  onChange.mockClear();
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "replaced" } }));
  expect(view.state.doc.toString()).toBe("let value = 2;");
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Complete" }).hasAttribute("disabled")).toBe(true);
  act(() => view.dispatch({ selection: { anchor: 4, head: 9 } }));
  expect(view.state.selection.main.from).toBe(4);
  expect(view.state.selection.main.to).toBe(9);

  rerender(editor(true, "let value = 3;"));
  expect(view.state.doc.toString()).toBe("let value = 3;");
  expect(onChange).not.toHaveBeenCalled();
  rerender(editor(false, "let value = 3;"));
  act(() => view.dispatch({ changes: { from: 12, to: 13, insert: "4" } }));
  expect(onChange).toHaveBeenLastCalledWith("let value = 4;");
});

it("keeps the caret outside the span an external value changes", () => {
  const editor = (value: string) => <CodeBodyEditor language="javascript" value={value} onChange={vi.fn()} />;
  const { container, rerender } = render(editor("const a = 1;\nconst b = 2;"));
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!;
  act(() => view.dispatch({ selection: { anchor: 6, head: 7 } }));
  rerender(editor("const a = 1;\nconst b = 3;"));
  expect(view.state.doc.toString()).toBe("const a = 1;\nconst b = 3;");
  expect(view.state.selection.main.from).toBe(6);
  expect(view.state.selection.main.to).toBe(7);
});

it("compact: no status line or symbol bar, and a diagnostic's body line still moves the caret to it", () => {
  const body = Array.from({ length: 60 }, (_, index) => `const line${index + 1} = ${index + 1};`).join("\n");
  const editor = (bodyLine?: number) =>
    <CodeBodyEditor language="javascript" value={body} onChange={vi.fn()} compact bodyLine={bodyLine} />;
  const { container, rerender } = render(editor());
  expect(screen.queryByTestId("js-accessory-bar")).toBeNull();
  expect(screen.queryByText(/Ctrl\+Space: Complete/)).toBeNull();
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!;
  rerender(editor(40));
  expect(view.state.selection.main.head).toBe(view.state.doc.line(40).from);
});
