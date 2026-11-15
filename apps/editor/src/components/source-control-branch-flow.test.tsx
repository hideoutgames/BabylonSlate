import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenDocument } from "../services/document-service";
import type { SourceControlSyncService } from "../services/source-control-sync";
import { integratedSync } from "../testing/integrated-sync";
import SourceControlBranchFlow from "./source-control-branch-flow";
import NewBranchDialog from "./source-control-new-branch-dialog";
import { SourceControlActionsProvider } from "./source-control-actions";

const state = vi.hoisted(() => ({
  sync: null as SourceControlSyncService | null,
  dirty: [] as OpenDocument[],
  saveAll: vi.fn(async () => true),
  applyPulledChanges: vi.fn<(paths: readonly string[], hold?: { release: () => void }) => Promise<void>>(async () => {}),
  lockAuthoring: vi.fn<(reason: string) => () => void>(() => () => {}),
  writing: false,
  lock: null as { readOnly: true; reason: string; revision: number } | null,
}));

const headers: Record<string, { name: string; type: string; chunks: [] }> = {
  "assets/Forest.scene.hasset": { name: "Forest", type: "Scene", chunks: [] },
  "assets/Rock.texture.hasset": { name: "Rock", type: "Texture", chunks: [] },
};

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({
    ...(state.sync ? { sourceControlSync: state.sync } : {}),
    dirtyDocuments: state.dirty,
    projectDirty: false,
    assetRegistry: { getByPath: (path: string) => (headers[path] ? { path, header: headers[path] } : undefined) } as never,
    saveAll: state.saveAll,
    applyPulledChanges: state.applyPulledChanges,
    lockAuthoring: state.lockAuthoring,
    ...(state.lock ? { getAuthoringLock: () => state.lock! } : {}),
    withProjectWrites: async <T,>(work: () => Promise<T>) => {
      state.writing = true;
      try {
        return await work();
      } finally {
        state.writing = false;
      }
    },
  })),
);

afterEach(() => {
  cleanup();
  state.sync?.dispose();
  state.sync = null;
  state.dirty = [];
  state.lock = null;
  state.saveAll.mockClear();
  state.applyPulledChanges.mockReset();
  state.lockAuthoring.mockReset();
  state.lockAuthoring.mockImplementation(() => () => {});
});

const dirtyForest: OpenDocument = {
  id: "scene:assets/Forest.scene.hasset",
  ref: { kind: "scene", path: "assets/Forest.scene.hasset", label: "Forest" },
  content: {},
  layout: null,
  dirty: true,
};

function renderFlow(branch: string, onDone = vi.fn()) {
  render(
    <SourceControlActionsProvider>
      <SourceControlBranchFlow branch={branch} onDone={onDone} />
    </SourceControlActionsProvider>,
  );
  return onDone;
}

