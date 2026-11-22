/** A decoded JSON asset: its verified bytes, the parsed document and what the player made of it (a normalized Scene). */
export type CachedDocument = { bytes: Uint8Array; document: unknown; value: unknown };

/** What `DocumentCache` holds by default: about 10 MiB of JSON source at three times its size. */
export const PLAYER_DOCUMENT_CACHE_BYTES = 32 * 1024 * 1024;

/**
 * The exported player's decoded JSON documents for the session, by asset guid and catalog revision, so loading one
 * again (a Scene re-entered after the loader released it) reads, hashes, parses and normalizes nothing. Binary
 * payloads (Textures, Models, Audio) never enter it. An entry costs three times its source bytes: the bytes it keeps
 * plus the decoded estimate the loader uses. Past `budgetBytes` the least recently used entries leave first, and an
 * entry larger than the budget is not kept. Every entry is shared by each load of its asset, so nothing may change it.
 */
export class DocumentCache {
  private readonly entries = new Map<string, CachedDocument & { revision: string; cost: number }>();
  private total = 0;
  readonly budgetBytes: number;

  constructor(budgetBytes = PLAYER_DOCUMENT_CACHE_BYTES) {
    this.budgetBytes = budgetBytes;
  }

  /** Bytes the kept entries cost. */
  get bytes(): number { return this.total; }

  get(guid: string, revision: string): CachedDocument | undefined {
    const entry = this.entries.get(guid);
    if (!entry || entry.revision !== revision) return undefined;
    // Most recently used last.
    this.entries.delete(guid);
    this.entries.set(guid, entry);
    return entry;
  }

  set(guid: string, revision: string, document: CachedDocument): void {
    this.delete(guid);
    const cost = document.bytes.byteLength * 3;
    if (cost > this.budgetBytes) return;
    this.entries.set(guid, { ...document, revision, cost });
    this.total += cost;
    for (const key of this.entries.keys()) {
      if (this.total <= this.budgetBytes) break;
      this.delete(key);
    }
  }

  has(guid: string): boolean { return this.entries.has(guid); }

  clear(): void {
    this.entries.clear();
    this.total = 0;
  }

  private delete(guid: string): void {
    const entry = this.entries.get(guid);
    if (!entry) return;
    this.entries.delete(guid);
    this.total -= entry.cost;
  }
}
