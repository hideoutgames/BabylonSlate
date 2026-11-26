/**
 * Lightweight raw RGBA8 texture binary container (`HRGB`) used for Editor Texture LOD
 * downsampling so Worker-decoded RGBA pixels upload directly to Babylon `RawTexture`
 * without a pure-JS PNG encode + browser PNG decode round-trip.
 *
 * Layout (little-endian):
 *   bytes 0..3:  ASCII magic "HRGB" (0x48, 0x52, 0x47, 0x42)
 *   bytes 4..7:  uint32 width
 *   bytes 8..11: uint32 height
 *   bytes 12..:  width * height * 4 RGBA8 pixel bytes
 */
export const RAW_RGBA_TEXTURE_HEADER_BYTES = 12;

export function isRawRgbaTextureBytes(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= RAW_RGBA_TEXTURE_HEADER_BYTES &&
    bytes[0] === 0x48 &&
    bytes[1] === 0x52 &&
    bytes[2] === 0x47 &&
    bytes[3] === 0x42
  );
}

export function readRawRgbaTextureHeader(bytes: Uint8Array): { width: number; height: number } | null {
  if (!isRawRgbaTextureBytes(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, RAW_RGBA_TEXTURE_HEADER_BYTES);
  const width = view.getUint32(4, true);
  const height = view.getUint32(8, true);
  if (width === 0 || height === 0) return null;
  const expected = RAW_RGBA_TEXTURE_HEADER_BYTES + width * height * 4;
  if (bytes.byteLength !== expected) return null;
  return { width, height };
}

export function packRawRgbaTexture(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid raw RGBA texture dimensions: ${width}x${height}`);
  }
  const pixelBytes = width * height * 4;
  if (rgba.byteLength !== pixelBytes) {
    throw new Error(`Expected ${pixelBytes} RGBA bytes for ${width}x${height}, got ${rgba.byteLength}`);
  }
  const out = new Uint8Array(RAW_RGBA_TEXTURE_HEADER_BYTES + pixelBytes);
  out[0] = 0x48; // H
  out[1] = 0x52; // R
  out[2] = 0x47; // G
  out[3] = 0x42; // B
  const view = new DataView(out.buffer);
  view.setUint32(4, width, true);
  view.setUint32(8, height, true);
  out.set(rgba, RAW_RGBA_TEXTURE_HEADER_BYTES);
  return out;
}
