import type { BabassetHeader } from "@babylonslate/assets";

/** Encode progress fields: rewriting them alone does not change the bytes a Texture uploads. */
const TEXTURE_PROGRESS_FIELDS = new Set(["compressionState", "encodeWallMs", "encodeError"]);

/**
 * The parts of a saved Texture header that decide which bytes a preview uploads:
 * the payload (Usage, Downsample, committed KTX2) and the chunks. It changes when
 * a Usage change is saved, an encode commits or the source is reimported, not
 * while an encode is queued or running, or after it fails.
 */
export function textureUploadSignature(header: Pick<BabassetHeader, "payload" | "chunks">): [Array<[string, unknown]>, string[]] {
  const payload = Object.entries(header.payload)
    .filter(([field]) => !TEXTURE_PROGRESS_FIELDS.has(field))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return [payload, header.chunks.map((chunk) => `${chunk.id}:${chunk.sha256}`)];
}
