import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { EditorReadOnlyContext } from "@haptic/editor-kit";
import { EditorView } from "@codemirror/view";
import { completionStatus } from "@codemirror/autocomplete";
import { defaultEngineSettings } from "@haptic/vfs";
import { MemoryAppSettingsStore } from "@haptic/vfs/test-support/memory-app-settings";
import { AppSettingsProvider } from "../context/app-settings-context";
import { KeybindProvider, useKeybindings } from "../context/keybind-context";
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

it("compact: no symbol bar, and a diagnostic's body line still moves the caret to it", () => {
  const body = Array.from({ length: 60 }, (_, index) => `const line${index + 1} = ${index + 1};`).join("\n");
  const editor = (bodyLine?: number) =>
    <CodeBodyEditor language="javascript" value={body} onChange={vi.fn()} compact bodyLine={bodyLine} />;
  const { container, rerender } = render(editor());
  expect(screen.queryByTestId("js-accessory-bar")).toBeNull();
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!;
  rerender(editor(40));
  expect(view.state.selection.main.head).toBe(view.state.doc.line(40).from);
});

it("shows no language or key hint bar in either variant or language", () => {
  for (const language of ["javascript", "glsl"] as const) {
    for (const compact of [false, true]) {
      const { unmount } = render(<CodeBodyEditor language={language} value="x" onChange={vi.fn()} compact={compact} />);
      expect(screen.queryByText(/^(JavaScript|GLSL)$/)).toBeNull();
      expect(screen.queryByText(/Ctrl\+Space|Esc: Dismiss/)).toBeNull();
      unmount();
    }
  }
});

describe("completion keys", () => {
  const press = (view: EditorView, init: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    act(() => { view.contentDOM.dispatchEvent(event); });
    return event;
  };
  const CTRL_SPACE = { key: " ", code: "Space", keyCode: 32, ctrlKey: true };
  const ENTER = { key: "Enter", code: "Enter", keyCode: 13 };
  const ESCAPE = { key: "Escape", code: "Escape", keyCode: 27 };
  /** "spe" with the caret at its end; the pin name `speed` completes it. */
  const mount = (wrap: (editor: ReactNode) => ReactNode = (editor) => editor) => {
    const onChange = vi.fn();
    const { container } = render(wrap(<CodeBodyEditor language="javascript" value="spe" names={["speed"]} onChange={onChange} />));
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor")!)!;
    act(() => view.dispatch({ selection: { anchor: 3 } }));
    return { view, onChange };
  };
  const listOpens = async (view: EditorView) => {
    await waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    // Accept ignores presses within its interaction delay (75 ms) of the list opening.
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
  };
  const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 150)));

  it("opens with Ctrl+Space, accepts with Enter and dismisses with Escape by default", async () => {
    const { view } = mount();
    const outside = vi.fn();
    view.dom.parentElement!.addEventListener("keydown", (event) => { if (event.key === "Escape") outside(); });

    // With no list open, Escape keeps its plain editing meaning and reaches the editor's host.
    press(view, ESCAPE);
    expect(outside).toHaveBeenCalledTimes(1);

    expect(press(view, CTRL_SPACE).defaultPrevented).toBe(true);
    await listOpens(view);
    press(view, ESCAPE);
    expect(completionStatus(view.state)).toBeNull();
    // A dismissing Escape stops there, so a dialog around the editor stays open.
    expect(outside).toHaveBeenCalledTimes(1);

    press(view, CTRL_SPACE);
    await listOpens(view);
    press(view, ENTER);
    expect(view.state.doc.toString()).toBe("speed");
    expect(completionStatus(view.state)).toBeNull();

    // Enter with no list open inserts a line.
    press(view, ENTER);
    expect(view.state.doc.toString()).toBe("speed\n");
  });

  it("follows rebound and unassigned keys from Engine Settings", async () => {
    const store = new MemoryAppSettingsStore();
    await store.save({ ...defaultEngineSettings(), keybinds: {
      "code.complete": ["Ctrl+J"], "code.acceptCompletion": [], "code.dismissCompletion": ["Shift+Escape"],
    } });
    function Hydrated() {
      return <span data-testid="complete-chords">{useKeybindings().get("code.complete")?.join(",")}</span>;
    }
    // The editor mounts with the defaults and picks the saved keys up once settings load.
    const { view, onChange } = mount((editor) => (
      <AppSettingsProvider store={store}><KeybindProvider><Hydrated />{editor}</KeybindProvider></AppSettingsProvider>
    ));
    await waitFor(() => expect(screen.getByTestId("complete-chords").textContent).toBe("Ctrl+J"));
    // Rebinding reconfigures the editor in place rather than recreating it.
    expect(view.dom.isConnected).toBe(true);

    press(view, CTRL_SPACE);
    await settle();
    expect(completionStatus(view.state)).toBeNull();

    press(view, { key: "j", code: "KeyJ", keyCode: 74, ctrlKey: true });
    await listOpens(view);
    // Escape no longer dismisses; Shift+Escape does.
    press(view, ESCAPE);
    expect(completionStatus(view.state)).toBe("active");
    press(view, { ...ESCAPE, shiftKey: true });
    expect(completionStatus(view.state)).toBeNull();

    // With Accept unassigned, Enter inserts a line while the list is open.
    press(view, { key: "j", code: "KeyJ", keyCode: 74, ctrlKey: true });
    await listOpens(view);
    press(view, ENTER);
    expect(view.state.doc.toString()).toBe("spe\n");
    expect(onChange).toHaveBeenLastCalledWith("spe\n");
  });
});
