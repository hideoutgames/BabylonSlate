import { normalizeGraphPinEdges } from "@haptic/core";
import type { MaterialDomain } from "./catalog";
import {
  materialNodeDefinition,
  parseMaterialDomain,
  terminalNodeTypeFor,
} from "./catalog";
import type { MaterialValueType } from "./types";

export type MaterialBlendMode =
  | "opaque"
  | "masked"
  | "translucent"
  | "additive"
  | "multiply";

/**
 * The Blend Modes a domain offers. Text and User Interface always blend (Translucent, Additive or Multiply); Particle and
 * Post Process have none (emitters own blending, a pass replaces the image, and a Post Process Material always stores
 * Opaque).
 */
export function materialBlendModesFor(domain: MaterialDomain): readonly MaterialBlendMode[] {
  if (domain === "text" || domain === "ui") return ["translucent", "additive", "multiply"];
  if (domain === "particle" || domain === "postProcess") return [];
  return ["opaque", "masked", "translucent", "additive", "multiply"];
}

export type MaterialShadingModel = "pbr" | "unlit";

export type MaterialPreviewMesh =
  | "cube"
  | "sphere"
  | "cylinder"
  | "cone"
  | "plane"
  | "custom";

export const MATERIAL_PREVIEW_MESHES: readonly MaterialPreviewMesh[] = [
  "cube",
  "sphere",
  "cylinder",
  "cone",
  "plane",
  "custom",
];

export interface MaterialGraphNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  properties: Record<string, unknown>;
}

export interface MaterialGraphEdge {
  id: string;
  sourceNodeId: string;
  sourcePinId: string;
  targetNodeId: string;
  targetPinId: string;
}

export interface MaterialPreviewSettings {
  mesh: MaterialPreviewMesh;
  customMeshGuid: string | null;
}

export interface MaterialDocument {
  name: string;
  domain: MaterialDomain;
  shadingModel: MaterialShadingModel;
  blendMode: MaterialBlendMode;
  twoSided: boolean;
  defaultNormals: "model" | "flat";
  alphaCutoff: number;
  boundsPadding?: number;
  preview: MaterialPreviewSettings;
  nodes: MaterialGraphNode[];
  edges: MaterialGraphEdge[];
  /**
   * Root Material guid when this document is a materialized Material Instance.
   * Runtime-only: never persisted, so saved Materials never carry it.
   */
  instanceOf?: string;
}

export interface MaterialFunctionPin {
  /** Stable id: renaming the display name must not break callers. */
  id: string;
  name: string;
  type: MaterialValueType;
  defaultValue?: number[];
}

export interface MaterialFunctionDocument {
  name: string;
  description: string;
  inputs: MaterialFunctionPin[];
  outputs: MaterialFunctionPin[];
  nodes: MaterialGraphNode[];
  edges: MaterialGraphEdge[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asPosition(value: unknown): { x: number; y: number } {
  const record = asRecord(value);
  return { x: asNumber(record.x, 0), y: asNumber(record.y, 0) };
}

function asValueType(value: unknown): MaterialValueType {
  return value === "vec2" ||
    value === "vec3" ||
    value === "vec4" ||
    value === "texture"
    ? value
    : "float";
}

function normalizeNodeProperties(
  type: string,
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const value = Array.isArray(properties.value) ? properties.value : [];
  if (type === "param.color") {
    return { ...properties, value: [asNumber(value[0], 1), asNumber(value[1], 1), asNumber(value[2], 1), asNumber(value[3], 1)] };
  }
  // Vector parameters keep exactly their width, so the plan hash and the uniform agree.
  if (type === "param.vec2") return { ...properties, value: [asNumber(value[0], 0), asNumber(value[1], 0)] };
  if (type === "param.vec3") {
    return { ...properties, value: [asNumber(value[0], 0), asNumber(value[1], 0), asNumber(value[2], 0)] };
  }
  if (type === "param.vec4") {
    return { ...properties, value: [asNumber(value[0], 0), asNumber(value[1], 0), asNumber(value[2], 0), asNumber(value[3], 0)] };
  }
  return properties;
}

function normalizeNodes(value: unknown): MaterialGraphNode[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    const record = asRecord(entry);
    const type = asString(record.type, "");
    if (!type) return [];
    return [
      {
        id: asString(record.id, `node-${index}`),
        type,
        position: asPosition(record.position),
        properties: normalizeNodeProperties(type, asRecord(record.properties)),
      },
    ];
  });
}

