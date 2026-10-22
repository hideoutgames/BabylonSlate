import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { createMemoryBlobStore, createVfsBlobStore } from "./blob-store";
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
});

describe("createMemoryBlobStore", () => {
  it("keeps stored bytes independent of the arrays callers write and read", async () => {
    const blobs = createMemoryBlobStore();
    const bytes = new Uint8Array([1, 2, 3]);
    await blobs.writeBlob("hash", bytes);
    bytes[0] = 9;
    const read = await blobs.readBlob("hash");
    read[1] = 9;
    expect(await blobs.readBlob("hash")).toEqual(new Uint8Array([1, 2, 3]));
  });
});
