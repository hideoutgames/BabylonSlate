import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeLockProvider } from "@haptic/source-control";
import { SourceControlService } from "../services/source-control-service";
import { MANUAL_SOURCE_CONTROL, signedInHosts } from "../testing/source-control-hosts";
import type { SourceControlSyncService } from "../services/source-control-sync";
import { deviceIntegratedSync, INTEGRATED_LOOKUP, integratedSync } from "../testing/integrated-sync";
import { SourceControlActionsProvider } from "../components/source-control-actions";
import { ChangesPanelContents } from "./changes-panel";

// jsdom has no PointerEvent; Base UI's Checkbox dispatches one on click.
if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {}
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const state = vi.hoisted(() => ({
  sync: null as SourceControlSyncService | null,
  locks: null as SourceControlService | null,
  setAdoption: null as ((adopted: boolean) => Promise<void>) | null,
  dirtyDocuments: [] as unknown[],
  withProjectWrites: null as (<T>(work: () => Promise<T>) => Promise<T>) | null,
}));

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({
    ...(state.sync ? { sourceControlSync: state.sync } : {}),
    ...(state.locks ? { sourceControl: state.locks } : {}),
    ...(state.setAdoption ? { setSourceControlAdoption: state.setAdoption } : {}),
    ...(state.withProjectWrites ? { withProjectWrites: state.withProjectWrites } : {}),
    dirtyDocuments: state.dirtyDocuments,
  })),
);

