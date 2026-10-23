/** Linear RGB pixels, rows top to bottom as stored in a `-Y H +X W` file. */
export interface RadianceImage {
  width: number;
  height: number;
  rgb: Float32Array;
}

export interface RadianceHeader {
  width: number;
  height: number;
  dataOffset: number;
}

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_EDGE = 0x7fff;

/** Radiance files start with `#?` and a program name such as `RADIANCE` or `RGBE`. */
export function isRadianceHdr(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x3f;
}

export function readRadianceHeader(bytes: Uint8Array): RadianceHeader {
  if (!isRadianceHdr(bytes))
    throw new Error("HDR files must start with a Radiance #? signature.");
  let offset = 0;
  const line = (): string => {
    const end = bytes.subarray(offset, Math.min(bytes.length, MAX_HEADER_BYTES)).indexOf(0x0a);
    if (end < 0) throw new Error("HDR header is truncated or larger than 64 KiB.");
    const text = String.fromCharCode(...bytes.subarray(offset, offset + end)).replace(/\r$/, "");
    offset += end + 1;
    return text;
  };
  line();
  for (let text = line(); text !== ""; text = line()) {
    const format = /^FORMAT=(.*)$/.exec(text);
    if (format && format[1]!.trim() !== "32-bit_rle_rgbe")
      throw new Error(`HDR format ${format[1]!.trim()} is not supported; save the file as RGBE (32-bit_rle_rgbe).`);
  }
  const size = /^-Y (\d+) \+X (\d+)$/.exec(line().trim());
  if (!size)
    throw new Error("HDR files must use the standard -Y height +X width orientation.");
  const height = Number(size[1]);
  const width = Number(size[2]);
  if (width < 1 || height < 1 || width > MAX_EDGE || height > MAX_EDGE)
    throw new Error(`HDR dimensions must be between 1 and ${MAX_EDGE} pixels.`);
  return { width, height, dataOffset: offset };
}

/**
 * Decode RGBE pixels (flat or new-style run-length scanlines) to linear RGB,
 * box-averaging `downsample`×`downsample` blocks so a large panorama never
 * needs a full-resolution float copy. EXPOSURE lines are ignored, as Babylon's
 * own HDR loader does.
 */
export function decodeRadianceHdr(bytes: Uint8Array, downsample = 1): RadianceImage {
  if (!Number.isInteger(downsample) || downsample < 1)
    throw new Error("HDR downsample factor must be a positive integer.");
  const { width, height, dataOffset } = readRadianceHeader(bytes);
  const outWidth = Math.ceil(width / downsample);
  const outHeight = Math.ceil(height / downsample);
  const rgb = new Float32Array(outWidth * outHeight * 3);
  // Planar R, G, B, E for one scanline, the layout run-length files store.
  const scanline = new Uint8Array(width * 4);
  const column = new Uint32Array(width);
  for (let x = 0; x < width; x++) column[x] = Math.floor(x / downsample) * 3;
  // RGBE mantissas scale by 2^(E - 136); E = 0 is black.
  const scale = new Float32Array(256);
  for (let exponent = 1; exponent < 256; exponent++) scale[exponent] = 2 ** (exponent - 136);
  let offset = dataOffset;
  const truncated = () => new Error("HDR pixel data is truncated.");
  for (let y = 0; y < height; y++) {
    if (offset + 4 > bytes.length) throw truncated();
    const runLength = width >= 8 &&
      bytes[offset] === 2 && bytes[offset + 1] === 2 && (bytes[offset + 2]! & 0x80) === 0;
    if (runLength) {
      if (((bytes[offset + 2]! << 8) | bytes[offset + 3]!) !== width)
        throw new Error("HDR scanline width does not match the image width.");
      offset += 4;
      // Each channel is stored as its own run-length plane.
      for (let channel = 0; channel < 4; channel++) {
        let x = channel * width;
        const end = x + width;
        while (x < end) {
          if (offset + 2 > bytes.length) throw truncated();
          let count = bytes[offset++]!;
          if (count > 128) {
            count -= 128;
            if (x + count > end) throw new Error("HDR scanline run exceeds the image width.");
            scanline.fill(bytes[offset++]!, x, x + count);
          } else {
            if (count === 0 || x + count > end) throw new Error("HDR scanline run exceeds the image width.");
            if (offset + count > bytes.length) throw truncated();
            scanline.set(bytes.subarray(offset, offset + count), x);
            offset += count;
          }
          x += count;
        }
      }
    } else {
      if (offset + width * 4 > bytes.length) throw truncated();
      for (let x = 0, at = offset; x < width; x++, at += 4) {
        scanline[x] = bytes[at]!;
        scanline[width + x] = bytes[at + 1]!;
        scanline[2 * width + x] = bytes[at + 2]!;
        scanline[3 * width + x] = bytes[at + 3]!;
      }
      offset += width * 4;
    }
    const row = Math.floor(y / downsample) * outWidth * 3;
    for (let x = 0; x < width; x++) {
      const factor = scale[scanline[3 * width + x]!]!;
      const target = row + column[x]!;
      rgb[target] = rgb[target]! + scanline[x]! * factor;
      rgb[target + 1] = rgb[target + 1]! + scanline[width + x]! * factor;
      rgb[target + 2] = rgb[target + 2]! + scanline[2 * width + x]! * factor;
    }
  }
  if (downsample > 1) {
    // Edge blocks of a size that is not a multiple of the factor hold fewer pixels.
    for (let y = 0; y < outHeight; y++) {
      const rows = Math.min(downsample, height - y * downsample);
      for (let x = 0; x < outWidth; x++) {
        const count = rows * Math.min(downsample, width - x * downsample);
        const at = (y * outWidth + x) * 3;
        rgb[at] = rgb[at]! / count;
        rgb[at + 1] = rgb[at + 1]! / count;
        rgb[at + 2] = rgb[at + 2]! / count;
      }
    }
  }
  return { width: outWidth, height: outHeight, rgb };
}
