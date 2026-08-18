import type { BabassetHeader, ChunkEntry } from "./babasset";

export interface TextureChunkSelection {
  chunk: ChunkEntry;
  kind: "ktx2" | "source";
  reason: string;
}

export interface SelectTextureChunkOptions {
  /** When false, force source bytes (transcoder unavailable / empty formats). */
  transcoderAvailable?: boolean;
  /** Device reports no compressed GPU formats. */
  supportedFormatsEmpty?: boolean;
}

/**
 * Prefer the KTX2 chunk when present and the transcoder can run; otherwise
 * fall back to the source `pixels` chunk with an explicit reason (never silent).
 */
export function selectTextureChunk(
  header: BabassetHeader,
  options: SelectTextureChunkOptions = {},
): TextureChunkSelection {
  const source = header.chunks.find(
    (chunk) => chunk.id === "pixels" || chunk.kind === "pixels",
  );
  const ktx2 = header.chunks.find(
    (chunk) => chunk.id.startsWith("ktx2:") || chunk.kind === "ktx2",
  );

  if (!source && !ktx2) {
    throw new Error(`Texture ${header.guid} has neither source nor KTX2 chunks`);
  }

  const transcoderAvailable = options.transcoderAvailable !== false;
  const formatsEmpty = options.supportedFormatsEmpty === true;

  if (ktx2 && transcoderAvailable && !formatsEmpty) {
    return { chunk: ktx2, kind: "ktx2", reason: "ktx2-preferred" };
  }

  if (!source) {
    throw new Error(
      `Texture ${header.guid} needs source fallback but has no pixels chunk`,
    );
  }

  let reason = "source-default";
  if (!ktx2) reason = "no-ktx2-chunk";
  else if (!transcoderAvailable) reason = "transcoder-unavailable";
  else if (formatsEmpty) reason = "supported-formats-empty";

  return { chunk: source, kind: "source", reason };
}

/** KTX2 identifier (`«KTX 22»` plus the standard control bytes). */
const KTX2_IDENTIFIER = new Uint8Array([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x32, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export function isKtx2Bytes(bytes: Uint8Array): boolean {
  if (bytes.length < KTX2_IDENTIFIER.length) return false;
  for (let i = 0; i < KTX2_IDENTIFIER.length; i++) {
    if (bytes[i] !== KTX2_IDENTIFIER[i]) return false;
  }
  return true;
}

/**
 * Browser-decodable MIME for Babylon GUI `Image.source`. KTX2 and unknown
 * blobs return null — they must not be labeled `image/png`.
 */
export function mimeForGuiTextureBytes(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (isKtx2Bytes(bytes)) return null;
  return null;
}

/**
 * Pixels (then imported `source`) for GUI Image blob URLs. Never the KTX2
 * GPU chunk — Babylon GUI cannot decode it.
 */
export function selectGuiImageChunk(
  header: BabassetHeader,
): TextureChunkSelection | null {
  const pixels = header.chunks.find(
    (chunk) => chunk.id === "pixels" || chunk.kind === "pixels",
  );
  if (pixels) {
    return { chunk: pixels, kind: "source", reason: "gui-pixels" };
  }
  const source = header.chunks.find(
    (chunk) => chunk.id === "source" || chunk.kind === "source",
  );
  if (source) {
    return { chunk: source, kind: "source", reason: "gui-source" };
  }
  return null;
}
