import { afterEach, describe, expect, it, vi } from "vitest";
import type { PropertiesDiff, SceneDiff } from "@haptic/assets/asset-diff";
import { PROJECT_FILE } from "@haptic/core";
import { setEditorQuiet } from "../lib/editor-quiet";
import { manyActors, sceneActor, sceneAsset } from "../testing/diff-assets";
import { integratedProjectJson, integratedSync } from "../testing/integrated-sync";
import { DIFF_IDLE_MS, SourceControlDiffService, type DiffState } from "./source-control-diff";

// The diff service and the revert over the real sync service and FakeSync, with real `.hasset`
// files: a Scene large enough that its document is a blob, as a real Scene's is.

const PATH = "assets/Forest.scene.hasset";

async function seeded() {
  const base = await sceneAsset(manyActors(1500));
  const blobFiles = Object.fromEntries([...base.blobs].map(([sha, bytes]) => [`assets/.blobs/${sha}`, bytes]));
  const sync = await integratedSync({ files: { [PATH]: base.bytes, ...blobFiles } });
  const head = sync.service.getSnapshot().head!;
  /** Saves a new version of the Scene into the working copy, with its blob, and reads the status. */
  const save = async (rename: Record<number, string>) => {
    const next = await sceneAsset(manyActors(1500, rename));
    for (const [sha, bytes] of next.blobs) await sync.storage.writeBinary(`assets/.blobs/${sha}`, bytes);
    await sync.storage.writeBinary(PATH, next.bytes);
    await sync.service.refreshStatus();
  };
  return { ...sync, base, head, baseBlob: `assets/.blobs/${[...base.blobs.keys()][0]}`, save };
}

/** The next state that is not loading. */
function settled(diff: SourceControlDiffService): Promise<DiffState> {
  return new Promise((resolve) => {
    const check = () => {
      const state = diff.getSnapshot();
      if (state.phase !== "loading" && state.phase !== "idle") {
        unsubscribe();
        resolve(state);
      }
    };
    const unsubscribe = diff.subscribe(check);
    check();
  });
}

afterEach(() => {
  setEditorQuiet(false);
});

