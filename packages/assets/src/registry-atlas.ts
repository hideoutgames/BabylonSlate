import { DOCUMENT_CHUNK_ID } from "./asset-document";
import { ATLAS_REFERRER_TYPES, atlasTextureGuids, headerAtlasTextureGuids } from "./atlas-textures";
import type { HassetHeader } from "./hasset";

/**
 * The textures each indexed atlas referrer samples, and the listener told
 * which textures' atlas status changed (`AssetRegistry.isAtlasTexture`).
 */
export class AtlasReferrerIndex {
  /** Atlas referrer (Tileset, Sprite, Sprite Animation) guid -> textures it samples. */
  private readonly atlasByReferrer = new Map<string, readonly string[]>();
  /** Texture guid -> atlas referrers sampling it. */
  private readonly atlasReferrers = new Map<string, Set<string>>();
  private atlasStatusListener: ((textureGuids: string[]) => void) | null = null;
  /** Texture guid -> atlas status before the changes not yet reported. */
  private readonly atlasStatusBefore = new Map<string, boolean>();
  private atlasFlushScheduled = false;
  /** Runs before each change to what `isAtlasTexture` may report. */
  private readonly onChange: () => void;

  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  /** A Tileset, Sprite or Sprite Animation samples this texture as an atlas. */
  isAtlasTexture(guid: string): boolean {
    return (this.atlasReferrers.get(guid)?.size ?? 0) > 0;
  }

  /** See `AssetRegistry.setAtlasStatusListener`. */
  setListener(listener: ((textureGuids: string[]) => void) | null): void {
    this.atlasStatusListener = listener;
    this.atlasStatusBefore.clear();
  }

  /** Record the textures a header just indexed (not a placeholder) samples, if its type is an atlas referrer. */
  indexReferrer(header: HassetHeader): void {
    if (!ATLAS_REFERRER_TYPES.has(header.type)) return;
    // Every document save lists the atlases in the header. A referrer whose
    // payload is still its header (created or imported, not yet saved as a
    // document) names them in that payload.
    const inHeader = !header.chunks.some((chunk) => chunk.id === DOCUMENT_CHUNK_ID);
    this.setReferrer(
      header.guid,
      headerAtlasTextureGuids(header.payload) ?? (inHeader ? atlasTextureGuids(header.type, header.payload) : []),
    );
  }

  setReferrer(referrer: string, textures: readonly string[]): void {
    const previous = this.atlasByReferrer.get(referrer) ?? [];
    const next = [...new Set(textures)];
    if (previous.length === 0 && next.length === 0) return;
    this.onChange();
    this.noteStatus([...previous, ...next]);
    for (const guid of previous) {
      const set = this.atlasReferrers.get(guid);
      set?.delete(referrer);
      if (set && set.size === 0) this.atlasReferrers.delete(guid);
    }
    if (next.length > 0) this.atlasByReferrer.set(referrer, next);
    else this.atlasByReferrer.delete(referrer);
    for (const guid of next) {
      let set = this.atlasReferrers.get(guid);
      if (!set) {
        set = new Set();
        this.atlasReferrers.set(guid, set);
      }
      set.add(referrer);
    }
  }

  /** Remember each texture's atlas status before a change, for the listener. */
  private noteStatus(textureGuids: readonly string[]): void {
    if (!this.atlasStatusListener) return;
    for (const guid of textureGuids) {
      if (!this.atlasStatusBefore.has(guid)) {
        this.atlasStatusBefore.set(guid, this.isAtlasTexture(guid));
      }
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (!this.atlasStatusListener || this.atlasFlushScheduled) return;
    this.atlasFlushScheduled = true;
    queueMicrotask(() => void this.flush());
  }

  private flush(): void {
    this.atlasFlushScheduled = false;
    const changed = [...this.atlasStatusBefore]
      .filter(([guid, before]) => this.isAtlasTexture(guid) !== before)
      .map(([guid]) => guid);
    this.atlasStatusBefore.clear();
    if (changed.length > 0) this.atlasStatusListener?.(changed);
  }
}
