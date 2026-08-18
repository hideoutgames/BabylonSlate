import type { MaterialDomain } from "./catalog";
import { materialNodeDefinition, terminalNodeTypeFor } from "./catalog";
import type { MaterialValueType } from "./types";

export const MATERIAL_SCHEMA_VERSION = 2;
export const MATERIAL_FUNCTION_SCHEMA_VERSION = 1;

export type MaterialBlendMode =
  | "opaque"
  | "masked"
  | "translucent"
  | "additive";

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
  schemaVersion: number;
  name: string;
  domain: MaterialDomain;
  shadingModel: MaterialShadingModel;
  blendMode: MaterialBlendMode;
  twoSided: boolean;
  alphaCutoff: number;
  preview: MaterialPreviewSettings;
  nodes: MaterialGraphNode[];
  edges: MaterialGraphEdge[];
}

export interface MaterialFunctionPin {
  /** Stable id: renaming the display name must not break callers. */
  id: string;
  name: string;
  type: MaterialValueType;
  defaultValue?: number[];
}

export interface MaterialFunctionDocument {
  schemaVersion: number;
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
  if (type !== "custom.glsl") return properties;
  const body =
    typeof properties.body === "string"
      ? properties.body
      : typeof properties.glsl === "string"
        ? properties.glsl
        : "a + b";
  const next: Record<string, unknown> = { ...properties, body };
  delete next.glsl;
  return next;
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

function normalizeEdges(value: unknown): MaterialGraphEdge[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    const record = asRecord(entry);
    const sourceNodeId = asString(record.sourceNodeId, "");
    const targetNodeId = asString(record.targetNodeId, "");
    if (!sourceNodeId || !targetNodeId) return [];
    return [
      {
        id: asString(record.id, `edge-${index}`),
        sourceNodeId,
        sourcePinId: asString(record.sourcePinId, "out"),
        targetNodeId,
        targetPinId: asString(record.targetPinId, "in"),
      },
    ];
  });
}

