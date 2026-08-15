import { describe, expect, it } from "vitest";
import { decodeBabpack, encodeBabpack } from "./babpack";

describe("babpack", () => {
  it("round-trips guid blobs with offset length and hash", async () => {
    const a = new TextEncoder().encode("scene-bytes");
    const b = new TextEncoder().encode("texture-bytes");
    const packed = await encodeBabpack([
      { guid: "scene-1", bytes: a },
      { guid: "tex-1", bytes: b },
    ]);
    const decoded = decodeBabpack(packed);
    expect(decoded.entries.map((entry) => entry.guid)).toEqual(["scene-1", "tex-1"]);
    expect(decoded.read("scene-1")).toEqual(a);
    expect(decoded.read("tex-1")).toEqual(b);
    expect(packed.subarray(
      decoded.entries[0]!.offset,
      decoded.entries[0]!.offset + decoded.entries[0]!.length,
    )).toEqual(a);
    expect(decoded.entries[0]?.length).toBe(a.byteLength);
    expect(decoded.entries[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws on a truncated pack", () => {
    expect(() => decodeBabpack(new Uint8Array([1, 2, 3]))).toThrow(/babpack/i);
  });
});
