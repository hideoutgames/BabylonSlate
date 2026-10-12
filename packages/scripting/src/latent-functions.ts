import type { SerializedGraph } from "@babylonslate/core";
import type { NodeRegistry } from "./node-registry";

/** Same ident rules as Call Function / compileGraph export names. */
export function codegenJsIdent(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

export function latentFunctionKey(
  classId: string,
  functionName: string,
): string {
  return `${classId}:${codegenJsIdent(functionName)}`;
}

export type LatentFunctionSource = {
  classId: string;
  functionName: string;
  nodes: ReadonlyArray<{
    typeId: string;
    properties: Record<string, unknown>;
  }>;
};

const EXECUTE_JS = "debug.executeJavaScript";
const CALL_FUNCTION = "functions.call";

function nodeIsLatentSource(
  node: { typeId: string; properties: Record<string, unknown> },
  registry: NodeRegistry,
  isLatentCall: (classId: string, functionName: string) => boolean,
): boolean {
  if (registry.get(node.typeId)?.latent) return true;
  if (node.typeId === EXECUTE_JS && node.properties.async === true) return true;
  if (node.typeId !== CALL_FUNCTION) return false;
  const classId =
    typeof node.properties.classId === "string" &&
    node.properties.classId.trim()
      ? node.properties.classId.trim()
      : "";
  if (!classId) return false;
  const functionName =
    typeof node.properties.functionName === "string"
      ? node.properties.functionName
      : "fn";
  return isLatentCall(classId, functionName);
}

function inLineage(
  classId: string,
  ancestorId: string,
  parentOf?: (classId: string) => string | null | undefined,
): boolean {
  let current: string | null | undefined = classId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    current = parentOf?.(current) ?? null;
  }
  return false;
}

function sharesLineage(
  classId: string,
  owner: string,
  parentOf?: (classId: string) => string | null | undefined,
): boolean {
  return inLineage(classId, owner, parentOf) || inLineage(owner, classId, parentOf);
}

/**
 * A Call naming `classId` runs the nearest implementation in the receiver's
 * lineage: an inherited one, or a subclass override when the receiver is a
 * subclass instance. It must await when any of those is latent.
 */
export function isLatentFunctionKey(
  classId: string,
  functionName: string,
  latent: ReadonlySet<string>,
  parentOf?: (classId: string) => string | null | undefined,
): boolean {
  const ident = codegenJsIdent(functionName);
  for (const key of latent) {
    // Idents never contain ":", so the last one separates the class id.
    const split = key.lastIndexOf(":");
    if (key.slice(split + 1) !== ident) continue;
    if (sharesLineage(classId, key.slice(0, split), parentOf)) return true;
  }
  return false;
}

/** Owner class ids of the latent keys, per function ident, in key order. */
type LatentOwners = Map<string, string[]>;

function addLatentOwner(owners: LatentOwners, key: string): void {
  const split = key.lastIndexOf(":");
  const ident = key.slice(split + 1);
  const list = owners.get(ident);
  if (list) list.push(key.slice(0, split));
  else owners.set(ident, [key.slice(0, split)]);
}

/** Fixpoint: Delay / async JS, then Calls to Functions already in the set. */
export function collectLatentFunctions(
  sources: readonly LatentFunctionSource[],
  registry: NodeRegistry,
  parentOf?: (classId: string) => string | null | undefined,
): Set<string> {
  const latent = new Set<string>();
  // Kept in step with `latent` so a Call only walks lineages of its own ident.
  const owners: LatentOwners = new Map();
  let changed = true;
  while (changed) {
    changed = false;
    const isLatentCall = (classId: string, functionName: string) =>
      owners
        .get(codegenJsIdent(functionName))
        ?.some((owner) => sharesLineage(classId, owner, parentOf)) ?? false;
    for (const source of sources) {
      const key = latentFunctionKey(source.classId, source.functionName);
      if (latent.has(key)) continue;
      if (
        source.nodes.some((node) =>
          nodeIsLatentSource(node, registry, isLatentCall),
        )
      ) {
        latent.add(key);
        addLatentOwner(owners, key);
        changed = true;
      }
    }
  }
  return latent;
}

function serializedNodeTypeId(node: {
  type: string;
  data: Record<string, unknown>;
}): string {
  return typeof node.data.__nodeType === "string"
    ? node.data.__nodeType
    : node.type;
}

export function latentSourcesFromSerializedGraph(
  classId: string,
  graph: Pick<SerializedGraph, "members" | "functionGraphs">,
): LatentFunctionSource[] {
  const sources: LatentFunctionSource[] = [];
  for (const member of graph.members ?? []) {
    if (member.kind !== "function" || !member.name) continue;
    const slice = graph.functionGraphs?.[member.id];
    sources.push({
      classId,
      functionName: member.name,
      nodes: (slice?.nodes ?? []).map((node) => ({
        typeId: serializedNodeTypeId(node),
        properties: { ...(node.data ?? {}) },
      })),
    });
  }
  return sources;
}
