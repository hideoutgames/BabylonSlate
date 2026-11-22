import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS } from "@haptic/core";
import { SyncError } from "@haptic/source-control";
import { MemoryStorageAdapter } from "@haptic/vfs";
import type { OpenDocument } from "../services/document-service";
import { SourceControlSyncService } from "../services/source-control-sync";
import { INTEGRATED_REPOSITORY, integratedSync } from "../testing/integrated-sync";
import { EditorStatusBar } from "./editor-status-bar";
import { SourceControlActionsProvider, useSourceControlActions } from "./source-control-actions";

const state = vi.hoisted(() => ({
  recoveryAvailable: false,
  journalPaused: false,
  projectDirty: false,
  autoSaveStatus: null as { state: "saved" | "error"; message?: string } | null,
  sync: null as SourceControlSyncService | null,
  setActiveDocument: vi.fn(),
  activeDocumentId: null as string | null,
  openDocuments: [] as OpenDocument[],
}));

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: state.openDocuments,
  dirtyDocuments: [],
  activeDocumentId: state.activeDocumentId,
  projectDirty: state.projectDirty,
  autoSaveStatus: state.autoSaveStatus,
  recoveryAvailable: state.recoveryAvailable,
  journalPaused: state.journalPaused,
  setActiveDocument: state.setActiveDocument,
  ...(state.sync ? { sourceControlSync: state.sync } : {}),
})));
vi.mock("../context/validation-context", () => ({ useValidation: () => ({ errorCount: 0 }) }));
vi.mock("../shell/use-platform-layout", () => ({ usePhoneLayout: () => false }));
vi.mock("../lib/build-identity", () => ({ getBuildLabel: () => "test" }));

afterEach(() => {
  cleanup();
  state.recoveryAvailable = false;
  state.journalPaused = false;
  state.projectDirty = false;
  state.autoSaveStatus = null;
  state.sync = null;
  state.setActiveDocument.mockClear();
  state.activeDocumentId = null;
  state.openDocuments = [];
});

function renderIntegrated() {
  return render(
    <SourceControlActionsProvider>
      <EditorStatusBar />
    </SourceControlActionsProvider>,
  );
}

