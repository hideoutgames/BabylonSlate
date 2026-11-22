import { formatImportCount, HDR_MAX_DECODED_PIXELS, importLimitError } from "./import-limits";

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
/** A run-length run covers at most 127 pixels in two bytes. */
const MAX_RUN = 127;
/** Main-thread time {@link decodeRadianceHdrAsync} works before it yields. */
const YIELD_INTERVAL_MS = 32;
const headerDecoder = new TextDecoder();

/** Radiance files start with `#?` and a program name such as `RADIANCE` or `RGBE`. */
function isRadianceHdr(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x3f;
}

export function readRadianceHeader(bytes: Uint8Array): RadianceHeader {
  if (!isRadianceHdr(bytes))
    throw new Error("HDR files must start with a Radiance #? signature.");
  let offset = 0;
  const line = (): string => {
    const end = bytes.subarray(offset, Math.min(bytes.length, MAX_HEADER_BYTES)).indexOf(0x0a);
    if (end < 0) throw new Error("HDR header is truncated or larger than 64 KiB.");
    const text = headerDecoder.decode(bytes.subarray(offset, offset + end)).replace(/\r$/, "");
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
 * The smallest box-downsample factor, at least `minimum`, that decodes a
 * `width` × `height` panorama to at most {@link HDR_MAX_DECODED_PIXELS}
 * pixels. Both edges count, so a tall panorama is reduced as a wide one is.
 */
export function radianceDownsampleFactor(width: number, height: number, minimum = 1): number {
  let factor = Math.max(minimum, Math.ceil(Math.sqrt((width * height) / HDR_MAX_DECODED_PIXELS)));
  while (Math.ceil(width / factor) * Math.ceil(height / factor) > HDR_MAX_DECODED_PIXELS) factor += 1;
  return factor;
}

/** The fewest bytes a scanline of `width` pixels can take: flat RGBE, or four planes of 127-pixel runs. */
function minimumScanlineBytes(width: number): number {
  const flat = width * 4;
  return width >= 8 ? Math.min(flat, 4 + 4 * 2 * Math.ceil(width / MAX_RUN)) : flat;
}

/**
 * Decodes one scanline per step, so {@link decodeRadianceHdr} runs it through
 * and {@link decodeRadianceHdrAsync} can yield between steps. Everything that
 * sizes an allocation is checked first: the factor keeps the output within
 * {@link HDR_MAX_DECODED_PIXELS}, and the pixel data must be long enough for
 * every scanline at its most compact.
 */
function* radianceScanlines(bytes: Uint8Array, downsample: number): Generator<void, RadianceImage> {
  if (!Number.isInteger(downsample) || downsample < 1)
    throw new Error("HDR downsample factor must be a positive integer.");
  const { width, height, dataOffset } = readRadianceHeader(bytes);
  const outWidth = Math.ceil(width / downsample);
  const outHeight = Math.ceil(height / downsample);
  if (outWidth * outHeight > HDR_MAX_DECODED_PIXELS) {
    throw importLimitError(
      "The decoded size of the HDR panorama",
      `${formatImportCount(outWidth * outHeight)} pixels`,
      `${formatImportCount(HDR_MAX_DECODED_PIXELS)} pixels`,
      "Decode it with a larger downsample factor.",
    );
  }
  const truncated = () => new Error("HDR pixel data is truncated.");
  if (bytes.length - dataOffset < height * minimumScanlineBytes(width)) throw truncated();
  const rgb = new Float32Array(outWidth * outHeight * 3);
  // Planar R, G, B, E for one scanline, the layout run-length files store.
  const scanline = new Uint8Array(width * 4);
  const column = new Uint32Array(width);
  for (let x = 0; x < width; x++) column[x] = Math.floor(x / downsample) * 3;
  // RGBE mantissas scale by 2^(E - 136); E = 0 is black.
  const scale = new Float32Array(256);
  for (let exponent = 1; exponent < 256; exponent++) scale[exponent] = 2 ** (exponent - 136);
  let offset = dataOffset;
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
    yield;
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

/**
 * Decode RGBE pixels (flat or new-style run-length scanlines) to linear RGB,
 * box-averaging `downsample`×`downsample` blocks so a large panorama never
 * needs a full-resolution float copy. EXPOSURE lines are ignored, as Babylon's
 * own HDR loader does. A factor that would decode more than
 * {@link HDR_MAX_DECODED_PIXELS} pixels throws; pick it with
 * {@link radianceDownsampleFactor}.
 */
export function decodeRadianceHdr(bytes: Uint8Array, downsample = 1): RadianceImage {
  const scanlines = radianceScanlines(bytes, downsample);
  for (;;) {
    const step = scanlines.next();
    if (step.done) return step.value;
  }
}

/** {@link decodeRadianceHdr} that yields to the event loop every 32 ms, checking `signal` each time. */
export async function decodeRadianceHdrAsync(
  bytes: Uint8Array,
  downsample: number,
  signal?: AbortSignal,
): Promise<RadianceImage> {
  const scanlines = radianceScanlines(bytes, downsample);
  let lastYield = performance.now();
  for (;;) {
    const step = scanlines.next();
    if (step.done) return step.value;
    if (performance.now() - lastYield > YIELD_INTERVAL_MS) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal?.throwIfAborted();
      lastYield = performance.now();
    }
  }
}
