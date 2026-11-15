import { mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ProjectStorage } from "@haptic/core";
import { NodeStorageAdapter } from "@haptic/vfs/node";
import { testAsset } from "../testing/diff-assets";
import { integratedSync } from "../testing/integrated-sync";
import { unusedLfsObjects } from "./source-control-unused-files";

const AUTHOR = { name: "ada", email: "" };
/** Large enough for a chunk to live in a blob. */
const BLOB_BYTES = 70 * 1024;

/** A Texture whose one chunk is a blob, and that blob. */
async function texture(name: string, fill: number) {
  const asset = await testAsset("Texture", name, { chunks: [{ id: "pixels", kind: "pixels", mime: "application/octet-stream", data: new Uint8Array(BLOB_BYTES).fill(fill) }] });
  const [sha, blob] = [...asset.blobs][0]!;
  return { bytes: asset.bytes, sha, blob };
}

/** The seed's assets as real `.hasset` files (an unreadable one would keep its root's blobs): Rock with its blob, no Forest. */
async function seed(extra: Record<string, Uint8Array> = {}) {
  const rock = await texture("Rock", 1);
  return {
    rock,
    files: { "assets/Forest.scene.hasset": null, "assets/Rock.texture.hasset": rock.bytes, [`assets/.blobs/${rock.sha}`]: rock.blob, ...extra },
  };
}

/** `storage` recording the paths removed through it. */
function recording(storage: ProjectStorage): { storage: ProjectStorage; removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    storage: new Proxy(storage, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (typeof value !== "function") return value;
        if (key !== "remove") return value.bind(target);
        return (path: string, ...rest: unknown[]) => {
          removed.push(path);
          return Reflect.apply(value, target, [path, ...rest]);
        };
      },
    }),
  };
}