export function normalizeMaterialPreviewSettings(value: unknown): MaterialPreviewSettings {
  const record = asRecord(value);
  const selectedMesh = MATERIAL_PREVIEW_MESHES.includes(
    record.mesh as MaterialPreviewMesh,
  )
    ? (record.mesh as MaterialPreviewMesh)
    : "cube";
  const customMeshGuid =
    typeof record.customMeshGuid === "string" && record.customMeshGuid
      ? record.customMeshGuid
      : null;
  const mesh =
    selectedMesh === "custom" && !customMeshGuid ? "cube" : selectedMesh;
  return { mesh, customMeshGuid: mesh === "custom" ? customMeshGuid : null };
}

/** Every material needs its terminal so the graph can never be output-less. */
function withTerminal(
  nodes: MaterialGraphNode[],
  domain: MaterialDomain,
): MaterialGraphNode[] {
  const terminalType = terminalNodeTypeFor(domain);
  if (nodes.some((node) => node.type === terminalType)) return nodes;
  return [
    ...nodes,
    {
      id: "output",
      type: terminalType,
      position: { x: 360, y: 0 },
      properties: {},
    },
  ];
}

function defaultSurfaceGraph(): {
  nodes: MaterialGraphNode[];
  edges: MaterialGraphEdge[];
} {
  return {
    nodes: [
      {
        id: "baseColor",
        type: "const.color",
        position: { x: 0, y: 0 },
        properties: { value: [0.8, 0.8, 0.8] },
      },
      {
        id: "output",
        type: "output.surface",
        position: { x: 400, y: 0 },
        properties: {},
      },
    ],
    edges: [
      {
        id: "e-color-output",
        sourceNodeId: "baseColor",
        sourcePinId: "out",
        targetNodeId: "output",
        targetPinId: "baseColor",
      },
    ],
  };
}

/** The surface seed (a Base Color constant) wired into a Decal Output instead. */
function defaultDecalGraph(): {
  nodes: MaterialGraphNode[];
  edges: MaterialGraphEdge[];
} {
  const graph = defaultSurfaceGraph();
  return {
    nodes: graph.nodes.map((node) => node.type === "output.surface" ? { ...node, type: "output.decal" } : node),
    edges: graph.edges,
  };
}

function defaultPostProcessGraph(): {
  nodes: MaterialGraphNode[];
  edges: MaterialGraphEdge[];
} {
  return {
    nodes: [
      {
        id: "screenUv",
        type: "input.screenUv",
        position: { x: 0, y: 0 },
        properties: {},
      },
      {
        id: "sceneColor",
        type: "input.sceneColor",
        position: { x: 400, y: 0 },
        properties: {},
      },
      {
        id: "output",
        type: "output.postProcess",
        position: { x: 800, y: 0 },
        properties: {},
      },
    ],
    edges: [
      {
        id: "e-uv-scene",
        sourceNodeId: "screenUv",
        sourcePinId: "uv",
        targetNodeId: "sceneColor",
        targetPinId: "uv",
      },
      {
        id: "e-scene-output",
        sourceNodeId: "sceneColor",
        sourcePinId: "color",
        targetNodeId: "output",
        targetPinId: "color",
      },
    ],
  };
}

function defaultParticleGraph(): {
  nodes: MaterialGraphNode[];
  edges: MaterialGraphEdge[];
} {
  return {
    nodes: [
      {
        id: "particleColor",
        type: "input.particleColor",
        position: { x: 0, y: 0 },
        properties: {},
      },
      {
        id: "output",
        type: "output.particle",
        position: { x: 400, y: 0 },
        properties: {},
      },
    ],
    edges: [
      {
        id: "e-color-output",
        sourceNodeId: "particleColor",
        sourcePinId: "color",
        targetNodeId: "output",
        targetPinId: "color",
      },
    ],
  };
}

