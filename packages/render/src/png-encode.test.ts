import { crc32, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodeRgbaPng, PNG_SIGNATURE } from "./png-encode";

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
