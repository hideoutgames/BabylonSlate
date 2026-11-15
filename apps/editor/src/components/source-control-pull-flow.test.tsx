import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceControlSyncService } from "../services/source-control-sync";
import type { OpenDocument } from "../services/document-service";
import { integratedSync } from "../testing/integrated-sync";
import SourceControlPullFlow from "./source-control-pull-flow";

const state = vi.hoisted(() => ({
  sync: null as SourceControlSyncService | null,
  dirty: [] as OpenDocument[],
  saveAll: vi.fn(async () => true),
  reloadDocs: vi.fn<(paths: string[]) => Promise<void>>(async () => {}),
  applyPulledChanges: vi.fn<(paths: readonly string[]) => Promise<void>>(async () => {}),
  writes: 0,
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
    confirmExternalChangeReloadDocs: state.reloadDocs,
    applyPulledChanges: state.applyPulledChanges,
    ...(state.lock ? { getAuthoringLock: () => state.lock! } : {}),
    withProjectWrites: async <T,>(work: () => Promise<T>) => {
      state.writes += 1;
      return work();
    },
  })),
);

afterEach(() => {
  cleanup();
  state.sync = null;
  state.dirty = [];
  state.saveAll.mockClear();
  state.reloadDocs.mockClear();
  state.applyPulledChanges.mockClear();
  state.writes = 0;
  state.lock = null;
});

const dirtyForest: OpenDocument = {
  id: "scene:assets/Forest.scene.hasset",
  ref: { kind: "scene", path: "assets/Forest.scene.hasset", label: "Forest" },
  content: {},
  layout: null,
  dirty: true,
};

describe("Pull", () => {
  it("saves unsaved documents first, confirms, fast-forwards in the write queue and reloads what it wrote", async () => {
    const { service, remote, storage } = await integratedSync();
    state.sync = service;
    state.dirty = [dirtyForest];
    remote.commit({ "assets/Rock.texture.hasset": "R2" }, "Teammate");
    await service.fetch();
    const onDone = vi.fn();
    render(<SourceControlPullFlow onDone={onDone} />);
    expect(screen.getByTestId("source-control-pull-unsaved").textContent).toContain("Forest");
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-control-pull-save"));
    });
    expect(state.saveAll).toHaveBeenCalledTimes(1);
    const confirm = await screen.findByTestId("source-control-pull-confirm");
    expect(confirm.textContent).toContain("Pull 1 Commit From main?");
    expect(confirm.textContent).toContain("It cannot be undone.");
    expect(await storage.readText("assets/Rock.texture.hasset")).toBe("R");
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-control-pull-confirm-action"));
    });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(state.writes).toBe(1);
    expect(await storage.readText("assets/Rock.texture.hasset")).toBe("R2");
    expect(state.applyPulledChanges).toHaveBeenCalledWith(["assets/Rock.texture.hasset"]);
  });

  it("refuses to start while Play holds the documents, naming why", async () => {
    const { service, remote, storage } = await integratedSync();
    state.sync = service;
    state.lock = { readOnly: true, reason: "Stop Play to edit.", revision: 1 };
    remote.commit({ "assets/Rock.texture.hasset": "R2" }, "Teammate");
    render(<SourceControlPullFlow onDone={() => {}} />);
    expect(screen.getByTestId("source-control-pull-blocked").textContent).toContain("Stop Play to edit.");
    expect(screen.queryByTestId("source-control-pull-confirm")).toBeNull();
    expect(await storage.readText("assets/Rock.texture.hasset")).toBe("R");
  });

  it("discards unsaved documents by reloading them from disk", async () => {
    const { service } = await integratedSync();
    state.sync = service;
    state.dirty = [dirtyForest];
    render(<SourceControlPullFlow onDone={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-control-pull-discard"));
    });
    expect(state.reloadDocs).toHaveBeenCalledWith(["assets/Forest.scene.hasset"]);
    expect(state.saveAll).not.toHaveBeenCalled();
    expect(await screen.findByTestId("source-control-pull-confirm")).toBeTruthy();
  });

  it("asks for a version of every asset changed on both sides, and applies only once each has one", async () => {
    const { service, remote, storage } = await integratedSync();
    state.sync = service;
    remote.commit({ "assets/Rock.texture.hasset": "R-theirs", "assets/Forest.scene.hasset": "F-theirs" }, "Teammate");
    await storage.writeText("assets/Rock.texture.hasset", "R-mine");
    await storage.writeText("assets/Forest.scene.hasset", "F-mine");
    const onDone = vi.fn();
    render(<SourceControlPullFlow onDone={onDone} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-control-pull-confirm-action"));
    });
    const dialog = await screen.findByTestId("source-control-pull-conflicts");
    expect(dialog.textContent).toContain("2 assets changed here and on main");
    const apply = screen.getByTestId("source-control-pull-conflicts-apply");
    expect(apply.hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("source-control-pull-conflicts-reason").textContent).toBe("Choose a version for Forest.");
    fireEvent.click(screen.getByTestId("source-control-conflict-mine-assets/Forest.scene.hasset"));
    expect(screen.getByTestId("source-control-pull-conflicts-reason").textContent).toBe("Choose a version for Rock.");
    fireEvent.click(screen.getByTestId("source-control-conflict-theirs-assets/Rock.texture.hasset"));
    expect(apply.hasAttribute("disabled")).toBe(false);
    // Nothing changed while the choices were made.
    expect(await storage.readText("assets/Rock.texture.hasset")).toBe("R-mine");
    await act(async () => {
      fireEvent.click(apply);
    });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(await storage.readText("assets/Rock.texture.hasset")).toBe("R-theirs");
    expect(await storage.readText("assets/Forest.scene.hasset")).toBe("F-mine");
    expect(state.applyPulledChanges).toHaveBeenCalledWith(["assets/Rock.texture.hasset"]);
    // Kept: Forest is still an uncommitted change.
    expect(service.getSnapshot().rows.map((row) => row.name)).toEqual(["Forest"]);
  });

  it("changes nothing when the pull is cancelled at its conflicts", async () => {
    const { service, remote, storage } = await integratedSync();
    state.sync = service;
    remote.commit({ "assets/Rock.texture.hasset": "R-theirs" }, "Teammate");
    await storage.writeText("assets/Rock.texture.hasset", "R-mine");
    const onDone = vi.fn();
    render(<SourceControlPullFlow onDone={onDone} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-control-pull-confirm-action"));
    });
    fireEvent.click(await screen.findByTestId("source-control-pull-conflicts-cancel"));
    expect(onDone).toHaveBeenCalled();
    expect(await storage.readText("assets/Rock.texture.hasset")).toBe("R-mine");
    expect(state.applyPulledChanges).not.toHaveBeenCalled();
  });
});
