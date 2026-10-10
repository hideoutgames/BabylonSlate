import type { MaterialParameterValue } from "@babylonslate/core";
import {
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
  createDefaultMaterialInstanceDocument,
  type MaterialDocument,
  type MaterialDomain,
  type MaterialFunctionDocument,
  type MaterialFunctionPin,
  type MaterialGraphEdge,
  type MaterialGraphNode,
  type MaterialInstanceDocument,
} from "@babylonslate/shader-graph";
import { newAssetFileName, type CreatableAssetType } from "../content-browser-helpers";
import {
  actor,
  meshComp,
  requireRef,
  tf,
  type FeatureTestContext,
  type Vec3,
} from "./context";

/** Folder under `assets/FeatureTest/` for every Material, Material Function and Material Instance. */
export const FEATURE_TEST_MATERIALS_FOLDER = "Materials";

/** Asset names, so sibling FeatureTest modules can look the assets up by path. */
export const FEATURE_TEST_MATERIAL_NAMES = {
  tintFunction: "FT_MatTintFn",
  pulseFunction: "FT_MatPulseFn",
  surface: "FT_MatSurface",
  surfaceInstance: "FT_MatSurfaceInstance",
  surfaceInstanceMetal: "FT_MatSurfaceInstanceMetal",
  emissive: "FT_MatEmissive",
  translucent: "FT_MatGlass",
  masked: "FT_MatNoiseMasked",
  particle: "FT_MatParticleSoft",
  particleSmoke: "FT_MatParticleSmoke",
  particleAdditive: "FT_MatParticleGlow",
  postProcess: "FT_MatPostGrade",
  landscape: "FT_MatLandscape",
  overlayUnlit: "FT_MatOverlayUnlit",
  text: "FT_MatText",
} as const;

const NAMES = FEATURE_TEST_MATERIAL_NAMES;
const FOLDER = FEATURE_TEST_MATERIALS_FOLDER;
/** Graph editor grid for authored node positions. */
const COLUMN = 300;
const ROW = 170;

type Graph = { nodes: MaterialGraphNode[]; edges: MaterialGraphEdge[] };
type MaterialSettings = Partial<
  Pick<MaterialDocument, "shadingModel" | "blendMode" | "twoSided" | "alphaCutoff" | "boundsPadding" | "preview">
>;

/** Guid of a Material, Material Function or Material Instance this module created. */
export function featureTestMaterialAssetGuid(
  ctx: FeatureTestContext,
  type: Extract<CreatableAssetType, "Material" | "MaterialFunction" | "MaterialInstance">,
  name: string,
): string {
  const asset = ctx.registry.getByPath(ctx.storagePath(FOLDER, newAssetFileName(type, name)));
  return requireRef(asset?.header.guid, `${type} ${name}`);
}

/**
 * Material Functions, Materials (every domain: surface, landscape, post
 * process, particle, text) and Material Instances (a chained surface pair and a
 * particle-domain instance). Fills every `ctx.assets.materials` key.
 *
 * Parameter names (override keys for instances, post-process entries,
 * scene-owned overrides and `material.set*Parameter` script nodes):
 * - surface: `Albedo` (texture), `Tint` (color), `Brightness`, `Roughness`, `Metallic`, `Emissive Color` (color)
 * - emissive: `Base Color` (color), `Roughness`, `Scroll Speed`, `Emissive Strength`
 * - translucent: `Base Color` (color), `Opacity`, `Roughness`, `Rim Color` (color)
 * - particle / particleAdditive: `Intensity` (+ `Falloff` on the additive glow)
 * - postProcess: `Desaturation` (0..1), `Vignette` (0..1 edge darkening)
 * - overlayUnlit: `Tint` (color), `Opacity`, `Scroll Speed`
 * - landscape: none (see `landscapeMaterial` for the paint layer semantics)
 */
