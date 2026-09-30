import {
  normalizeMaterialParameterOverrides,
  type MaterialParameterValue,
} from "@babylonslate/core";
import { parseMaterialDomain, type MaterialDomain } from "./catalog";
import {
  normalizeMaterialPreviewSettings,
  type MaterialDocument,
  type MaterialPreviewSettings,
} from "./document";
import { isMaterialParameterNode, materialParameterName } from "./parameters";

export const MATERIAL_INSTANCE_SCHEMA_VERSION = 1;
/** Parent chains deeper than this are rejected as authoring mistakes. */
export const MATERIAL_INSTANCE_MAX_DEPTH = 16;

/**
 * A Material Instance reuses its parent's compiled shader and only replaces
 * root parameter values. Parents may be Materials or other instances.
 */
export interface MaterialInstanceDocument {
  schemaVersion: number;
  kind: "materialInstance";
  name: string;
  parentGuid: string | null;
  /**
   * The root Material's domain, cached when the parent changes so pickers can
   * filter by domain from the asset header. Rendering always uses the root's.
   */
  domain: MaterialDomain;
  /** Parameter name to value; names or kinds the parent lacks are ignored. */
  overrides: Record<string, MaterialParameterValue>;
  preview: MaterialPreviewSettings;
}

export type MaterialSource =
  | { kind: "material"; document: MaterialDocument }
  | { kind: "instance"; document: MaterialInstanceDocument };

export type MaterialInstanceResolution =
  | {
      ok: true;
      /** The instance first, then each parent, ending with the root Material. */
      chain: string[];
      rootGuid: string;
      root: MaterialDocument;
      /** Merged overrides; nearer instances win. */
      overrides: Record<string, MaterialParameterValue>;
    }
  | {
      ok: false;
      code: "materialInstance.missingParent" | "materialInstance.cycle" | "materialInstance.tooDeep";
      message: string;
      chain: string[];
    };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Instance payloads carry an explicit discriminator; Material graphs never do. */
export function isMaterialInstanceContent(value: unknown): boolean {
  return asRecord(value).kind === "materialInstance";
}

export function createDefaultMaterialInstanceDocument(
  name = "Material Instance",
  parentGuid: string | null = null,
): MaterialInstanceDocument {
  return {
    schemaVersion: MATERIAL_INSTANCE_SCHEMA_VERSION,
    kind: "materialInstance",
    name,
    parentGuid,
    domain: "surface",
    overrides: {},
    preview: { mesh: "cube", customMeshGuid: null },
  };
}

export function normalizeMaterialInstanceDocument(
  value: unknown,
  fallbackName = "Material Instance",
): MaterialInstanceDocument {
  const record = asRecord(value);
  const parent = typeof record.parentGuid === "string" ? record.parentGuid.trim() : "";
  return {
    schemaVersion: MATERIAL_INSTANCE_SCHEMA_VERSION,
    kind: "materialInstance",
    name: typeof record.name === "string" && record.name.trim() ? record.name : fallbackName,
    parentGuid: parent || null,
    domain: parseMaterialDomain(record.domain),
    overrides: normalizeMaterialParameterOverrides(record.overrides),
    preview: normalizeMaterialPreviewSettings(record.preview),
  };
}

/** Walk the parent chain to the root Material and merge overrides (nearest wins). */
export function resolveMaterialInstance(
  guid: string,
  lookup: (guid: string) => MaterialSource | null,
): MaterialInstanceResolution {
  const chain: string[] = [];
  const layers: Array<Record<string, MaterialParameterValue>> = [];
  let current: string | null = guid;
  while (current) {
    if (chain.includes(current)) {
      return { ok: false, code: "materialInstance.cycle", message: "Material Instance parents form a cycle", chain: [...chain, current] };
    }
    if (chain.length > MATERIAL_INSTANCE_MAX_DEPTH) {
      return { ok: false, code: "materialInstance.tooDeep", message: `Material Instance chains are limited to ${MATERIAL_INSTANCE_MAX_DEPTH} parents`, chain };
    }
    chain.push(current);
    const source = lookup(current);
    if (!source) break;
    if (source.kind === "material") {
      const overrides: Record<string, MaterialParameterValue> = {};
      for (const layer of [...layers].reverse()) Object.assign(overrides, layer);
      return { ok: true, chain, rootGuid: current, root: source.document, overrides };
    }
    layers.push(source.document.overrides);
    current = source.document.parentGuid;
  }
  return { ok: false, code: "materialInstance.missingParent", message: "Material Instance has no parent Material", chain };
}

function sameKind(node: { type: string }, value: MaterialParameterValue): boolean {
  return node.type === `param.${value.kind}`;
}

/**
 * The root Material with its parameter defaults replaced. The graph, and so the
 * generated shader, is unchanged: renderers share the root's GPU program and
 * only upload different uniform values and textures.
 */
export function materializeMaterialInstance(
  root: MaterialDocument,
  rootGuid: string,
  overrides: Readonly<Record<string, MaterialParameterValue>>,
  instance?: Pick<MaterialInstanceDocument, "name" | "preview">,
): MaterialDocument {
  return {
    ...root,
    name: instance?.name ?? root.name,
    preview: instance?.preview ?? root.preview,
    instanceOf: root.instanceOf ?? rootGuid,
    nodes: root.nodes.map((node) => {
      if (!isMaterialParameterNode(node.type)) return node;
      const value = overrides[materialParameterName(node)];
      if (!value || !sameKind(node, value)) return node;
      const properties = { ...node.properties };
      if (value.kind === "texture") properties.textureGuid = value.textureAssetGuid;
      else properties.value = value.kind === "float" ? [value.value] : [...value.value];
      return { ...node, properties };
    }),
  };
}

/** Parent plus texture overrides, for `header.dependencies[]` and export closures. */
export function materialInstanceDependencies(
  doc: MaterialInstanceDocument,
): { parent: string | null; textures: string[]; all: string[] } {
  const textures = [...new Set(Object.values(doc.overrides).flatMap((value) =>
    value.kind === "texture" && value.textureAssetGuid ? [value.textureAssetGuid] : []))].sort();
  const all = [...new Set([...(doc.parentGuid ? [doc.parentGuid] : []), ...textures])].sort();
  return { parent: doc.parentGuid, textures, all };
}

/**
 * Expand every resolvable instance into a Material document keyed by the
 * instance guid, so hosts that consume `Map<guid, MaterialDocument>` (viewports,
 * Play, packaged players, parameter catalogs) handle instances unchanged.
 */
export function materializeMaterialInstances(
  materials: ReadonlyMap<string, MaterialDocument>,
  instances: ReadonlyMap<string, MaterialInstanceDocument>,
): Map<string, MaterialDocument> {
  const lookup = (guid: string): MaterialSource | null => {
    const material = materials.get(guid);
    if (material) return { kind: "material", document: material };
    const instance = instances.get(guid);
    return instance ? { kind: "instance", document: instance } : null;
  };
  const result = new Map<string, MaterialDocument>();
  for (const [guid, instance] of instances) {
    const resolved = resolveMaterialInstance(guid, lookup);
    if (!resolved.ok) continue;
    result.set(guid, materializeMaterialInstance(resolved.root, resolved.rootGuid, resolved.overrides, instance));
  }
  return result;
}