describe("SourceControlDiffService", () => {
  it("compares HEAD with the working copy, reading the base once and again only the working copy after a save", async () => {
    const { service, save } = await seeded();
    await save({ 3: "Renamed" });
    const reads = vi.spyOn(service, "readFileAt");
    const diff = new SourceControlDiffService(service);
    const detach = diff.attach();
    // The Diff window is on screen.
    diff.watch();
    diff.open({ path: PATH, name: "Forest", type: "Scene" });
    const first = await settled(diff);
    expect(first.phase).toBe("ready");
    expect((first.diff!.view as SceneDiff).counts).toEqual({ added: 0, removed: 0, changed: 1 });
    // The first changed actor is chosen.
    expect(first.selection).toBe("a3");

    await save({ 3: "Renamed", 4: "Also" });
    await vi.waitFor(() => expect((diff.getSnapshot().diff?.view as SceneDiff | undefined)?.counts.changed).toBe(2));
    expect(reads).toHaveBeenCalledTimes(1);
    detach();
  });

  it("loads the working copy again only when the asset's own files change, not after a save of another asset", async () => {
    // The clock moves past each save, so no stamp is too close to a write to trust.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 10, 15, 12) });
    try {
      const sync = await integratedSync({ files: { [PATH]: (await sceneAsset([sceneActor("a", "A")])).bytes } });
      const { service, storage } = sync;
      await storage.writeBinary(PATH, (await sceneAsset([sceneActor("a", "B")])).bytes);
      await service.refreshStatus();
      vi.setSystemTime(Date.now() + 10_000);
      const working = vi.spyOn(service, "readWorking");
      const loads = () => working.mock.calls.filter(([path]) => path === PATH).length;
      const diff = new SourceControlDiffService(service);
      const detach = diff.attach();
      diff.watch();
      diff.open({ path: PATH, name: "Forest", type: "Scene" });
      expect((await settled(diff)).phase).toBe("ready");
      expect(loads()).toBe(1);

      // Rock's save runs a status: Forest's stats are looked at, its file is not read.
      const stamps = vi.spyOn(service, "workingStamp");
      await storage.writeText("assets/Rock.texture.hasset", "R2");
      await service.refreshStatus();
      await vi.waitFor(() => expect(stamps).toHaveBeenCalledTimes(1));
      await stamps.mock.results[0]!.value;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(diff.getSnapshot().phase).toBe("ready");
      expect(loads()).toBe(1);

      // Forest saved again: its Changes row is the same, its file is not.
      vi.setSystemTime(Date.now() + 10_000);
      await storage.writeBinary(PATH, (await sceneAsset([sceneActor("a", "C")])).bytes);
      await service.refreshStatus();
      expect(service.getSnapshot().rows.find((row) => row.id === PATH)?.paths).toEqual([PATH]);
      await vi.waitFor(() => expect(loads()).toBe(2));
      expect((await settled(diff)).phase).toBe("ready");
      detach();
    } finally {
      vi.useRealTimers();
    }
  });

  it("downloads a base blob the working copy no longer has, without writing it", async () => {
    const { service, storage, save, baseBlob } = await seeded();
    await save({ 1: "Moved" });
    await storage.remove(baseBlob);
    const diff = new SourceControlDiffService(service);
    const detach = diff.attach();
    // The Diff window is on screen.
    diff.watch();
    diff.open({ path: PATH, name: "Forest", type: "Scene" });
    expect((await settled(diff)).phase).toBe("ready");
    expect(await storage.exists(baseBlob)).toBe(false);
    detach();
  });

  it("waits while a game covers the editor", async () => {
    const { service, save } = await seeded();
    await save({ 2: "Later" });
    const reads = vi.spyOn(service, "readFileAt");
    setEditorQuiet(true);
    const diff = new SourceControlDiffService(service);
    const detach = diff.attach();
    // The Diff window is on screen.
    diff.watch();
    diff.open({ path: PATH, name: "Forest", type: "Scene" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(diff.getSnapshot().phase).toBe("loading");
    expect(reads).not.toHaveBeenCalled();
    setEditorQuiet(false);
    expect((await settled(diff)).phase).toBe("ready");
    detach();
  });

  it("ends the worker and its decoded versions a while after the last window showing the diff went, and loads again when one is back", async () => {
    const { service, save } = await seeded();
    await save({ 3: "Renamed" });
    const { createDiffLoader } = await import("./source-control-diff-loader");
    const disposed = vi.fn();
    const created = vi.fn();
    const diff = new SourceControlDiffService(service, async (sync) => {
      created();
      const loader = createDiffLoader(sync);
      return { load: loader.load, dispose: () => { disposed(); loader.dispose(); } };
    });
    const detach = diff.attach();
    const unwatch = diff.watch();
    diff.open({ path: PATH, name: "Forest", type: "Scene" });
    expect((await settled(diff)).phase).toBe("ready");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      unwatch();
      // Back within the while: the same worker serves it.
      vi.advanceTimersByTime(DIFF_IDLE_MS - 1);
      const again = diff.watch();
      await vi.advanceTimersByTimeAsync(DIFF_IDLE_MS);
      expect(disposed).not.toHaveBeenCalled();
      again();
      await vi.advanceTimersByTimeAsync(DIFF_IDLE_MS);
      expect(disposed).toHaveBeenCalledTimes(1);
      // The result goes with it; the choice of asset and versions stays.
      expect(diff.getSnapshot()).toMatchObject({ target: { path: PATH }, diff: null });
    } finally {
      vi.useRealTimers();
    }
    const shown = diff.watch();
    expect((await settled(diff)).phase).toBe("ready");
    expect(created).toHaveBeenCalledTimes(2);
    shown();
    detach();
  });

  it("shows a version that is not a readable asset as an error, and closes with the project", async () => {
    const { service } = await seeded();
    const diff = new SourceControlDiffService(service);
    const detach = diff.attach();
    // The Diff window is on screen.
    diff.watch();
    diff.open({ path: "assets/Rock.texture.hasset", name: "Rock", type: "Texture" });
    const state = await settled(diff);
    expect(state).toMatchObject({ phase: "error", diff: null });
    expect(state.error).toMatch(/\.hasset/);
    service.stop();
    expect(diff.getSnapshot()).toMatchObject({ target: null, phase: "idle" });
    detach();
  });

  it("compares Project Settings as the editor reads them, opening on the first changed category; other plain files have no diff", async () => {
    const { service, storage } = await integratedSync({ files: { [PROJECT_FILE]: integratedProjectJson({ autoSave: true }) } });
    await storage.writeText(PROJECT_FILE, integratedProjectJson({ autoSave: false }, { updatedAt: "2026-06-06T00:00:00.000Z" }));
    await service.refreshStatus();
    const diff = new SourceControlDiffService(service);
    const detach = diff.attach();
    diff.watch();
    diff.open({ path: PROJECT_FILE, name: "Project Settings", type: "Project" });
    const state = await settled(diff);
    expect(state.phase).toBe("ready");
    expect(state.diff).toMatchObject({ status: "changed", type: "Project", header: [], chunks: [] });
    const view = state.diff!.view as PropertiesDiff;
    expect(view.groups.flatMap((group) => group.rows.filter((row) => row.changed).map((row) => [group.title, row.label, row.base, row.compare]))).toEqual([
      ["General", "Auto-Save", "On", "Off"],
    ]);
    expect(state.selection).toBe("group:general");

    // A version that cannot be read names itself.
    await storage.writeText(PROJECT_FILE, "{ not json");
    await service.refreshStatus();
    await vi.waitFor(() => expect(diff.getSnapshot().phase).toBe("error"));
    expect(diff.getSnapshot().error).toMatch(/^The Project Settings in Working Copy cannot be read: /);

    // Folder markers and other plain files keep their error.
    diff.open({ path: ".gitattributes", name: ".gitattributes", type: null });
    expect((await settled(diff)).error).toBe(".gitattributes is not an asset, so it has no diff.");
    detach();
  });

  it("shows Project Settings as added when the base version has no project.json", async () => {
    const { service, storage } = await integratedSync();
    await storage.writeText(PROJECT_FILE, integratedProjectJson());
    await service.refreshStatus();
    const diff = new SourceControlDiffService(service);
    const detach = diff.attach();
    diff.watch();
    diff.open({ path: PROJECT_FILE, name: "Project Settings", type: "Project" });
    const state = await settled(diff);
    expect(state.diff?.status).toBe("added");
    const general = (state.diff!.view as PropertiesDiff).groups.find((group) => group.id === "general")!;
    expect(general.rows.find((row) => row.label === "Auto-Save")).toMatchObject({ base: null, compare: "On", changed: true });
    detach();
  });
});

describe("SourceControlSyncService.revert", () => {
  it("writes HEAD's version with the blob it references, downloading a blob the copy lost into its file, and leaves no change", async () => {
    const { service, storage, port, save, head, base, baseBlob } = await seeded();
    await save({ 1: "Edited" });
    await storage.remove(baseBlob);
    const reads = vi.spyOn(port, "readLfsObject");
    const downloads = vi.spyOn(port, "downloadLfsObjects");
    expect(await service.revert(PATH, head)).toEqual([PATH]);
    // Straight into the file (natively on a device): the blob's bytes never enter JavaScript.
    expect(reads).not.toHaveBeenCalled();
    expect(downloads.mock.calls.map(([files]) => files)).toEqual([[{ path: baseBlob, size: [...base.blobs.values()][0]!.byteLength }]]);
    expect(await storage.readBinary(PATH)).toEqual(base.bytes);
    expect(await storage.readBinary(baseBlob)).toEqual([...base.blobs.values()][0]);
    // The edit's own blob is left as an added file; the asset itself matches HEAD.
    expect(service.getSnapshot().rows.map((row) => row.id)).not.toContain(PATH);
  });

  it("leaves the asset as it was when a blob it needs cannot be had", async () => {
    const { service, storage, remote, save, head, baseBlob } = await seeded();
    await save({ 1: "Edited" });
    const edited = await storage.readBinary(PATH);
    await storage.remove(baseBlob);
    remote.lfsObjects.delete(baseBlob.slice("assets/.blobs/".length));
    await expect(service.revert(PATH, head)).rejects.toMatchObject({ kind: "lfs", code: "lfs-object-missing" });
    expect(await storage.readBinary(PATH)).toEqual(edited);
    expect(await storage.exists(baseBlob)).toBe(false);
  });

  it("removes an asset HEAD does not have", async () => {
    const { service, storage, head } = await seeded();
    await storage.writeBinary("assets/New.scene.hasset", (await sceneAsset([])).bytes);
    await service.refreshStatus();
    expect(service.getSnapshot().rows.map((row) => row.id)).toContain("assets/New.scene.hasset");
    await service.revert("assets/New.scene.hasset", head);
    expect(await storage.exists("assets/New.scene.hasset")).toBe(false);
    expect(service.getSnapshot().rows.map((row) => row.id)).not.toContain("assets/New.scene.hasset");
  });

  it("never writes Project Settings the project could not reopen with this repository, nor removes project.json", async () => {
    const { service, storage } = await integratedSync({ files: { [PROJECT_FILE]: integratedProjectJson({ sourceControl: { mode: "integrated", repositoryUrl: "https://github.com/team/other.git" } }) } });
    const head = service.getSnapshot().head!;
    const working = integratedProjectJson({ autoSave: false });
    await storage.writeText(PROJECT_FILE, working);
    await expect(service.revert(PROJECT_FILE, head)).rejects.toThrow("use another repository (https://github.com/team/other.git)");
    await expect(service.revert(PROJECT_FILE, null)).rejects.toThrow("has no Project Settings to revert to");
    expect(await storage.readText(PROJECT_FILE)).toBe(working);
  });
});
