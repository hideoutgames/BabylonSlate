import { createDefaultMaterialDocument, materialDependencies } from "@babylonslate/shader-graph";
import type { GlbBrowseMaterial } from "./glb-parse";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const number = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Extract the supported metallic/roughness subset; retain loader materials for the rest. */
export function importedGltfMaterial(name: string, material: GlbBrowseMaterial, imageGuids: readonly string[]) {
  const doc = createDefaultMaterialDocument(name);
  doc.nodes = doc.nodes.filter((node) => node.id === "output");
  doc.edges = [];
  const source = material.source ?? {};
  const pbr = record(source.pbrMetallicRoughness);
  const extensions = record(source.extensions);
  let preserveSource = !!source.occlusionTexture || Object.keys(extensions).some((key) => !["KHR_materials_unlit", "KHR_materials_emissive_strength"].includes(key));
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
  const sample = (id: string, info: unknown, colorSpace: string): string | null => {
    const ref = record(info);
    if (typeof ref.index !== "number") return null;
    const image = material.textureImages?.[ref.index] ?? null;
    const guid = image === null ? undefined : imageGuids[image];
    if (!guid) { preserveSource = true; return null; }
    if (number(ref.texCoord, 0) !== 0 || Object.keys(record(ref.extensions)).length) preserveSource = true;
    return add(id, "texture.sample", { textureGuid: guid, colorSpace });
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
  const normal = sample("normal", source.normalTexture, "data");
  if (normal) {
    const unpack = add("normal-map", "shading.normalMap", { "default:strength": [number(record(source.normalTexture).scale, 1)] });
    wire(normal, "rgb", unpack, "packed");
    wire(unpack, "normal", "output", "normal");
  }
  return { document: doc, dependencies: materialDependencies(doc).all, preserveSource };
}
