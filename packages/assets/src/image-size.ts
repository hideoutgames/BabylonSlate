export interface ImageSize {
  width: number;
  height: number;
}

function readU32be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

/** PNG IHDR (and JPEG SOF when present) without a full decode. */
export function sniffImageSize(bytes: Uint8Array): ImageSize | null {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const width = readU32be(bytes, 16);
    const height = readU32be(bytes, 20);
    if (width > 0 && height > 0) return { width, height };
    return null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return sniffJpegSize(bytes);
  }
  return null;
}

function sniffJpegSize(bytes: Uint8Array): ImageSize | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (
      marker === 0xc0 ||
      marker === 0xc1 ||
      marker === 0xc2 ||
      marker === 0xc3
    ) {
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
      if (width > 0 && height > 0) return { width, height };
      return null;
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/**
 * WebP canvas size from its VP8X, VP8L or VP8 chunk, and whether VP8X marks
 * it animated. Null unless the RIFF length matches the bytes.
 */
export function sniffWebpSize(bytes: Uint8Array): (ImageSize & { animated: boolean }) | null {
  const text = (offset: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length < 20 || text(0) !== "RIFF" || text(8) !== "WEBP")
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length) return null;
  const u24 = (offset: number) =>
    bytes[offset]! + bytes[offset + 1]! * 256 + bytes[offset + 2]! * 65536;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const length = view.getUint32(offset + 4, true);
    if (offset + 8 + length > bytes.length) return null;
    const start = offset + 8;
    if (text(offset) === "VP8X" && length >= 10) {
      return {
        width: u24(start + 4) + 1,
        height: u24(start + 7) + 1,
        animated: (bytes[start]! & 2) !== 0,
      };
    }
    if (text(offset) === "VP8L" && length >= 5 && bytes[start] === 0x2f) {
      const bits = view.getUint32(start + 1, true);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
        animated: false,
      };
    }
    if (
      text(offset) === "VP8 " &&
      length >= 10 &&
      bytes[start + 3] === 0x9d &&
      bytes[start + 4] === 1 &&
      bytes[start + 5] === 0x2a
    ) {
      return {
        width: view.getUint16(start + 6, true) & 0x3fff,
        height: view.getUint16(start + 8, true) & 0x3fff,
        animated: false,
      };
    }
    offset += 8 + length + (length % 2);
  }
  return null;
}

/** GIF logical screen size (`GIF87a` / `GIF89a`), the size browsers decode it at. */
function sniffGifSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 10) return null;
  const signature = String.fromCharCode(...bytes.subarray(0, 6));
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;
  const width = bytes[6]! | (bytes[7]! << 8);
  const height = bytes[8]! | (bytes[9]! << 8);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Size of any image a Texture imports (PNG, JPEG, WebP, GIF), for recording
 * `payload.width` / `height` and deciding encode padding. The resolver and
 * render keep {@link sniffImageSize} (PNG / JPEG): widening it would change
 * the preferred encode id of existing WebP and GIF Textures.
 */
export function sniffSourceImageSize(bytes: Uint8Array): ImageSize | null {
  const webp = sniffWebpSize(bytes);
  if (webp) return webp.width > 0 && webp.height > 0 ? { width: webp.width, height: webp.height } : null;
  return sniffImageSize(bytes) ?? sniffGifSize(bytes);
}

export function longestEdge(size: ImageSize | null): number | null {
  if (!size) return null;
  return Math.max(size.width, size.height);
}
