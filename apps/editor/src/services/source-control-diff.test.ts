import { afterEach, describe, expect, it, vi } from "vitest";
import type { SceneDiff } from "@haptic/assets/asset-diff";
import { setEditorQuiet } from "../lib/editor-quiet";
import { manyActors, sceneAsset } from "../testing/diff-assets";
import { integratedSync } from "../testing/integrated-sync";
import { SourceControlDiffService, type DiffState } from "./source-control-diff";

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
    diff.open({ path: PATH, name: "Forest", type: "Scene" });
    const first = await settled(diff);
    expect(first.phase).toBe("ready");
    expect((first.diff!.view as SceneDiff).counts).toEqual({ added: 0, removed: 0, changed: 1 });
    // The first changed actor is chosen.
    expect(first.selection).toBe("a3");

    await save({ 3: "Renamed", 4: "Also" });
    await vi.waitFor(() => expect((diff.getSnapshot().diff?.view as SceneDiff | undefined)?.counts.changed).toBe(2));
    expect(reads).toHaveBeenCalledTimes(1);
    diff.dispose();
  });

  it("downloads a base blob the working copy no longer has, without writing it", async () => {
    const { service, storage, save, baseBlob } = await seeded();
    await save({ 1: "Moved" });
    await storage.remove(baseBlob);
    const diff = new SourceControlDiffService(service);
    diff.open({ path: PATH, name: "Forest", type: "Scene" });
    expect((await settled(diff)).phase).toBe("ready");
    expect(await storage.exists(baseBlob)).toBe(false);
    diff.dispose();
  });

  it("waits while a game covers the editor", async () => {
    const { service, save } = await seeded();
    await save({ 2: "Later" });
    const reads = vi.spyOn(service, "readFileAt");
    setEditorQuiet(true);
    const diff = new SourceControlDiffService(service);
    diff.open({ path: PATH, name: "Forest", type: "Scene" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(diff.getSnapshot().phase).toBe("loading");
    expect(reads).not.toHaveBeenCalled();
    setEditorQuiet(false);
    expect((await settled(diff)).phase).toBe("ready");
    diff.dispose();
  });

  it("shows a version that is not a readable asset as an error, and closes with the project", async () => {
    const { service } = await seeded();
    const diff = new SourceControlDiffService(service);
    diff.open({ path: "assets/Rock.texture.hasset", name: "Rock", type: "Texture" });
    const state = await settled(diff);
    expect(state).toMatchObject({ phase: "error", diff: null });
    expect(state.error).toMatch(/\.hasset/);
    service.stop();
    expect(diff.getSnapshot()).toMatchObject({ target: null, phase: "idle" });
    diff.dispose();
  });
});

describe("SourceControlSyncService.revert", () => {
  it("writes HEAD's version with the blob it references, downloading a blob the copy lost, and leaves no change", async () => {
    const { service, storage, save, head, base, baseBlob } = await seeded();
    await save({ 1: "Edited" });
    await storage.remove(baseBlob);
    expect(await service.revert(PATH, head)).toEqual([PATH]);
    expect(await storage.readBinary(PATH)).toEqual(base.bytes);
    expect(await storage.readBinary(baseBlob)).toEqual([...base.blobs.values()][0]);
    // The edit's own blob is left as an added file; the asset itself matches HEAD.
    expect(service.getSnapshot().rows.map((row) => row.id)).not.toContain(PATH);
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
});
