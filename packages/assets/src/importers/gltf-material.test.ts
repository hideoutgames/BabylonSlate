import { describe, expect, it } from "vitest";
import { lowerMaterialDocument } from "@babylonslate/shader-graph";
import { importedGltfMaterial } from "./gltf-material";

describe("imported glTF material graphs", () => {
  it("preserves factors, packed channels, emission, transparency and sidedness", () => {
    const result = importedGltfMaterial("Paint", { name: "Paint", unlit: false, albedoImageIndex: 0, textureImages: [0, 1], source: {
      pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.6, 0.7], baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 1 }, metallicFactor: 0.3, roughnessFactor: 0.8 },
      emissiveFactor: [0.5, 0, 0], alphaMode: "MASK", alphaCutoff: 0.4, doubleSided: true,
    } }, ["albedo", "packed"]);
    expect(result.preserveSource).toBe(false);
    expect(result.document).toMatchObject({ blendMode: "masked", alphaCutoff: 0.4, twoSided: true });
    expect(result.dependencies).toEqual(expect.arrayContaining(["albedo", "packed"]));
    const lowered = lowerMaterialDocument(result.document);
    expect(lowered.ok).toBe(true);
    expect(result.document.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceNodeId: "metallic-roughness", sourcePinId: "b", targetNodeId: "metallic-multiply" }),
      expect.objectContaining({ sourceNodeId: "metallic-roughness", sourcePinId: "g", targetNodeId: "roughness-multiply" }),
    ]));
  });

  it("does not borrow unrelated images and preserves unsupported source materials", () => {
    const bare = importedGltfMaterial("Plain", { name: "Plain", unlit: false, albedoImageIndex: null, source: {} }, ["unrelated"]);
    expect(bare.dependencies).toEqual([]);
    const extended = importedGltfMaterial("Coated", { name: "Coated", unlit: false, albedoImageIndex: null, source: { extensions: { KHR_materials_clearcoat: { clearcoatFactor: 1 } } } }, []);
    expect(extended.preserveSource).toBe(true);
  });
});
