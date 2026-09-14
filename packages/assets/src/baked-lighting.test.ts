import { expect, it } from "vitest";
import type { BakeInputHashes, BakedLightingManifest } from "@babylonslate/core";
import { sha256Hex } from "./bytes";
import {
  bakedLightingImportResult, bakedLightingValidity, bakedReceiverKey,
  decodeBakedLightingAsset, encodeBakedLightingAsset, fingerprintBakeInputs,
  parseBakedLightingManifest, validateBakedLightingChunks,
} from "./baked-lighting";

async function fixture() {
  const values = [2, 1, 0.5, 1, 0, 3, 0, 0];
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  const inputs = await fingerprintBakeInputs({
    geometry: ["model-content", "mesh:0/primitive:1"], uv: [0, 0, 1, 1],
    transforms: [1, 0, 0, 1], materials: { albedo: [0.5, 0.25, 0.1], emission: 0 },
    lights: { static: [1, 2, 3], stationary: [0.1, 0.2, 0.3] },
    environment: { guid: "cube", rotation: 90, intensity: 2 },
    settings: { version: "1", samples: 64, bounces: 2, clamp: 10 },
    provider: { id: "test-provider", version: "1", adapterVersion: "1" },
  });
  const manifest: BakedLightingManifest = {
    version: 1, sceneGuid: "scene", inputs,
    provider: { id: "test-provider", version: "1", adapterVersion: "1" }, settingsVersion: "1",
    dependencies: ["model", "cube"],
    sources: [
      { id: "sun", kind: "light", actorId: "light-a", componentId: "light", mobility: "static", inputHash: inputs.lights },
      { id: "lamp", kind: "light", actorId: "light-b", componentId: "light", mobility: "stationary", inputHash: inputs.lights },
      { id: "sky", kind: "environment", assetGuid: "cube", inputHash: inputs.environment },
    ],
    receivers: [{
      identity: { actorId: "receiver", componentId: "mesh", primitive: { kind: "model", assetGuid: "model", nodeIndex: 2, meshIndex: 0, primitiveIndex: 1 } },
      hashes: { geometry: inputs.geometry, uv: inputs.uv, transforms: inputs.transforms, materials: inputs.materials },
      atlasGuid: "atlas", scale: [1, 1], offset: [0, 0],
      contributions: [{ sourceId: "sun", term: "directAndIndirect" }, { sourceId: "lamp", term: "indirectOnly" }, { sourceId: "sky", term: "environmentDiffuse" }],
    }],
    atlases: [{ guid: "atlas", chunkId: "atlas:atlas", width: 1, height: 2,
      sha256: await sha256Hex(bytes), encoding: "rgba32float-le", colorSpace: "linear",
      quantity: "diffuseIrradiance", convention: "physical-E", alpha: "coverage", rowOrder: "bottomFirst",
      uvSet: 1, mipLevels: 1, gutterTexels: 0 }],
  };
  const result = await bakedLightingImportResult({ guid: "bake", name: "Bake", manifest, atlases: new Map([["atlas", bytes]]) });
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
