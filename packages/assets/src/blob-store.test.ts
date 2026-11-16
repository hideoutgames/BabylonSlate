import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { createVfsBlobStore } from "./blob-store";
import { sha256Hex } from "./bytes";

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