afterEach(() => {
  cleanup();
  state.sync?.dispose();
  state.sync = null;
  state.locks?.dispose();
  state.locks = null;
  state.setAdoption = null;
  state.dirtyDocuments = [];
  state.withProjectWrites = null;
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

  it("marks added assets with a plus, deleted ones with a minus and modified ones with M, beside who holds each lock", async () => {
    const { service, storage } = await integratedSync();
    state.sync = service;
    const locks = new SourceControlService();
    const fake = new FakeLockProvider({ selfName: "Ada" });
    fake.addTheirs("assets/Rock.texture.hasset", "Bob");
    await locks.configure({ settings: MANUAL_SOURCE_CONTROL, projectKey: "proj", platform: "electron", testMode: true, hosts: await signedInHosts(), fake });
    await locks.lockPaths(["assets/Forest.scene.hasset"]);
    await locks.refresh();
    state.locks = locks;
    await storage.writeText("assets/Forest.scene.hasset", "F2");
    await storage.remove("assets/Rock.texture.hasset");
    await storage.writeText("assets/Cave.scene.hasset", "C");
    await service.refreshStatus();
    renderPanel();
    const row = (path: string) => within(screen.getByTestId(`changes-row-${path}`));
    expect(row("assets/Cave.scene.hasset").getByRole("img", { name: "Added" }).querySelector(".lucide-plus")).not.toBeNull();
    expect(row("assets/Rock.texture.hasset").getByRole("img", { name: "Deleted" }).querySelector(".lucide-minus")).not.toBeNull();
    expect(row("assets/Forest.scene.hasset").getByRole("img", { name: "Modified" }).textContent).toBe("M");
    expect(row("assets/Forest.scene.hasset").getByRole("img", { name: "Locked By You" })).toBeTruthy();
    expect(row("assets/Rock.texture.hasset").getByRole("img", { name: "Locked By Bob" })).toBeTruthy();
    expect(row("assets/Cave.scene.hasset").queryByRole("img", { name: /^Locked By/ })).toBeNull();
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

  it("picks the branch in place of its label: this copy's and the remote's branches, and New Branch…", async () => {
    const { service, remote } = await integratedSync();
    remote.commit({ "assets/Rock.texture.hasset": "R-art" }, "Art", "art");
    state.sync = service;
    renderPanel();
    fireEvent.click(screen.getByTestId("changes-branch"));
    expect((await screen.findByTestId("changes-branch-main")).getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      fireEvent.click(await screen.findByTestId("changes-remote-art"));
    });
    expect((await screen.findByTestId("source-control-switch-confirm")).textContent).toContain("Switch To art?");
    fireEvent.click(screen.getByTestId("source-control-switch-cancel"));
    await waitFor(() => expect(screen.queryByTestId("source-control-switch-confirm")).toBeNull());
    expect(service.getSnapshot().branch).toBe("main");

    fireEvent.click(screen.getByTestId("changes-branch"));
    await act(async () => {
      fireEvent.click(await screen.findByTestId("changes-new-branch"));
    });
    expect(await screen.findByTestId("source-control-new-branch")).toBeTruthy();
  });

  it("removes unused files from its menu after a confirmation naming their count and size, refused while documents are unsaved", async () => {
    // The seed's assets as no files at all: only the loose blob is left to judge.
    const { service, storage } = await integratedSync({ files: { "assets/Forest.scene.hasset": null, "assets/Rock.texture.hasset": null } });
    state.sync = service;
    const loose = `assets/.blobs/${"b".repeat(64)}`;
    await storage.writeBinary(loose, new Uint8Array(3 * 1024));
    state.dirtyDocuments = [{ ref: { kind: "scene", path: "assets/Forest.scene.hasset", label: "Forest" } }];
    let queued = 0;
    state.withProjectWrites = <T,>(work: () => Promise<T>) => {
      queued += 1;
      return work();
    };
    renderPanel();
    const open = async () => {
      fireEvent.click(screen.getByTestId("changes-more"));
      await act(async () => {
        fireEvent.click(await screen.findByTestId("changes-remove-unused"));
      });
    };

    await open();
    const refused = await screen.findByTestId("source-control-unused-blocked");
    expect(refused.textContent).toContain("Forest");
    fireEvent.click(within(refused).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByTestId("source-control-unused-blocked")).toBeNull());
    expect(await storage.exists(loose)).toBe(true);

    state.dirtyDocuments = [];
    await open();
    const confirm = await screen.findByTestId("source-control-unused-confirm");
    expect(confirm.textContent).toContain("Remove 1 Unused File?");
    expect(confirm.textContent).toContain("3 KB");
    expect(await storage.exists(loose)).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-control-unused-confirm-action"));
    });
    expect((await screen.findByTestId("source-control-unused-done")).textContent).toContain("Removed 1 Unused File");
    expect(await storage.exists(loose)).toBe(false);
    // In the project write queue, so no editor save runs meanwhile.
    expect(queued).toBe(1);
  });

  it("says nothing was removed, and why, when a blob folder is a symbolic link", async () => {
    const { service } = await integratedSync();
    state.sync = service;
    vi.spyOn(service, "findUnusedFiles").mockResolvedValue({ paths: [], bytes: 0, linkedBlobFolders: true });
    renderPanel();
    fireEvent.click(screen.getByTestId("changes-more"));
    await act(async () => {
      fireEvent.click(await screen.findByTestId("changes-remove-unused"));
    });
    const done = await screen.findByTestId("source-control-unused-done");
    expect(done.textContent).toContain("Nothing Removed");
    expect(done.textContent).toContain("symbolic link");
    expect(done.textContent).not.toContain("No Unused Files");
  });

  it("offers Cancel while the removal waits for other writers, which removes nothing, and none once files are being removed", async () => {
    let drain!: () => void;
    const drained = new Promise<void>((resolve) => { drain = resolve; });
    let finish!: () => void;
    const removing = new Promise<void>((resolve) => { finish = resolve; });
    const { service, storage } = await integratedSync({
      files: { "assets/Forest.scene.hasset": null, "assets/Rock.texture.hasset": null },
      // A long Texture encode is admitted: the removal waits for it until the wait's signal ends.
      exclusiveWrites: async (_reason, work, storage, signal) => {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          void drained.then(resolve);
        });
        // Each removal waits, so the step can be seen while files go.
        return work(new Proxy(storage, {
          get(target, key) {
            const value = Reflect.get(target, key, target) as unknown;
            if (typeof value !== "function") return value;
            if (key !== "remove") return value.bind(target);
            return async (path: string) => {
              await removing;
              return (value as (path: string) => Promise<void>).call(target, path);
            };
          },
        }));
      },
    });
    state.sync = service;
    const loose = `assets/.blobs/${"c".repeat(64)}`;
    await storage.writeBinary(loose, new Uint8Array(1024));
    renderPanel();
    const remove = async () => {
      fireEvent.click(screen.getByTestId("changes-more"));
      await act(async () => {
        fireEvent.click(await screen.findByTestId("changes-remove-unused"));
      });
      await screen.findByTestId("source-control-unused-confirm");
      await act(async () => {
        fireEvent.click(screen.getByTestId("source-control-unused-confirm-action"));
      });
      return screen.findByTestId("source-control-unused-removing");
    };

    const waiting = await remove();
    expect(waiting.textContent).toContain("Waiting");
    await act(async () => {
      fireEvent.click(within(waiting).getByRole("button", { name: "Cancel" }));
    });
    await waitFor(() => expect(screen.queryByTestId("source-control-unused-removing")).toBeNull());
    expect(screen.queryByTestId("source-control-unused-failed")).toBeNull();
    expect(service.getSnapshot().problem).toBeNull();
    expect(await storage.exists(loose)).toBe(true);

    drain();
    const step = await remove();
    await waitFor(() => expect(within(step).queryByRole("button", { name: "Cancel" })).toBeNull());
    expect(step.textContent).toContain("Saves wait until the files are removed.");
    finish();
    expect((await screen.findByTestId("source-control-unused-done")).textContent).toContain("Removed 1 Unused File");
    expect(await storage.exists(loose)).toBe(false);
  });

  it("offers Add Git LFS Rule where a commit of blobs is refused, and commits once the rule is in", async () => {
    const blob = `assets/.blobs/${"a".repeat(64)}`;
    // Forest's new version stores a chunk in the blob.
    const { service, storage, remote } = await integratedSync({
      lfsRule: false,
      lookup: (path) => (path === "assets/Forest.scene.hasset" ? { name: "Forest", type: "Scene", blobPaths: [blob] } : INTEGRATED_LOOKUP(path)),
    });
    state.sync = service;
    await storage.writeText("assets/Forest.scene.hasset", "F2");
    await storage.writeBinary(blob, new Uint8Array([1, 2]));
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