export async function buildFeatureTestMaterials(ctx: FeatureTestContext): Promise<void> {
  const colormap = requireRef(ctx.assets.textures.colormap, "the colormap Texture");
  const pixelArt = requireRef(ctx.assets.textures.colormapPixelArt, "the pixel art colormap Texture");

  const tintGuid = await saveFunction(ctx, NAMES.tintFunction, tintFunction(NAMES.tintFunction));
  const pulseGuid = await saveFunction(ctx, NAMES.pulseFunction, pulseFunction(NAMES.pulseFunction));

  const surface = await saveMaterial(ctx, NAMES.surface, surfaceMaterial(NAMES.surface, colormap, tintGuid, pulseGuid));
  const surfaceInstance = await saveInstance(ctx, NAMES.surfaceInstance, surface, "surface", {
    Tint: color(1, 0.4, 0.32),
    Brightness: float(1.15),
    Roughness: float(0.25),
    "Emissive Color": color(0.05, 0.25, 0.8),
  });
  // A chained instance: inherits the coral tint, then swaps the albedo texture and goes metallic.
  await saveInstance(ctx, NAMES.surfaceInstanceMetal, surfaceInstance, "surface", {
    Metallic: float(1),
    Roughness: float(0.3),
    Albedo: { kind: "texture", textureAssetGuid: pixelArt },
  });
  const emissive = await saveMaterial(ctx, NAMES.emissive, emissiveMaterial(NAMES.emissive));
  const translucent = await saveMaterial(ctx, NAMES.translucent, glassMaterial(NAMES.translucent));
  await saveMaterial(ctx, NAMES.masked, noiseMaskedMaterial(NAMES.masked));

  const particle = await saveMaterial(ctx, NAMES.particle, particleSoftMaterial(NAMES.particle));
  await saveInstance(ctx, NAMES.particleSmoke, particle, "particle", { Intensity: float(0.75) });
  const particleAdditive = await saveMaterial(ctx, NAMES.particleAdditive, particleGlowMaterial(NAMES.particleAdditive));
  const postProcess = await saveMaterial(ctx, NAMES.postProcess, postGradeMaterial(NAMES.postProcess));
  const landscape = await saveMaterial(ctx, NAMES.landscape, landscapeMaterial(NAMES.landscape));
  const overlayUnlit = await saveMaterial(ctx, NAMES.overlayUnlit, overlayUnlitMaterial(NAMES.overlayUnlit));
  await saveMaterial(ctx, NAMES.text, textMaterial(NAMES.text));

  Object.assign(ctx.assets.materials, {
    surface,
    surfaceInstance,
    emissive,
    translucent,
    particle,
    particleAdditive,
    postProcess,
    landscape,
    overlayUnlit,
  });
}

/**
 * `Meshes And Materials` zone: floor, one of every primitive kind in the
 * surface Material, a row of Material / Instance spheres and shapes (instance,
 * chained instance, scene-owned private overrides, emissive, translucent,
 * masked) and Holiday Pack Models keeping their slot Materials beside one with
 * a whole-mesh Material override.
 */
export async function placeFeatureTestMaterials(ctx: FeatureTestContext): Promise<void> {
  const zone = ctx.zone("meshes");
  zone.floor();
  const materials = ctx.assets.materials;
  const surface = requireRef(materials.surface, "the surface Material");
  const surfaceInstance = requireRef(materials.surfaceInstance, "the surface Material Instance");
  const emissive = requireRef(materials.emissive, "the emissive Material");
  const translucent = requireRef(materials.translucent, "the translucent Material");
  const metal = featureTestMaterialAssetGuid(ctx, "MaterialInstance", NAMES.surfaceInstanceMetal);
  const masked = featureTestMaterialAssetGuid(ctx, "Material", NAMES.masked);

  const place = (
    id: string,
    name: string,
    kind: "box" | "sphere" | "cylinder" | "plane" | "ground",
    position: Vec3,
    materialGuid: string | null,
    options: { scale?: Vec3; rotationDeg?: Vec3 } = {},
  ) => {
    const mesh = meshComp(`ft-mat-${id}-mesh`, kind, { materialGuid });
    return ctx.addActor(actor(`ft-mat-${id}`, name, tf(position, options), [mesh]), { zone: "meshes" });
  };

  // Front row: every primitive kind in the textured surface Material.
  place("box", "Primitive Box", "box", zone.at(-8, 0.75, -7), surface);
  place("sphere", "Primitive Sphere", "sphere", zone.at(-4, 0.75, -7), surface);
  place("cylinder", "Primitive Cylinder", "cylinder", zone.at(0, 0.75, -7), surface);
  place("plane", "Primitive Plane", "plane", zone.at(4, 0.75, -7), surface);
  place("ground", "Primitive Ground", "ground", zone.at(8, 0.02, -7), surface, { scale: [0.3, 1, 0.3] });

  // Middle row: one shape per Material or Material Instance.
  place("surface", "Surface Material", "sphere", zone.at(-9.6, 0.75, -1), surface);
  place("instance", "Material Instance", "sphere", zone.at(-6.4, 0.75, -1), surfaceInstance);
  place("instance-metal", "Chained Material Instance", "sphere", zone.at(-3.2, 0.75, -1), metal);
  const privateOverrides = place("private", "Private Overrides", "sphere", zone.at(0, 0.75, -1), surface);
  privateOverrides.components[0]!.materialInstance = {
    materialGuid: surface,
    parameters: {
      Tint: color(0.35, 1, 0.4),
      Roughness: float(0.9),
      "Emissive Color": color(0, 0, 0),
    },
  };
  place("emissive", "Emissive Material", "cylinder", zone.at(3.2, 0.75, -1), emissive);
  place("translucent", "Translucent Material", "sphere", zone.at(6.4, 0.9, -1), translucent);
  place("masked", "Masked Material", "plane", zone.at(9.6, 1, -1), masked, { scale: [1.3, 1.3, 1.3] });

  // Back row: Holiday Pack Models keep their imported slot Materials; the last overrides the whole mesh.
  const models = ctx.assets.models;
  const model = (id: string, name: string, guid: string, position: Vec3, scale: number, materialGuid: string | null) => {
    const mesh = meshComp(`ft-mat-${id}-mesh`, "box", { assetGuid: guid, materialGuid });
    ctx.addActor(
      actor(`ft-mat-${id}`, name, tf(position, { rotationDeg: [0, 160, 0], scale: [scale, scale, scale] }), [mesh]),
      { zone: "meshes" },
    );
  };
  model("train", "Train Locomotive", requireRef(models["train-locomotive"], "the train-locomotive Model"), zone.at(-8, 0, 6), 3, null);
  model("snowman", "Snowman", requireRef(models.snowman, "the snowman Model"), zone.at(-3, 0, 6), 1.5, null);
  model("lantern", "Lantern", requireRef(models.lantern, "the lantern Model"), zone.at(2, 0, 6), 1, null);
  model(
    "snowman-override",
    "Snowman Material Override",
    requireRef(models.snowman, "the snowman Model"),
    zone.at(7, 0, 6),
    1.5,
    surfaceInstance,
  );
}

