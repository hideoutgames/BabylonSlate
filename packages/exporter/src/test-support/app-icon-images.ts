import { APP_ICON_SIZES, type AppIconImages } from "../app-icon";

/**
 * A PNG signature, IHDR (8-bit RGBA, CRC left zero) and IEND for a square
 * image: header fields only, enough for byte-level packaging, with `size`
 * marking which image it is.
 */
export function pngHeader(size: number, height = size): Uint8Array {
  const bytes = new Uint8Array(8 + 25 + 12);
  const view = new DataView(bytes.buffer);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, size);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  bytes.set([0x49, 0x45, 0x4e, 0x44], 8 + 25 + 4);
  return bytes;
}

/** An App Icon with every package size, each a `pngHeader` of its size. */
export function appIconImages(): AppIconImages {
  return new Map(APP_ICON_SIZES.map((size) => [size, pngHeader(size)]));
}
