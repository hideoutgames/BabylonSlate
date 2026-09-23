import { describe, expect, it } from "vitest";
import { AREA_EMISSION_EDGE, decodeAreaEmission, encodeAreaEmission } from "./area-emission";
import { filterAreaEmission, processAreaEmissionRgba, resampleAreaEmissionSource } from "./area-emission-processing";

describe("derived rectangular emission", () => {
  it("preserves the average of odd-sized fine stripes without backend-specific mip aliasing", async () => {
    const width = 1537, height = 1;
    const source = new Uint8Array(width * 4);
    for (let x = 0; x < width; x++) source.set([x % 2 ? 255 : 0, 80, 170, 255], x * 4);
    const result = await resampleAreaEmissionSource(source, width, height);
    for (let i = 0; i < result.length; i += 4) {
      if (result[i]! < 127 || result[i]! > 128) throw new Error(`Aliased stripe at ${i / 4}: ${result[i]}`);
    }
    await expect(resampleAreaEmissionSource(source, width, height, (value) => { if (value > 0) throw new Error("cancelled"); })).rejects.toThrow("cancelled");
  });

  it("prefilters minified source detail instead of aliasing the original raster", async () => {
    const width = 1536, height = 16;
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
      pixels.set([x % 2 ? 255 : 0, 80, 170, 255], (y * width + x) * 4);
    const progress: number[] = [];
    const result = await processAreaEmissionRgba(pixels, width, height, (value) => { progress.push(value); });
    for (let i = 0; i < result.length; i += 4)
      if (result[i] !== 128 || result[i + 1] !== 80 || result[i + 2] !== 170 || result[i + 3] !== 255)
        throw new Error(`Minified uniform average changed at pixel ${i / 4}: ${result.slice(i, i + 4)}`);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.at(-1)).toBe(1);
  // Exercise the full 1024-square offline filter, including every output byte.
  // Instrumented hosted CI takes longer than the default 5-second test deadline.
  }, 30_000);

  it("round-trips its versioned encoding and rejects corruption or a replaced source", async () => {
    const pixels = new Uint8Array(AREA_EMISSION_EDGE ** 2 * 4).fill(97);
    const sourceHash = "a".repeat(64);
    const bytes = await encodeAreaEmission(pixels, sourceHash);
    expect((await decodeAreaEmission(bytes, sourceHash)).rgba.every((value) => value === 97)).toBe(true);
    await expect(decodeAreaEmission(bytes, "b".repeat(64))).rejects.toThrow("Stale");
    bytes[bytes.length - 1] = 0;
    await expect(decodeAreaEmission(bytes)).rejects.toThrow("Corrupt");
    await expect(decodeAreaEmission(bytes.subarray(0, 12))).rejects.toThrow("size");
  });

  it("retains uniform RGB and exact alpha while reporting cancellable progress", async () => {
    const source = new Uint8Array(16 * 16 * 4);
    for (let i = 0; i < source.length; i += 4) { source.set([80, 140, 220, i / 4], i); }
    const progress: number[] = [];
    const filtered = await filterAreaEmission(source, 16, (value) => { progress.push(value); });
    expect(filtered).toEqual(source);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    await expect(filterAreaEmission(source, 16, (value) => { if (value >= 0.5) throw new Error("cancelled"); })).rejects.toThrow("cancelled");
  });
});
