import type { BakedLightingManifest } from "@babylonslate/core";

/** Physical E fixture with mixed source terms and stable imported-primitive identity. */
export async function createBakedLightingFixture(width = 1, height = 2) {
  const bytes = new Uint8Array(width * height * 16);
  const view = new DataView(bytes.buffer);
  const values = [2, 1, 0.5, 1, 0, 3, 0, 0];
  for (let offset = 0; offset < bytes.length; offset += 4)
    view.setFloat32(offset, values[(offset / 4) % values.length]!, true);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const inputs = {
    geometry: "1".repeat(64), uv: "2".repeat(64), transforms: "3".repeat(64),
    materials: "4".repeat(64), lights: "5".repeat(64), environment: "6".repeat(64),
    settings: "7".repeat(64), provider: "8".repeat(64),
  };
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
      mobility: "static",
      identity: { actorId: "receiver", componentId: "mesh", primitive: { kind: "model", assetGuid: "model", nodeIndex: 2, meshIndex: 0, primitiveIndex: 1 } },
      hashes: { geometry: inputs.geometry, uv: inputs.uv, transforms: inputs.transforms, materials: inputs.materials },
      atlasGuid: "atlas", scale: [1, 1], offset: [0, 0],
      contributions: [{ sourceId: "sun", term: "directAndIndirect" }, { sourceId: "lamp", term: "indirectOnly" }, { sourceId: "sky", term: "environmentDiffuse" }],
    }],
    atlases: [{ guid: "atlas", chunkId: "atlas:atlas", width, height, sha256,
      encoding: "rgba32float-le", colorSpace: "linear", quantity: "diffuseIrradiance",
      convention: "physical-E", alpha: "coverage", rowOrder: "bottomFirst", uvSet: 1, mipLevels: 1, gutterTexels: 0 }],
  };
  return { manifest, bytes, atlases: new Map([["atlas", bytes]]) };
}
