import type { ProjectStorage } from "@babylonslate/core";
import { derivedDataRoot } from "./derived-data";

export const DEFAULT_THUMBNAIL_MAX_EDGE = 128;

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

/**
 * Downsample source image bytes to a small JPEG/PNG for the CB grid.
 * Returns null when the host cannot decode images (e.g. plain Node without
 * canvas). Callers should treat null as "no thumbnail yet".
 */
export async function generateThumbnailBytes(
  source: Uint8Array,
  maxEdge: number = DEFAULT_THUMBNAIL_MAX_EDGE,
  mime?: string,
): Promise<Uint8Array | null> {
  if (typeof createImageBitmap !== "function") {
    return null;
  }
  const copy = source.slice();
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(
      new Blob([copy], mime ? { type: mime } : undefined),
    );
  } catch {
    return null;
  }
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    if (typeof OffscreenCanvas === "undefined") {
      return null;
    }
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob =
      typeof canvas.convertToBlob === "function"
        ? await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 })
        : null;
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}
