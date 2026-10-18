import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTENT_BROWSER_ID,
  CONTENT_BROWSER_REF,
  createDocumentRef,
} from "@babylonslate/core";
import type { CloseProjectResult } from "../context/document-context";
import type { OpenDocument } from "../services/document-service";
import EditorRoute from "./editor-route";

const state = vi.hoisted(() => ({
  documents: [] as OpenDocument[],
  projectDirty: false,
  closeProject: vi.fn(async (): Promise<CloseProjectResult> =>
    state.projectDirty ? { outcome: "unsaved", projectDirty: true, dirty: [] } : { outcome: "closed" }),
  releaseSessionsForProjectClose: vi.fn(async () => true),
  forceCloseProject: vi.fn(async () => true),
  saveAll: vi.fn(async () => true),
  setAutoSavePaused: vi.fn(),
  approveMigrationsAndSave: vi.fn(async () => true),
  migrationPromptRequest: 0,
  play: {} as Record<string, unknown>,
  closeDocument: vi.fn((id: string) => {
    state.documents = state.documents.filter((doc) => doc.id !== id);
  }),
}));

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: state.documents,
  dirtyDocuments: state.documents.filter((doc) => doc.dirty),
  projectDirty: state.projectDirty,
  closeProject: state.closeProject,
  releaseSessionsForProjectClose: state.releaseSessionsForProjectClose,
  forceCloseProject: state.forceCloseProject,
  migrationPending: [],
  migrationPromptRequest: state.migrationPromptRequest,
  pendingExclusiveScene: null,
  externalChangePrompt: null,
  cancelExclusiveSceneOpen: vi.fn(),
  saveAll: state.saveAll,
  setAutoSavePaused: state.setAutoSavePaused,
  approveMigrationsAndSave: state.approveMigrationsAndSave,
  closeDocument: state.closeDocument,
})));

// Keep the document menu and close dialogs real; omit unrelated engine hosts.
vi.mock("../components/editor-chrome-bar", async () => {
  const { DocumentSwitcher } = await import("../components/document-switcher");
  return {
    EditorChromeBar: ({
      onCloseDocument,
      onCloseAllDocuments,
      onCloseProject,
    }: {
      onCloseDocument: (id: string) => void;
      onCloseAllDocuments: () => void;
      onCloseProject: () => void;
    }) => (
      <>
      <button onClick={onCloseProject}>Close Project</button>
      <DocumentSwitcher
        documents={state.documents}
        activeDocumentId="scene"
        onSelect={() => {}}
        onClose={onCloseDocument}
        onCloseAll={onCloseAllDocuments}
      />
      </>
    ),
  };
});
vi.mock("../context/asset-open-provider", () => ({
  AssetOpenDocumentsProvider: ({ children }: { children: ReactNode }) =>
    children,
}));
vi.mock("../context/asset-create-provider", () => ({
  AssetCreateDocumentsProvider: ({ children }: { children: ReactNode }) =>
    children,
}));
vi.mock("../context/validation-context", () => ({
  ValidationProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../context/play-context", () => ({
  PlayProvider: ({ children }: { children: ReactNode }) => children,
  usePlay: () => state.play,
}));
vi.mock("../context/material-render-control-context", () => ({
  MaterialRenderControlProvider: ({ children }: { children: ReactNode }) =>
    children,
}));
vi.mock("../context/project-search-context", () => ({
  ProjectSearchProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../components/component-gallery", () => ({
  ComponentGallery: () => null,
}));
vi.mock("../components/editor-status-bar", () => ({
  EditorStatusBar: () => null,
}));
vi.mock("../components/document-workspace", () => ({
  DocumentWorkspace: () => null,
}));
vi.mock("../components/external-change-dialogs", () => ({
  ExternalChangeDialogs: () => null,
}));
vi.mock("../components/editor-utility-runtime", () => ({
  EditorUtilityRuntime: () => null,
}));
vi.mock("../components/model-thumbnail-capture-host", () => ({
  ModelThumbnailCaptureHost: () => null,
}));
vi.mock("../lib/test-audio-host-stats", () => ({
  TestAudioHostStats: () => null,
}));
vi.mock("../lib/test-particle-host-stats", () => ({
  TestParticleHostStats: () => null,
}));

