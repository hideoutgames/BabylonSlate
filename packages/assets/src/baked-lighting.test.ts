import { createBakedLightingFixture } from "@babylonslate/test-kit/baked-lighting-fixtures";
import { expect, it } from "vitest";
import type { BakeInputHashes, BakedLightingManifest } from "@babylonslate/core";
import { sha256Hex } from "./bytes";
import { encodeBabasset } from "./babasset";
import { importBabasset } from "./importers/babasset";
import {
  bakedLightingImportResult, bakedLightingValidity, bakedReceiverKey,
  decodeBakedLightingAsset, encodeBakedLightingAsset, fingerprintBakeInputs,
  parseBakedLightingManifest, validateBakedLightingChunks,
} from "./baked-lighting";

async function fixture() {
  const { manifest, bytes, atlases } = await createBakedLightingFixture();
  const result = await bakedLightingImportResult({ guid: "bake", name: "Bake", manifest, atlases });
  return { manifest, bytes, result };
}

it("roundtrips complete physical irradiance and mixed source membership without a renderer or provider", async () => {
  const { manifest, result } = await fixture();
  const decoded = await decodeBakedLightingAsset(await encodeBakedLightingAsset(result));
  const data = decoded.atlases.get("atlas")!;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  expect(Array.from({ length: 8 }, (_, index) => view.getFloat32(index * 4, true))).toEqual([2, 1, 0.5, 1, 0, 3, 0, 0]);
  expect(decoded.manifest.receivers[0]!.contributions).toEqual([
    { sourceId: "sun", term: "directAndIndirect" },
    { sourceId: "lamp", term: "indirectOnly" },
    { sourceId: "sky", term: "environmentDiffuse" },
  ]);
  expect(decoded.manifest.dependencies).toEqual(["model", "cube"]);
  expect(bakedLightingValidity("scene", manifest.inputs, decoded.manifest)).toEqual({ status: "valid" });
});

it("distinguishes missing, duplicated Scene ownership, and every changed bake input", async () => {
  const { manifest } = await fixture();
  expect(bakedLightingValidity("scene", manifest.inputs, null).status).toBe("missing");
  expect(bakedLightingValidity("duplicated-scene", manifest.inputs, manifest)).toEqual({ status: "stale", reasons: ["Scene identity changed"] });
  for (const category of ["geometry", "uv", "transforms", "materials", "lights", "environment", "settings", "provider"] as const) {
    const current: BakeInputHashes = { ...manifest.inputs, [category]: "f".repeat(64) };
    expect(bakedLightingValidity("scene", current, manifest)).toEqual({ status: "stale", reasons: [`${category} changed`] });
  }
  const first = manifest.receivers[0]!.identity;
  expect(bakedReceiverKey(first)).not.toBe(bakedReceiverKey({ ...first, actorId: "duplicated-instance" }));
  expect(bakedReceiverKey(first)).not.toBe(bakedReceiverKey({ ...first, primitive: { ...first.primitive, kind: "model", assetGuid: "reimport", nodeIndex: 2, meshIndex: 0, primitiveIndex: 1 } }));
});

it("hashes canonical inputs independently of object key order but requires every category and finite JSON", async () => {
  const input = { geometry: "g", uv: "u", transforms: "t", materials: { a: 1, b: 2 }, lights: [], environment: null, settings: { samples: 2 }, provider: "v1" };
  expect(await fingerprintBakeInputs({ ...input, materials: { b: 2, a: 1 } })).toEqual(await fingerprintBakeInputs(input));
  expect((await fingerprintBakeInputs({ ...input, materials: { a: 1, b: 3 } })).materials).not.toBe((await fingerprintBakeInputs(input)).materials);
  await expect(fingerprintBakeInputs({ ...input, settings: { samples: NaN } })).rejects.toThrow();
  const { uv: _uv, ...missing } = input;
  await expect(fingerprintBakeInputs(missing as typeof input)).rejects.toThrow("Every bake input category");
});