/** A Color constant wired into User Interface Output's Color, as the Surface default feeds Base Color. */
function defaultUserInterfaceGraph(): {
  nodes: MaterialGraphNode[];
  edges: MaterialGraphEdge[];
} {
  return {
    nodes: [
      {
        id: "color",
        type: "const.color",
        position: { x: 0, y: 0 },
        properties: { value: [1, 1, 1] },
      },
      {
        id: "output",
        type: "output.ui",
        position: { x: 400, y: 0 },
        properties: {},
      },
    ],
    edges: [
      {
        id: "e-color-output",
        sourceNodeId: "color",
        sourcePinId: "out",
        targetNodeId: "output",
        targetPinId: "color",
      },
    ],
  };
}

/**
 * Text and User Interface Materials draw on 2D quads blended over what is behind them: always unlit,
 * two-sided and translucent, additive or multiply.
 */
function isOverlayDomain(domain: MaterialDomain): boolean {
  return domain === "text" || domain === "ui";
}
const RETYPED_TERMINALS: ReadonlySet<string> = new Set(["output.surface", "output.decal"]);

export function createDefaultMaterialDocument(
  name = "Material",
  domain: MaterialDomain = "surface",
): MaterialDocument {
  const graph =
    domain === "text"
      ? { nodes: [{ id: "output", type: "output.text", position: { x: 300, y: 0 }, properties: {} }], edges: [] }
      : domain === "ui"
      ? defaultUserInterfaceGraph()
      : domain === "postProcess"
      ? defaultPostProcessGraph()
      : domain === "particle"
        ? defaultParticleGraph()
        : domain === "decal"
          ? defaultDecalGraph()
          : defaultSurfaceGraph();
  return {
    name,
    domain,
    shadingModel: domain === "particle" || isOverlayDomain(domain) ? "unlit" : "pbr",
    // A decal blends over the surface it lands on.
    blendMode: isOverlayDomain(domain) || domain === "decal" ? "translucent" : domain === "particle" ? "additive" : "opaque",
    twoSided: isOverlayDomain(domain),
    defaultNormals: "model",
    alphaCutoff: 0.5,
    preview: { mesh: isOverlayDomain(domain) ? "plane" : "cube", customMeshGuid: null },
    nodes: graph.nodes,
    edges: graph.edges,
  };
}

/**
 * Change a material's domain, dropping any node the new domain does not allow.
 * Switching would otherwise leave, say, a Scene Color node in a surface
 * material, which only surfaces later as a validation error. Surface and
 * Landscape draw through the same Material Output, so it stays with its
 * position, pin defaults and wires. Between Material Output and Decal Output
 * the node changes type and keeps the wires and defaults of the pins both have;
 * any other switch replaces the terminal with an unwired one. Switching to
 * Particle also wires Particle Color into the new Particle Output.
 */