beforeEach(() => {
  state.projectDirty = false;
  state.closeProject.mockClear();
  state.releaseSessionsForProjectClose.mockReset().mockResolvedValue(true);
  state.forceCloseProject.mockReset().mockResolvedValue(true);
  state.documents = [
    {
      id: CONTENT_BROWSER_ID,
      ref: CONTENT_BROWSER_REF,
      content: null,
      layout: null,
      dirty: false,
    },
    {
      id: "scene",
      ref: createDocumentRef("scene", "assets/Main.scene.babasset"),
      content: null,
      layout: null,
      dirty: true,
    },
    {
      id: "graph",
      ref: createDocumentRef("graph", "assets/Hero.class.babasset"),
      content: null,
      layout: null,
      dirty: true,
    },
    {
      id: "other",
      ref: createDocumentRef("graph", "assets/Other.class.babasset"),
      content: null,
      layout: null,
      dirty: false,
    },
  ];
  state.saveAll.mockReset().mockResolvedValue(true);
  state.approveMigrationsAndSave.mockReset().mockResolvedValue(true);
  state.migrationPromptRequest = 0;
  state.play = {};
  state.closeDocument.mockClear();
  state.setAutoSavePaused.mockClear();
});
afterEach(cleanup);

function requestBulkClose() {
  fireEvent.click(screen.getByRole("button", { name: "Open Documents" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Close Open Tab(s)" }));
}

describe("document tab close requests", () => {
  it.each([true, false])("includes project-only settings in close and unload protection (save result: %s)", async (saved) => {
    state.documents.forEach((doc) => { doc.dirty = false; });
    state.projectDirty = true;
    state.saveAll.mockImplementation(async () => {
      if (saved) state.projectDirty = false;
      return saved;
    });
    render(<EditorRoute />);
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close Project" }));
    await screen.findByTestId("dirty-close-dialog");
    expect(screen.getByRole("listitem").textContent).toBe("Project Settings");
    fireEvent.click(screen.getByTestId("dirty-save"));
    await waitFor(() => expect(state.saveAll).toHaveBeenCalledOnce());
    await waitFor(() => expect(state.closeProject).toHaveBeenCalledTimes(saved ? 2 : 1));
    if (saved) await waitFor(() => expect(screen.queryByTestId("dirty-close-dialog")).toBeNull());
    else expect(screen.getByTestId("dirty-close-dialog")).toBeTruthy();
    expect(state.forceCloseProject).not.toHaveBeenCalled();
  });

  it("rechecks settings changed during a save before closing the project", async () => {
    state.documents.forEach((doc) => { doc.dirty = false; });
    state.projectDirty = true;
    render(<EditorRoute />);
    fireEvent.click(screen.getByRole("button", { name: "Close Project" }));
    await screen.findByTestId("dirty-close-dialog");
    // The write succeeded, but newer project settings are still dirty.
    fireEvent.click(screen.getByTestId("dirty-save"));
    await waitFor(() => expect(state.closeProject).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("dirty-close-dialog")).toBeTruthy();
    expect(state.forceCloseProject).not.toHaveBeenCalled();
  });

  it("closes all clean document tabs and leaves Content Browser open", () => {
    state.documents.forEach((doc) => {
      doc.dirty = false;
    });
    render(<EditorRoute />);
    requestBulkClose();
    expect(state.documents.map((doc) => doc.id)).toEqual([CONTENT_BROWSER_ID]);
    expect(screen.queryByTestId("dirty-close-dialog")).toBeNull();
  });

  it("lists every dirty tab and cancels without closing any tabs", () => {
    render(<EditorRoute />);
    requestBulkClose();
    expect(
      screen.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual(["Main Scene", "Hero Class"]);
    fireEvent.click(screen.getByTestId("dirty-cancel"));
    expect(state.documents.map((doc) => doc.id)).toEqual([
      CONTENT_BROWSER_ID,
      "scene",
      "graph",
      "other",
    ]);
    expect(state.saveAll).not.toHaveBeenCalled();
  });

  it("discards all requested tabs through one prompt", () => {
    render(<EditorRoute />);
    requestBulkClose();
    fireEvent.click(screen.getByTestId("dirty-discard"));
    expect(state.documents.map((doc) => doc.id)).toEqual([CONTENT_BROWSER_ID]);
    expect(state.saveAll).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "closes tabs only after a successful save (save result: %s)",
    async (saved) => {
      state.saveAll.mockImplementation(async () => {
        if (saved) state.documents.forEach((doc) => { doc.dirty = false; });
        return saved;
      });
      render(<EditorRoute />);
      requestBulkClose();
      fireEvent.click(screen.getByTestId("dirty-save"));
      await waitFor(() => expect(state.saveAll).toHaveBeenCalledOnce());
      await waitFor(() =>
        expect(state.documents.map((doc) => doc.id)).toEqual(
          saved
            ? [CONTENT_BROWSER_ID]
            : [CONTENT_BROWSER_ID, "scene", "graph", "other"],
        ),
      );
    },
  );

  it.each(["tabs", "project"] as const)("Cancel stops a pending Save-close request for %s", async (target) => {
    let finishSave!: (saved: boolean) => void;
    state.saveAll.mockImplementation(() => new Promise((resolve) => { finishSave = resolve; }));
    if (target === "project") {
      state.documents.forEach((doc) => { doc.dirty = false; });
      state.projectDirty = true;
    }
    render(<EditorRoute />);
    if (target === "tabs") requestBulkClose();
    else fireEvent.click(screen.getByRole("button", { name: "Close Project" }));
    await screen.findByTestId("dirty-close-dialog");
    fireEvent.click(screen.getByTestId("dirty-save"));
    expect(screen.getByTestId("dirty-save")).toHaveProperty("disabled", true);
    await waitFor(() => expect(state.saveAll).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByTestId("dirty-cancel"));
    await act(async () => {
      state.documents.forEach((doc) => { doc.dirty = false; });
      state.projectDirty = false;
      finishSave(true);
    });
    expect(state.closeDocument).not.toHaveBeenCalled();
    expect(state.closeProject).toHaveBeenCalledTimes(target === "project" ? 1 : 0);
    await waitFor(() => expect(screen.queryByTestId("dirty-close-dialog")).toBeNull());
  });

  it("keeps the prompt and its tabs when Save All fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    state.saveAll.mockRejectedValue(new Error("Storage unavailable"));
    try {
      render(<EditorRoute />);
      requestBulkClose();
      fireEvent.click(screen.getByTestId("dirty-save"));
      await waitFor(() => expect(screen.getByTestId("dirty-save")).toHaveProperty("disabled", false));
      expect(error).toHaveBeenCalled();
      expect(state.closeDocument).not.toHaveBeenCalled();
      expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Main Scene", "Hero Class"]);
    } finally {
      error.mockRestore();
    }
  });

  it("keeps tabs open when edits remain dirty after a successful save", async () => {
    state.saveAll.mockImplementation(async () => {
      state.documents.forEach((doc) => { doc.dirty = doc.id === "graph"; });
      return true;
    });
    render(<EditorRoute />);
    requestBulkClose();
    fireEvent.click(screen.getByTestId("dirty-save"));
    await waitFor(() => expect(screen.getByTestId("dirty-save")).toHaveProperty("disabled", false));
    expect(state.closeDocument).not.toHaveBeenCalled();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Hero Class"]);
  });

  it.each(["dirty-cancel", "dirty-discard"])("holds auto-save while the tab prompt is open and resumes it after %s", (button) => {
    render(<EditorRoute />);
    expect(state.setAutoSavePaused).not.toHaveBeenCalledWith(true);
    requestBulkClose();
    expect(state.setAutoSavePaused).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByTestId(button));
    expect(state.setAutoSavePaused).toHaveBeenLastCalledWith(false);
  });

  it("lists only what is still unsaved when a save lands under the prompt", () => {
    const { rerender } = render(<EditorRoute />);
    requestBulkClose();
    state.documents.find((doc) => doc.id === "graph")!.dirty = false;
    rerender(<EditorRoute />);
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Main Scene"]);
    fireEvent.click(screen.getByTestId("dirty-discard"));
    expect(state.documents.map((doc) => doc.id)).toEqual([CONTENT_BROWSER_ID]);
  });

  it("closes the tabs without a prompt when everything listed was saved meanwhile", async () => {
    const { rerender } = render(<EditorRoute />);
    requestBulkClose();
    state.documents.forEach((doc) => { doc.dirty = false; });
    rerender(<EditorRoute />);
    await waitFor(() => expect(screen.queryByTestId("dirty-close-dialog")).toBeNull());
    expect(state.documents.map((doc) => doc.id)).toEqual([CONTENT_BROWSER_ID]);
    expect(state.setAutoSavePaused).toHaveBeenLastCalledWith(false);
  });

  it("still closes only the active tab for the individual close action", () => {
    render(<EditorRoute />);
    fireEvent.click(screen.getByRole("button", { name: "Open Documents" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Close Main Scene" }));
    fireEvent.click(screen.getByTestId("dirty-discard"));
    expect(state.documents.map((doc) => doc.id)).toEqual([
      CONTENT_BROWSER_ID,
      "graph",
      "other",
    ]);
  });
});

describe("project close requests", () => {
  beforeEach(() => {
    state.documents.forEach((doc) => { doc.dirty = false; });
  });

  it("asks a running session to stop only after Save All is chosen", async () => {
    state.projectDirty = true;
    state.saveAll.mockImplementation(async () => {
      state.projectDirty = false;
      return true;
    });
    render(<EditorRoute />);
    fireEvent.click(screen.getByRole("button", { name: "Close Project" }));
    await screen.findByTestId("dirty-close-dialog");
    expect(state.releaseSessionsForProjectClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("dirty-save"));
    await waitFor(() => expect(state.closeProject).toHaveBeenCalledTimes(2));
    expect(state.releaseSessionsForProjectClose.mock.invocationCallOrder[0])
      .toBeLessThan(state.saveAll.mock.invocationCallOrder[0]!);
  });

  it.each(["dirty-cancel", "dirty-discard"])("holds auto-save while the project prompt is open and resumes it after %s", async (button) => {
    state.projectDirty = true;
    render(<EditorRoute />);
    fireEvent.click(screen.getByRole("button", { name: "Close Project" }));
    await screen.findByTestId("dirty-close-dialog");
    expect(state.setAutoSavePaused).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByTestId(button));
    expect(state.setAutoSavePaused).toHaveBeenLastCalledWith(false);
  });

  it("lists the unsaved work live and closes without the prompt once it was saved meanwhile", async () => {
    state.documents.find((doc) => doc.id === "scene")!.dirty = true;
    state.projectDirty = true;
    const { rerender } = render(<EditorRoute />);
    fireEvent.click(screen.getByRole("button", { name: "Close Project" }));
    await screen.findByTestId("dirty-close-dialog");
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Main Scene", "Project Settings"]);

    state.projectDirty = false;
    rerender(<EditorRoute />);
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Main Scene"]);

    state.documents.find((doc) => doc.id === "scene")!.dirty = false;
    rerender(<EditorRoute />);
    await waitFor(() => expect(state.closeProject).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("dirty-close-dialog")).toBeNull());
    expect(state.forceCloseProject).not.toHaveBeenCalled();
  });

  it("reports a session that refuses to stop instead of listing unsaved work", async () => {
    state.closeProject.mockResolvedValueOnce({ outcome: "refused" });
    render(<EditorRoute />);
    fireEvent.click(screen.getByRole("button", { name: "Close Project" }));
    await screen.findByTestId("close-project-error-dialog");
    expect(screen.queryByTestId("dirty-close-dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("close-project-error-ok"));
    await waitFor(() => expect(screen.queryByTestId("close-project-error-dialog")).toBeNull());
  });

  it("reports a Discard whose close fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    state.projectDirty = true;
    state.forceCloseProject.mockRejectedValue(new Error("Journal unavailable"));
    try {
      render(<EditorRoute />);
      fireEvent.click(screen.getByRole("button", { name: "Close Project" }));
      await screen.findByTestId("dirty-close-dialog");
      fireEvent.click(screen.getByTestId("dirty-discard"));
      expect((await screen.findByTestId("close-project-error-dialog")).textContent).toContain("Journal unavailable");
      await waitFor(() => expect(screen.queryByTestId("dirty-close-dialog")).toBeNull());
    } finally {
      error.mockRestore();
    }
  });

  it("continues the close once Migrate On Save approves the Save All that migrations refused", async () => {
    state.projectDirty = true;
    state.saveAll.mockImplementation(async () => {
      if (state.projectDirty) {
        state.migrationPromptRequest += 1;
        return false;
      }
      return true;
    });
    state.approveMigrationsAndSave.mockImplementation(async () => {
      state.projectDirty = false;
      return true;
    });
    render(<EditorRoute />);
    fireEvent.click(screen.getByRole("button", { name: "Close Project" }));
    await screen.findByTestId("dirty-close-dialog");
    fireEvent.click(screen.getByTestId("dirty-save"));
    fireEvent.click(await screen.findByTestId("migrate-approve"));
    await waitFor(() => expect(state.closeProject).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("dirty-close-dialog")).toBeNull());
  });
});

describe("schema migration prompt", () => {
  it("opens when pending migrations refuse a Save All", () => {
    const { rerender } = render(<EditorRoute />);
    expect(screen.queryByTestId("migrate-on-save-dialog")).toBeNull();
    state.migrationPromptRequest = 1;
    rerender(<EditorRoute />);
    expect(screen.getByTestId("migrate-on-save-dialog")).toBeTruthy();
  });

  it("stays closed for a refusal made before the editor opened, such as in a closed project", () => {
    state.migrationPromptRequest = 1;
    const { rerender } = render(<EditorRoute />);
    expect(screen.queryByTestId("migrate-on-save-dialog")).toBeNull();
    state.migrationPromptRequest = 2;
    rerender(<EditorRoute />);
    expect(screen.getByTestId("migrate-on-save-dialog")).toBeTruthy();
  });

  it.each([true, false])("resumes a waiting Play only when Migrate On Save saved (saved: %s)", async (saved) => {
    const resume = vi.fn(async () => {});
    const cancel = vi.fn();
    state.play = { playAwaitingMigration: true, resumePlayAfterMigration: resume, cancelPlayMigration: cancel };
    state.approveMigrationsAndSave.mockResolvedValue(saved);
    render(<EditorRoute />);
    fireEvent.click(await screen.findByTestId("migrate-approve"));
    await waitFor(() => expect(saved ? resume : cancel).toHaveBeenCalledOnce());
    expect(saved ? cancel : resume).not.toHaveBeenCalled();
  });
});