function normalizePreview(value: unknown): MaterialPreviewSettings {
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

export function createDefaultMaterialDocument(
  name = "Material",
  domain: MaterialDomain = "surface",
): MaterialDocument {
  const nodes: MaterialGraphNode[] =
    domain === "surface"
      ? [
          {
            id: "baseColor",
            type: "const.color",
            position: { x: 0, y: 0 },
            properties: { value: [0.8, 0.8, 0.8] },
          },
          {
            id: "output",
            type: "output.surface",
            position: { x: 300, y: 0 },
            properties: {},
          },
        ]
      : [
          {
            id: "screenUv",
            type: "input.screenUv",
            position: { x: 0, y: 0 },
            properties: {},
          },
          {
            id: "sceneColor",
            type: "input.sceneColor",
            position: { x: 200, y: 0 },
            properties: {},
          },
          {
            id: "output",
            type: "output.postProcess",
            position: { x: 420, y: 0 },
            properties: {},
          },
        ];
  const edges: MaterialGraphEdge[] =
    domain === "surface"
      ? [
          {
            id: "e-color-output",
            sourceNodeId: "baseColor",
            sourcePinId: "out",
            targetNodeId: "output",
            targetPinId: "baseColor",
          },
        ]
      : [
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
        ];
  return {
    schemaVersion: MATERIAL_SCHEMA_VERSION,
    name,
    domain,
    shadingModel: "pbr",
    blendMode: "opaque",
    twoSided: false,
    alphaCutoff: 0.5,
    preview: { mesh: "cube", customMeshGuid: null },
    nodes,
    edges,
  };
}

/**
 * Change a material's domain, dropping the old terminal and any node the new
 * domain does not allow. Switching would otherwise leave, say, a Scene Color
 * node in a surface material, which only surfaces later as a validation error.
 */
export function setMaterialDomain(
  doc: MaterialDocument,
  domain: MaterialDomain,
): MaterialDocument {
  if (doc.domain === domain) return doc;
  const kept = doc.nodes.filter((node) => {
    const definition = materialNodeDefinition(node.type);
    if (!definition) return true;
    if (definition.terminal) return false;
    return definition.domains ? definition.domains.includes(domain) : true;
  });
  const keptIds = new Set(kept.map((node) => node.id));
  return normalizeMaterialDocument({
    ...doc,
    domain,
    nodes: kept,
    edges: doc.edges.filter(
      (edge) =>
        keptIds.has(edge.sourceNodeId) && keptIds.has(edge.targetNodeId),
    ),
  });
}

export function normalizeMaterialDocument(
  value: unknown,
  fallbackName = "Material",
): MaterialDocument {
  const record = asRecord(value);
  const domain: MaterialDomain =
    record.domain === "postProcess" ? "postProcess" : "surface";
  return {
    schemaVersion: asNumber(record.schemaVersion, MATERIAL_SCHEMA_VERSION),
    name: asString(record.name, fallbackName),
    domain,
    shadingModel: record.shadingModel === "unlit" ? "unlit" : "pbr",
    blendMode:
      record.blendMode === "masked" ||
      record.blendMode === "translucent" ||
      record.blendMode === "additive"
        ? record.blendMode
        : "opaque",
    twoSided: record.twoSided === true,
    alphaCutoff: asNumber(record.alphaCutoff, 0.5),
    preview: normalizePreview(record.preview),
    nodes: withTerminal(normalizeNodes(record.nodes), domain),
    edges: normalizeEdges(record.edges),
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
    schemaVersion: MATERIAL_FUNCTION_SCHEMA_VERSION,
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
  const nodes = normalizeNodes(record.nodes);
  const withPlumbing = [...nodes];
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
    schemaVersion: asNumber(
      record.schemaVersion,
      MATERIAL_FUNCTION_SCHEMA_VERSION,
    ),
    name: asString(record.name, fallbackName),
    description: asString(record.description, ""),
    inputs: normalizeFunctionPins(record.inputs, "in"),
    outputs: normalizeFunctionPins(record.outputs, "out"),
    nodes: withPlumbing,
    edges: normalizeEdges(record.edges),
  };
}

/** Legacy `output.fragment` / `output.postProcess` to the canonical terminals. */
const LEGACY_NODE_TYPES: Record<string, string> = {
  "output.fragment": "output.surface",
  custom: "custom.glsl",
};

const LEGACY_TERMINAL_PIN: Record<string, string> = {
  color: "baseColor",
};

export interface LegacyShaderMigrationContext {
  /** Texture guids from an imported Material header's dependencies. */
  textureGuids?: readonly string[];
}

/**
 * Legacy authored `Shader` payloads and empty imported `Material` stubs both
 * become canonical Material documents. The legacy default wired a Vector 2 UV
 * into a color input, which was never a legal connection, so it is dropped
 * rather than migrated into a type error.
 */
export function migrateLegacyShaderPayload(
  value: unknown,
  context: LegacyShaderMigrationContext = {},
): MaterialDocument {
  const record = asRecord(value);
  const legacyNodes = normalizeNodes(record.nodes);
  const hasPostTerminal = legacyNodes.some(
    (node) => node.type === "output.postProcess",
  );
  const domain: MaterialDomain =
    record.postProcess === true || hasPostTerminal ? "postProcess" : "surface";

  const nodes = legacyNodes.map((node) => ({
    ...node,
    type:
      domain === "postProcess" && node.type === "output.fragment"
        ? "output.postProcess"
        : (LEGACY_NODE_TYPES[node.type] ?? node.type),
  }));
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const edges = normalizeEdges(record.edges)
    .map((edge) => {
      const target = byId.get(edge.targetNodeId);
      if (!target) return edge;
      if (target.type !== "output.surface") return edge;
      return {
        ...edge,
        targetPinId: LEGACY_TERMINAL_PIN[edge.targetPinId] ?? edge.targetPinId,
      };
    })
    .filter((edge) => {
      const source = byId.get(edge.sourceNodeId);
      const target = byId.get(edge.targetNodeId);
      if (!source || !target) return false;
      const sourceDefinition = materialNodeDefinition(source.type);
      const targetDefinition = materialNodeDefinition(target.type);
      if (!sourceDefinition || !targetDefinition) return false;
      const sourcePin = sourceDefinition.outputs.find(
        (pin) => pin.id === edge.sourcePinId,
      );
      const targetPin = targetDefinition.inputs.find(
        (pin) => pin.id === edge.targetPinId,
      );
      if (!sourcePin || !targetPin) return false;
      // Legacy graphs were never type-checked; keep only connections whose
      // widths still line up so the migrated material compiles.
      if (sourcePin.type.kind === "generic" || targetPin.type.kind === "generic") {
        return true;
      }
      return (
        sourcePin.type.kind === targetPin.type.kind ||
        sourcePin.type.kind === "float"
      );
    });

  const seeded =
    nodes.length === 0 && (context.textureGuids?.length ?? 0) > 0
      ? seedImportedMaterialNodes(context.textureGuids![0]!)
      : { nodes, edges };

  return normalizeMaterialDocument({
    schemaVersion: MATERIAL_SCHEMA_VERSION,
    name: asString(record.name, "Material"),
    domain,
    shadingModel: record.shadingModel,
    blendMode: record.blendMode,
    twoSided: record.twoSided,
    alphaCutoff: record.alphaCutoff,
    preview: record.preview,
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
  for (const node of doc.nodes) {
    const texture = guidProperty(node, "textureGuid");
    if (texture) textures.add(texture);
    const fn = guidProperty(node, "functionGuid");
    if (fn) functions.add(fn);
  }
  if ("preview" in doc && doc.preview.customMeshGuid) {
    meshes.add(doc.preview.customMeshGuid);
  }
  const sorted = (values: Set<string>) => [...values].sort();
  const all = sorted(new Set([...textures, ...functions, ...meshes]));
  return {
    textures: sorted(textures),
    functions: sorted(functions),
    meshes: sorted(meshes),
    all,
  };
}
