import { AUDIO_DECODED_PCM_LRU_BYTES } from "@babylonslate/assets";

export interface AudioBufferCacheOptions {
  byteCeiling?: number;
  budgetEnabled?: boolean;
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
 * Guid-keyed decoded PCM cache with a 256 MiB LRU ceiling, separate from the
 * texture ResourceCache. Active voices pin their buffer so playback cannot
 * evict the bytes they are reading.
 */
export class AudioBufferCache {
  private ceiling: number;
  private budgetEnabled: boolean;
  private readonly evictListeners: Array<
    (assetGuid: string, reason: string) => void
  > = [];
  private readonly entries = new Map<string, AudioCacheEntry>();
  private clock = 0;
  private totalBytes = 0;
  private reserved = 0;

  constructor(options: AudioBufferCacheOptions = {}) {
    this.ceiling = options.byteCeiling ?? AUDIO_DECODED_PCM_LRU_BYTES;
    this.budgetEnabled = options.budgetEnabled !== false;
    if (options.onEvict) this.evictListeners.push(options.onEvict);
  }

  addEvictListener(listener: (assetGuid: string, reason: string) => void): void {
    this.evictListeners.push(listener);
  }

  setByteCeiling(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.ceiling = bytes;
    this.evictToCeiling();
  }

  setBudgetEnabled(enabled: boolean): void {
    this.budgetEnabled = enabled;
    if (enabled) this.evictToCeiling();
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
    this.evictToCeiling();
  }

  accountedBytes(): number {
    return this.totalBytes;
  }

  removeUnreferenced(assetGuid: string): boolean {
    const entry = this.entries.get(assetGuid);
    if (!entry || entry.pins !== 0) return false;
    this.evictEntry(assetGuid, "source-release");
    return true;
  }

  /** Admission includes live PCM and other decoders; oversized work fails instead of waiting. */
  reserveDecode(bytes: number): { resize: (actualBytes: number) => void; release: () => void } {
    let held = 0;
    let released = false;
    const resize = (next: number) => {
      if (released) throw new Error("Audio decode reservation was released.");
      if (!Number.isSafeInteger(next) || next < 0) throw new Error("Invalid Audio decode size.");
      if (this.budgetEnabled) {
        if (next > this.ceiling) throw new Error(`Audio decode needs ${next} bytes, exceeding the ${this.ceiling}-byte PCM budget.`);
        const candidates = [...this.entries.values()].filter((entry) => entry.pins === 0).sort((a, b) => a.lastUsed - b.lastUsed);
        for (const entry of candidates) {
          if (this.totalBytes + this.reserved - held + next <= this.ceiling) break;
          this.evictEntry(entry.assetGuid, "decode-admission");
        }
        if (this.totalBytes + this.reserved - held + next > this.ceiling)
          throw new Error(`Audio decode needs ${next} bytes; active voices and pending decoding occupy the available PCM budget.`);
      }
      this.reserved += next - held;
      held = next;
    };
    resize(bytes);
    return { resize, release: () => { if (released) return; released = true; this.reserved -= held; held = 0; } };
  }

  reservedBytes(): number { return this.reserved; }

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
    if (!this.budgetEnabled) return;
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
    for (const listener of this.evictListeners) {
      listener(assetGuid, reason);
    }
  }
}
