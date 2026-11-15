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
  applyPulledChanges: vi.fn<(paths: readonly string[], hold?: { release: () => void }) => Promise<void>>(async () => {}),
  lockAuthoring: vi.fn<(reason: string) => () => void>(() => () => {}),
  withProjectWrites: null as (<T>(work: () => Promise<T>) => Promise<T>) | null,
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
    lockAuthoring: state.lockAuthoring,
    ...(state.lock ? { getAuthoringLock: () => state.lock! } : {}),
    withProjectWrites: async <T,>(work: () => Promise<T>) => {
      state.writes += 1;
      return state.withProjectWrites ? state.withProjectWrites(work) : work();
    },
  })),
);

afterEach(() => {
  cleanup();
  state.sync = null;
  state.dirty = [];
  state.saveAll.mockClear();
  state.reloadDocs.mockClear();
  state.applyPulledChanges.mockReset();
  state.lockAuthoring.mockReset();
  state.lockAuthoring.mockImplementation(() => () => {});
  state.withProjectWrites = null;
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
    expect(state.applyPulledChanges).toHaveBeenCalledWith(["assets/Rock.texture.hasset"], expect.objectContaining({ release: expect.any(Function) }));
  });

  it("holds the documents read-only behind a Pulling step until the pulled files are reloaded, in the same write-queue turn", async () => {
    const { service, remote, port } = await integratedSync();
    state.sync = service;
    remote.commit({ "assets/Rock.texture.hasset": "R2" }, "Teammate");
    await service.fetch();
    const events: string[] = [];
    let writing = false;
    state.lockAuthoring.mockImplementation((reason: string) => {
      events.push(`lock: ${reason}`);
      // As the document service's: a repeated release is harmless.
      let held = true;
      return () => {
        if (held) events.push("release");
        held = false;
      };
    });
    state.withProjectWrites = async <T,>(work: () => Promise<T>) => {
      writing = true;
      try {
        return await work();
      } finally {
        writing = false;
      }
    };
    state.applyPulledChanges.mockImplementation(async (paths, hold) => {
      events.push(`reload ${paths.join(", ")}${writing ? " in the write queue" : ""}`);
      hold?.release();
    });
    let finishPull!: () => void;
    const pulled = new Promise<void>((resolve) => { finishPull = resolve; });
    const original = port.pull.bind(port);
    vi.spyOn(port, "pull").mockImplementation(async (input) => {
      await pulled;
      return original(input);
    });
    const onDone = vi.fn();
    render(<SourceControlPullFlow onDone={onDone} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-control-pull-confirm-action"));
    });
    expect((await screen.findByTestId("source-control-pull-running")).textContent).toContain("Pulling");
    expect(events).toEqual(["lock: Read-only while pulling"]);
    await act(async () => {
      finishPull();
    });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(events).toEqual(["lock: Read-only while pulling", "reload assets/Rock.texture.hasset in the write queue", "release"]);
  });

  it("ends and gives the documents back when the reload after the pull fails", async () => {
    const { service, remote } = await integratedSync();
    state.sync = service;
    remote.commit({ "assets/Rock.texture.hasset": "R2" }, "Teammate");
    let held = false;
    state.lockAuthoring.mockImplementation(() => {
      held = true;
      return () => { held = false; };
    });
    state.applyPulledChanges.mockRejectedValue(new Error("The project could not be read."));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onDone = vi.fn();
    try {
      render(<SourceControlPullFlow onDone={onDone} />);
      await act(async () => {
        fireEvent.click(screen.getByTestId("source-control-pull-confirm-action"));
      });
      await waitFor(() => expect(onDone).toHaveBeenCalled());
      expect(held).toBe(false);
    } finally {
      warn.mockRestore();
    }
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
    expect(state.applyPulledChanges).toHaveBeenCalledWith(["assets/Rock.texture.hasset"], expect.objectContaining({ release: expect.any(Function) }));
    // Kept: Forest is still an uncommitted change.
    expect(service.getSnapshot().rows.map((row) => row.name)).toEqual(["Forest"]);
  });

  it("compares a conflicting asset's incoming version with the working copy, keeping the pull's choices and hold", async () => {
    const { service, remote, storage } = await integratedSync();
    state.sync = service;
    remote.commit({ "assets/Rock.texture.hasset": "R-theirs", "assets/Forest.scene.hasset": "F-theirs" }, "Teammate");
    await storage.writeText("assets/Rock.texture.hasset", "R-mine");
    await storage.writeText("assets/Forest.scene.hasset", "F-mine");
    const release = vi.fn();
    state.lockAuthoring.mockImplementation(() => release);
    const onCompare = vi.fn();
    const onDone = vi.fn();
    render(<SourceControlPullFlow onDone={onDone} onCompare={onCompare} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-control-pull-confirm-action"));
    });
    await screen.findByTestId("source-control-pull-conflicts");
    fireEvent.click(screen.getByTestId("source-control-conflict-mine-assets/Forest.scene.hasset"));
    fireEvent.click(screen.getByTestId("source-control-conflict-compare-assets/Rock.texture.hasset"));
    expect(onCompare).toHaveBeenCalledWith({
      path: "assets/Rock.texture.hasset",
      name: "Rock",
      type: "Texture",
      base: { kind: "remote" },
      compare: { kind: "working" },
    });
    // The incoming version is the remote branch the pull fetched.
    expect(service.getSnapshot().remoteHead).toBe(remote.branches.get("main"));
    const comparing = await screen.findByTestId("source-control-pull-comparing");
    expect(comparing.textContent).toContain("Comparing Rock with main");
    await waitFor(() => expect(screen.queryByTestId("source-control-pull-conflicts")).toBeNull());
    expect(release).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("source-control-pull-comparing-back"));
    await screen.findByTestId("source-control-pull-conflicts");
    // Forest keeps its choice; Rock still needs one.
    expect(screen.getByTestId("source-control-pull-conflicts-reason").textContent).toBe("Choose a version for Rock.");
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