export function setMaterialDomain(
  doc: MaterialDocument,
  domain: MaterialDomain,
): MaterialDocument {
  if (doc.domain === domain) return doc;
  const terminalType = terminalNodeTypeFor(domain);
  const previousTerminal = terminalNodeTypeFor(doc.domain);
  const keepsTerminal = previousTerminal === terminalType;
  // Material Output and Decal Output share their pin ids: a switch between them retypes the output node, keeping the
  // wires and pin defaults of the pins the new one has.
  const retypesTerminal = !keepsTerminal && RETYPED_TERMINALS.has(previousTerminal) && RETYPED_TERMINALS.has(terminalType);
  const terminalPins = new Set(materialNodeDefinition(terminalType)?.inputs.map((pin) => pin.id) ?? []);
  const kept = doc.nodes.flatMap((node) => {
    const definition = materialNodeDefinition(node.type);
    if (!definition) return [node];
    if (definition.terminal) {
      if (keepsTerminal && node.type === terminalType) return [node];
      if (!retypesTerminal || node.type !== previousTerminal) return [];
      const properties = Object.fromEntries(Object.entries(node.properties)
        .filter(([key]) => !key.startsWith("default:") || terminalPins.has(key.slice("default:".length))));
      return [{ ...node, type: terminalType, properties }];
    }
    return (definition.domains ? definition.domains.includes(domain) || (domain === "landscape" && definition.domains.includes("surface")) : true) ? [node] : [];
  });
  const keptIds = new Set(kept.map((node) => node.id));
  const retyped = new Set(retypesTerminal ? kept.filter((node) => node.type === terminalType).map((node) => node.id) : []);
  // Text and User Interface force unlit, translucent and two-sided, so those
  // values were never authored. Leaving either, or entering User Interface,
  // takes the new domain's defaults instead.
  const target = isOverlayDomain(doc.domain) || domain === "ui" ? createDefaultMaterialDocument(doc.name, domain) : null;
  const forcedSettings = target
    ? { shadingModel: target.shadingModel, blendMode: target.blendMode, twoSided: target.twoSided }
    : {};
  const switched = normalizeMaterialDocument({
    ...doc,
    ...forcedSettings,
    domain,
    nodes: kept,
    edges: doc.edges.filter(
      (edge) =>
        keptIds.has(edge.sourceNodeId) && keptIds.has(edge.targetNodeId) &&
        (!retyped.has(edge.targetNodeId) || terminalPins.has(edge.targetPinId)),
    ),
  });
  return domain === "particle" ? withParticleColorWired(switched) : switched;
}

/**
 * The new-Material Base Color constant, untouched and no longer wired. Its
 * value is the Material Output's own Base Color default, so dropping it loses
 * nothing; an edited value or a remaining wire marks it as authored.
 */
function isUnwiredSurfaceSeed(
  node: MaterialGraphNode,
  edges: readonly MaterialGraphEdge[],
): boolean {
  const seed = defaultSurfaceGraph().nodes.find(
    (entry) => entry.id === node.id && entry.type === node.type,
  );
  return (
    seed !== undefined &&
    !materialNodeDefinition(seed.type)?.terminal &&
    JSON.stringify(seed.properties) === JSON.stringify(node.properties) &&
    !edges.some(
      (edge) => edge.sourceNodeId === node.id || edge.targetNodeId === node.id,
    )
  );
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  let id = base;
  for (let suffix = 2; taken.has(id); suffix++) id = `${base}-${suffix}`;
  return id;
}

/**
 * Wire Particle Color into an unwired Particle Output, dropping the untouched
 * Base Color seed the old Surface output used. An unwired output draws the
 * pin's constant white, ignoring every emitter colour. A wired output is left
 * as is. Shading Model and Blend Mode stay: Particle ignores them (emitters own
 * blending), so a return to Surface keeps the authored values.
 */
function withParticleColorWired(doc: MaterialDocument): MaterialDocument {
  const output = doc.nodes.find(
    (node) => node.type === terminalNodeTypeFor("particle"),
  );
  if (
    !output ||
    doc.edges.some(
      (edge) => edge.targetNodeId === output.id && edge.targetPinId === "color",
    )
  ) {
    return doc;
  }
  const nodes = doc.nodes.filter((node) => !isUnwiredSurfaceSeed(node, doc.edges));
  const template = defaultParticleGraph();
  const templateColor = template.nodes.find(
    (node) => node.type === "input.particleColor",
  )!;
  const templateEdge = template.edges[0]!;
  const existing = nodes.find((node) => node.type === templateColor.type);
  // Nodes are at least 320 units wide: left of every node, with a gap, never
  // lands on a kept one.
  const left = Math.min(...nodes.map((node) => node.position.x));
  const color = existing ?? {
    ...templateColor,
    id: uniqueId(templateColor.id, new Set(nodes.map((node) => node.id))),
    position: { x: left - 400, y: output.position.y },
  };
  return {
    ...doc,
    nodes: existing ? nodes : [...nodes, color],
    edges: [
      ...doc.edges,
      {
        ...templateEdge,
        id: uniqueId(templateEdge.id, new Set(doc.edges.map((edge) => edge.id))),
        sourceNodeId: color.id,
        targetNodeId: output.id,
      },
    ],
  };
}

