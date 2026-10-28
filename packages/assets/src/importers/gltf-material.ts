import { createDefaultMaterialDocument, materialDependencies, materialPinDefaultPropertyKey } from "@haptic/shader-graph";
import type { GlbBrowseMaterial } from "./glb-parse";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const number = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const vector = (value: unknown, fallback: readonly number[]) => fallback.map((entry, index) => number(Array.isArray(value) ? value[index] : undefined, entry));

/** The UV set and KHR_texture_transform a texture reference samples with; the transform's texCoord overrides. */
function textureCoordinates(reference: Record<string, unknown>) {
  const transform = record(record(reference.extensions).KHR_texture_transform);
  return {
    texCoord: number(transform.texCoord, number(reference.texCoord, 0)),
    offset: vector(transform.offset, [0, 0]),
    rotation: number(transform.rotation, 0),
    scale: vector(transform.scale, [1, 1]),
  };
}

/**
 * The glTF metallic/roughness material as a graph. Extensions the loader does not read (clear coat, sheen and so on)
 * are dropped, as the loader drops them. A texture on UV set 2 or later, which the UV node does not read, leaves the
 * Model's slot empty.
 */
export function importedGltfMaterial(name: string, material: GlbBrowseMaterial, imageGuids: readonly string[]) {
  const doc = createDefaultMaterialDocument(name);
  doc.nodes = doc.nodes.filter((node) => node.id === "output");
  doc.edges = [];
  const source = material.source ?? {};
  const pbr = record(source.pbrMetallicRoughness);
  const extensions = record(source.extensions);
  let leaveSlotEmpty = false;
  doc.shadingModel = material.unlit ? "unlit" : "pbr";
  doc.blendMode = source.alphaMode === "BLEND" ? "translucent" : source.alphaMode === "MASK" ? "masked" : "opaque";
  doc.alphaCutoff = number(source.alphaCutoff, 0.5);
  doc.twoSided = source.doubleSided === true;
  const add = (id: string, type: string, properties: Record<string, unknown> = {}) => {
    doc.nodes.push({ id, type, position: { x: -560 + (doc.nodes.length % 3) * 180, y: doc.nodes.length * 80 }, properties });
    return id;
  };
  const wire = (from: string, pin: string, target: string, input: string) => doc.edges.push({ id: `${from}-${pin}-${target}-${input}`, sourceNodeId: from, sourcePinId: pin, targetNodeId: target, targetPinId: input });
  const factor = (id: string, values: number[]) => add(id, values.length === 1 ? "const.float" : "const.vec3", { value: values });
  // One UV source per distinct UV set and transform, shared by the textures that sample with it.
  const uvSources = new Map<string, { node: string; pin: string }>();
  const uvSource = (reference: Record<string, unknown>) => {
    const { texCoord, offset, rotation, scale } = textureCoordinates(reference);
    const transformed = rotation !== 0 || offset.some((value) => value !== 0) || scale.some((value) => value !== 1);
    if (texCoord === 0 && !transformed) return null;
    const key = JSON.stringify([texCoord, offset, rotation, scale]);
    const existing = uvSources.get(key);
    if (existing) return existing;
    const id = `uv-${uvSources.size}`;
    let source = { node: add(id, "input.uv", texCoord === 1 ? { channel: 1 } : {}), pin: "uv" };
    if (transformed) {
      // Babylon's loader turns the texture by -rotation (wAng) around the UV origin; Transform UV turns UV by Rotation.
      const transform = add(`${id}-transform`, "texture.transformUv", {
        [materialPinDefaultPropertyKey("tiling")]: scale,
        [materialPinDefaultPropertyKey("rotation")]: [-rotation],
        [materialPinDefaultPropertyKey("offset")]: offset,
      });
      wire(source.node, source.pin, transform, "uv");
      source = { node: transform, pin: "out" };
    }
    uvSources.set(key, source);
    return source;
  };
  const sample = (id: string, info: unknown, colorSpace: string): string | null => {
    const ref = record(info);
    if (typeof ref.index !== "number") return null;
    const image = material.textureImages?.[ref.index] ?? null;
    const guid = image === null ? undefined : imageGuids[image];
    // A texture with no image has nothing to sample; its factor still applies.
    if (!guid) return null;
    if (textureCoordinates(ref).texCoord > 1) leaveSlotEmpty = true;
    const sampleId = add(id, "texture.sample", { textureGuid: guid, colorSpace, ...(material.nearestTextures?.[ref.index] ? { filter: "nearest" } : {}) });
    const uv = uvSource(ref);
    if (uv) wire(uv.node, uv.pin, sampleId, "uv");
    return sampleId;
  };
  const channel = (id: string, values: number[], texture: string | null, pin: string) => {
    const value = factor(`${id}-factor`, values);
    if (!texture) { wire(value, "out", "output", id); return; }
    const multiply = add(`${id}-multiply`, "math.multiply");
    wire(value, "out", multiply, "a");
    wire(texture, pin, multiply, "b");
    wire(multiply, "out", "output", id);
  };
  const base = Array.isArray(pbr.baseColorFactor) ? pbr.baseColorFactor : [];
  const albedo = sample("albedo", pbr.baseColorTexture, "color");
  channel("baseColor", [number(base[0], 1), number(base[1], 1), number(base[2], 1)], albedo, "rgb");
  channel("opacity", [number(base[3], 1)], albedo, "a");
  const metallicRoughness = sample("metallic-roughness", pbr.metallicRoughnessTexture, "data");
  channel("metallic", [number(pbr.metallicFactor, 1)], metallicRoughness, "b");
  channel("roughness", [number(pbr.roughnessFactor, 1)], metallicRoughness, "g");
  const emission = Array.isArray(source.emissiveFactor) ? source.emissiveFactor : [];
  const strength = number(record(extensions.KHR_materials_emissive_strength).emissiveStrength, 1);
  channel("emissive", [0, 1, 2].map((i) => number(emission[i], 0) * strength), sample("emission", source.emissiveTexture, "color"), "rgb");
  // glTF occlusion darkens only indirect light, which is what Environment Influence scales.
  const occlusion = sample("occlusion", source.occlusionTexture, "data");
  if (occlusion) {
    const strength = add("occlusion-strength", "math.mix", {
      [materialPinDefaultPropertyKey("a")]: [1],
      [materialPinDefaultPropertyKey("alpha")]: [number(record(source.occlusionTexture).strength, 1)],
    });
    wire(occlusion, "r", strength, "b");
    wire(strength, "out", "output", "environmentInfluence");
  }
  const normal = sample("normal", source.normalTexture, "data");
  if (normal) {
    const unpack = add("normal-map", "shading.normalMap", { "default:strength": [number(record(source.normalTexture).scale, 1)] });
    wire(normal, "rgb", unpack, "packed");
    wire(unpack, "normal", "output", "normal");
  }
  return { document: doc, dependencies: materialDependencies(doc).all, leaveSlotEmpty };
}
