export interface FontFaceLike {
  family: string;
  load(): Promise<FontFaceLike>;
}

export interface FontFaceHost {
  create(family: string, source: BufferSource, descriptors?: FontFaceDescriptors): FontFaceLike;
  add(face: FontFaceLike): void;
  load(font: string, text?: string): Promise<FontFaceLike[]>;
  check?(font: string, text?: string): boolean;
}

export interface FontAssetEntry {
  guid: string;
  family: string;
  bytes: BufferSource;
  weight?: string | number;
  style?: string;
}

export type FontRegistryWarning = {
  guid: string;
  family: string;
  message: string;
};

function defaultHost(): FontFaceHost | null {
  if (typeof FontFace === "undefined" || typeof document === "undefined") {
    return null;
  }
  return {
    create(family, source, descriptors) {
      return new FontFace(family, source, descriptors);
    },
    add(face) {
      (
        document.fonts as unknown as { add(font: FontFace): void }
      ).add(face as FontFace);
    },
    load(font, text) {
      return document.fonts.load(font, text);
    },
    check(font, text) {
      return document.fonts.check(font, text);
    },
  };
}

/**
 * Main-thread FontFace registry. Await `ready` before the first UI draw.
 * Failed loads become warnings — never a silent Arial substitution.
 */
export class FontRegistry {
  private readonly host: FontFaceHost | null;
  private readonly loaded = new Set<string>();
  private readonly warnings: FontRegistryWarning[] = [];
  private dirty = false;

  constructor(host: FontFaceHost | null | undefined = defaultHost()) {
    this.host = host ?? null;
  }

  getWarnings(): readonly FontRegistryWarning[] {
    return this.warnings;
  }

  consumeDirty(): boolean {
    const was = this.dirty;
    this.dirty = false;
    return was;
  }

  async register(entry: FontAssetEntry): Promise<boolean> {
    const family = entry.family.trim();
    if (!family) {
      this.warnings.push({
        guid: entry.guid,
        family,
        message: "Font asset is missing a family name",
      });
      return false;
    }
    if (!this.host) {
      this.warnings.push({
        guid: entry.guid,
        family,
        message: `Font "${family}" could not load (no FontFace host)`,
      });
      return false;
    }
    try {
      const face = this.host.create(family, entry.bytes, {
        weight: String(entry.weight ?? "400"),
        style: entry.style === "italic" ? "italic" : "normal",
      });
      this.host.add(face);
      await this.host.load(`16px "${family}"`);
      this.loaded.add(entry.guid);
      this.dirty = true;
      return true;
    } catch (error) {
      this.warnings.push({
        guid: entry.guid,
        family,
        message: `Font "${family}" failed to load: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      return false;
    }
  }

  isReady(guid: string): boolean {
    return this.loaded.has(guid);
  }

  /** Await every face before the first UI draw (engineplan §11.4). */
  async registerAll(entries: readonly FontAssetEntry[]): Promise<boolean> {
    let ok = true;
    for (const entry of entries) {
      if (!(await this.register(entry))) ok = false;
    }
    return ok;
  }
}

/** Register faces then dirty the ADT if any face resolved. */
export async function applyFontRegistryToHost(
  registry: FontRegistry,
  entries: readonly FontAssetEntry[],
  markDirty: () => void,
): Promise<void> {
  await registry.registerAll(entries);
  if (registry.consumeDirty()) markDirty();
}
