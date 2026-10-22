import type { HassetHeader } from "@haptic/assets";

/** Encode progress fields: rewriting them alone does not change the bytes a Texture uploads. */
const TEXTURE_PROGRESS_FIELDS = new Set(["compressionState", "encodeWallMs", "encodeError"]);

/** Payload fields the encode queue writes with a commit: they describe how a Texture is stored, not what it shows. */
const TEXTURE_ENCODE_FIELDS = new Set([
  ...TEXTURE_PROGRESS_FIELDS,
  "ktx2ChunkId",
  "ktx2Width",
  "ktx2Height",
  "ktx2BlockAlign",
  "ktx2Sha256",
]);

type TextureHeader = Pick<HassetHeader, "payload" | "chunks">;

function isKtx2Chunk(chunk: TextureHeader["chunks"][number]): boolean {
  return chunk.kind === "ktx2" || chunk.id.startsWith("ktx2:");
}

function sortedPayload(header: TextureHeader, exclude: ReadonlySet<string>): Array<[string, unknown]> {
  return Object.entries(header.payload)
    .filter(([field]) => !exclude.has(field))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The parts of a saved Texture header that decide which bytes a preview uploads:
 * the payload (Usage, Downsample, committed KTX2) and the chunks. It changes when
 * a Usage change is saved, an encode commits or the source is reimported, not
 * while an encode is queued or running, or after it fails.
 */
export function textureUploadSignature(header: TextureHeader): [Array<[string, unknown]>, string[]] {
  return [sortedPayload(header, TEXTURE_PROGRESS_FIELDS), header.chunks.map((chunk) => `${chunk.id}:${chunk.sha256}`)];
}

/**
 * What a Texture shows, without how it is stored: the payload minus encode
 * bookkeeping, and every chunk but the KTX2 encodes. It changes when the source
 * is reimported or a setting that alters the picture (Usage, Downsample,
 * Compression Quality) is saved, and stays equal through encode progress and a
 * commit, which only swap the stored representation of the same pixels.
 */
export function textureContentSignature(header: TextureHeader): [Array<[string, unknown]>, string[]] {
  return [
    sortedPayload(header, TEXTURE_ENCODE_FIELDS),
    header.chunks.filter((chunk) => !isKtx2Chunk(chunk)).map((chunk) => `${chunk.id}:${chunk.sha256}`),
  ];
}

/** How a Texture is stored: the committed KTX2 and the encodes the header retains. */
export function textureEncodingSignature(header: TextureHeader): string {
  return JSON.stringify([
    header.payload.ktx2ChunkId ?? null,
    header.chunks.filter(isKtx2Chunk).map((chunk) => `${chunk.id}:${chunk.sha256}`),
  ]);
}
