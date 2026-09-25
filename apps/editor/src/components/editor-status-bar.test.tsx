import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorStatusBar } from "./editor-status-bar";

const state = vi.hoisted(() => ({
  dirtyDocuments: [] as Array<{ id: string }>,
  projectDirty: false,
  errorCount: 0,
  phone: false,
}));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    openDocuments: [{ id: "scene", ref: { label: "Main Scene" } }],
    activeDocumentId: "scene",
    dirtyDocuments: state.dirtyDocuments,
    projectDirty: state.projectDirty,
  }),
}));
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
