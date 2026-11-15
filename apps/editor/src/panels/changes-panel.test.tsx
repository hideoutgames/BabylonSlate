import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceControlService } from "../services/source-control-service";
import type { SourceControlSyncService } from "../services/source-control-sync";
import { deviceIntegratedSync, integratedSync } from "../testing/integrated-sync";
import { SourceControlActionsProvider } from "../components/source-control-actions";
import { ChangesPanelContents } from "./changes-panel";

// jsdom has no PointerEvent; Base UI's Checkbox dispatches one on click.
if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {}
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const state = vi.hoisted(() => ({
  sync: null as SourceControlSyncService | null,
  setAdoption: null as ((adopted: boolean) => Promise<void>) | null,
}));

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({
    ...(state.sync ? { sourceControlSync: state.sync } : {}),
    ...(state.setAdoption ? { setSourceControlAdoption: state.setAdoption } : {}),
  })),
);

afterEach(() => {
  cleanup();
  state.sync?.dispose();
  state.sync = null;
  state.setAdoption = null;
});

function renderPanel() {
  return render(
    <SourceControlActionsProvider>
      <ChangesPanelContents />
    </SourceControlActionsProvider>,
  );
}

describe("Changes window", () => {
  it("asks before running Git in a desktop working copy a stored Integrated mode reached, and opens it once accepted", async () => {
    const desktop = await deviceIntegratedSync({ adopted: false });
    state.sync = desktop.service;
    state.setAdoption = desktop.setAdoption;
    renderPanel();
    expect(screen.getByTestId("changes-blocked").textContent).toContain("Haptic Does Not Run Git In This Folder Yet");
    expect(screen.queryByTestId("changes-commit")).toBeNull();

    // Cancel stores nothing; the blocker stays.
    fireEvent.click(screen.getByTestId("changes-adopt"));
    expect((await screen.findByTestId("source-control-adopt-confirm")).textContent).toContain("No other Git app may use it at the same time");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("source-control-adopt-confirm")).toBeNull());
    expect(desktop.adoption.adopted).toBe(false);
    expect(screen.getByTestId("changes-blocked")).toBeTruthy();

    fireEvent.click(screen.getByTestId("changes-adopt"));
    await act(async () => {
      fireEvent.click(await screen.findByTestId("source-control-adopt-confirm-action"));
    });
    expect(desktop.adoption.adopted).toBe(true);
    await waitFor(() => expect(screen.getByTestId("changes-branch").textContent).toBe("main"));
    expect(screen.queryByTestId("changes-blocked")).toBeNull();
  });

  it("keeps the warning open with the reason when the answer cannot be recorded, while the folder is read again", async () => {
    const desktop = await deviceIntegratedSync({ adopted: false });
    state.sync = desktop.service;
    state.setAdoption = desktop.setAdoption;
    vi.spyOn(desktop.factory, "setAdoption").mockRejectedValueOnce(new Error("The folder is read-only."));
    renderPanel();
    fireEvent.click(screen.getByTestId("changes-adopt"));
    await act(async () => {
      fireEvent.click(await screen.findByTestId("source-control-adopt-confirm-action"));
    });
    expect((await screen.findByTestId("source-control-adopt-error")).textContent).toContain("The folder is read-only.");
    expect(screen.getByTestId("changes-blocked").textContent).toContain("Haptic Does Not Run Git In This Folder Yet");
    expect(desktop.adoption.adopted).toBe(false);
  });

  it("offers nothing to accept where another app owns the folder", async () => {
    state.sync = (await deviceIntegratedSync({ adopted: false, platform: "ios", tier: "external" })).service;
    renderPanel();
    expect(screen.getByTestId("changes-blocked").textContent).toBe("Another Git App Syncs This Folder");
    expect(screen.queryByTestId("changes-adopt")).toBeNull();
  });

  it("commits only the included assets with the message, then pushes", async () => {
    const { service, storage, remote } = await integratedSync();
    state.sync = service;
    await storage.writeText("assets/Forest.scene.hasset", "F2");
    await storage.writeText("assets/Rock.texture.hasset", "R2");
    await service.refreshStatus();
    renderPanel();
    expect(screen.getByTestId("changes-count").textContent).toBe("2");
    expect(screen.getByTestId("changes-row-assets/Forest.scene.hasset").textContent).toContain("M");
    const commit = screen.getByTestId("changes-commit");
    expect(commit.textContent).toBe("Commit 2 Assets");
    // No message, no commit.
    expect(commit.hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(screen.getByTestId("changes-row-assets/Rock.texture.hasset")).getByRole("checkbox", { name: "Include Rock" }));
    expect(commit.textContent).toBe("Commit 1 Asset");
    fireEvent.change(screen.getByTestId("changes-commit-message"), { target: { value: "Greener forest" } });
    await act(async () => {
      fireEvent.click(commit);
    });
    // Pushed: the remote branch holds the commit.
    await waitFor(() => expect(remote.get(remote.branches.get("main")!).message).toBe("Greener forest"));
    const head = remote.get(remote.branches.get("main")!);
    await waitFor(() => expect(service.getSnapshot().operation).toBeNull());
    expect(screen.getByTestId("changes-count").textContent).toBe("1");
    expect(new TextDecoder().decode(head.files.get("assets/Forest.scene.hasset"))).toBe("F2");
    expect(new TextDecoder().decode(head.files.get("assets/Rock.texture.hasset"))).toBe("R");
    expect((screen.getByTestId("changes-commit-message") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByTestId("changes-status").textContent).toMatch(/^Up to date\. Checked/);
  });

  it("keeps the commit local without Push After Commit, and counts it to push", async () => {
    const { service, storage } = await integratedSync();
    state.sync = service;
    await storage.writeText("assets/Forest.scene.hasset", "F2");
    await service.refreshStatus();
    renderPanel();
    fireEvent.click(screen.getByTestId("changes-push-after"));
    fireEvent.change(screen.getByTestId("changes-commit-message"), { target: { value: "Local" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("changes-commit"));
    });
    await waitFor(() => expect(screen.getByTestId("changes-push").textContent).toBe("Push1"));
    expect(screen.getByTestId("changes-empty").textContent).toBe("No Changes.");
  });

  it("lists incoming commits and counts them on Pull", async () => {
    const { service, remote } = await integratedSync();
    state.sync = service;
    remote.commit({ "assets/Rock.texture.hasset": "R2" }, "Tune rock\n\nLonger body");
    await service.fetch();
    renderPanel();
    expect(screen.getByTestId("changes-pull").textContent).toBe("Pull1");
    expect(screen.getByTestId("changes-incoming").textContent).toContain("Tune rock");
    expect(screen.getByTestId("changes-incoming").textContent).not.toContain("Longer body");
    expect(screen.getByTestId("changes-status").textContent).toMatch(/^1 commit to pull\. Checked just now\.$/);
  });

  describe("with many changes", () => {
    async function manyChanges(count: number) {
      const { service, storage } = await integratedSync();
      state.sync = service;
      for (let index = 0; index < count; index += 1) await storage.writeText(`notes/note-${index}.txt`, String(index));
      await service.refreshStatus();
      return service;
    }

    it("mounts only the rows its scroll region shows", async () => {
      // jsdom lays nothing out: give the scroll regions a height of ten rows.
      const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
        return this.getAttribute("data-slot") === "scroll-area-viewport" ? 280 : 0;
      });
      try {
        await manyChanges(300);
        renderPanel();
        expect(screen.getByTestId("changes-count").textContent).toBe("300");
        const mounted = screen.getAllByTestId(/^changes-row-/).length;
        expect(mounted).toBeGreaterThanOrEqual(10);
        expect(mounted).toBeLessThan(30);
      } finally {
        height.mockRestore();
      }
    });

    it("re-renders no row and asks no lock state while a commit message is typed", async () => {
      await manyChanges(40);
      const lockState = vi.spyOn(SourceControlService.prototype, "lockStateForPath");
      try {
        renderPanel();
        lockState.mockClear();
        for (const text of ["F", "Fi", "Fix", "Fix notes"]) {
          fireEvent.change(screen.getByTestId("changes-commit-message"), { target: { value: text } });
        }
        expect(lockState).not.toHaveBeenCalled();
        expect(screen.getByTestId("changes-commit").hasAttribute("disabled")).toBe(false);
      } finally {
        lockState.mockRestore();
      }
    });
  });

  it("offers Add Git LFS Rule where a commit of blobs is refused, and commits once the rule is in", async () => {
    const { service, storage, remote } = await integratedSync({ lfsRule: false });
    state.sync = service;
    await storage.writeText("assets/Forest.scene.hasset", "F2");
    await storage.writeBinary(`assets/.blobs/${"a".repeat(64)}`, new Uint8Array([1, 2]));
    await service.refreshStatus();
    renderPanel();
    fireEvent.change(screen.getByTestId("changes-commit-message"), { target: { value: "Forest" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("changes-commit"));
    });
    expect((await screen.findByTestId("changes-problem")).textContent).toContain("Could Not Commit");
    await act(async () => {
      fireEvent.click(screen.getByTestId("changes-add-lfs-rule"));
    });
    await waitFor(() => expect(service.getSnapshot().operation).toBeNull());
    expect(screen.queryByTestId("changes-problem")).toBeNull();
    // The rule is its own local commit; the remote has it only after the next push.
    expect(remote.get(remote.branches.get("main")!).files.has(".gitattributes")).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByTestId("changes-commit"));
    });
    await waitFor(() => expect(remote.get(remote.branches.get("main")!).files.has(`assets/.blobs/${"a".repeat(64)}`)).toBe(true));
    expect(screen.getByTestId("changes-empty").textContent).toBe("No Changes.");
  });
});
