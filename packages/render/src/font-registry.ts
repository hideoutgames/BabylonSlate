import { assetByteFingerprint } from "./asset-byte-fingerprint";

export interface FontFaceLike {
  family: string;
  load(): Promise<FontFaceLike>;
}

export interface FontFaceHost {
  create(family: string, source: BufferSource, descriptors?: FontFaceDescriptors): FontFaceLike;
  add(face: FontFaceLike): void;
  delete?(face: FontFaceLike): void;
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
    delete(face) {
      (
        document.fonts as unknown as { delete(font: FontFace): boolean }
      ).delete(face as FontFace);
    },
    load(font, text) {
      return document.fonts.load(font, text);
    },
    check(font, text) {
      return document.fonts.check(font, text);
    },
  };
}

type FontRegistration = { key: string; result: Promise<boolean> };

function fontBytesDigest(bytes: BufferSource): string {
  return assetByteFingerprint(
    ArrayBuffer.isView(bytes)
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new Uint8Array(bytes),
  );
}

/**
 * Main-thread FontFace registry. Await `ready` before the first UI draw.
 * Failed loads become warnings — never a silent Arial substitution.
 * The document keeps one face per registered font content; `dispose` removes
 * only this registry's faces, so sibling views keep their own.
 */
export class FontRegistry {
  private readonly host: FontFaceHost | null;
  private readonly loaded = new Set<string>();
  /** Latest requested content per guid; identical requests share its result. */
  private readonly registrations = new Map<string, FontRegistration>();
  /** The loaded face currently serving each guid. */
  private readonly faces = new Map<string, FontFaceLike>();
  /** Faces this registry added to the document and has not removed. */
  private readonly added = new Set<FontFaceLike>();
  private readonly warnings: FontRegistryWarning[] = [];
  private dirty = false;
  private disposed = false;

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
    if (this.disposed) return false;
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
    const descriptors = {
      weight: String(entry.weight ?? "400"),
      style: entry.style === "italic" ? "italic" : "normal",
    };
    const key = `${family}|${descriptors.weight}|${descriptors.style}|${fontBytesDigest(entry.bytes)}`;
    const current = this.registrations.get(entry.guid);
    if (current?.key === key) return current.result;
    // Record the request before any await so overlapping calls share it.
    const registration = { key } as FontRegistration;
    this.registrations.set(entry.guid, registration);
    registration.result = this.load(this.host, entry, family, descriptors, registration);
    return registration.result;
  }

  private async load(
    host: FontFaceHost,
    entry: FontAssetEntry,
    family: string,
    descriptors: FontFaceDescriptors,
    registration: FontRegistration,
  ): Promise<boolean> {
    let face: FontFaceLike | undefined;
    try {
      face = host.create(family, entry.bytes, descriptors);
      host.add(face);
      this.added.add(face);
      await host.load(`16px "${family}"`);
      // Disposal or newer pending content for this guid supersedes this face.
      const latest = this.registrations.get(entry.guid);
      if (this.disposed || (latest !== undefined && latest !== registration)) {
        this.remove(face);
        return false;
      }
      const previous = this.faces.get(entry.guid);
      this.faces.set(entry.guid, face);
      // The replacement is live before the previous face leaves the document.
      if (previous) this.remove(previous);
      this.loaded.add(entry.guid);
      this.dirty = true;
      return true;
    } catch (error) {
      // A failed face never serves the family; the previous face stays.
      if (face) this.remove(face);
      if (this.registrations.get(entry.guid) === registration) {
        this.registrations.delete(entry.guid);
      }
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

  /** Remove this registry's faces from the document; later registrations are ignored. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const face of [...this.added]) this.remove(face);
    this.faces.clear();
    this.registrations.clear();
  }

  private remove(face: FontFaceLike): void {
    if (this.added.delete(face)) this.host?.delete?.(face);
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