export function normalizeMaterialDocument(
  value: unknown,
  fallbackName = "Material",
): MaterialDocument {
  const record = asRecord(value);
  const domain = parseMaterialDomain(record.domain);
  const nodes = withTerminal(normalizeNodes(record.nodes), domain);
  return {
    name: asString(record.name, fallbackName),
    domain,
    shadingModel: isOverlayDomain(domain) || record.shadingModel === "unlit" ? "unlit" : "pbr",
    // A post-process pass replaces the image, so it has no Blend Mode: always Opaque.
    blendMode:
      isOverlayDomain(domain) ? (record.blendMode === "additive" || record.blendMode === "multiply" ? record.blendMode : "translucent") : domain === "postProcess" ? "opaque" : record.blendMode === "masked" ||
      record.blendMode === "translucent" ||
      record.blendMode === "additive" ||
      record.blendMode === "multiply"
        ? record.blendMode
        : "opaque",
    twoSided: isOverlayDomain(domain) || record.twoSided === true,
    defaultNormals: record.defaultNormals === "flat" ? "flat" : "model",
    alphaCutoff: asNumber(record.alphaCutoff, 0.5),
    ...(asNumber(record.boundsPadding, 0) > 0 ? { boundsPadding: asNumber(record.boundsPadding, 0) } : {}),
    preview: normalizeMaterialPreviewSettings(record.preview),
    nodes,
    edges: normalizeGraphPinEdges(record.edges),
  };
}

function normalizeFunctionPins(
  value: unknown,
  prefix: string,
): MaterialFunctionPin[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const record = asRecord(entry);
    return {
      id: asString(record.id, `${prefix}_${index}`),
      name: asString(record.name, `${prefix === "in" ? "Input" : "Output"} ${index + 1}`),
      type: asValueType(record.type),
      ...(Array.isArray(record.defaultValue)
        ? {
            defaultValue: (record.defaultValue as unknown[]).map((component) =>
              asNumber(component, 0),
            ),
          }
        : {}),
    };
  });
}

export function createDefaultMaterialFunctionDocument(
  name = "Material Function",
): MaterialFunctionDocument {
  return {
    name,
    description: "",
    inputs: [{ id: "in_value", name: "Value", type: "vec3" }],
    outputs: [{ id: "out_value", name: "Result", type: "vec3" }],
    nodes: [
      {
        id: "inputs",
        type: "function.input",
        position: { x: 0, y: 0 },
        properties: {},
      },
      {
        id: "outputs",
        type: "function.output",
        position: { x: 360, y: 0 },
        properties: {},
      },
    ],
    edges: [
      {
        id: "e-passthrough",
        sourceNodeId: "inputs",
        sourcePinId: "in_value",
        targetNodeId: "outputs",
        targetPinId: "out_value",
      },
    ],
  };
}

export function normalizeMaterialFunctionDocument(
  value: unknown,
  fallbackName = "Material Function",
): MaterialFunctionDocument {
  const record = asRecord(value);
  const withPlumbing = normalizeNodes(record.nodes);
  if (!withPlumbing.some((node) => node.type === "function.input")) {
    withPlumbing.unshift({
      id: "inputs",
      type: "function.input",
      position: { x: 0, y: 0 },
      properties: {},
    });
  }
  if (!withPlumbing.some((node) => node.type === "function.output")) {
    withPlumbing.push({
      id: "outputs",
      type: "function.output",
      position: { x: 360, y: 0 },
      properties: {},
    });
  }
  return {
    name: asString(record.name, fallbackName),
    description: asString(record.description, ""),
    inputs: normalizeFunctionPins(record.inputs, "in"),
    outputs: normalizeFunctionPins(record.outputs, "out"),
    nodes: withPlumbing,
    edges: normalizeGraphPinEdges(record.edges),
  };
}

