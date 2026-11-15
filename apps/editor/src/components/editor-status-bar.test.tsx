import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceControlSyncService } from "../services/source-control-sync";
import { integratedSync } from "../testing/integrated-sync";
import { EditorStatusBar } from "./editor-status-bar";
import { SourceControlActionsProvider } from "./source-control-actions";

const state = vi.hoisted(() => ({
  recoveryAvailable: false,
  projectDirty: false,
  autoSaveStatus: null as { state: "saved" | "error"; message?: string } | null,
  sync: null as SourceControlSyncService | null,
  setActiveDocument: vi.fn(),
}));

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  openDocuments: [],
  dirtyDocuments: [],
  activeDocumentId: null,
  projectDirty: state.projectDirty,
  autoSaveStatus: state.autoSaveStatus,
  recoveryAvailable: state.recoveryAvailable,
  setActiveDocument: state.setActiveDocument,
  ...(state.sync ? { sourceControlSync: state.sync } : {}),
})));
vi.mock("../context/validation-context", () => ({ useValidation: () => ({ errorCount: 0 }) }));
vi.mock("../shell/use-platform-layout", () => ({ usePhoneLayout: () => false }));
vi.mock("../lib/build-identity", () => ({ getBuildLabel: () => "test" }));

afterEach(() => {
  cleanup();
  state.recoveryAvailable = false;
  state.projectDirty = false;
  state.autoSaveStatus = null;
  state.sync = null;
  state.setActiveDocument.mockClear();
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

    it("opens a menu with Commit…, Pull, Push, Refresh and Open Source Control", async () => {
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
        "Open Source Control",
      ]);
    });
  });
});
