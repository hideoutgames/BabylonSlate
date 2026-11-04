import type { IndexedAsset, TilesetPayload } from "@haptic/assets";

export type ReadAtlasChunk = (path: string, chunkId: string) => Promise<Uint8Array | null | undefined>;

type AtlasRegistry = { getByGuid(guid: string): IndexedAsset | undefined } | null | undefined;

/** One Texture's decoded image, kept while the same registry entry describes the Texture. */
interface AtlasEntry {
  asset: IndexedAsset;
  url: string | null;
  image: HTMLImageElement | null;
}

type WantedAtlas = { tileset: string; texture: string; asset: IndexedAsset };

const EMPTY: ReadonlyMap<string, HTMLImageElement> = new Map();

/** A number per registry entry object: a save or reindex replaces the entry, so a new number means new pixels. */
const entryIds = new WeakMap<object, number>();
let lastEntryId = 0;
function entryId(asset: object): number {
  let id = entryIds.get(asset);
  if (id === undefined) entryIds.set(asset, (id = ++lastEntryId));
  return id;
}

/**
 * Decoded atlas images of a Tilemap document's Tilesets, by Tileset guid,
 * shared by its Palette and Paint so each Texture is read and decoded once.
 * An image stays while its Texture's registry entry is the same object; a
 * Tileset edit that keeps its Texture keeps the image. Images publish as they
 * finish loading. `dispose` revokes every object URL it made.
 */
export class TilesetAtlasLoader {
  private images = EMPTY;
  private key: string | null = null;
  private wanted: readonly WantedAtlas[] = [];
  private readonly entries = new Map<string, AtlasEntry>();
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): ReadonlyMap<string, HTMLImageElement> => this.images;

  request(payloads: ReadonlyMap<string, TilesetPayload>, registry: AtlasRegistry, read: ReadAtlasChunk | undefined): void {
    const wanted: WantedAtlas[] = [];
    for (const [tileset, payload] of payloads) {
      const asset = payload.textureGuid ? registry?.getByGuid(payload.textureGuid) : undefined;
      if (asset && payload.textureGuid) wanted.push({ tileset, texture: payload.textureGuid, asset });
    }
    const key = wanted.map((entry) => `${entry.tileset}:${entry.texture}:${entryId(entry.asset)}`).join(",");
    if (key === this.key) return;
    this.key = key;
    this.wanted = wanted;
    const textures = new Map(wanted.map((entry) => [entry.texture, entry.asset]));
    for (const [texture, entry] of this.entries) {
      if (textures.get(texture) === entry.asset) continue;
      if (entry.url) URL.revokeObjectURL(entry.url);
      this.entries.delete(texture);
    }
    this.publish();
    if (!read) return;
    for (const [texture, asset] of textures) {
      if (this.entries.has(texture)) continue;
      const entry: AtlasEntry = { asset, url: null, image: null };
      this.entries.set(texture, entry);
      void read(asset.path, "pixels").then((bytes) => {
        // A dispose or a newer Texture entry may have dropped this one during the read.
        if (this.entries.get(texture) !== entry || !bytes || bytes.byteLength === 0) return;
        entry.url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/png" }));
        const image = new Image();
        image.onload = () => {
          if (this.entries.get(texture) !== entry) return;
          entry.image = image;
          this.publish();
        };
        image.src = entry.url;
      }, () => {
        if (this.entries.get(texture) === entry) this.entries.delete(texture);
      });
    }
  }

  /** Drop every image and revoke its URL; a later `request` loads again. */
  dispose(): void {
    for (const entry of this.entries.values()) if (entry.url) URL.revokeObjectURL(entry.url);
    this.entries.clear();
    this.key = null;
    this.wanted = [];
  }

  /** The loaded images of the latest request, by Tileset guid; listeners hear only a change. */
  private publish(): void {
    const next = new Map<string, HTMLImageElement>();
    for (const entry of this.wanted) {
      const image = this.entries.get(entry.texture)?.image;
      if (image) next.set(entry.tileset, image);
    }
    if (next.size === this.images.size && [...next].every(([guid, image]) => this.images.get(guid) === image)) return;
    this.images = next;
    for (const listener of [...this.listeners]) listener();
  }
}
