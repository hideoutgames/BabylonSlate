import { crc32, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodeRgbaPng, encodeRgbaPngCompressed, PNG_SIGNATURE } from "./png-encode";

function readChunks(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: Array<{ type: string; data: Uint8Array; crc: number; typeAndData: Uint8Array }> = [];
  for (let offset = PNG_SIGNATURE.length; offset < png.length;) {
    const length = view.getUint32(offset);
    chunks.push({
      type: new TextDecoder().decode(png.subarray(offset + 4, offset + 8)),
      data: png.subarray(offset + 8, offset + 8 + length),
      crc: view.getUint32(offset + 8 + length),
      typeAndData: png.subarray(offset + 4, offset + 8 + length),
    });
    offset += 12 + length;
  }
  return chunks;
}

describe("encodeRgbaPng", () => {
  it("writes a PNG signature and IHDR for RGBA pixels", () => {
    const pixels = new Uint8Array(2 * 2 * 4);
    pixels[3] = 0;
    pixels[7] = 255;
    const png = encodeRgbaPng(2, 2, pixels);
    expect([...png.subarray(0, 8)]).toEqual([...PNG_SIGNATURE]);
    const text = new TextDecoder().decode(png);
    expect(text).toContain("IHDR");
    expect(text).toContain("IDAT");
    expect(text).toContain("IEND");
  });

  it("writes valid chunk CRCs and a zlib stream that inflates to filter-0 rows", () => {
    // Over 65535 filtered bytes: two stored blocks and many Adler-32 windows.
    const width = 150;
    const height = 120;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 7 + (i >>> 9)) & 0xff;
    const chunks = readChunks(encodeRgbaPng(width, height, rgba));
    expect(chunks.map((chunk) => chunk.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    for (const chunk of chunks) expect(chunk.crc).toBe(crc32(chunk.typeAndData));
    expect(chunks[2]!.crc).toBe(0xae426082);
    const ihdr = new DataView(chunks[0]!.data.buffer, chunks[0]!.data.byteOffset, 13);
    expect([ihdr.getUint32(0), ihdr.getUint32(4), ihdr.getUint8(8), ihdr.getUint8(9)]).toEqual([width, height, 8, 6]);
    // inflateSync also rejects a wrong Adler-32 trailer.
    const rows = inflateSync(chunks[1]!.data);
    const expected = new Uint8Array(height * (1 + width * 4));
    for (let y = 0; y < height; y++) {
      expected.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
    }
    expect(rows.equals(expected)).toBe(true);
  });
});

/** A reference PNG row decoder (RGBA8): undoes each row's filter, per the PNG specification. */
function unfilter(rows: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 4;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = rows[y * (stride + 1)]!;
    for (let i = 0; i < stride; i++) {
      const value = rows[y * (stride + 1) + 1 + i]!;
      const a = i >= 4 ? out[y * stride + i - 4]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + i]! : 0;
      const c = i >= 4 && y > 0 ? out[(y - 1) * stride + i - 4]! : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a
        : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const predicted = [0, a, b, (a + b) >> 1, paeth][filter]!;
      out[y * stride + i] = (value + predicted) & 0xff;
    }
  }
  return out;
}

describe("encodeRgbaPngCompressed", () => {
  it("decodes to the same pixels as the store-only PNG, several times smaller for a thumbnail", async () => {
    // A 128×128 thumbnail: a shaded disc on a transparent background.
    const size = 128;
    const rgba = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if ((x - 64) ** 2 + (y - 64) ** 2 > 50 ** 2) continue;
        rgba.set([x * 2, y * 2, 128, 255], (y * size + x) * 4);
      }
    }
    const stored = encodeRgbaPng(size, size, rgba);
    const compressed = await encodeRgbaPngCompressed(size, size, rgba);
    const storedChunks = readChunks(stored);
    const compressedChunks = readChunks(compressed);
    expect(compressedChunks.map((chunk) => chunk.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    for (const chunk of compressedChunks) expect(chunk.crc).toBe(crc32(chunk.typeAndData));
    expect(compressedChunks[0]!.data).toEqual(storedChunks[0]!.data);
    const rows = inflateSync(compressedChunks[1]!.data);
    // Each row names one of the five filters, and the rows decode to the input pixels.
    for (let y = 0; y < size; y++) expect(rows[y * (size * 4 + 1)]).toBeLessThanOrEqual(4);
    expect(unfilter(rows, size, size)).toEqual(rgba);
    expect(unfilter(inflateSync(storedChunks[1]!.data), size, size)).toEqual(rgba);
    expect(stored.byteLength).toBeGreaterThan(65_000);
    expect(compressed.byteLength).toBeLessThan(stored.byteLength / 4);
  });

  it("falls back to the store-only encoding without CompressionStream", async ({ onTestFinished }) => {
    const original = globalThis.CompressionStream;
    onTestFinished(() => { globalThis.CompressionStream = original; });
    Reflect.deleteProperty(globalThis, "CompressionStream");
    const rgba = new Uint8Array([1, 2, 3, 4]);
    expect(await encodeRgbaPngCompressed(1, 1, rgba)).toEqual(encodeRgbaPng(1, 1, rgba));
  });
});
