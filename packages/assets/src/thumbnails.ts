import type { ProjectStorage } from "@babylonslate/core";
import { derivedDataRoot } from "./derived-data";

export function thumbnailsDir(projectGuid: string): string {
  return `${derivedDataRoot(projectGuid)}/thumbnails`;
}

/** `derived/{projectGuid}/thumbnails/{assetGuid}.bin` */
export function thumbnailPath(projectGuid: string, assetGuid: string): string {
  return `${thumbnailsDir(projectGuid)}/${assetGuid}.bin`;
}

export async function writeThumbnail(
  derivedStorage: ProjectStorage,
  projectGuid: string,
  assetGuid: string,
  bytes: Uint8Array,
): Promise<void> {
  await derivedStorage.mkdir(thumbnailsDir(projectGuid), true);
  await derivedStorage.writeBinary(thumbnailPath(projectGuid, assetGuid), bytes);
}

export async function readThumbnail(
  derivedStorage: ProjectStorage,
  projectGuid: string,
  assetGuid: string,
): Promise<Uint8Array | null> {
  const path = thumbnailPath(projectGuid, assetGuid);
  if (!(await derivedStorage.exists(path))) {
    return null;
  }
  return derivedStorage.readBinary(path);
}

/**
 * Decoded-thumbnail LRU, deliberately separate from the P4 scene resource
 * cache (engineplan §2.4): the Content Browser grid decodes only visible,
 * virtualised cells and must not let that evict scene payloads or vice versa.
 */
export class ThumbnailDecodeLru {
  private readonly maxEntries: number;
  private readonly entries = new Map<string, Uint8Array>();

  constructor(maxEntries: number) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  get(key: string): Uint8Array | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: Uint8Array): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(key, value);
  }

  get size(): number {
    return this.entries.size;
  }
}
