import { StrictMode, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MultilineTextField } from "@haptic/editor-kit";
import { TextEditorWorkspace } from "../components/text-editor-workspace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentRef } from "@haptic/core";
import type { OpenDocument } from "../services/document-service";
import {
  clearTextEditorSessions,
  getTextEditorSession,
  listTextEditorSessions,
} from "../services/text-editor-sessions";
import { useTextEditorTab, type TextEditorTabOptions } from "./use-text-editor-tab";

const SOURCE = "graph:assets/Player.class.hasset";
const SESSION = `${SOURCE}#node:n1:formula`;
const TAB = `text-editor:${SESSION}`;

const harness = vi.hoisted(() => ({
  openTransientDocument: vi.fn((ref: { kind: string; path: string }) => `${ref.kind}:${ref.path}`),
  closeDocument: vi.fn(),
  openDocuments: [] as unknown[],
}));

vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({ documentId: SOURCE }),
}));
vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => harness),
);

let open: (() => void) | undefined;
function Field(props: Partial<TextEditorTabOptions>) {
  open = useTextEditorTab({
    fieldKey: "node:n1:formula",
    title: "Formula",
    mode: "formula",
    value: "y = 1",
    onChange: () => {},
    ...props,
  });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  harness.openTransientDocument.mockClear();
  harness.closeDocument.mockClear();
  harness.openDocuments = [{
    id: SOURCE,
    ref: { kind: "graph", path: "assets/Player.class.hasset", label: "Player Class" },
    content: { nodes: [], edges: [] },
    layout: null,
    dirty: false,
  } satisfies OpenDocument];
});

afterEach(() => {
  cleanup();
  act(() => vi.runAllTimers());
  vi.useRealTimers();
  clearTextEditorSessions();
});

describe("useTextEditorTab", () => {
  it("opens one Text Editor tab for the field, named after it and its document, and reopening reuses it", () => {
    render(<Field />);
    expect(listTextEditorSessions()).toEqual([]);
    act(() => open!());
    const ref: DocumentRef = { kind: "text-editor", path: SESSION, label: "Formula: Player Class" };
    expect(harness.openTransientDocument.mock.calls).toEqual([[ref]]);
    expect(getTextEditorSession(SESSION)).toMatchObject({ sourceDocumentId: SOURCE, mode: "formula", value: "y = 1", readOnly: false });
    act(() => open!());
    expect(harness.openTransientDocument.mock.calls).toEqual([[ref], [ref]]);
    expect(listTextEditorSessions()).toHaveLength(1);
  });

  it("keeps the session current and commits through the field's latest onChange", () => {
    const first = vi.fn();
    const latest = vi.fn();
    const view = render(<Field onChange={first} />);
    act(() => open!());
    view.rerender(<Field onChange={latest} value="y = 2" error="Line 1" disabled />);
    expect(getTextEditorSession(SESSION)).toMatchObject({ value: "y = 2", error: "Line 1", readOnly: true });
    getTextEditorSession(SESSION)!.commit("y = 3");
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith("y = 3");
  });

  it("closes the tab when the field unmounts", () => {
    const view = render(<Field />);
    act(() => open!());
    view.unmount();
    expect(harness.closeDocument).not.toHaveBeenCalled();
    act(() => vi.runAllTimers());
    expect(harness.closeDocument.mock.calls).toEqual([[TAB]]);
    expect(getTextEditorSession(SESSION)).toBeUndefined();
  });

  it("keeps the tab through StrictMode's effect replay and a field that remounts at once", () => {
    const view = render(<StrictMode><Field key="a" /></StrictMode>);
    act(() => open!());
    act(() => vi.runAllTimers());
    view.rerender(<StrictMode><Field key="b" /></StrictMode>);
    act(() => vi.runAllTimers());
    expect(harness.closeDocument).not.toHaveBeenCalled();
    expect(getTextEditorSession(SESSION)).toBeDefined();
  });

  it("opens the tab on text typed inline but not yet committed", () => {
    const committed: string[] = [];
    function FormulaField() {
      const [value, setValue] = useState("y = 1");
      const onChange = (next: string) => {
        committed.push(next);
        setValue(next);
      };
      const openInTab = useTextEditorTab({ fieldKey: "node:n1:formula", title: "Formula", mode: "formula", value, onChange });
      return <MultilineTextField label="Formula" value={value} onChange={onChange} onOpenInTab={openInTab} data-testid="formula" />;
    }
    render(<FormulaField />);
    fireEvent.change(screen.getByTestId("formula-editor"), { target: { value: "y = 2" } });
    fireEvent.click(screen.getByTestId("formula-open-tab"));
    expect(committed).toEqual(["y = 2"]);
    expect(harness.openTransientDocument).toHaveBeenCalledTimes(1);
    // The session follows the committed value, and the tab shows it.
    expect(getTextEditorSession(SESSION)?.value).toBe("y = 2");
    render(<TextEditorWorkspace documentId={TAB} sessionId={SESSION} active />);
    expect((screen.getByRole("textbox", { name: "Formula" }) as HTMLTextAreaElement).value).toBe("y = 2");
  });

  it("does not reopen a tab the user closed while the field stays", () => {
    const view = render(<Field />);
    act(() => open!());
    act(() => clearTextEditorSessions());
    view.rerender(<Field value="y = 5" />);
    expect(getTextEditorSession(SESSION)).toBeUndefined();
    view.unmount();
    act(() => vi.runAllTimers());
    expect(harness.closeDocument).not.toHaveBeenCalled();
  });
});
