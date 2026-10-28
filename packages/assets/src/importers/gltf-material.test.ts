import { describe, expect, it } from "vitest";
import { lowerMaterialDocument } from "@haptic/shader-graph";
import { importedGltfMaterial } from "./gltf-material";

describe("imported glTF material graphs", () => {
  it("preserves factors, packed channels, emission, transparency and sidedness", () => {
    const result = importedGltfMaterial("Paint", { name: "Paint", unlit: false, albedoImageIndex: 0, textureImages: [0, 1], source: {
      pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.6, 0.7], baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 1 }, metallicFactor: 0.3, roughnessFactor: 0.8 },
      emissiveFactor: [0.5, 0, 0], alphaMode: "MASK", alphaCutoff: 0.4, doubleSided: true,
    } }, ["albedo", "packed"]);
    expect(result.leaveSlotEmpty).toBe(false);
    expect(result.document).toMatchObject({ blendMode: "masked", alphaCutoff: 0.4, twoSided: true });
    expect(result.dependencies).toEqual(expect.arrayContaining(["albedo", "packed"]));
    const lowered = lowerMaterialDocument(result.document);
    expect(lowered.ok).toBe(true);
    expect(result.document.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceNodeId: "metallic-roughness", sourcePinId: "b", targetNodeId: "metallic-multiply" }),
      expect.objectContaining({ sourceNodeId: "metallic-roughness", sourcePinId: "g", targetNodeId: "roughness-multiply" }),
    ]));
  });

  it("does not borrow unrelated images, and drops the extensions the glTF loader does not read either", () => {
    const bare = importedGltfMaterial("Plain", { name: "Plain", unlit: false, albedoImageIndex: null, source: {} }, ["unrelated"]);
    expect(bare.dependencies).toEqual([]);
    const extended = importedGltfMaterial("Coated", { name: "Coated", unlit: false, albedoImageIndex: null, source: { extensions: { KHR_materials_clearcoat: { clearcoatFactor: 1 } } } }, []);
    expect(extended.leaveSlotEmpty).toBe(false);
    expect(lowerMaterialDocument(extended.document).ok).toBe(true);
  });

  it("darkens only indirect light by the occlusion texture, at its strength", () => {
    const result = importedGltfMaterial("Stone", { name: "Stone", unlit: false, albedoImageIndex: null, textureImages: [0], source: {
      occlusionTexture: { index: 0, strength: 0.6 },
    } }, ["orm"]);
    expect(result.leaveSlotEmpty).toBe(false);
    expect(lowerMaterialDocument(result.document).ok).toBe(true);
    expect(result.document.nodes.find((node) => node.id === "occlusion-strength")?.properties).toMatchObject({ "default:a": [1], "default:alpha": [0.6] });
    expect(result.document.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceNodeId: "occlusion", sourcePinId: "r", targetNodeId: "occlusion-strength", targetPinId: "b" }),
      expect.objectContaining({ sourceNodeId: "occlusion-strength", targetNodeId: "output", targetPinId: "environmentInfluence" }),
    ]));
  });

  it("samples UV set 1 and texture transforms through UV and Transform UV nodes, shared by textures that agree", () => {
    const imported = (albedo: Record<string, unknown>, emission: Record<string, unknown> = {}) => importedGltfMaterial("Paint", { name: "Paint", unlit: false, albedoImageIndex: 0, textureImages: [0, 1], source: {
      pbrMetallicRoughness: { baseColorTexture: { index: 0, ...albedo } },
      emissiveTexture: { index: 1, ...emission },
    } }, ["albedo", "glow"]);
    const uvOf = (result: ReturnType<typeof imported>, sample: string) => result.document.edges.find((edge) => edge.targetNodeId === sample && edge.targetPinId === "uv");
    const node = (result: ReturnType<typeof imported>, id: string | undefined) => result.document.nodes.find((entry) => entry.id === id);

    // UV set 0 without a transform, an identity transform included, samples the mesh UV.
    for (const reference of [{}, { extensions: { KHR_texture_transform: { texCoord: 0, offset: [0, 0], scale: [1, 1], rotation: 0 } } }]) {
      const result = imported(reference);
      expect([uvOf(result, "albedo"), result.document.nodes.some((entry) => entry.type === "input.uv")]).toEqual([undefined, false]);
    }
    // The transform's texCoord overrides the reference's.
    for (const reference of [{ texCoord: 1 }, { texCoord: 0, extensions: { KHR_texture_transform: { texCoord: 1 } } }]) {
      const result = imported(reference);
      expect(node(result, uvOf(result, "albedo")?.sourceNodeId)).toMatchObject({ type: "input.uv", properties: { channel: 1 } });
    }
    const transform = { extensions: { KHR_texture_transform: { offset: [0.5, 0.25], rotation: 0.5, scale: [2, 3] } } };
    const transformed = imported(transform, transform);
    const xform = node(transformed, uvOf(transformed, "albedo")?.sourceNodeId);
    expect(xform).toMatchObject({ type: "texture.transformUv", properties: { "default:tiling": [2, 3], "default:rotation": [-0.5], "default:offset": [0.5, 0.25] } });
    expect(node(transformed, transformed.document.edges.find((edge) => edge.targetNodeId === xform?.id)?.sourceNodeId)).toMatchObject({ type: "input.uv", properties: {} });
    expect(uvOf(transformed, "emission")?.sourceNodeId).toBe(xform?.id);
    expect([transformed.leaveSlotEmpty, lowerMaterialDocument(transformed.document).ok]).toEqual([false, true]);
    // A different transform gets its own source.
    const separate = imported(transform, { texCoord: 1 });
    expect(uvOf(separate, "emission")?.sourceNodeId).not.toBe(uvOf(separate, "albedo")?.sourceNodeId);
    // The UV node reads sets 0 and 1 only.
    expect(imported({ texCoord: 2 }).leaveSlotEmpty).toBe(true);
  });

  it("filters a texture whose sampler magnifies NEAREST as nearest, and draws a texture with no image by its factor", () => {
    const result = importedGltfMaterial("Palette", { name: "Palette", unlit: false, albedoImageIndex: 0, textureImages: [0, null], nearestTextures: [true, false], source: {
      pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 1 }, metallicFactor: 0.25 },
    } }, ["palette"]);
    expect(result.leaveSlotEmpty).toBe(false);
    expect(result.document.nodes.find((node) => node.id === "albedo")?.properties).toMatchObject({ filter: "nearest" });
    expect(result.document.nodes.some((node) => node.id === "metallic-roughness")).toBe(false);
    expect(result.document.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceNodeId: "metallic-factor", targetNodeId: "output", targetPinId: "metallic" }),
    ]));
  });
});
