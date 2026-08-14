import { describe, expect, it } from "vitest";
import {
  bytesEqual,
  concatBytes,
  readU32LE,
  sha256Hex,
  stableStringify,
  writeU32LE,
} from "./bytes";

describe("stableStringify", () => {
  it("sorts object keys recursively so hashes stay order-independent", () => {
    const a = { z: 1, nested: { b: 2, a: 1 }, list: [{ y: 1, x: 0 }] };
    const b = { nested: { a: 1, b: 2 }, list: [{ x: 0, y: 1 }], z: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(stableStringify(a)).toBe(
      '{"list":[{"x":0,"y":1}],"nested":{"a":1,"b":2},"z":1}',
    );
  });
});

describe("bytes helpers", () => {
  it("compares, concatenates, and round-trips little-endian u32", () => {
    const left = new Uint8Array([1, 2, 3]);
    const right = new Uint8Array([4, 5]);
    expect(bytesEqual(left, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(bytesEqual(left, right)).toBe(false);
    expect(Array.from(concatBytes([left, right]))).toEqual([1, 2, 3, 4, 5]);

    const encoded = writeU32LE(0x04030201);
    expect(Array.from(encoded)).toEqual([1, 2, 3, 4]);
    expect(readU32LE(encoded, 0)).toBe(0x04030201);
  });

  it("hashes bytes with sha-256 hex", async () => {
    const hex = await sha256Hex(new Uint8Array([0, 1, 2, 3]));
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(hex).toBe(await sha256Hex(new Uint8Array([0, 1, 2, 3])));
    expect(hex).not.toBe(await sha256Hex(new Uint8Array([0, 1, 2, 4])));
  });
});