describe("Remove Unused Files", () => {
  it("removes untracked blob files nothing needs, keeping those a plugin asset, an unpushed branch or a commit holds", async () => {
    const stale = await texture("Stale", 2);
    const lost = await texture("Lost", 3);
    const crate = await texture("Crate", 4);
    const fern = await texture("Fern", 5);
    const writes: string[] = [];
    // Tracked, though no asset uses it any more.
    const { rock, files } = await seed({ [`assets/.blobs/${stale.sha}`]: stale.blob });
    const { service, storage, port } = await integratedSync({
      files,
      exclusiveWrites: async (reason, work, storage) => {
        writes.push(reason);
        return work(storage);
      },
    });
    // A blob only a commit of another branch holds, not pushed yet: it exists nowhere else.
    await port.createBranch("feature");
    await storage.writeBinary(`assets/.blobs/${fern.sha}`, fern.blob);
    await storage.writeBinary("assets/Fern.texture.hasset", fern.bytes);
    await port.commit({ paths: [`assets/.blobs/${fern.sha}`, "assets/Fern.texture.hasset"], message: "Fern", author: AUTHOR });
    await port.switchBranch("main");
    // A reverted edit's blob, which nothing references.
    await storage.writeBinary(`assets/.blobs/${lost.sha}`, lost.blob);
    // A plugin asset's blob, in its own root's folder; the registry need not index the plugin.
    await storage.writeBinary(`plugins/Props/assets/.blobs/${crate.sha}`, crate.blob);
    await storage.writeBinary("plugins/Props/assets/Crate.texture.hasset", crate.bytes);
    // Rock's blob copied into the plugin's folder: only the plugin's own assets would load it.
    await storage.writeBinary(`plugins/Props/assets/.blobs/${rock.sha}`, rock.blob);
    // Rock saved again, not committed yet: its new blob is untracked, and the tracked asset uses it.
    const edited = await texture("Rock", 6);
    await storage.writeBinary(`assets/.blobs/${edited.sha}`, edited.blob);
    await storage.writeBinary("assets/Rock.texture.hasset", edited.bytes);
    await service.refreshStatus();

    const unused = [`assets/.blobs/${lost.sha}`, `plugins/Props/assets/.blobs/${rock.sha}`].sort();
    expect(await service.findUnusedFiles()).toEqual({ paths: unused, bytes: 2 * BLOB_BYTES });
    expect(await service.removeUnusedFiles(unused)).toEqual({ paths: unused, bytes: 2 * BLOB_BYTES });
    expect(writes).toEqual(["Read-only while removing unused files"]);

    for (const path of unused) expect(await storage.exists(path)).toBe(false);
    for (const path of [`assets/.blobs/${rock.sha}`, `assets/.blobs/${edited.sha}`, `assets/.blobs/${stale.sha}`, `assets/.blobs/${fern.sha}`, `plugins/Props/assets/.blobs/${crate.sha}`]) {
      expect(await storage.exists(path)).toBe(true);
    }
    expect(await service.findUnusedFiles()).toEqual({ paths: [], bytes: 0 });
    // The unpushed branch still pushes its object from the working copy.
    await port.switchBranch("feature");
    expect(await port.push()).toMatchObject({ uploaded: 1 });
  });

  it("keeps a confirmed file that an asset references by the time it would be removed, and removes only through the project's only writer", async () => {
    const lost = await texture("Lost", 3);
    const other = await texture("Other", 6);
    const exclusive = { reasons: [] as string[], removed: [] as string[] };
    const { service, storage } = await integratedSync({
      files: (await seed()).files,
      exclusiveWrites: async (reason, work, storage) => {
        exclusive.reasons.push(reason);
        const own = recording(storage);
        try {
          return await work(own.storage);
        } finally {
          exclusive.removed.push(...own.removed);
        }
      },
    });
    await storage.writeBinary(`assets/.blobs/${lost.sha}`, lost.blob);
    await storage.writeBinary(`assets/.blobs/${other.sha}`, other.blob);
    const found = await service.findUnusedFiles();
    expect(found.paths).toEqual([`assets/.blobs/${lost.sha}`, `assets/.blobs/${other.sha}`].sort());

    // Imported again after the confirmation: the import found the blob in place and only wrote its asset.
    await storage.writeBinary("assets/Lost.texture.hasset", lost.bytes);
    expect(await service.removeUnusedFiles(found.paths)).toEqual({ paths: [`assets/.blobs/${other.sha}`], bytes: BLOB_BYTES });
    expect(await storage.exists(`assets/.blobs/${lost.sha}`)).toBe(true);
    expect(exclusive).toEqual({ reasons: ["Read-only while removing unused files"], removed: [`assets/.blobs/${other.sha}`] });
  });

  it("reads only the headers of the content roots that hold a file to remove, and only their headers", async () => {
    const lost = await texture("Lost", 3);
    const crate = await texture("Crate", 4);
    const { service, storage } = await integratedSync({ files: (await seed()).files });
    await storage.writeBinary(`plugins/Props/assets/.blobs/${lost.sha}`, lost.blob);
    await storage.writeBinary(`plugins/Props/assets/.blobs/${crate.sha}`, crate.blob);
    await storage.writeBinary("plugins/Props/assets/Crate.texture.hasset", crate.bytes);
    const whole = vi.spyOn(storage, "readBinary");
    const ranges = vi.spyOn(storage, "readBinaryRange");

    expect(await service.findUnusedFiles()).toEqual({ paths: [`plugins/Props/assets/.blobs/${lost.sha}`], bytes: BLOB_BYTES });
    // No asset or blob is read whole, and the project root's assets, which cannot load the plugin's blobs, are not read at all.
    expect(whole.mock.calls.map(([path]) => path).filter((path) => path.endsWith(".hasset") || path.includes("/.blobs/"))).toEqual([]);
    expect([...new Set(ranges.mock.calls.map(([path]) => path))]).toEqual(["plugins/Props/assets/Crate.texture.hasset"]);
  });

  it("removes nothing once the project closes while it waits to be the only writer", async () => {
    const lost = await texture("Lost", 3);
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    let proceed!: () => void;
    const gate = new Promise<void>((resolve) => { proceed = resolve; });
    const { service, storage } = await integratedSync({
      files: (await seed()).files,
      exclusiveWrites: async (_reason, work, storage) => {
        enter();
        await gate;
        return work(storage);
      },
    });
    await storage.writeBinary(`assets/.blobs/${lost.sha}`, lost.blob);
    const found = await service.findUnusedFiles();
    expect(found.paths).toEqual([`assets/.blobs/${lost.sha}`]);

    const removing = service.removeUnusedFiles(found.paths);
    await entered;
    service.stop();
    proceed();
    await expect(removing).rejects.toThrow();
    expect(await storage.exists(`assets/.blobs/${lost.sha}`)).toBe(true);
  });

  it("removes nothing when cancelled while it waits for other writers, and no cancel stops it once removing began", async () => {
    const lost = await texture("Lost", 3);
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    let proceed!: () => void;
    const drained = new Promise<void>((resolve) => { proceed = resolve; });
    let waits = 0;
    const { service, storage } = await integratedSync({
      files: (await seed()).files,
      // Admitted writers drain until the wait's signal ends it, as the project service waits.
      exclusiveWrites: async (_reason, work, storage, signal) => {
        waits += 1;
        enter();
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          void drained.then(resolve);
        });
        return work(storage);
      },
    });
    await storage.writeBinary(`assets/.blobs/${lost.sha}`, lost.blob);
    const found = await service.findUnusedFiles();
    expect(found.paths).toEqual([`assets/.blobs/${lost.sha}`]);

    const cancel = new AbortController();
    let outcome: unknown = "waiting";
    service.removeUnusedFiles(found.paths, { signal: cancel.signal }).then((removed) => { outcome = removed; }, (error: unknown) => { outcome = error; });
    await entered;
    cancel.abort();
    await vi.waitFor(() => expect(outcome).toMatchObject({ kind: "cancelled" }));
    expect(await storage.exists(`assets/.blobs/${lost.sha}`)).toBe(true);
    // A cancel is no problem to show.
    expect(service.getSnapshot().problem).toBeNull();

    // Cancelled before its turn: nothing waits for other writers.
    await expect(service.removeUnusedFiles(found.paths, { signal: cancel.signal })).rejects.toMatchObject({ kind: "cancelled" });
    expect(waits).toBe(1);

    proceed();
    const late = new AbortController();
    const steps: string[] = [];
    const removed = await service.removeUnusedFiles(found.paths, {
      signal: late.signal,
      onRemoving: () => {
        steps.push("removing");
        late.abort();
      },
    });
    expect(steps).toEqual(["removing"]);
    expect(removed).toEqual({ paths: found.paths, bytes: BLOB_BYTES });
    expect(await storage.exists(`assets/.blobs/${lost.sha}`)).toBe(false);
  });

  it("keeps a blob a committed version of an asset names while that commit lacks it", async () => {
    // Another Git app committed Fern without its blob: only this file lets that version be compared or reverted.
    const fern = await texture("Fern", 5);
    const edited = await texture("Fern", 6);
    const { service, storage, port } = await integratedSync({ files: (await seed()).files });
    await storage.writeBinary(`assets/.blobs/${fern.sha}`, fern.blob);
    await storage.writeBinary("assets/Fern.texture.hasset", fern.bytes);
    await port.commit({ paths: ["assets/Fern.texture.hasset"], message: "Fern", author: AUTHOR });
    await port.push();
    await storage.writeBinary(`assets/.blobs/${edited.sha}`, edited.blob);
    await storage.writeBinary("assets/Fern.texture.hasset", edited.bytes);
    await port.commit({ paths: ["assets/Fern.texture.hasset", `assets/.blobs/${edited.sha}`], message: "Fern again", author: AUTHOR });
    await port.push();

    expect(await service.findUnusedFiles()).toEqual({ paths: [], bytes: 0 });
    expect(await storage.exists(`assets/.blobs/${fern.sha}`)).toBe(true);
  });

  it("keeps the blobs a rename's backup references, and every blob of a root holding a backup that is no readable asset", async () => {
    // A case-only rename whose restore failed leaves the original only in its backup, beside the asset.
    const lost = await texture("Lost", 3);
    const crate = await texture("Crate", 4);
    const loose = await texture("Loose", 5);
    const { service, storage } = await integratedSync({ files: (await seed()).files });
    await storage.writeBinary(`assets/.blobs/${lost.sha}`, lost.blob);
    await storage.writeBinary("assets/Characters/.haptic-move-0c5a1e7f", lost.bytes);
    await storage.writeBinary(`assets/.blobs/${loose.sha}`, loose.blob);
    await storage.writeBinary(`plugins/Props/assets/.blobs/${crate.sha}`, crate.blob);
    await storage.writeText("plugins/Props/assets/.haptic-move-9d2b4c11", "half a backup");

    expect(await service.findUnusedFiles()).toEqual({ paths: [`assets/.blobs/${loose.sha}`], bytes: BLOB_BYTES });
  });

  it("removes nothing while a symbolic link may show one blob folder's files under another's paths", async () => {
    // Git lists a blob in a linked folder under both paths; the plugin's header keeps only its own.
    const dir = await mkdtemp(join(tmpdir(), "haptic-unused-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const crate = await texture("Crate", 4);
    const storage = new NodeStorageAdapter(dir);
    await storage.openDocumentsProject("Game");
    const project = join(dir, "Game");
    const signal = new AbortController().signal;
    await storage.writeBinary(`assets/.blobs/${crate.sha}`, crate.blob);
    await storage.writeBinary("plugins/Props/assets/Crate.texture.hasset", crate.bytes);
    const own = `assets/.blobs/${crate.sha}`;
    const plugin = `plugins/Props/assets/.blobs/${crate.sha}`;

    // Without a link the project's copy is its own file, which nothing in its root uses.
    expect(await unusedLfsObjects(storage, [own], signal)).toEqual({ paths: [own], bytes: BLOB_BYTES });

    // The plugin's folder is a link to the project's.
    await symlink(join(project, "assets", ".blobs"), join(project, "plugins", "Props", "assets", ".blobs"));
    expect(await unusedLfsObjects(storage, [own, plugin], signal)).toEqual({ paths: [], bytes: 0 });

    // The project's folder is a link to the plugin's.
    await rm(join(project, "plugins", "Props", "assets", ".blobs"));
    await rename(join(project, "assets", ".blobs"), join(project, "plugins", "Props", "assets", ".blobs"));
    await symlink(join(project, "plugins", "Props", "assets", ".blobs"), join(project, "assets", ".blobs"));
    expect(await unusedLfsObjects(storage, [own, plugin], signal)).toEqual({ paths: [], bytes: 0 });

    // One blob file is a link to another folder's.
    await rm(join(project, "assets", ".blobs"));
    await rename(join(project, "plugins", "Props", "assets", ".blobs"), join(project, "assets", ".blobs"));
    await mkdir(join(project, "plugins", "Props", "assets", ".blobs"));
    await symlink(join(project, "assets", ".blobs", crate.sha), join(project, "plugins", "Props", "assets", ".blobs", crate.sha));
    expect(await unusedLfsObjects(storage, [own, plugin], signal)).toEqual({ paths: [], bytes: 0 });
    expect(await storage.readBinary(plugin)).toEqual(crate.blob);
  });

  it("keeps every blob of a content root that holds an asset whose header cannot be read", async () => {
    const lost = await texture("Lost", 3);
    const { service, storage } = await integratedSync({ files: (await seed()).files });
    await storage.writeBinary(`assets/.blobs/${lost.sha}`, lost.blob);
    await storage.writeBinary(`plugins/Props/assets/.blobs/${lost.sha}`, lost.blob);
    await storage.writeText("assets/Broken.texture.hasset", "not an asset");
    // Its root's blobs stay; another root's are judged by their own assets.
    expect(await service.findUnusedFiles()).toEqual({ paths: [`plugins/Props/assets/.blobs/${lost.sha}`], bytes: BLOB_BYTES });
  });
});
