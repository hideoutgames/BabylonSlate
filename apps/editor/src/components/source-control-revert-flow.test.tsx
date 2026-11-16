import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenDocument } from "../services/document-service";
import type { SourceControlSyncService } from "../services/source-control-sync";
import { sceneActor, sceneAsset } from "../testing/diff-assets";
import { integratedSync } from "../testing/integrated-sync";
import SourceControlRevertFlow from "./source-control-revert-flow";

const state = vi.hoisted(() => ({
  sync: null as SourceControlSyncService | null,
  dirty: [] as OpenDocument[],
  saveAll: vi.fn(async () => true),
  reloadDocs: vi.fn<(paths: string[]) => Promise<void>>(async () => {}),
  applyPulledChanges: vi.fn<(paths: readonly string[], hold?: { release: () => void }) => Promise<void>>(async () => {}),
  lockAuthoring: vi.fn<(reason: string) => () => void>(() => () => {}),
  writing: false,
  lock: null as { readOnly: true; reason: string; revision: number } | null,
}));

vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({
    ...(state.sync ? { sourceControlSync: state.sync } : {}),
    dirtyDocuments: state.dirty,
    projectDirty: false,
    saveAll: state.saveAll,
    confirmExternalChangeReloadDocs: state.reloadDocs,
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
  state.reloadDocs.mockClear();
  state.applyPulledChanges.mockReset();
  state.lockAuthoring.mockReset();
  state.lockAuthoring.mockImplementation(() => () => {});
});

const PATH = "assets/Forest.scene.hasset";

const dirtyForest: OpenDocument = {
  id: `scene:${PATH}`,
  ref: { kind: "scene", path: PATH, label: "Forest" },
  content: {},
  layout: null,
  dirty: true,
};

async function edited() {
  const base = await sceneAsset([sceneActor("a", "A")]);
  const sync = await integratedSync({ files: { [PATH]: base.bytes } });
  state.sync = sync.service;
  await sync.storage.writeBinary(PATH, (await sceneAsset([sceneActor("a", "Edited")])).bytes);
  await sync.service.refreshStatus();
  return { ...sync, base };
}

describe("Revert Asset", () => {
  it("discards the asset's unsaved edits first, confirms, then writes HEAD's version read-only in the write queue and reloads it", async () => {
    const { service, storage, base } = await edited();
    state.dirty = [dirtyForest, { ...dirtyForest, id: "scene:other", ref: { kind: "scene", path: "assets/Other.scene.hasset", label: "Other" } }];
    const events: string[] = [];
    state.lockAuthoring.mockImplementation((reason) => {
      events.push(`lock: ${reason}`);
      return () => events.push("release");
    });
    state.applyPulledChanges.mockImplementation(async (paths) => {
      events.push(`reload ${paths.join(", ")}${state.writing ? " in the write queue" : ""}`);
    });
    const onDone = vi.fn();
    render(<SourceControlRevertFlow request={{ path: PATH, name: "Forest", ref: { kind: "head" } }} onDone={onDone} />);
    // Only the asset being reverted is asked about.
    const unsaved = screen.getByTestId("source-control-revert-unsaved");
    expect(unsaved.textContent).toContain("Forest");
    expect(unsaved.textContent).not.toContain("Other");
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-control-revert-discard"));
    });
    expect(state.reloadDocs).toHaveBeenCalledWith([PATH]);
    const confirm = await screen.findByTestId("source-control-revert-confirm");
    expect(confirm.textContent).toContain(`Reverting replaces Forest with its version from main · ${service.getSnapshot().head!.slice(0, 7)}. It cannot be undone.`);
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-control-revert-confirm-action"));
    });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(await storage.readBinary(PATH)).toEqual(base.bytes);
    expect(events).toEqual(["lock: Read-only while reverting", `reload ${PATH} in the write queue`, "release"]);
    expect(service.getSnapshot().rows).toEqual([]);
  });

  it("refuses while Play holds the documents, naming why, and writes nothing", async () => {
    const { storage } = await edited();
    state.lock = { readOnly: true, reason: "Read-only while playing", revision: 1 };
    const before = await storage.readBinary(PATH);
    render(<SourceControlRevertFlow request={{ path: PATH, name: "Forest", ref: { kind: "head" } }} onDone={() => {}} />);
    expect(screen.getByTestId("source-control-revert-blocked").textContent).toContain("Read-only while playing");
    expect(await storage.readBinary(PATH)).toEqual(before);
  });

  it("shows why a revert failed and releases the documents", async () => {
    const { service } = await edited();
    vi.spyOn(service, "revert").mockRejectedValueOnce(new Error("The server has no LFS object."));
    const release = vi.fn();
    state.lockAuthoring.mockImplementation(() => release);
    render(<SourceControlRevertFlow request={{ path: PATH, name: "Forest", ref: { kind: "head" } }} onDone={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-control-revert-confirm-action"));
    });
    const failed = await screen.findByTestId("source-control-revert-blocked");
    expect(failed.textContent).toContain("Could Not Revert Forest");
    expect(failed.textContent).toContain("The server has no LFS object.");
    expect(release).toHaveBeenCalled();
    expect(state.applyPulledChanges).not.toHaveBeenCalled();
  });
});
