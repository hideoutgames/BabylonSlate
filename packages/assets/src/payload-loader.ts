import type { ProjectStorage } from "@babylonslate/core";
import type { ChunkEntry } from "./babasset";
import { readU32LE } from "./bytes";
import { createVfsBlobStore, type BlobStore } from "./blob-store";

export interface AccountedPayloadLoaderOptions {
  blobs?: BlobStore;
}

/**
 * Thin, byte-accounted chunk accessor (engineplan §2.4). Registry scan and
 * browse only ever call `readBabassetHeader`; this is the one path that is
 * allowed to allocate a chunk's payload, and every byte it allocates is
 * counted so the "several hundred assets open near-zero" invariant is a
 * runtime-checkable number rather than an assertion about code shape.
 */
export class AccountedPayloadLoader {
  private readonly blobs: BlobStore;
  private accounted = 0;

  constructor(storage: ProjectStorage, options: AccountedPayloadLoaderOptions = {}) {
    this.blobs = options.blobs ?? createVfsBlobStore(storage);
  }

  async loadChunk(
    fileBytes: Uint8Array,
    entry: ChunkEntry,
    blobs: BlobStore = this.blobs,
  ): Promise<Uint8Array> {
    let data: Uint8Array;
    if ("inline" in entry.locator) {
      const headerLen = readU32LE(fileBytes, 8);
      const payloadStart = 12 + headerLen;
      const { offset, length } = entry.locator.inline;
      data = fileBytes.subarray(payloadStart + offset, payloadStart + offset + length);
    } else {
      data = await blobs.readBlob(entry.locator.blob);
    }
    this.accounted += data.byteLength;
    return data;
  }

  get accountedPayloadBytes(): number {
    return this.accounted;
  }

  resetAccounting(): void {
    this.accounted = 0;
  }
}
