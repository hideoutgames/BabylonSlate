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

export function isLatentFunctionKey(
  classId: string,
  functionName: string,
  latent: ReadonlySet<string>,
  parentOf?: (classId: string) => string | null | undefined,
): boolean {
  let current: string | null | undefined = classId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (latent.has(latentFunctionKey(current, functionName))) return true;
    current = parentOf?.(current) ?? null;
  }
  return false;
}

/** Fixpoint: Delay / async JS, then Calls to Functions already in the set. */
export function collectLatentFunctions(
  sources: readonly LatentFunctionSource[],
  registry: NodeRegistry,
  parentOf?: (classId: string) => string | null | undefined,
): Set<string> {
  const latent = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    const isLatentCall = (classId: string, functionName: string) =>
      isLatentFunctionKey(classId, functionName, latent, parentOf);
    for (const source of sources) {
      const key = latentFunctionKey(source.classId, source.functionName);
      if (latent.has(key)) continue;
      if (
        source.nodes.some((node) =>
          nodeIsLatentSource(node, registry, isLatentCall),
        )
      ) {
        latent.add(key);
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
