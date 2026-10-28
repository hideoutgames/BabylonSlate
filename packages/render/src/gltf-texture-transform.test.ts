import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import type { PBRMaterial, Texture } from "@babylonjs/core";
import { buildMinimalGlbFixture, encodeGlbJsonBin, importModel, splitGlbJsonBin } from "@haptic/assets";
import type { MaterialDocument } from "@haptic/shader-graph";
import { describe, expect, it } from "vitest";
import { createTestEngine } from "./create-null-engine";
import "./gltf-loader";

/** The fixture GLB with its base color texture read through `transform`. */
function transformedGlb(transform: Record<string, unknown>): Uint8Array {
  const split = splitGlbJsonBin(buildMinimalGlbFixture())!;
  const [material] = split.json.materials as { pbrMetallicRoughness: Record<string, unknown> }[];
  material!.pbrMetallicRoughness.baseColorTexture = { index: 0, extensions: { KHR_texture_transform: transform } };
  split.json.extensionsUsed = ["KHR_texture_transform"];
  return encodeGlbJsonBin(split.json, split.bin);
}

/** Where Babylon's glTF loader samples `uv`: its texture matrix applied as the shader does, to (u, v, 1, 0). */
async function loaderUv(bytes: Uint8Array) {
  const handle = createTestEngine();
  try {
    const container = await LoadAssetContainerAsync(bytes, handle.scene, {
      pluginExtension: ".glb",
      pluginOptions: { gltf: { loadAllMaterials: true } },
    });
    const m = ((container.materials[0] as PBRMaterial).albedoTexture as Texture).getTextureMatrix().m;
    return ([u, v]: readonly number[]) => [m[0]! * u! + m[4]! * v! + m[8]!, m[1]! * u! + m[5]! * v! + m[9]!];
  } finally {
    handle.scene.dispose();
    handle.engine.dispose();
  }
}

/** Where the imported Material samples `uv`: Transform UV's Tiling, Rotate 2D at Rotation, then Offset. */
async function importedUv(bytes: Uint8Array) {
  const results = await importModel(bytes, { fileName: "transformed.glb", existingGuids: new Set() });
  const document = results.find((result) => result.type === "Material")!.payload as unknown as MaterialDocument;
  const properties = document.nodes.find((node) => node.type === "texture.transformUv")!.properties;
  const [sx, sy] = properties["default:tiling"] as number[];
  const [angle] = properties["default:rotation"] as number[];
  const [ox, oy] = properties["default:offset"] as number[];
  return ([u, v]: readonly number[]) => {
    const [x, y] = [sx! * u!, sy! * v!];
    return [Math.cos(angle!) * x - Math.sin(angle!) * y + ox!, Math.sin(angle!) * x + Math.cos(angle!) * y + oy!];
  };
}

describe("an imported KHR_texture_transform", () => {
  it.each([
    { offset: [0.25, 0.5] },
    { scale: [2, 3] },
    { rotation: 0.6 },
    { offset: [0.1, -0.2], rotation: 1.2, scale: [0.5, 2] },
  ])("samples where Babylon's glTF loader sampled: %j", async (transform) => {
    const bytes = transformedGlb(transform);
    const [expected, actual] = await Promise.all([loaderUv(bytes), importedUv(bytes)]);
    for (const uv of [[0, 0], [1, 0], [0, 1], [0.3, 0.7]]) {
      const [a, b] = [expected(uv), actual(uv)];
      expect(b[0]).toBeCloseTo(a[0]!, 6);
      expect(b[1]).toBeCloseTo(a[1]!, 6);
    }
  });
});
