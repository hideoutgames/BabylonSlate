import { describe, expect, it } from "vitest";
import { encodeRgbaPng, PNG_SIGNATURE } from "./png-encode";

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
});
