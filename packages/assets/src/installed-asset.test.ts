import { expect, it } from "vitest";
import { sha256Hex } from "./bytes";
import { installAssetBytes, installedAssetIdentity } from "./installed-asset";

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

it("takes a verified catalog revision as the content identity hashing would give", async () => {
  const input = new Uint8Array([4, 5, 6]);
  const verified = installAssetBytes(input, "image/png", await sha256Hex(input));
  expect(installedAssetIdentity(verified)).toBe(installedAssetIdentity(installAssetBytes(input.slice(), "image/png")));
  expect([...new Uint8Array(await verified.arrayBuffer())]).toEqual([4, 5, 6]);
});
