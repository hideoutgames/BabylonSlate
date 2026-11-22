import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectStorage } from "@haptic/core";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { createVfsBlobStore } from "./blob-store";
import { collectReferencedBlobs, sweepOrphanedBlobs } from "./blob-sweep";
import { sha256Hex } from "./bytes";
import { encodeHasset } from "./hasset";

afterEach(() => {
  vi.useRealTimers();
});

/** Bytes big enough to be externalised to the blob folder, distinct per `seed`. */
function large(seed: number): Uint8Array {
  return new Uint8Array(70 * 1024).map((_, index) => (index * 7 + seed) % 256);
}

/** Writes an asset at `path` whose one chunk is a blob in `assets/.blobs`; resolves the blob's hash. */
async function writeAsset(storage: ProjectStorage, path: string, seed: number): Promise<string> {
  const data = large(seed);
  const bytes = await encodeHasset({
    header: {
      dependencyMetadataVersion: 1, requiredDependencies: [],
      guid: `guid-${seed}`, type: "Texture", name: `T${seed}`, engineVersion: "0.0.0", version: 1, mode: "thin", dependencies: [], payload: {},
    },
    chunks: [{ id: "pixels", kind: "pixels", mime: "application/octet-stream", data }],
    blobThreshold: 64 * 1024,
    writeBlob: async (hash, blob) => {
      await storage.mkdir("assets/.blobs", true);
      await storage.writeBinary(`assets/.blobs/${hash}`, blob);
    },
  });
  await storage.mkdir(path.slice(0, path.lastIndexOf("/")), true);
  await storage.writeBinary(path, bytes);
  return sha256Hex(data);
}

/** A blob file no asset names. */
async function writeOrphan(storage: ProjectStorage, seed: number): Promise<string> {
  const data = large(seed);
  const hash = await sha256Hex(data);
  await storage.mkdir("assets/.blobs", true);
  await storage.writeBinary(`assets/.blobs/${hash}`, data);
  return hash;
}

async function project(): Promise<MemoryStorageAdapter> {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("sweep.hproject");
  return storage;
}

const STAGED = ".haptic-0f8fad5b-d9cb-469f-a165-70867728950e.tmp";
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);

describe("sweepOrphanedBlobs", () => {
  it("removes only old blobs no asset names and old staged files, keeping referenced, recent and unknown files", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const storage = await project();
    const used = await writeAsset(storage, "assets/Rock.texture.hasset", 1);
    const orphan = await writeOrphan(storage, 2);
    await storage.writeBinary(`assets/.blobs/${STAGED}`, new Uint8Array(10));
    await storage.writeBinary("assets/.blobs/notes.txt", new Uint8Array(3));
    // Written 30 s before the sweep: inside the grace window.
    vi.setSystemTime(T0 + 90_000);
    const fresh = await writeOrphan(storage, 3);
    vi.setSystemTime(T0 + 120_000);

    const referenced = await collectReferencedBlobs(storage);
    expect(referenced).toEqual({ complete: true, blobs: new Set([used]) });
    const result = await sweepOrphanedBlobs(storage, referenced.complete ? referenced.blobs : new Set());
    expect(result).toEqual({ removed: [`assets/.blobs/${STAGED}`, `assets/.blobs/${orphan}`].sort(), bytes: 70 * 1024 + 10, stopped: false });
    expect((await storage.readdir("assets/.blobs")).map((entry) => entry.name).sort()).toEqual([fresh, "notes.txt", used].sort());
  });

  it("keeps a blob a write asked for within the window, though its file is old", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const storage = await project();
    const data = large(4);
    const hash = await writeOrphan(storage, 4);
    vi.setSystemTime(T0 + 120_000);
    // A save found it stored and wrote nothing; its asset lands after.
    await createVfsBlobStore(storage).writeBlob(hash, data);
    expect((await sweepOrphanedBlobs(storage, new Set())).removed).toEqual([]);
  });

  it("keeps files whose mtime is unknown or in the future", async () => {
    const storage = await project();
    const unknown = await writeOrphan(storage, 5);
    const future = await writeOrphan(storage, 6);
    const view = new Proxy(storage, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (key === "readdir") {
          return async (path: string) => (await target.readdir(path)).map((entry) => ({
            ...entry, mtime: entry.name === unknown ? null : entry.name === future ? Date.now() + 3_600_000 : entry.mtime,
          }));
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as ProjectStorage;
    const result = await sweepOrphanedBlobs(view, new Set(), { now: () => Date.now() + 120_000 });
    expect(result.removed).toEqual([]);
  });

  it("stops before a batch its admission refuses, removing nothing more", async () => {
    const storage = await project();
    await writeOrphan(storage, 7);
    const result = await sweepOrphanedBlobs(storage, new Set(), { now: () => Date.now() + 120_000, admit: async () => false });
    expect(result).toEqual({ removed: [], bytes: 0, stopped: true });
    expect(await storage.readdir("assets/.blobs")).toHaveLength(1);
  });
});

