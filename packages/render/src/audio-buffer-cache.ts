import { AUDIO_DECODED_PCM_LRU_BYTES } from "@babylonslate/assets";

export interface AudioBufferCacheOptions {
  byteCeiling?: number;
  onEvict?: (assetGuid: string, reason: string) => void;
}

interface AudioCacheEntry {
  assetGuid: string;
  bytes: Uint8Array;
  accounted: number;
  pins: number;
  lastUsed: number;
}

/**
 * Guid-keyed decoded PCM cache with a 64 MiB LRU ceiling, separate from the
 * texture ResourceCache. Active voices pin their buffer so playback cannot
 * evict the bytes they are reading.
 */
export class AudioBufferCache {
  private readonly ceiling: number;
  private readonly onEvict?: (assetGuid: string, reason: string) => void;
  private readonly entries = new Map<string, AudioCacheEntry>();
  private clock = 0;
  private totalBytes = 0;

  constructor(options: AudioBufferCacheOptions = {}) {
    this.ceiling = options.byteCeiling ?? AUDIO_DECODED_PCM_LRU_BYTES;
    this.onEvict = options.onEvict;
  }

  put(assetGuid: string, bytes: Uint8Array, accounted = bytes.byteLength): void {
    const existing = this.entries.get(assetGuid);
    if (existing) {
      this.totalBytes -= existing.accounted;
      existing.bytes = bytes;
      existing.accounted = accounted;
      existing.lastUsed = ++this.clock;
      this.totalBytes += accounted;
      this.evictToCeiling(assetGuid);
      return;
    }
    this.entries.set(assetGuid, {
      assetGuid,
      bytes,
      accounted,
      pins: 0,
      lastUsed: ++this.clock,
    });
    this.totalBytes += accounted;
    this.evictToCeiling(assetGuid);
  }

  get(assetGuid: string): Uint8Array | undefined {
    const entry = this.entries.get(assetGuid);
    if (!entry) return undefined;
    entry.lastUsed = ++this.clock;
    return entry.bytes;
  }

  pin(assetGuid: string): void {
    const entry = this.entries.get(assetGuid);
    if (!entry) return;
    entry.pins += 1;
    entry.lastUsed = ++this.clock;
  }

  unpin(assetGuid: string): void {
    const entry = this.entries.get(assetGuid);
    if (!entry) return;
    entry.pins = Math.max(0, entry.pins - 1);
  }

  accountedBytes(): number {
    return this.totalBytes;
  }

  flushUnreferenced(): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.pins === 0) this.evictEntry(entry.assetGuid, "flush");
    }
  }

  dispose(): void {
    for (const guid of [...this.entries.keys()]) {
      this.evictEntry(guid, "dispose");
    }
  }

  private evictToCeiling(keepGuid?: string): void {
    if (this.totalBytes <= this.ceiling) return;
    const candidates = [...this.entries.values()]
      .filter((entry) => entry.pins === 0 && entry.assetGuid !== keepGuid)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of candidates) {
      if (this.totalBytes <= this.ceiling) break;
      this.evictEntry(entry.assetGuid, "lru");
    }
  }

  private evictEntry(assetGuid: string, reason: string): void {
    const entry = this.entries.get(assetGuid);
    if (!entry) return;
    this.totalBytes -= entry.accounted;
    this.entries.delete(assetGuid);
    this.onEvict?.(assetGuid, reason);
  }
}
