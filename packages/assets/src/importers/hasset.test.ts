import { describe, expect, it, vi } from "vitest";
import { concatBytes, sha256Hex, stableStringify, writeU32LE } from "../bytes";
import { decodeHasset, encodeHasset, HASSET_FORMAT_VERSION, HASSET_MAGIC } from "../hasset";
import { HASSET_MAX_NESTED_ASSETS, HASSET_MAX_NESTING_DEPTH, ImportLimitError } from "../import-limits";
import { importHasset } from "./hasset";

// A small byte budget stands in for the real 256 MiB one, so the test never allocates that much.
vi.mock("../import-limits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../import-limits")>()),
  HASSET_MAX_NESTED_BYTES: 1024 * 1024,
}));

function header(guid: string, mode: "thin" | "bundled") {
  return {
    dependencyMetadataVersion: 1,
    requiredDependencies: [],
    guid,
    type: "Texture",
    name: guid,
    engineVersion: "0.0.0",
    version: 1,
    mode,
    dependencies: [],
    payload: {},
  };
}

function leaf(guid: string, data = new Uint8Array([1, 2, 3])): Promise<Uint8Array> {
  return encodeHasset({ header: header(guid, "thin"), chunks: [{ id: "pixels", kind: "pixels", mime: "image/png", data }], blobThreshold: Infinity });
}

function bundle(guid: string, nested: Array<{ guid: string; bytes: Uint8Array }>): Promise<Uint8Array> {
  return encodeHasset({ header: header(guid, "bundled"), chunks: [], nestedAssets: nested });
}

/** `levels` bundles each wrapping the next, around one leaf: `levels` levels of nesting. */
async function chain(levels: number): Promise<Uint8Array> {
  let bytes = await leaf(`level-${levels}`);
  for (let level = levels - 1; level >= 0; level--) bytes = await bundle(`level-${level}`, [{ guid: `level-${level + 1}`, bytes }]);
  return bytes;
}

/** A bundled file listing `copies` nested chunks that all point at the same inline bytes. */
async function overlapping(nested: Uint8Array, copies: number): Promise<Uint8Array> {
  const sha256 = await sha256Hex(nested);
  const chunks = Array.from({ length: copies }, (_, index) => ({
    id: `nested:copy-${index}`,
    kind: "asset",
    mime: "application/vnd.haptic.hasset",
    sha256,
    byteLength: nested.byteLength,
    locator: { inline: { offset: 0, length: nested.byteLength } },
  }));
  const json = new TextEncoder().encode(stableStringify({ ...header("root", "bundled"), chunks }));
  return concatBytes([HASSET_MAGIC, writeU32LE(HASSET_FORMAT_VERSION), writeU32LE(json.byteLength), json, nested]);
}

describe("importHasset limits", () => {
  it("imports every asset of a bundle nested to the depth limit", async () => {
    const results = await importHasset(await chain(HASSET_MAX_NESTING_DEPTH), { fileName: "deep.hasset", existingGuids: new Set() });
    expect(results).toHaveLength(HASSET_MAX_NESTING_DEPTH + 1);
  });

  it("refuses a bundle nested past the depth limit", async () => {
    await expect(importHasset(await chain(HASSET_MAX_NESTING_DEPTH + 1), { fileName: "deeper.hasset", existingGuids: new Set() }))
      .rejects.toThrow(/more than 8 levels deep; the import limit is 8/);
  });

  it("refuses inline chunks that overlap, so one nested asset cannot be counted many times", async () => {
    // Ten copies per level over three levels would otherwise decode a thousand assets from a few kilobytes.
    let bytes = await leaf("leaf");
    for (let level = 0; level < 3; level++) bytes = await overlapping(bytes, 10);
    await expect(decodeHasset(bytes)).rejects.toThrow(/overlap/);
    await expect(importHasset(bytes, { fileName: "bomb.hasset", existingGuids: new Set() })).rejects.toThrow(/overlap/);
  });

  it("refuses more nested assets than the limit across all levels", async () => {
    const leaves = await Promise.all(Array.from({ length: 300 }, (_, index) => leaf(`leaf-${index}`)));
    const half = (from: number) => leaves.slice(from, from + 150).map((bytes, index) => ({ guid: `leaf-${from + index}`, bytes }));
    const within = await bundle("root", [
      { guid: "a", bytes: await bundle("a", half(0)) },
      { guid: "b", bytes: await bundle("b", half(150)) },
    ]);
    expect(await importHasset(within, { fileName: "many.hasset", existingGuids: new Set() })).toHaveLength(303);

    const over = await bundle("root", Array.from({ length: HASSET_MAX_NESTED_ASSETS + 1 }, (_, index) => ({
      guid: `leaf-${index % 300}-${index}`,
      bytes: leaves[index % 300]!,
    })));
    const rejection = importHasset(over, { fileName: "too-many.hasset", existingGuids: new Set() });
    await expect(rejection).rejects.toThrow(ImportLimitError);
    await expect(rejection).rejects.toThrow(/at least 501; the import limit is 500/);
  });

  it("refuses nested assets whose bytes together pass the limit", async () => {
    const big = await leaf("big", new Uint8Array(600 * 1024));
    const one = await bundle("root", [{ guid: "big", bytes: big }]);
    expect(await importHasset(one, { fileName: "one.hasset", existingGuids: new Set() })).toHaveLength(2);
    const two = await bundle("root", [{ guid: "big", bytes: big }, { guid: "big-2", bytes: big }]);
    await expect(importHasset(two, { fileName: "two.hasset", existingGuids: new Set() })).rejects.toThrow(/the import limit is 1 MiB/);
  });
});
