/**
 * GLB embedded-image slimming for asset-driven models (plan Phase 5).
 *
 * When every material slot is assigned to extracted Material assets, the GLB's
 * own embedded images are never sampled — but `LoadAssetContainerAsync` still
 * decodes them at full size. Replacing each embedded raster image with a named
 * 1×1 placeholder makes that decode cost kilobytes while keeping mesh, node,
 * animation and accessor data byte-identical. Already-compressed (`image/ktx2`)
 * and URI-referenced images are left untouched.
 *
 * Pure function: parse failure returns null and the caller falls back to the
 * original bytes.
 */

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_TYPE_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_TYPE_BIN = 0x004e4942; // 'BIN\0'

/** Canonical 1×1 fully-transparent PNG (67 bytes). */
const PLACEHOLDER_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44,
  0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d,
  0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
  0x60, 0x82,
]);

export interface SlimGlbImagesResult {
  bytes: Uint8Array;
  replacedCount: number;
}

interface GlbChunk {
  type: number;
  start: number;
  length: number;
}

function walkChunks(
  view: DataView,
  totalLength: number,
): { json?: GlbChunk; bin?: GlbChunk } {
  const chunks: { json?: GlbChunk; bin?: GlbChunk } = {};
  let offset = 12;
  while (offset + 8 <= totalLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (length > totalLength - offset - 8) break;
    const chunk = { type, start: offset + 8, length };
    if (type === CHUNK_TYPE_JSON && !chunks.json) chunks.json = chunk;
    if (type === CHUNK_TYPE_BIN && !chunks.bin) chunks.bin = chunk;
    offset += 8 + length;
  }
  return chunks;
}

export function slimGlbEmbeddedImages(
  bytes: Uint8Array,
): SlimGlbImagesResult | null {
  try {
    if (bytes.length < 20) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== GLB_MAGIC) return null;
    const { json: jsonChunk, bin: binChunk } = walkChunks(view, bytes.length);
    if (!jsonChunk) return null;

    const jsonText = new TextDecoder().decode(
      bytes.subarray(jsonChunk.start, jsonChunk.start + jsonChunk.length),
    );
    // Spec pads with spaces, but some writers zero-pad — tolerate both.
    const json = JSON.parse(jsonText.replace(/[\0\s]+$/, "")) as {
      images?: Array<Record<string, unknown>>;
      bufferViews?: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };
    const images = Array.isArray(json.images) ? json.images : null;
    const bufferViews = Array.isArray(json.bufferViews)
      ? json.bufferViews
      : null;
    if (!images || images.length === 0 || !bufferViews || !binChunk) return null;

    const binStart = binChunk.start;
    const binLength = binChunk.length;

    // Validate targets up-front so any surprise aborts before mutation.
    const targetIndices: number[] = [];
    for (let i = 0; i < images.length; i++) {
      const image = images[i]!;
      if (typeof image.uri === "string") continue; // external reference
      if (image.mimeType === "image/ktx2") continue; // already GPU-ready
      const bufferViewIndex = image.bufferView;
      if (typeof bufferViewIndex !== "number") continue;
      const bufferView = bufferViews[bufferViewIndex] as
        | { byteOffset?: number; byteLength?: number }
        | undefined;
      if (!bufferView) return null;
      const byteOffset = typeof bufferView.byteOffset === "number" ? bufferView.byteOffset : 0;
      const byteLength =
        typeof bufferView.byteLength === "number" ? bufferView.byteLength : 0;
      if (byteOffset < 0 || byteLength < 0) return null;
      if (byteOffset + byteLength > binLength) return null;
      targetIndices.push(i);
    }
    if (targetIndices.length === 0) return null;

    // Append the placeholder PNG once, 4-byte aligned after the existing BIN.
    const padding = (4 - (binLength % 4)) % 4;
    const placeholderOffset = binLength + padding;
    const newBufferViewIndex = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: placeholderOffset, byteLength: PLACEHOLDER_PNG.length });

    for (const i of targetIndices) {
      const image = images[i]!;
      image.name = `__bsl_img_${i}`;
      image.mimeType = "image/png";
      image.bufferView = newBufferViewIndex;
    }

    const jsonTextOut = JSON.stringify(json);
    const jsonPadding = (4 - (jsonTextOut.length % 4)) % 4;
    const jsonPadded = jsonTextOut.padEnd(jsonTextOut.length + jsonPadding, " ");
    const jsonBytes = new TextEncoder().encode(jsonPadded);

    const newBinLength = placeholderOffset + PLACEHOLDER_PNG.length;
    const headerLength = 12 + 8 + jsonBytes.length + 8 + newBinLength;

    const out = new Uint8Array(headerLength);
    const outView = new DataView(out.buffer);
    outView.setUint32(0, GLB_MAGIC, true);
    outView.setUint32(4, 2, true);
    outView.setUint32(8, headerLength, true);
    outView.setUint32(12, jsonBytes.length, true);
    outView.setUint32(16, CHUNK_TYPE_JSON, true);
    out.set(jsonBytes, 20);
    const binHeaderAt = 20 + jsonBytes.length;
    outView.setUint32(binHeaderAt, newBinLength, true);
    outView.setUint32(binHeaderAt + 4, CHUNK_TYPE_BIN, true);
    const newBinStart = binHeaderAt + 8;
    out.set(
      bytes.subarray(binStart, binStart + binLength),
      newBinStart,
    );
    out.set(
      PLACEHOLDER_PNG,
      newBinStart + placeholderOffset,
    );

    return { bytes: out, replacedCount: targetIndices.length };
  } catch {
    return null;
  }
}