describe("EditorStatusBar", () => {
  it("reads saved when nothing is waiting, without naming the open document", () => {
    render(<EditorStatusBar />);
    expect(screen.getByRole("status").textContent).toBe("All Changes Saved");
    expect(screen.getByTestId("editor-status-bar").querySelector(".editor-status-summary")!.textContent).toBe("All Changes Saved");
    expect(screen.queryByTestId("status-source-control")).toBeNull();
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

  it("says crash recovery paused, over unsaved work, until a save restarts it", () => {
    state.journalPaused = true;
    state.projectDirty = true;
    render(<EditorStatusBar />);
    expect(screen.getByRole("status").textContent).toBe("Crash Recovery Paused — Use Save All");
    expect(screen.getByRole("status").getAttribute("title")).toMatch(/storage is full/i);
  });

  describe("in Integrated mode", () => {
    it("leads with the branch, the change count, Pull and Push, and shrinks the save state to Saved", async () => {
      const { service, storage, remote } = await integratedSync();
      state.sync = service;
      await storage.writeText("assets/Forest.scene.hasset", "F2");
      remote.commit({ "assets/Rock.texture.hasset": "R2" }, "Teammate");
      await service.refresh();
      renderIntegrated();
      const bar = screen.getByTestId("status-source-control");
      expect(within(bar).getByTestId("status-source-control-menu").getAttribute("aria-label")).toBe("Source Control Menu: Branch main");
      expect(within(bar).getByTestId("status-source-control-changes").textContent).toBe("1 Change");
      expect(within(bar).getByTestId("status-source-control-pull-button").textContent).toBe("Pull 1");
      expect(within(bar).queryByTestId("status-source-control-push-button")).toBeNull();
      expect(screen.getByRole("status").textContent).toBe("Saved");
      fireEvent.click(within(bar).getByTestId("status-source-control-changes"));
      expect(state.setActiveDocument).toHaveBeenCalledWith("source-control");
    });

    it("keeps a save problem on the right", async () => {
      const { service } = await integratedSync();
      state.sync = service;
      state.autoSaveStatus = { state: "error", message: "Disk full" };
      renderIntegrated();
      expect(screen.getByRole("status").textContent).toBe("Auto-Save Failed — Use Save All");
    });

    it("replaces Pull and Push with the running transfer", async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      // The lock check is the push's first step: hold it there while the bar shows the transfer.
      const { service, storage } = await integratedSync({
        locks: {
          theirs: async () => {
            await held;
            return [];
          },
        },
      });
      state.sync = service;
      await storage.writeText("assets/Forest.scene.hasset", "F2");
      await service.commit({ rowIds: new Set(["assets/Forest.scene.hasset"]), message: "Forest", push: false });
      renderIntegrated();
      expect(screen.getByTestId("status-source-control-push-button").textContent).toBe("Push 1");
      let pushing!: Promise<void>;
      act(() => {
        pushing = service.push();
      });
      expect((await screen.findByTestId("status-source-control-transfer")).textContent).toContain("Pushing 1 Commit");
      expect(screen.queryByTestId("status-source-control-push-button")).toBeNull();
      await act(async () => {
        release();
        await pushing;
      });
      expect(screen.queryByTestId("status-source-control-transfer")).toBeNull();
      expect(screen.queryByTestId("status-source-control-push-button")).toBeNull();
    });

    it("names a refused push and leads to the Changes window that says why", async () => {
      const { service, storage } = await integratedSync({
        locks: { theirs: async (paths) => paths.map((path) => ({ id: "1", path, ownerName: "Sam", lockedAt: "", ours: false })) },
      });
      state.sync = service;
      await storage.writeText("assets/Forest.scene.hasset", "F2");
      await service.commit({ rowIds: new Set(["assets/Forest.scene.hasset"]), message: "Forest", push: false });
      renderIntegrated();
      await act(async () => {
        fireEvent.click(screen.getByTestId("status-source-control-push-button"));
      });
      const problem = await screen.findByTestId("status-source-control-problem");
      expect(problem.textContent).toBe("Could Not Push");
      expect(problem.getAttribute("title")).toContain("Sam");
      // Still unpushed.
      expect(screen.getByTestId("status-source-control-push-button").textContent).toBe("Push 1");
      fireEvent.click(problem);
      expect(state.setActiveDocument).toHaveBeenCalledWith("source-control");
    });

    it("opens a menu with Commit…, Pull, Push, Refresh, the branch actions, Open Source Control and Open History", async () => {
      const { service } = await integratedSync();
      state.sync = service;
      renderIntegrated();
      fireEvent.click(screen.getByTestId("status-source-control-menu"));
      const items = await screen.findAllByRole("menuitem");
      expect(items.map((item) => item.textContent?.replace(/\d+ (Changes?|Commits?)$/, "").trim())).toEqual([
        "Commit…",
        "Pull",
        "Push",
        "Refresh",
        "Switch Branch",
        "New Branch…",
        "Open Source Control",
        "Open History",
      ]);
    });

    it("lists this copy's branches and the remote's under Switch Branch, and switching asks first", async () => {
      const { service, remote } = await integratedSync();
      remote.commit({ "assets/Rock.texture.hasset": "R-art" }, "Art", "art");
      state.sync = service;
      renderIntegrated();
      fireEvent.click(screen.getByTestId("status-source-control-menu"));
      fireEvent.click(await screen.findByTestId("status-source-control-switch-branch"));
      const current = await screen.findByTestId("status-source-control-branch-main");
      expect(current.getAttribute("aria-checked")).toBe("true");
      const art = await screen.findByTestId("status-source-control-remote-art");
      await act(async () => {
        fireEvent.click(art);
      });
      // A switch rewrites files, so it is confirmed first; nothing has changed yet.
      expect((await screen.findByTestId("source-control-switch-confirm")).textContent).toContain("Switch To art?");
      expect(service.getSnapshot().branch).toBe("main");
    });

    it("names no branch, with why, when the repository could not open on a detached HEAD", async () => {
      const storage = new MemoryStorageAdapter("documents");
      const folder = await storage.openDocumentsProject("Game");
      const detached = "This working copy has no branch checked out. Check out a branch with the Git app that left it, then open the project again.";
      const service = new SourceControlSyncService();
      await service.configure({
        settings: { ...DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS, mode: "integrated", repositoryUrl: INTEGRATED_REPOSITORY, branch: "main" },
        folder,
        storage,
        platform: "web",
        testMode: true,
        lookup: () => null,
        locks: { theirs: async () => [], releaseOwn: async () => {} },
        exclusiveWrites: (_reason, work) => work(storage),
        factory: {
          open: async () => {
            throw new SyncError("conflict", detached, { code: "detached-head" });
          },
          init: async () => {
            throw new Error("Not published here.");
          },
          author: async () => ({ name: "ada", email: "" }),
          readAdoption: async () => false,
          setAdoption: async () => {},
        },
      });
      state.sync = service;
      renderIntegrated();
      const menu = screen.getByTestId("status-source-control-menu");
      expect(menu.textContent).toBe("No Branch Checked Out");
      expect(menu.getAttribute("aria-label")).toBe("Source Control Menu: No Branch Checked Out");
      fireEvent.click(menu);
      // Not the project's default branch marked as checked out, and no branch to start another from.
      expect(screen.queryByTestId("status-source-control-branch-main")).toBeNull();
      expect((await screen.findByTestId("status-source-control-new-branch")).getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(screen.getByTestId("status-source-control-switch-branch"));
      expect((await screen.findByTestId("status-source-control-no-branch")).textContent).toContain(detached);
      expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0);
    });

    it("opens History on the asset in the active tab", async () => {
      const { service } = await integratedSync();
      state.sync = service;
      state.activeDocumentId = "scene:assets/Forest.scene.hasset";
      state.openDocuments = [{ id: "scene:assets/Forest.scene.hasset", ref: { kind: "scene", path: "assets/Forest.scene.hasset", label: "Forest" }, content: {}, layout: null, dirty: false }];
      let historyPath: string | null = null;
      function Probe() {
        historyPath = useSourceControlActions().historyPath;
        return null;
      }
      render(
        <SourceControlActionsProvider>
          <EditorStatusBar />
          <Probe />
        </SourceControlActionsProvider>,
      );
      fireEvent.click(screen.getByTestId("status-source-control-menu"));
      await act(async () => {
        fireEvent.click(await screen.findByTestId("status-source-control-history"));
      });
      expect(state.setActiveDocument).toHaveBeenCalledWith("source-control");
      expect(historyPath).toBe("assets/Forest.scene.hasset");
    });
  });
});
