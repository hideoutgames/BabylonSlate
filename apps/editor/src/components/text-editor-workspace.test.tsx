import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTextEditorSessions,
  upsertTextEditorSession,
  type TextEditorSession,
} from "../services/text-editor-sessions";
import { TextEditorWorkspace } from "./text-editor-workspace";

const harness = vi.hoisted(() => ({ closeDocument: vi.fn() }));
vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => harness),
);

const ID = "graph:assets/A.class.hasset#node:n1:formula";
const TAB = `text-editor:${ID}`;
let commit: ReturnType<typeof vi.fn<(value: string) => void>>;

function session(overrides: Partial<TextEditorSession> = {}): TextEditorSession {
  return {
    id: ID, sourceDocumentId: "graph:assets/A.class.hasset", title: "Formula", mode: "formula",
    value: "y = 1", readOnly: false, names: [], error: null, commit, ...overrides,
  };
}

beforeEach(() => {
  commit = vi.fn<(value: string) => void>();
  harness.closeDocument.mockClear();
});

afterEach(() => {
  cleanup();
  clearTextEditorSessions();
});

describe("TextEditorWorkspace", () => {
  it("commits the draft once when focus leaves the editor", () => {
    upsertTextEditorSession(session());
    render(<TextEditorWorkspace documentId={TAB} sessionId={ID} active />);
    const editor = screen.getByRole("textbox", { name: "Formula" }) as HTMLTextAreaElement;
    expect(editor.value).toBe("y = 1");
    fireEvent.change(editor, { target: { value: "y = 2" } });
    expect(commit).not.toHaveBeenCalled();
    fireEvent.blur(editor, { relatedTarget: document.body });
    fireEvent.blur(editor, { relatedTarget: document.body });
    expect(commit.mock.calls).toEqual([["y = 2"]]);
  });

  it("commits when the tab stops being the active document and on close", () => {
    upsertTextEditorSession(session());
    const view = render(<TextEditorWorkspace documentId={TAB} sessionId={ID} active />);
    fireEvent.change(screen.getByRole("textbox", { name: "Formula" }), { target: { value: "y = 2" } });
    view.rerender(<TextEditorWorkspace documentId={TAB} sessionId={ID} active={false} />);
    expect(commit.mock.calls).toEqual([["y = 2"]]);
    view.rerender(<TextEditorWorkspace documentId={TAB} sessionId={ID} active />);
    fireEvent.change(screen.getByRole("textbox", { name: "Formula" }), { target: { value: "y = 3" } });
    view.unmount();
    expect(commit.mock.calls).toEqual([["y = 2"], ["y = 3"]]);
  });

  it("adopts a value committed elsewhere and shows the field's error", () => {
    upsertTextEditorSession(session());
    render(<TextEditorWorkspace documentId={TAB} sessionId={ID} active />);
    act(() => upsertTextEditorSession(session({ value: "y = (", error: "Line 1, column 6: Expected an expression" })));
    expect((screen.getByRole("textbox", { name: "Formula" }) as HTMLTextAreaElement).value).toBe("y = (");
    expect(screen.getByRole("alert").textContent).toBe("Line 1, column 6: Expected an expression");
    expect(commit).not.toHaveBeenCalled();
  });

  it("shows a read-only session's text without committing edits", () => {
    upsertTextEditorSession(session({ mode: "text", title: "Text", readOnly: true }));
    render(<TextEditorWorkspace documentId={TAB} sessionId={ID} active />);
    const editor = screen.getByRole("textbox", { name: "Text" }) as HTMLTextAreaElement;
    expect(editor.readOnly).toBe(true);
    fireEvent.change(editor, { target: { value: "changed" } });
    fireEvent.blur(editor, { relatedTarget: document.body });
    expect(commit).not.toHaveBeenCalled();
  });

  it("closes a tab whose session is gone", () => {
    render(<TextEditorWorkspace documentId={TAB} sessionId={ID} active />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(harness.closeDocument).toHaveBeenCalledWith(TAB);
  });
});
