import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorStatusBar } from "./editor-status-bar";

const state = vi.hoisted(() => ({
  dirtyDocuments: [] as Array<{ id: string }>,
  projectDirty: false,
  autoSaveStatus: null as ReturnType<typeof import("../context/document-context").useDocuments>["autoSaveStatus"],
  errorCount: 0,
  phone: false,
}));

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: [{ id: "scene", ref: { label: "Main Scene" } }],
  activeDocumentId: "scene",
  dirtyDocuments: state.dirtyDocuments,
  projectDirty: state.projectDirty,
  autoSaveStatus: state.autoSaveStatus,
})));
vi.mock("../context/validation-context", () => ({
  useValidation: () => ({ errorCount: state.errorCount }),
}));
vi.mock("../shell/use-platform-layout", () => ({
  usePhoneLayout: () => state.phone,
}));

beforeEach(() => {
  vi.stubGlobal("__BABYLONSLATE_BUILD_LABEL__", "0.0.1 Development build");
  state.dirtyDocuments = [];
  state.projectDirty = false;
  state.autoSaveStatus = null;
  state.errorCount = 0;
  state.phone = false;
});

afterEach(cleanup);

describe("EditorStatusBar", () => {
  it("reports a clean project, the active document, and the build", () => {
    render(<EditorStatusBar />);
    const bar = screen.getByTestId("editor-status-bar");
    expect(bar.textContent).toContain("All Changes Saved");
    expect(bar.textContent).toContain("Main Scene");
    expect(bar.textContent).toContain("0.0.1 Development build");
  });

  it("counts unsaved documents before project-only changes", () => {
    state.dirtyDocuments = [{ id: "a" }, { id: "b" }];
    state.projectDirty = true;
    const { rerender } = render(<EditorStatusBar />);
    expect(screen.getByTestId("editor-status-bar").textContent).toContain(
      "2 Unsaved Documents",
    );
    state.dirtyDocuments = [];
    rerender(<EditorStatusBar />);
    expect(screen.getByTestId("editor-status-bar").textContent).toContain(
      "Unsaved Project Changes",
    );
  });

  it("distinguishes automatic saving, success, failure, and newer unsaved edits", () => {
    state.autoSaveStatus = { state: "saving" };
    const { rerender } = render(<EditorStatusBar />);
    expect(screen.getByRole("status").textContent).toContain("Auto-Saving");
    state.autoSaveStatus = { state: "saved" };
    rerender(<EditorStatusBar />);
    expect(screen.getByRole("status").textContent).toContain("Auto-Saved");
    state.dirtyDocuments = [{ id: "new-edit" }];
    rerender(<EditorStatusBar />);
    expect(screen.getByRole("status").textContent).toContain("1 Unsaved Document");
    state.autoSaveStatus = { state: "error", message: "Storage unavailable" };
    rerender(<EditorStatusBar />);
    expect(screen.getByRole("status").textContent).toContain("Auto-Save Failed");
    expect(screen.getByRole("status").title).toBe("Storage unavailable");
  });

  it("shows compile errors", () => {
    state.errorCount = 1;
    render(<EditorStatusBar />);
    expect(screen.getByTestId("editor-status-bar").textContent).toContain(
      "1 Error",
    );
  });

  it("is omitted on phone layouts", () => {
    state.phone = true;
    render(<EditorStatusBar />);
    expect(screen.queryByTestId("editor-status-bar")).toBeNull();
  });
});
