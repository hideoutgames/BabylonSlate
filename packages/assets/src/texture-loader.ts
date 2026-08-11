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
