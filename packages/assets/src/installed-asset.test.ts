import { expect, it, vi } from "vitest";
import { installAssetBytes, installedAssetHeader, installedAssetIdentity } from "./installed-asset";

it("publishes immutable content and recognizes equal content across independent views", async () => {
  const input = new Uint8Array([1, 2, 3]);
  const first = installAssetBytes(input);
  const sibling = installAssetBytes(input.slice());
  expect(installedAssetIdentity(sibling)).toBe(installedAssetIdentity(first));
  input[1] = 9;
  const replacement = installAssetBytes(input);
  expect(installedAssetIdentity(replacement)).not.toBe(installedAssetIdentity(first));
  expect([...new Uint8Array(await first.arrayBuffer())]).toEqual([1, 2, 3]);
  expect([...new Uint8Array(await replacement.arrayBuffer())]).toEqual([1, 9, 3]);
});

it("identifies installed content by its SHA-256, or by the digest the host already verified, copying only the header", () => {
  const slice = vi.spyOn(Uint8Array.prototype, "slice");
  try {
    const bytes = new Uint8Array([1, 2, 3]);
    const hashed = installAssetBytes(bytes);
    expect(installedAssetIdentity(hashed)).toBe("039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81");
    const verified = installAssetBytes(bytes, "image/png", "f".repeat(64));
    expect(installedAssetIdentity(verified)).toBe("f".repeat(64));
    // The Blob is the only full copy of the source; the bounded upload header is the other one.
    expect(slice.mock.calls.filter((_, index) => slice.mock.contexts[index] === bytes)).toEqual([[0, 64 * 1024], [0, 64 * 1024]]);
  } finally { slice.mockRestore(); }
});

it("installs a view into a larger buffer exactly as its own bytes", async () => {
  const buffer = new Uint8Array([9, 9, 9, 9, 1, 2, 3, 9, 9]);
  const view = buffer.subarray(4, 7);
  const installed = installAssetBytes(view);
  expect(installedAssetIdentity(installed)).toBe("039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81");
  expect([...installedAssetHeader(installed)!]).toEqual([1, 2, 3]);
  expect([...new Uint8Array(await installed.arrayBuffer())]).toEqual([1, 2, 3]);
});
