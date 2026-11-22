import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PROJECT_FILE } from "@haptic/core";
import type { SaveAllOutcome } from "../context/document-context-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenDocument } from "../services/document-service";
import type { SourceControlSyncService } from "../services/source-control-sync";
import { sceneActor, sceneAsset } from "../testing/diff-assets";
import { integratedProjectJson, integratedSync } from "../testing/integrated-sync";
import SourceControlRevertFlow from "./source-control-revert-flow";

const state = vi.hoisted(() => ({
  sync: null as SourceControlSyncService | null,
  dirty: [] as OpenDocument[],
  projectDirty: false,
  reloadProject: vi.fn<() => Promise<void>>(async () => {}),
  saveAll: vi.fn(async (): Promise<SaveAllOutcome> => "saved"),
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
    projectDirty: state.projectDirty,
    saveAll: state.saveAll,
    confirmExternalChangeReloadDocs: state.reloadDocs,
    confirmExternalChangeReloadProject: state.reloadProject,
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
  state.projectDirty = false;
  state.reloadProject.mockClear();
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

  it("says it deletes an asset the version does not hold, and deletes it", async () => {
    const { service, storage } = await edited();
    const ADDED = "assets/Rock.scene.hasset";
    await storage.writeBinary(ADDED, (await sceneAsset([sceneActor("r", "Rock")])).bytes);
    await service.refreshStatus();
    const onDone = vi.fn();
    render(<SourceControlRevertFlow request={{ path: ADDED, name: "Rock", ref: { kind: "head" } }} onDone={onDone} />);
    const confirm = await screen.findByTestId("source-control-revert-confirm");
    expect(confirm.textContent).toContain("Delete Rock?");
    expect(confirm.textContent).toContain(`Rock is not in main · ${service.getSnapshot().head!.slice(0, 7)}, so reverting deletes it. It cannot be undone.`);
    expect(confirm.textContent).not.toContain("replaces");
    expect(screen.getByTestId("source-control-revert-confirm-action").textContent).toBe("Delete");
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-control-revert-confirm-action"));
    });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(await storage.exists(ADDED)).toBe(false);
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
    await screen.findByTestId("source-control-revert-confirm");
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

describe("Revert Project Settings", () => {
  /** HEAD's Project Settings save automatically; the working copy's turned Auto-Save off. */
  async function editedSettings() {
    const committed = integratedProjectJson({ autoSave: true });
    const sync = await integratedSync({ files: { [PROJECT_FILE]: committed } });
    state.sync = sync.service;
    await sync.storage.writeText(PROJECT_FILE, integratedProjectJson({ autoSave: false }));
    await sync.service.refreshStatus();
    return { ...sync, committed };
  }

  it("asks about every unsaved document and Project Settings, says the project reloads, then writes the version's project.json and reloads it", async () => {
    const { service, storage, committed } = await editedSettings();
    state.dirty = [dirtyForest];
    state.projectDirty = true;
    const events: string[] = [];
    state.applyPulledChanges.mockImplementation(async (paths) => {
      events.push(`reload ${paths.join(", ")}${state.writing ? " in the write queue" : ""}`);
    });
    const onDone = vi.fn();
    render(<SourceControlRevertFlow request={{ path: PROJECT_FILE, name: "Project Settings", ref: { kind: "head" } }} onDone={onDone} />);
    // The project reloads, so every unsaved document counts, Project Settings included.
    const unsaved = screen.getByTestId("source-control-revert-unsaved");
    expect(unsaved.textContent).toContain("Forest");
    expect(unsaved.textContent).toContain("Project Settings");
    expect(unsaved.textContent).toContain("the project reloads afterwards");
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-control-revert-discard"));
    });
    expect(state.reloadProject).toHaveBeenCalled();
    const confirm = await screen.findByTestId("source-control-revert-confirm");
    expect(confirm.textContent).toContain("Revert Project Settings?");
    expect(confirm.textContent).toContain(`Reverting replaces Project Settings with their version from main · ${service.getSnapshot().head!.slice(0, 7)}, then the project reloads. It cannot be undone.`);
    await act(async () => {
      fireEvent.click(screen.getByTestId("source-control-revert-confirm-action"));
    });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(await storage.readText(PROJECT_FILE)).toBe(committed);
    expect(events).toEqual([`reload ${PROJECT_FILE} in the write queue`]);
    expect(service.getSnapshot().rows).toEqual([]);
  });

  it("refuses a version whose Project Settings would stop Haptic's Git here, before anything is saved, and writes nothing", async () => {
    const { service, storage } = await editedSettings();
    await storage.writeText(PROJECT_FILE, integratedProjectJson({ sourceControl: { mode: "off" } }));
    await service.refreshStatus();
    await service.commit({ rowIds: new Set([PROJECT_FILE]), message: "Turn source control off", push: false });
    await storage.writeText(PROJECT_FILE, integratedProjectJson({ autoSave: false }));
    await service.refreshStatus();
    state.dirty = [dirtyForest];
    const before = await storage.readText(PROJECT_FILE);
    render(<SourceControlRevertFlow request={{ path: PROJECT_FILE, name: "Project Settings", ref: { kind: "head" } }} onDone={() => {}} />);
    const blocked = await screen.findByTestId("source-control-revert-blocked");
    expect(blocked.textContent).toContain("set Source Control to Off, so reverting to them would stop Haptic's Git in this folder.");
    expect(screen.queryByTestId("source-control-revert-unsaved")).toBeNull();
    expect(screen.queryByTestId("source-control-revert-confirm")).toBeNull();
    expect(await storage.readText(PROJECT_FILE)).toBe(before);
    expect(state.applyPulledChanges).not.toHaveBeenCalled();
  });
});