// ---------------------------------------------------------------------------
// Asset writers

async function saveMaterial(ctx: FeatureTestContext, name: string, doc: MaterialDocument): Promise<string> {
  return (await ctx.createAsset("Material", FOLDER, name, { payload: payload(doc) })).guid;
}

async function saveFunction(ctx: FeatureTestContext, name: string, doc: MaterialFunctionDocument): Promise<string> {
  return (await ctx.createAsset("MaterialFunction", FOLDER, name, { payload: payload(doc) })).guid;
}

/** Instances carry their root's domain so domain-filtered pickers (particle, post process) list them. */
async function saveInstance(
  ctx: FeatureTestContext,
  name: string,
  parentGuid: string,
  domain: MaterialDomain,
  overrides: Record<string, MaterialParameterValue>,
): Promise<string> {
  const doc: MaterialInstanceDocument = {
    ...createDefaultMaterialInstanceDocument(name, parentGuid),
    domain,
    overrides,
    preview: { mesh: domain === "particle" ? "plane" : "sphere", customMeshGuid: null },
  };
  return (await ctx.createAsset("MaterialInstance", FOLDER, name, { payload: payload(doc) })).guid;
}

function payload(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function float(value: number): MaterialParameterValue {
  return { kind: "float", value };
}

function color(r: number, g: number, b: number, a = 1): MaterialParameterValue {
  return { kind: "color", value: [r, g, b, a] };
}

// ---------------------------------------------------------------------------
// Graph builders

function node(
  graph: Graph,
  id: string,
  type: string,
  column: number,
  row: number,
  properties: Record<string, unknown> = {},
): void {
  graph.nodes.push({ id, type, position: { x: column * COLUMN, y: row * ROW }, properties });
}

function wire(graph: Graph, from: string, fromPin: string, to: string, toPin: string): void {
  graph.edges.push({
    id: `${from}:${fromPin}:${to}:${toPin}`,
    sourceNodeId: from,
    sourcePinId: fromPin,
    targetNodeId: to,
    targetPinId: toPin,
  });
}

/**
 * Splat a wired float into a vector. A wired float feeding a wider pin is
 * padded with 1s, not splatted, so scaling a color needs this Combine.
 */
function splat(
  graph: Graph,
  id: string,
  from: string,
  fromPin: string,
  column: number,
  row: number,
  width: 3 | 4,
): string {
  node(graph, id, "vector.combine", column, row);
  for (const channel of width === 4 ? ["x", "y", "z", "w"] : ["x", "y", "z"]) wire(graph, from, fromPin, id, channel);
  return width === 4 ? "xyzw" : "xyz";
}

function blankMaterial(name: string, domain: MaterialDomain, settings: MaterialSettings = {}): MaterialDocument {
  return { ...createDefaultMaterialDocument(name, domain), ...settings, nodes: [], edges: [] };
}

function blankFunction(
  name: string,
  description: string,
  inputs: MaterialFunctionPin[],
  outputs: MaterialFunctionPin[],
  outputColumn: number,
): MaterialFunctionDocument {
  const fn: MaterialFunctionDocument = {
    ...createDefaultMaterialFunctionDocument(name),
    description,
    inputs,
    outputs,
    nodes: [],
    edges: [],
  };
  node(fn, "inputs", "function.input", 0, 0);
  node(fn, "outputs", "function.output", outputColumn, 0);
  return fn;
}

// ---------------------------------------------------------------------------
// Material Functions (domain-neutral bodies, no parameter nodes)

/** Color × Tint × Brightness: tints the sampled albedo of the surface Material. */
function tintFunction(name: string): MaterialFunctionDocument {
  const fn = blankFunction(
    name,
    "Multiplies a color by a tint and a scalar brightness.",
    [
      { id: "in_color", name: "Color", type: "vec3", defaultValue: [1, 1, 1] },
      { id: "in_tint", name: "Tint", type: "vec3", defaultValue: [1, 1, 1] },
      { id: "in_brightness", name: "Brightness", type: "float", defaultValue: [1] },
    ],
    [{ id: "out_color", name: "Result", type: "vec3" }],
    3,
  );
  node(fn, "tinted", "math.multiply", 1, 0);
  const gainPin = splat(fn, "gain", "inputs", "in_brightness", 1, 1, 3);
  node(fn, "scaled", "math.multiply", 2, 0);
  wire(fn, "inputs", "in_color", "tinted", "a");
  wire(fn, "inputs", "in_tint", "tinted", "b");
  wire(fn, "tinted", "out", "scaled", "a");
  wire(fn, "gain", gainPin, "scaled", "b");
  wire(fn, "scaled", "out", "outputs", "out_color");
  return fn;
}

/** Color × a 0.1..1 sine pulse over time at Speed (rad/s). */
function pulseFunction(name: string): MaterialFunctionDocument {
  const fn = blankFunction(
    name,
    "Scales a color by a time-driven 0.1..1 sine pulse.",
    [
      { id: "in_color", name: "Color", type: "vec3", defaultValue: [1, 0.45, 0.1] },
      { id: "in_speed", name: "Speed", type: "float", defaultValue: [2] },
    ],
    [{ id: "out_value", name: "Result", type: "vec3" }],
    6,
  );
  node(fn, "time", "input.time", 0, 1, { timeMode: "seconds" });
  node(fn, "rate", "math.multiply", 1, 1);
  node(fn, "wave", "math.sin", 2, 1);
  node(fn, "range", "math.remap", 3, 1, {
    "default:fromMin": [-1],
    "default:fromMax": [1],
    "default:toMin": [0.1],
    "default:toMax": [1],
  });
  const pulsePin = splat(fn, "pulse", "range", "out", 4, 1, 3);
  node(fn, "tint", "math.multiply", 5, 0);
  wire(fn, "time", "time", "rate", "a");
  wire(fn, "inputs", "in_speed", "rate", "b");
  wire(fn, "rate", "out", "wave", "value");
  wire(fn, "wave", "out", "range", "value");
  wire(fn, "inputs", "in_color", "tint", "a");
  wire(fn, "pulse", pulsePin, "tint", "b");
  wire(fn, "tint", "out", "outputs", "out_value");
  return fn;
}

// ---------------------------------------------------------------------------
// Surface Materials

/** Lit PBR: tiled colormap → Tint function → Base Color, parameters, pulsing emissive function. */
function surfaceMaterial(name: string, albedoGuid: string, tintGuid: string, pulseGuid: string): MaterialDocument {
  const doc = blankMaterial(name, "surface", { preview: { mesh: "sphere", customMeshGuid: null } });
  node(doc, "albedo", "param.texture", 0, 0, { name: "Albedo", textureGuid: albedoGuid });
  node(doc, "uv", "input.uv", 0, 1);
  node(doc, "tintColor", "param.color", 0, 2, { name: "Tint", value: [0.92, 0.96, 1, 1] });
  node(doc, "brightness", "param.float", 0, 3, { name: "Brightness", value: [1] });
  node(doc, "roughness", "param.float", 0, 4, { name: "Roughness", value: [0.6] });
  node(doc, "metallic", "param.float", 0, 5, { name: "Metallic", value: [0] });
  node(doc, "glow", "param.color", 0, 6, { name: "Emissive Color", value: [0.3, 0.1, 0.02, 1] });
  node(doc, "tiling", "texture.transformUv", 1, 1, { "default:tiling": [2, 2] });
  node(doc, "sample", "texture.sample", 2, 0);
  node(doc, "tint", "function.call", 3, 1, { functionGuid: tintGuid });
  node(doc, "pulse", "function.call", 3, 6, { functionGuid: pulseGuid, "default:in_speed": [1.5] });
  node(doc, "output", "output.surface", 4, 2);
  wire(doc, "albedo", "out", "sample", "texture");
  wire(doc, "uv", "uv", "tiling", "uv");
  wire(doc, "tiling", "out", "sample", "uv");
  wire(doc, "sample", "rgb", "tint", "in_color");
  wire(doc, "tintColor", "rgb", "tint", "in_tint");
  wire(doc, "brightness", "out", "tint", "in_brightness");
  wire(doc, "tint", "out_color", "output", "baseColor");
  wire(doc, "roughness", "out", "output", "roughness");
  wire(doc, "metallic", "out", "output", "metallic");
  wire(doc, "glow", "rgb", "pulse", "in_color");
  wire(doc, "pulse", "out_value", "output", "emissive");
  return doc;
}

/** Dark lit base with color bands scrolling up the mesh (UV V + time) as emissive light. */
function emissiveMaterial(name: string): MaterialDocument {
  const doc = blankMaterial(name, "surface");
  node(doc, "time", "input.time", 0, 0, { timeMode: "seconds" });
  node(doc, "speed", "param.float", 0, 1, { name: "Scroll Speed", value: [0.35] });
  node(doc, "uv", "input.uv", 0, 2);
  node(doc, "base", "param.color", 0, 4, { name: "Base Color", value: [0.05, 0.05, 0.07, 1] });
  node(doc, "roughness", "param.float", 0, 5, { name: "Roughness", value: [0.4] });
  node(doc, "strength", "param.float", 0, 6, { name: "Emissive Strength", value: [2.5] });
  node(doc, "scroll", "math.multiply", 1, 0);
  node(doc, "split", "vector.split", 1, 2);
  node(doc, "phase", "math.add", 2, 1);
  node(doc, "band", "math.fract", 3, 1);
  node(doc, "ramp", "color.gradient", 4, 1, {
    stops: [
      { position: 0, color: [1, 0.1, 0.6] },
      { position: 0.33, color: [0.1, 0.8, 1] },
      { position: 0.66, color: [1, 0.85, 0.1] },
      { position: 1, color: [1, 0.1, 0.6] },
    ],
  });
  const gainPin = splat(doc, "gain", "strength", "out", 4, 6, 3);
  node(doc, "glow", "math.multiply", 5, 3);
  node(doc, "output", "output.surface", 6, 3);
  wire(doc, "time", "time", "scroll", "a");
  wire(doc, "speed", "out", "scroll", "b");
  wire(doc, "uv", "uv", "split", "value");
  wire(doc, "split", "y", "phase", "a");
  wire(doc, "scroll", "out", "phase", "b");
  wire(doc, "phase", "out", "band", "value");
  wire(doc, "band", "out", "ramp", "value");
  wire(doc, "ramp", "out", "glow", "a");
  wire(doc, "gain", gainPin, "glow", "b");
  wire(doc, "base", "rgb", "output", "baseColor");
  wire(doc, "roughness", "out", "output", "roughness");
  wire(doc, "glow", "out", "output", "emissive");
  return doc;
}

/**
 * Alpha-blended, two-sided glass: vertex World Position Offset ripples along
 * world X (bounds padded so it is not culled) and a fresnel rim glows.
 */
function glassMaterial(name: string): MaterialDocument {
  const doc = blankMaterial(name, "surface", {
    blendMode: "translucent",
    twoSided: true,
    boundsPadding: 0.25,
    preview: { mesh: "sphere", customMeshGuid: null },
  });
  node(doc, "worldPosition", "input.worldPosition", 0, 0);
  node(doc, "time", "input.time", 0, 1, { timeMode: "seconds" });
  node(doc, "base", "param.color", 0, 3, { name: "Base Color", value: [0.35, 0.65, 0.95, 1] });
  node(doc, "opacity", "param.float", 0, 4, { name: "Opacity", value: [0.45] });
  node(doc, "roughness", "param.float", 0, 5, { name: "Roughness", value: [0.08] });
  node(doc, "rimColor", "param.color", 0, 6, { name: "Rim Color", value: [0.2, 0.8, 1, 1] });
  node(doc, "rim", "shading.fresnel", 0, 7, { "default:power": [3] });
  node(doc, "split", "vector.split", 1, 0);
  node(doc, "rate", "math.multiply", 1, 1, { "default:b": [2] });
  const rimPin = splat(doc, "rimGain", "rim", "out", 1, 7, 3);
  node(doc, "phase", "math.add", 2, 0);
  node(doc, "wave", "math.sin", 3, 0);
  node(doc, "amplitude", "math.multiply", 4, 0, { "default:b": [0.12] });
  node(doc, "offset", "vector.combine", 5, 0);
  node(doc, "rimTint", "math.multiply", 5, 6);
  node(doc, "output", "output.surface", 6, 3);
  wire(doc, "worldPosition", "position", "split", "value");
  wire(doc, "time", "time", "rate", "a");
  wire(doc, "split", "x", "phase", "a");
  wire(doc, "rate", "out", "phase", "b");
  wire(doc, "phase", "out", "wave", "value");
  wire(doc, "wave", "out", "amplitude", "a");
  wire(doc, "amplitude", "out", "offset", "y");
  wire(doc, "rimGain", rimPin, "rimTint", "a");
  wire(doc, "rimColor", "rgb", "rimTint", "b");
  wire(doc, "offset", "xyz", "output", "worldPositionOffset");
  wire(doc, "base", "rgb", "output", "baseColor");
  wire(doc, "opacity", "out", "output", "opacity");
  wire(doc, "roughness", "out", "output", "roughness");
  wire(doc, "rimTint", "out", "output", "emissive");
  return doc;
}

/** Unlit, masked (alpha clip) Voronoi cells that drift over time; two-sided. */
function noiseMaskedMaterial(name: string): MaterialDocument {
  const doc = blankMaterial(name, "surface", {
    shadingModel: "unlit",
    blendMode: "masked",
    alphaCutoff: 0.35,
    twoSided: true,
    preview: { mesh: "plane", customMeshGuid: null },
  });
  node(doc, "time", "input.time", 0, 0, { timeMode: "seconds" });
  node(doc, "density", "param.float", 0, 1, { name: "Cell Density", value: [6] });
  node(doc, "cells", "noise.voronoi", 1, 0);
  node(doc, "ramp", "color.gradient", 2, 0, {
    stops: [
      { position: 0, color: [0.05, 0.1, 0.3] },
      { position: 0.5, color: [0.2, 0.9, 0.6] },
      { position: 1, color: [1, 1, 0.8] },
    ],
  });
  node(doc, "output", "output.surface", 3, 0);
  wire(doc, "time", "time", "cells", "offset");
  wire(doc, "density", "out", "cells", "density");
  wire(doc, "cells", "cells", "ramp", "value");
  wire(doc, "ramp", "out", "output", "baseColor");
  wire(doc, "cells", "out", "output", "alphaClip");
  return doc;
}

/** Unlit, alpha-blended scrolling color bands for overlay 2D Material widgets, panels and sprites. */
function overlayUnlitMaterial(name: string): MaterialDocument {
  const doc = blankMaterial(name, "surface", {
    shadingModel: "unlit",
    blendMode: "translucent",
    twoSided: true,
    preview: { mesh: "plane", customMeshGuid: null },
  });
  node(doc, "uv", "input.uv", 0, 0);
  node(doc, "time", "input.time", 0, 1, { timeMode: "seconds" });
  node(doc, "speed", "param.float", 0, 2, { name: "Scroll Speed", value: [0.2] });
  node(doc, "tintColor", "param.color", 0, 3, { name: "Tint", value: [1, 1, 1, 1] });
  node(doc, "opacity", "param.float", 0, 4, { name: "Opacity", value: [0.9] });
  node(doc, "split", "vector.split", 1, 0);
  node(doc, "scroll", "math.multiply", 1, 1);
  node(doc, "phase", "math.add", 2, 0);
  node(doc, "band", "math.fract", 3, 0);
  node(doc, "ramp", "color.gradient", 4, 0, {
    stops: [
      { position: 0, color: [0.1, 0.75, 0.8] },
      { position: 0.5, color: [0.55, 0.3, 0.95] },
      { position: 1, color: [0.1, 0.75, 0.8] },
    ],
  });
  node(doc, "tinted", "math.multiply", 5, 1);
  node(doc, "output", "output.surface", 6, 1);
  wire(doc, "uv", "uv", "split", "value");
  wire(doc, "time", "time", "scroll", "a");
  wire(doc, "speed", "out", "scroll", "b");
  wire(doc, "split", "x", "phase", "a");
  wire(doc, "scroll", "out", "phase", "b");
  wire(doc, "phase", "out", "band", "value");
  wire(doc, "band", "out", "ramp", "value");
  wire(doc, "ramp", "out", "tinted", "a");
  wire(doc, "tintColor", "rgb", "tinted", "b");
  wire(doc, "tinted", "out", "output", "baseColor");
  wire(doc, "opacity", "out", "output", "opacity");
  return doc;
}

// ---------------------------------------------------------------------------
// Landscape, post process, particle and text domains

/**
 * Landscape domain. Paint layers are the LandscapeComponent `weights`
 * (4 floats per vertex, index `vertex * 4 + layer - 1`, renormalized; missing
 * weights default to layer 1 = 1):
 * - Layer 1: grass, the base color (default weight).
 * - Layer 2: snow (paint it on the high rows or peaks).
 * - Layer 3: sand (shores).
 * - Layer 4: exposed dark rock.
 * Rock also blends in automatically on steep slopes (Landscape Slope), with no
 * paint. Roughness varies with Perlin noise over Landscape Coordinates.
 */
function landscapeMaterial(name: string): MaterialDocument {
  const doc = blankMaterial(name, "landscape", { preview: { mesh: "plane", customMeshGuid: null } });
  node(doc, "grass", "const.color", 0, 0, { value: [0.22, 0.42, 0.14] });
  node(doc, "rock", "const.color", 0, 1, { value: [0.42, 0.4, 0.38] });
  node(doc, "scree", "const.color", 0, 2, { value: [0.26, 0.24, 0.23] });
  node(doc, "sand", "const.color", 0, 3, { value: [0.76, 0.68, 0.48] });
  node(doc, "snow", "const.color", 0, 4, { value: [0.92, 0.94, 0.98] });
  node(doc, "slope", "landscape.slope", 0, 5);
  node(doc, "layers", "landscape.layers", 0, 6);
  node(doc, "coords", "landscape.uv", 0, 7, { "default:scale": [0.15] });
  node(doc, "steep", "math.smoothstep", 1, 5, { "default:edgeA": [0.2], "default:edgeB": [0.5] });
  node(doc, "detail", "noise.perlin", 1, 7);
  node(doc, "slopeRock", "landscape.blend", 2, 0);
  node(doc, "layerRock", "landscape.blend", 3, 1);
  node(doc, "layerSand", "landscape.blend", 4, 2);
  node(doc, "layerSnow", "landscape.blend", 5, 3);
  node(doc, "roughness", "math.remap", 2, 7, {
    "default:fromMin": [-1],
    "default:fromMax": [1],
    "default:toMin": [0.7],
    "default:toMax": [0.95],
  });
  node(doc, "output", "output.surface", 6, 4);
  wire(doc, "slope", "slope", "steep", "value");
  wire(doc, "grass", "out", "slopeRock", "base");
  wire(doc, "rock", "out", "slopeRock", "layer");
  wire(doc, "steep", "out", "slopeRock", "weight");
  wire(doc, "slopeRock", "color", "layerRock", "base");
  wire(doc, "scree", "out", "layerRock", "layer");
  wire(doc, "layers", "layer4", "layerRock", "weight");
  wire(doc, "layerRock", "color", "layerSand", "base");
  wire(doc, "sand", "out", "layerSand", "layer");
  wire(doc, "layers", "layer3", "layerSand", "weight");
  wire(doc, "layerSand", "color", "layerSnow", "base");
  wire(doc, "snow", "out", "layerSnow", "layer");
  wire(doc, "layers", "layer2", "layerSnow", "weight");
  wire(doc, "layerSnow", "color", "output", "baseColor");
  wire(doc, "coords", "uv", "detail", "coordinates");
  wire(doc, "detail", "out", "roughness", "value");
  wire(doc, "roughness", "out", "output", "roughness");
  return doc;
}

/** Subtle full-screen grade: partial desaturation and a soft vignette. */
function postGradeMaterial(name: string): MaterialDocument {
  const doc = blankMaterial(name, "postProcess");
  node(doc, "screenUv", "input.screenUv", 0, 0);
  node(doc, "amount", "param.float", 0, 2, { name: "Desaturation", value: [0.15] });
  node(doc, "vignette", "param.float", 0, 3, { name: "Vignette", value: [0.25] });
  node(doc, "sceneColor", "input.sceneColor", 1, 0);
  node(doc, "distance", "vector.distance", 1, 2, { "default:b": [0.5, 0.5] });
  node(doc, "edge", "math.subtract", 1, 3, { "default:a": [1] });
  node(doc, "desaturate", "color.desaturate", 2, 0);
  node(doc, "falloff", "math.remap", 2, 2, {
    "default:fromMin": [0.3],
    "default:fromMax": [0.85],
    "default:toMin": [1],
  });
  node(doc, "clamp", "math.saturate", 3, 2);
  const vignettePin = splat(doc, "darken", "clamp", "out", 4, 2, 3);
  node(doc, "graded", "math.multiply", 5, 0);
  node(doc, "output", "output.postProcess", 6, 0);
  wire(doc, "screenUv", "uv", "sceneColor", "uv");
  wire(doc, "sceneColor", "color", "desaturate", "color");
  wire(doc, "amount", "out", "desaturate", "level");
  wire(doc, "screenUv", "uv", "distance", "a");
  wire(doc, "vignette", "out", "edge", "b");
  wire(doc, "distance", "out", "falloff", "value");
  wire(doc, "edge", "out", "falloff", "toMax");
  wire(doc, "falloff", "out", "clamp", "value");
  wire(doc, "desaturate", "out", "graded", "a");
  wire(doc, "darken", vignettePin, "graded", "b");
  wire(doc, "graded", "out", "output", "color");
  return doc;
}

/**
 * Particle domain soft disc for alpha-blended (Normal) emitters: Particle
 * Color × a radial falloff × Intensity, alpha included.
 */
function particleSoftMaterial(name: string): MaterialDocument {
  // Emitters own blending; Blend Mode here only documents the intent.
  const doc = blankMaterial(name, "particle", {
    blendMode: "translucent",
    preview: { mesh: "plane", customMeshGuid: null },
  });
  node(doc, "uv", "input.uv", 0, 0);
  node(doc, "particleColor", "input.particleColor", 0, 2);
  node(doc, "intensity", "param.float", 0, 3, { name: "Intensity", value: [1.2] });
  node(doc, "distance", "vector.distance", 1, 0, { "default:b": [0.5, 0.5] });
  node(doc, "falloff", "math.remap", 2, 0, {
    "default:fromMin": [0],
    "default:fromMax": [0.5],
    "default:toMin": [1],
    "default:toMax": [0],
  });
  node(doc, "clamp", "math.saturate", 3, 0);
  node(doc, "boost", "math.multiply", 4, 1);
  const discPin = splat(doc, "disc", "boost", "out", 5, 1, 4);
  node(doc, "lit", "math.multiply", 6, 2);
  node(doc, "output", "output.particle", 7, 2);
  wire(doc, "uv", "uv", "distance", "a");
  wire(doc, "distance", "out", "falloff", "value");
  wire(doc, "falloff", "out", "clamp", "value");
  wire(doc, "clamp", "out", "boost", "a");
  wire(doc, "intensity", "out", "boost", "b");
  wire(doc, "particleColor", "color", "lit", "a");
  wire(doc, "disc", discPin, "lit", "b");
  wire(doc, "lit", "out", "output", "color");
  return doc;
}

/** Particle domain hot glow for Additive emitters: sharpened falloff (Falloff power) × Intensity. */
function particleGlowMaterial(name: string): MaterialDocument {
  const doc = blankMaterial(name, "particle", {
    blendMode: "additive",
    preview: { mesh: "plane", customMeshGuid: null },
  });
  node(doc, "uv", "input.uv", 0, 0);
  node(doc, "power", "param.float", 0, 1, { name: "Falloff", value: [2.5] });
  node(doc, "particleColor", "input.particleColor", 0, 2);
  node(doc, "intensity", "param.float", 0, 3, { name: "Intensity", value: [2] });
  node(doc, "distance", "vector.distance", 1, 0, { "default:b": [0.5, 0.5] });
  node(doc, "falloff", "math.remap", 2, 0, {
    "default:fromMin": [0],
    "default:fromMax": [0.5],
    "default:toMin": [1],
    "default:toMax": [0],
  });
  node(doc, "clamp", "math.saturate", 3, 0);
  node(doc, "sharpen", "math.pow", 4, 0);
  node(doc, "boost", "math.multiply", 5, 1);
  const glowPin = splat(doc, "glow", "boost", "out", 6, 1, 4);
  node(doc, "lit", "math.multiply", 7, 2);
  node(doc, "output", "output.particle", 8, 2);
  wire(doc, "uv", "uv", "distance", "a");
  wire(doc, "distance", "out", "falloff", "value");
  wire(doc, "falloff", "out", "clamp", "value");
  wire(doc, "clamp", "out", "sharpen", "base");
  wire(doc, "power", "out", "sharpen", "exponent");
  wire(doc, "sharpen", "out", "boost", "a");
  wire(doc, "intensity", "out", "boost", "b");
  wire(doc, "particleColor", "color", "lit", "a");
  wire(doc, "glow", glowPin, "lit", "b");
  wire(doc, "lit", "out", "output", "color");
  return doc;
}

/** Text domain: a gold shimmer sweeping across the text box (for 2D Text and Rich Text). */
function textMaterial(name: string): MaterialDocument {
  const doc = blankMaterial(name, "text");
  node(doc, "uv", "input.uv", 0, 0);
  node(doc, "time", "input.time", 0, 1, { timeMode: "seconds" });
  node(doc, "split", "vector.split", 1, 0);
  node(doc, "scroll", "math.multiply", 1, 1, { "default:b": [0.3] });
  node(doc, "phase", "math.add", 2, 0);
  node(doc, "band", "math.fract", 3, 0);
  node(doc, "ramp", "color.gradient", 4, 0, {
    stops: [
      { position: 0, color: [1, 0.78, 0.3] },
      { position: 0.5, color: [1, 1, 0.92] },
      { position: 1, color: [1, 0.78, 0.3] },
    ],
  });
  node(doc, "output", "output.text", 5, 0);
  wire(doc, "uv", "uv", "split", "value");
  wire(doc, "time", "time", "scroll", "a");
  wire(doc, "split", "x", "phase", "a");
  wire(doc, "scroll", "out", "phase", "b");
  wire(doc, "phase", "out", "band", "value");
  wire(doc, "band", "out", "ramp", "value");
  wire(doc, "ramp", "out", "output", "color");
  return doc;
}
