import { expect, it } from "vitest";
import { sha256Hex } from "./bytes";
import { assetContentHash, installAssetBytes, installedAssetIdentity } from "./installed-asset";

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

it("takes a verified catalog revision as the identity without hashing the bytes", async () => {
  const input = new Uint8Array([4, 5, 6]);
  const revision = await sha256Hex(input);
  const verified = installAssetBytes(input, "image/png", revision);
  expect(installedAssetIdentity(verified)).toBe(revision);
  expect([...new Uint8Array(await verified.arrayBuffer())]).toEqual([4, 5, 6]);
});

it("hashes unverified content with MurmurHash3 x86 128 behind its length", () => {
  // Reference values from the canonical C implementation (seed 0): empty input, short tails, and tails after one and
  // two full 16-byte blocks.
  const text = new TextEncoder();
  expect(assetContentHash(new Uint8Array())).toBe("0:00000000000000000000000000000000");
  expect(assetContentHash(text.encode("a"))).toBe("1:a794933c5556b01b5556b01b5556b01b");
  expect(assetContentHash(text.encode("abc"))).toBe("3:75cdc6d1a2b006a5a2b006a5a2b006a5");
  expect(assetContentHash(text.encode("Hello, world! 1234"))).toBe("18:671df8d94893290de8b706d4cbe45d11");
  expect(assetContentHash(Uint8Array.from({ length: 37 }, (_, index) => index))).toBe("37:217f288ecc2dcabebd9af5c3a2dd66c0");
});
