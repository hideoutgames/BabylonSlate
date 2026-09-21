import { describe, expect, it } from "vitest";
import { AREA_EMISSION_EDGE, decodeAreaEmission, encodeAreaEmission } from "./area-emission";
import { filterAreaEmission } from "./area-emission-processing";

describe("derived rectangular emission", () => {
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
