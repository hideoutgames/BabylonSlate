import { assetByteFingerprint } from "./asset-byte-fingerprint";
import { forgetRasterizedGlyphs } from "./text2d-bitmap";

export interface FontFaceLike {
  family: string;
  load(): Promise<FontFaceLike>;
}

export interface FontFaceHost {
  create(family: string, source: BufferSource, descriptors?: FontFaceDescriptors): FontFaceLike;
  add(face: FontFaceLike): void;
  delete?(face: FontFaceLike): void;
}

export interface FontAssetEntry {
  guid: string;
  family: string;
  bytes: BufferSource;
  weight?: string | number;
  style?: string;
}

type FontRegistryWarning = {
  guid: string;
  family: string;
  message: string;
};

/** How long an unloaded view's document FontFaces stay parked for a following view (Editor <-> Play). */
const PARKED_FONT_FACE_MS = 5_000;

interface ParkedFontFace {
  face: FontFaceLike;
  timer: ReturnType<typeof setTimeout>;
}

export interface FontRegistryOptions {
  /** Park loaded document FontFaces briefly on dispose so Editor <-> Play handovers adopt them without reloading. */
  parkOnDispose?: boolean;
}

const parkedDocumentFaces = new Map<string, ParkedFontFace>();

let sharedDefaultHost: FontFaceHost | undefined;

function defaultHost(): FontFaceHost | null {
  if (typeof FontFace === "undefined" || typeof document === "undefined") {
    return null;
  }
  if (sharedDefaultHost) return sharedDefaultHost;
  sharedDefaultHost = {
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
  };
  return sharedDefaultHost;
}

function adoptParkedDocumentFace(key: string): FontFaceLike | null {
  const parked = parkedDocumentFaces.get(key);
  if (!parked) return null;
  parkedDocumentFaces.delete(key);
  clearTimeout(parked.timer);
  return parked.face;
}

function parkDocumentFace(host: FontFaceHost, key: string, face: FontFaceLike): void {
  const existing = parkedDocumentFaces.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    if (existing.face !== face) host.delete?.(existing.face);
  }
  const timer = setTimeout(() => {
    const current = parkedDocumentFaces.get(key);
    if (!current || current.face !== face) return;
    parkedDocumentFaces.delete(key);
    host.delete?.(face);
    forgetRasterizedGlyphs();
  }, PARKED_FONT_FACE_MS);
  (timer as { unref?: () => void }).unref?.();
  parkedDocumentFaces.set(key, { face, timer });
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
  /** Content key per loaded face (for default-host handover parking). */
  private readonly faceKeys = new Map<FontFaceLike, string>();
  private readonly warnings: FontRegistryWarning[] = [];
  private dirty = false;
  private disposed = false;
  private readonly parksOnDispose: boolean;

  constructor(host: FontFaceHost | null | undefined = defaultHost(), options: FontRegistryOptions = {}) {
    this.host = host ?? null;
    this.parksOnDispose = options.parkOnDispose === true && this.host !== null && this.host === sharedDefaultHost;
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
      const adopted = this.parksOnDispose ? adoptParkedDocumentFace(registration.key) : null;
      if (adopted) {
        face = adopted;
        this.added.add(face);
        this.faceKeys.set(face, registration.key);
      } else {
        face = host.create(family, entry.bytes, descriptors);
        host.add(face);
        this.added.add(face);
        this.faceKeys.set(face, registration.key);
        // Wait for this exact face: a family-wide document load matches only the
        // regular face and would mark a bold or italic face ready before it loads.
        await face.load();
        // Glyphs drawn before this face could draw them came from another font.
        forgetRasterizedGlyphs();
      }
      // Disposal or newer pending content for this guid supersedes this face.
      const latest = this.registrations.get(entry.guid);
      if (this.disposed || latest !== registration) {
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

  /** True when `entry` is already loaded under this exact family, descriptors and byte content. */
  isRegistered(entry: FontAssetEntry): boolean {
    if (this.disposed || !this.loaded.has(entry.guid)) return false;
    const family = entry.family.trim();
    if (!family) return false;
    const weight = String(entry.weight ?? "400");
    const style = entry.style === "italic" ? "italic" : "normal";
    const key = `${family}|${weight}|${style}|${fontBytesDigest(entry.bytes)}`;
    return this.registrations.get(entry.guid)?.key === key;
  }

  /** Release both a prepared face and any pending registration for this owner. */
  unregister(guid: string): void {
    this.registrations.delete(guid);
    this.loaded.delete(guid);
    const face = this.faces.get(guid);
    if (face) this.remove(face);
    this.faces.delete(guid);
  }

  /** Remove this registry's faces from the document; later registrations are ignored. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const loadedFaces = new Set(this.faces.values());
    for (const face of [...this.added]) {
      const key = this.faceKeys.get(face);
      if (this.parksOnDispose && this.host && loadedFaces.has(face) && key) {
        this.added.delete(face);
        this.faceKeys.delete(face);
        parkDocumentFace(this.host, key, face);
      } else {
        this.remove(face);
      }
    }
    this.faces.clear();
    this.faceKeys.clear();
    this.registrations.clear();
    this.loaded.clear();
  }

  private remove(face: FontFaceLike): void {
    this.faceKeys.delete(face);
    if (!this.added.delete(face)) return;
    this.host?.delete?.(face);
    // Glyphs this face drew now fall to another font.
    forgetRasterizedGlyphs();
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