it("rejects unsupported data, ambiguous receiver bindings and duplicate lighting terms", async () => {
  const { manifest } = await fixture();
  const bad = (change: (copy: BakedLightingManifest) => void) => {
    const copy = structuredClone(manifest); change(copy);
    expect(() => parseBakedLightingManifest(copy)).toThrow();
  };
  expect(() => parseBakedLightingManifest({ ...manifest, version: 2 })).toThrow();
  expect(() => parseBakedLightingManifest({ ...manifest, uniqueId: 42 })).toThrow();
  bad((copy) => { copy.receivers.push(structuredClone(copy.receivers[0]!)); });
  bad((copy) => { copy.receivers[0]!.contributions[1]!.term = "directAndIndirect"; });
  bad((copy) => { copy.receivers[0]!.contributions.push({ sourceId: "sun", term: "directAndIndirect" }); });
  bad((copy) => { copy.receivers[0]!.contributions[0]!.sourceId = "missing"; });
  bad((copy) => { copy.receivers[0]!.offset[0] = 0.5; });
  bad((copy) => { copy.dependencies = []; });
  bad((copy) => { copy.atlases[0]!.width = 4096; copy.atlases[0]!.height = 4096; });
  expect(() => parseBakedLightingManifest({ ...manifest, atlases: [{ ...manifest.atlases[0], colorSpace: "srgb" }] })).toThrow();
});

it("rejects missing, corrupt and nonfinite atlas contents before they can become a usable output", async () => {
  const { result, manifest, bytes } = await fixture();
  await expect(validateBakedLightingChunks(result, result.chunks.slice(0, 1))).rejects.toThrow();
  const corrupt = result.chunks.map((chunk) => ({ ...chunk, data: chunk.data.slice() }));
  corrupt[1]!.data[0] = 1;
  await expect(validateBakedLightingChunks(result, corrupt)).rejects.toThrow("hash mismatch");
  new DataView(bytes.buffer).setFloat32(0, Infinity, true);
  manifest.atlases[0]!.sha256 = await sha256Hex(bytes);
  await expect(bakedLightingImportResult({ guid: "bad", name: "Bad", manifest, atlases: new Map([["atlas", bytes]]) })).rejects.toThrow("invalid radiance or coverage");
});

it("owns atlas and header inputs across asynchronous validation and later caller mutation", async () => {
  const { manifest, bytes, result } = await fixture();
  const validating = validateBakedLightingChunks(result, result.chunks);
  result.guid = "mutated";
  result.chunks[1]!.data.fill(0);
  const owned = await validating;
  expect(owned.guid).toBe("bake");
  expect(owned.atlases.get("atlas")).toEqual(bytes);
  const preparing = bakedLightingImportResult({ guid: "next", name: "Next", manifest, atlases: new Map([["atlas", bytes]]) });
  bytes.fill(0);
  manifest.receivers[0]!.identity.actorId = "mutated";
  const prepared = await preparing;
  const decoded = await decodeBakedLightingAsset(await encodeBakedLightingAsset(prepared));
  expect(decoded.manifest.receivers[0]!.identity.actorId).toBe("receiver");
  expect(decoded.atlases.get("atlas")).toEqual(owned.atlases.get("atlas"));
});

it("validates imports before admission and refuses source GUID rebinding while allowing a new bake asset GUID", async () => {
  const { result } = await fixture();
  const bytes = await encodeBakedLightingAsset(result);
  const [imported] = await importBabasset(bytes, { fileName: "Bake.babasset", existingGuids: new Set(["bake"]) });
  expect(imported!.guid).not.toBe("bake");
  bytes.fill(0);
  expect((await validateBakedLightingChunks(imported!, imported!.chunks)).manifest.sceneGuid).toBe("scene");
  const corrupt = result.chunks.map((chunk) => ({ ...chunk, data: chunk.data.slice() }));
  corrupt[1]!.data[0] = 1;
  await expect(importBabasset(await encodeBabasset({ header: { ...result, engineVersion: "0", mode: "bundled" }, chunks: corrupt }),
    { fileName: "Bad.babasset", existingGuids: new Set() })).rejects.toThrow("hash mismatch");
  const source = await encodeBabasset({ header: { guid: "model", name: "Model", type: "Model", version: 1,
    dependencies: [], payload: {}, engineVersion: "0", mode: "bundled" }, chunks: [] });
  const bundled = await encodeBabasset({ header: { ...result, engineVersion: "0", mode: "bundled" }, chunks: result.chunks,
    nestedAssets: [{ guid: "model", bytes: source }] });
  await expect(importBabasset(bundled, { fileName: "Bundle.babasset", existingGuids: new Set(["model"]) })).rejects.toThrow("source GUID remapping requires a new bake");
});
