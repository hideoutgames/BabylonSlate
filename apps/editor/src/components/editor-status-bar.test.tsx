import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorStatusBar } from "./editor-status-bar";

const state = vi.hoisted(() => ({
  recoveryAvailable: false,
  projectDirty: false,
  autoSaveStatus: null as { state: "saved" } | null,
}));

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: [],
  dirtyDocuments: [],
  activeDocumentId: null,
  projectDirty: state.projectDirty,
  autoSaveStatus: state.autoSaveStatus,
  recoveryAvailable: state.recoveryAvailable,
})));
vi.mock("../context/validation-context", () => ({ useValidation: () => ({ errorCount: 0 }) }));
vi.mock("../shell/use-platform-layout", () => ({ usePhoneLayout: () => false }));
vi.mock("../lib/build-identity", () => ({ getBuildLabel: () => "test" }));

afterEach(() => {
  cleanup();
  state.recoveryAvailable = false;
  state.projectDirty = false;
  state.autoSaveStatus = null;
});

describe("EditorStatusBar", () => {
  it("reads saved when nothing is waiting", () => {
    render(<EditorStatusBar />);
    expect(screen.getByRole("status").textContent).toBe("All Changes Saved");
  });

  it.each([null, { state: "saved" as const }])("never reads saved while edits wait for Recover or Discard (auto-save %j)", (autoSaveStatus) => {
    state.recoveryAvailable = true;
    state.autoSaveStatus = autoSaveStatus;
    render(<EditorStatusBar />);
    expect(screen.getByRole("status").textContent).toBe("Unrecovered Edits");
  });

  it("keeps naming unsaved project changes when edits also wait for recovery", () => {
    state.recoveryAvailable = true;
    state.projectDirty = true;
    render(<EditorStatusBar />);
    expect(screen.getByRole("status").textContent).toBe("Unsaved Project Changes");
  });
});