describe("Switch Branch", () => {
  it("saves unsaved documents first, confirms, then switches read-only in the write queue and reloads the files it wrote", async () => {
    const { service, remote, storage } = await integratedSync();
    const art = remote.commit({ "assets/Rock.texture.hasset": "R-art" }, "Art", "art");
    state.sync = service;
    state.dirty = [dirtyForest];
    const events: string[] = [];
    state.lockAuthoring.mockImplementation((reason) => {
      events.push(`lock: ${reason}`);
      return () => events.push("release");
    });
    state.applyPulledChanges.mockImplementation(async (paths) => {
      events.push(`reload ${paths.join(", ")}${state.writing ? " in the write queue" : ""}`);
    });
    const onDone = renderFlow("art");

    expect(screen.getByTestId("source-control-switch-unsaved").textContent).toContain("Forest");
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-control-switch-save"));
    });
    expect(state.saveAll).toHaveBeenCalledTimes(1);
    const confirm = await screen.findByTestId("source-control-switch-confirm");
    expect(confirm.textContent).toContain("Switch To art?");
    expect(confirm.textContent).toContain("It cannot be undone.");
    // Nothing is written before the confirmation.
    expect(await storage.readText("assets/Rock.texture.hasset")).toBe("R");

    await act(async () => {
      fireEvent.click(screen.getByTestId("source-control-switch-confirm-action"));
    });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(await storage.readText("assets/Rock.texture.hasset")).toBe("R-art");
    expect(events).toEqual(["lock: Read-only while switching branch", "reload assets/Rock.texture.hasset in the write queue", "release"]);
    expect(service.getSnapshot()).toMatchObject({ branch: "art", head: art });
  });

  it("names the assets whose uncommitted changes the switch would overwrite, and changes nothing", async () => {
    const { service, remote, storage } = await integratedSync();
    remote.commit({ "assets/Rock.texture.hasset": "R-art" }, "Art", "art");
    state.sync = service;
    await storage.writeText("assets/Rock.texture.hasset", "R-mine");
    await service.refreshStatus();
    const onDone = renderFlow("art");
    await act(async () => {
      fireEvent.click(await screen.findByTestId("source-control-switch-confirm-action"));
    });
    const refused = await screen.findByTestId("source-control-switch-refused");
    expect(refused.textContent).toContain("Cannot Switch To art");
    expect(refused.querySelector("li")?.textContent).toBe("Rock");
    expect(state.applyPulledChanges).not.toHaveBeenCalled();
    expect(await storage.readText("assets/Rock.texture.hasset")).toBe("R-mine");
    expect(service.getSnapshot().branch).toBe("main");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("is refused while documents are read-only", async () => {
    const { service } = await integratedSync();
    state.sync = service;
    state.lock = { readOnly: true, reason: "Read-only while Play runs", revision: 1 };
    renderFlow("art");
    const blocked = await screen.findByTestId("source-control-switch-blocked");
    expect(blocked.textContent).toContain("Cannot Switch Branch Now");
    expect(blocked.textContent).toContain("Read-only while Play runs");
    expect(screen.queryByTestId("source-control-switch-confirm")).toBeNull();
  });
});

describe("New Branch", () => {
  it("refuses names that are invalid or taken here or on the remote, then starts the branch at HEAD and checks it out", async () => {
    const { service, remote, storage } = await integratedSync();
    remote.commit({ "assets/Rock.texture.hasset": "R-art" }, "Art", "art");
    state.sync = service;
    await storage.writeText("assets/Forest.scene.hasset", "F2");
    await service.refreshStatus();
    const head = service.getSnapshot().head;
    const onDone = vi.fn();
    render(<NewBranchDialog onDone={onDone} />);
    const name = screen.getByTestId("source-control-new-branch-name");
    const create = screen.getByTestId("source-control-new-branch-create") as HTMLButtonElement;
    const reason = () => screen.getByTestId("source-control-new-branch-reason").textContent;
    expect(create.disabled).toBe(true);
    fireEvent.change(name, { target: { value: "bad name" } });
    expect(reason()).toContain("no spaces");
    // Both lists are read when the dialog opens.
    fireEvent.change(name, { target: { value: "main" } });
    await waitFor(() => expect(reason()).toBe("There is already a branch named main."));
    fireEvent.change(name, { target: { value: "art" } });
    await waitFor(() => expect(reason()).toBe("The remote already has a branch named art. Switch to it instead."));

    fireEvent.change(name, { target: { value: "feature/bridge" } });
    expect(screen.queryByTestId("source-control-new-branch-reason")).toBeNull();
    await act(async () => {
      fireEvent.click(create);
    });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    // HEAD's commit, with the uncommitted change still there.
    expect(service.getSnapshot()).toMatchObject({ branch: "feature/bridge", head });
    expect(service.getSnapshot().rows.map((row) => row.id)).toEqual(["assets/Forest.scene.hasset"]);
    expect(await service.localBranches()).toEqual(["feature/bridge", "main"]);
  });
});