describe("collectReferencedBlobs", () => {
  it("reads every asset header, nested, in other roots and in move backups, but not .git", async () => {
    const storage = await project();
    const nested = await writeAsset(storage, "assets/Deep/Er/Stone.texture.hasset", 8);
    const plugin = await writeAsset(storage, "plugins/Kit/assets/Kit.texture.hasset", 9);
    const backup = await writeAsset(storage, "assets/Deep/.haptic-move-1234", 10);
    await writeAsset(storage, ".git/lfs/Ignored.texture.hasset", 11);
    const referenced = await collectReferencedBlobs(storage);
    expect(referenced).toEqual({ complete: true, blobs: new Set([nested, plugin, backup]) });
  });

  it("is incomplete when an asset header cannot be read, so a sweep removes nothing", async () => {
    const storage = await project();
    await writeAsset(storage, "assets/Good.texture.hasset", 12);
    await storage.writeBinary("assets/Half.texture.hasset", new Uint8Array([0x48, 0x41]));
    expect(await collectReferencedBlobs(storage)).toEqual({ complete: false, reason: "unreadable", paths: ["assets/Half.texture.hasset"] });
  });
});

describe("createVfsBlobStore", () => {
  it("rewrites a torn blob at its hash path and leaves a complete one alone", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("blobs.hproject");
    const blobs = createVfsBlobStore(storage);
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const hash = await sha256Hex(bytes);
    await storage.mkdir("assets/.blobs", true);
    await storage.writeBinary(`assets/.blobs/${hash}`, bytes.subarray(0, 2));

    await blobs.writeBlob(hash, bytes);
    expect(await blobs.readBlob(hash)).toEqual(bytes);

    const write = vi.spyOn(storage, "writeBinary");
    await blobs.writeBlob(hash, bytes);
    expect(write).not.toHaveBeenCalled();
  });

  it("passes a blob already stored through the storage's write guard, as a written one", async () => {
    // Remove Unused Files removes blobs as the project's only writer: an asset written meanwhile
    // must not name a blob it found stored, which the removal may take before the asset's header lands.
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("blobs.hproject");
    const bytes = new Uint8Array([1, 2, 3]);
    const hash = await sha256Hex(bytes);
    await createVfsBlobStore(storage).writeBlob(hash, bytes);
    let guarded = false;
    const guard = new Proxy(storage, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (typeof value !== "function") return value;
        if (guarded && (key === "writeBinary" || key === "mkdir" || key === "remove")) {
          return () => Promise.reject(new Error("Read-only while removing unused files"));
        }
        return value.bind(target);
      },
    });
    const blobs = createVfsBlobStore(guard);

    guarded = true;
    await expect(blobs.writeBlob(hash, bytes)).rejects.toThrow("Read-only while removing unused files");
    guarded = false;
    await blobs.writeBlob(hash, bytes);
    expect(await blobs.readBlob(hash)).toEqual(bytes);
  });
});