/**
 * The Material for an imported glTF material slot with an albedo texture: the
 * texture sampled at the mesh UVs feeds Base Color.
 */
export function createImportedMaterialDocument(options: {
  textureGuid: string;
  shadingModel?: MaterialShadingModel;
}): MaterialDocument {
  const seeded = seedImportedMaterialNodes(options.textureGuid);
  return normalizeMaterialDocument({
    name: "Material",
    domain: "surface",
    shadingModel: options.shadingModel,
    nodes: seeded.nodes,
    edges: seeded.edges,
  });
}

/** An imported glTF material keeps its albedo texture wired to Base Color. */
function seedImportedMaterialNodes(textureGuid: string): {
  nodes: MaterialGraphNode[];
  edges: MaterialGraphEdge[];
} {
  return {
    nodes: [
      {
        id: "albedo",
        type: "param.texture",
        position: { x: 0, y: 0 },
        properties: { textureGuid, name: "Albedo" },
      },
      {
        id: "uv",
        type: "input.uv",
        position: { x: 0, y: 140 },
        properties: {},
      },
      {
        id: "sample",
        type: "texture.sample",
        position: { x: 220, y: 40 },
        properties: {},
      },
      {
        id: "output",
        type: "output.surface",
        position: { x: 460, y: 0 },
        properties: {},
      },
    ],
    edges: [
      {
        id: "e-tex",
        sourceNodeId: "albedo",
        sourcePinId: "out",
        targetNodeId: "sample",
        targetPinId: "texture",
      },
      {
        id: "e-uv",
        sourceNodeId: "uv",
        sourcePinId: "uv",
        targetNodeId: "sample",
        targetPinId: "uv",
      },
      {
        id: "e-base",
        sourceNodeId: "sample",
        sourcePinId: "rgb",
        targetNodeId: "output",
        targetPinId: "baseColor",
      },
    ],
  };
}

export interface MaterialDependencies {
  textures: string[];
  functions: string[];
  meshes: string[];
  /** Global Parameter Collections its Global Parameter nodes read. */
  globalParameterCollections: string[];
  /** Sorted union for `header.dependencies[]`. */
  all: string[];
}

function guidProperty(
  node: MaterialGraphNode,
  key: string,
): string | null {
  const value = node.properties[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Authoritative dependency extraction. Saving a Material or Material Function
 * writes this into `header.dependencies[]` so Show References and the export
 * closure see textures, called functions and the preview mesh.
 */
export function materialDependencies(
  doc: MaterialDocument | MaterialFunctionDocument,
): MaterialDependencies {
  const textures = new Set<string>();
  const functions = new Set<string>();
  const meshes = new Set<string>();
  const collections = new Set<string>();
  for (const node of doc.nodes) {
    const texture = guidProperty(node, "textureGuid");
    if (texture) textures.add(texture);
    const fn = guidProperty(node, "functionGuid");
    if (fn) functions.add(fn);
    const collection = node.type === "global.parameter" ? guidProperty(node, "collectionGuid") : null;
    if (collection) collections.add(collection);
  }
  if ("preview" in doc && doc.preview.customMeshGuid) {
    meshes.add(doc.preview.customMeshGuid);
  }
  const sorted = (values: Set<string>) => [...values].sort();
  const all = sorted(new Set([...textures, ...functions, ...meshes, ...collections]));
  return {
    textures: sorted(textures),
    functions: sorted(functions),
    meshes: sorted(meshes),
    globalParameterCollections: sorted(collections),
    all,
  };
}

/** Texture guids sampled by Materials that are absent from packed Texture bytes. */
export function missingPackedMaterialTextureGuids(
  documents: Iterable<MaterialDocument | MaterialFunctionDocument>,
  packedTextureGuids: ReadonlySet<string>,
): string[] {
  const missing = new Set<string>();
  for (const document of documents) {
    for (const guid of materialDependencies(document).textures) {
      if (!packedTextureGuids.has(guid)) missing.add(guid);
    }
  }
  return [...missing].sort();
}
