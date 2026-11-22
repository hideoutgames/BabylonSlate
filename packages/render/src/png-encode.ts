/** PNG file signature (`89 50 4E 47 0D 0A 1A 0A`). */
export const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** zlib's NMAX: the longest run whose Adler sums cannot exceed 32 bits. */
const ADLER_BLOCK = 5552;

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let start = 0; start < bytes.length; start += ADLER_BLOCK) {
    const end = Math.min(start + ADLER_BLOCK, bytes.length);
    for (let i = start; i < end; i += 1) {
      a += bytes[i]!;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

/** Write a chunk whose data `writeData` fills in place; returns the next offset. */
function writeChunk(
  out: Uint8Array,
  offset: number,
  type: string,
  length: number,
  writeData: (dataOffset: number) => void,
): number {
  writeUint32(out, offset, length);
  for (let i = 0; i < 4; i += 1) out[offset + 4 + i] = type.charCodeAt(i);
  writeData(offset + 8);
  // Type and data are contiguous, so the CRC needs no separate input copy.
  writeUint32(out, offset + 8 + length, crc32(out.subarray(offset + 4, offset + 8 + length)));
  return offset + 12 + length;
}

const STORED_BLOCK_BYTES = 65535;

function storedBlockCount(length: number): number {
  return Math.max(1, Math.ceil(length / STORED_BLOCK_BYTES));
}

/** Store-only zlib so we do not take a deflate dependency in `@haptic/render`. */
function writeZlibStore(out: Uint8Array, offset: number, data: Uint8Array): void {
  out[offset] = 0x78;
  out[offset + 1] = 0x01;
  offset += 2;
  const blockCount = storedBlockCount(data.length);
  for (let i = 0; i < blockCount; i += 1) {
    const start = i * STORED_BLOCK_BYTES;
    const slice = data.subarray(start, start + STORED_BLOCK_BYTES);
    const last = i === blockCount - 1 ? 1 : 0;
    out[offset] = last;
    out[offset + 1] = slice.length & 0xff;
    out[offset + 2] = (slice.length >>> 8) & 0xff;
    const nlen = (~slice.length) & 0xffff;
    out[offset + 3] = nlen & 0xff;
    out[offset + 4] = (nlen >>> 8) & 0xff;
    out.set(slice, offset + 5);
    offset += 5 + slice.length;
  }
  writeUint32(out, offset, adler32(data));
}

/** Filter-0 scanlines: each row of RGBA prefixed by its filter byte. */
function filteredRows(width: number, height: number, rgba: Uint8Array): Uint8Array<ArrayBuffer> {
  const rowBytes = width * 4;
  const raw = new Uint8Array(height * (1 + rowBytes));
  for (let y = 0; y < height; y += 1) {
    const dest = y * (1 + rowBytes);
    raw[dest] = 0;
    raw.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), dest + 1);
  }
  return raw;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

/**
 * Scanlines each filtered with whichever of the five PNG filters gives the smallest sum of
 * absolute (signed) residuals, the PNG specification's suggested heuristic: shaded renders
 * deflate far better as differences than as raw values. Decoding restores the same pixels.
 */
function adaptivelyFilteredRows(width: number, height: number, rgba: Uint8Array): Uint8Array<ArrayBuffer> {
  const rowBytes = width * 4;
  const raw = new Uint8Array(height * (1 + rowBytes));
  const candidate = new Uint8Array(rowBytes);
  const best = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y += 1) {
    const row = rgba.subarray(y * rowBytes, (y + 1) * rowBytes);
    const above = y > 0 ? rgba.subarray((y - 1) * rowBytes, y * rowBytes) : null;
    let bestFilter = 0;
    let bestCost = Infinity;
    for (let filter = 0; filter <= 4; filter += 1) {
      let cost = 0;
      for (let i = 0; i < rowBytes; i += 1) {
        const left = i >= 4 ? row[i - 4]! : 0;
        const up = above ? above[i]! : 0;
        const upLeft = above && i >= 4 ? above[i - 4]! : 0;
        const predicted = filter === 0 ? 0
          : filter === 1 ? left
            : filter === 2 ? up
              : filter === 3 ? (left + up) >>> 1
                : paeth(left, up, upLeft);
        const residual = (row[i]! - predicted) & 0xff;
        candidate[i] = residual;
        cost += residual < 128 ? residual : 256 - residual;
      }
      if (cost < bestCost) {
        bestCost = cost;
        bestFilter = filter;
        best.set(candidate);
      }
    }
    const dest = y * (1 + rowBytes);
    raw[dest] = bestFilter;
    raw.set(best, dest + 1);
  }
  return raw;
}

/** Signature, then IHDR, IDAT (a zlib stream `writeIdat` fills) and IEND, 12 bytes of framing each. */
function assemblePng(
  width: number,
  height: number,
  zlibLength: number,
  writeIdat: (out: Uint8Array, offset: number) => void,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(PNG_SIGNATURE.length + 12 + 13 + 12 + zlibLength + 12);
  out.set(PNG_SIGNATURE, 0);
  let offset = writeChunk(out, PNG_SIGNATURE.length, "IHDR", 13, (data) => {
    writeUint32(out, data, width);
    writeUint32(out, data + 4, height);
    out[data + 8] = 8;
    out[data + 9] = 6;
  });
  offset = writeChunk(out, offset, "IDAT", zlibLength, (data) => writeIdat(out, data));
  writeChunk(out, offset, "IEND", 0, () => {});
  return out;
}

/** Encode unpremultiplied RGBA8 into a PNG (filter 0, store-only IDAT). Synchronous, for tests and fixtures. */
export function encodeRgbaPng(
  width: number,
  height: number,
  rgba: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const raw = filteredRows(width, height, rgba);
  const zlibLength = 2 + storedBlockCount(raw.length) * 5 + raw.length + 4;
  return assemblePng(width, height, zlibLength, (out, offset) => writeZlibStore(out, offset, raw));
}

/**
 * The same image as `encodeRgbaPng` (decoding to the same pixels), its rows adaptively filtered
 * and its IDAT deflated by the platform's `CompressionStream("deflate")`, whose output is a zlib
 * stream as PNG requires. A store-only 128×128 thumbnail is about 64 KiB; most deflate to a fraction of
 * it. Where `CompressionStream` is missing, the store-only encoding.
 */
export async function encodeRgbaPngCompressed(
  width: number,
  height: number,
  rgba: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof CompressionStream === "undefined") return encodeRgbaPng(width, height, rgba);
  const raw = adaptivelyFilteredRows(width, height, rgba);
  const deflated = new Uint8Array(
    await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer(),
  );
  return assemblePng(width, height, deflated.length, (out, offset) => out.set(deflated, offset));
}
