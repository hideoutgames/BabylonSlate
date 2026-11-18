import {
  isNamedRerouteDeclarationType,
  isNamedRerouteUsageType,
  namedRerouteDeclarationId,
  namedRerouteName,
} from "./catalog";
import type { MaterialGraphEdge, MaterialGraphNode } from "./document";
import { uniqueSuffixedName } from "./parameter-authoring";
import type { MaterialDiagnostic } from "./validate";

export {
  NAMED_REROUTE_DECLARATION_TYPE,
  NAMED_REROUTE_USAGE_TYPE,
  isNamedRerouteDeclarationType,
  isNamedRerouteUsageType,
  namedRerouteDeclarationId,
  namedRerouteName,
} from "./catalog";

/** A Named Reroute colour: `[r, g, b]` from 0 to 1, as the Inspector's colour rows edit. */
export type NamedRerouteColor = [number, number, number];

/** The name a new declaration starts from. */
const DEFAULT_NAME = "Reroute";

/** New declarations take these in turn, by how many declarations the graph already has. */
const DEFAULT_COLORS: readonly NamedRerouteColor[] = [
  [0.9, 0.3, 0.3],
  [0.95, 0.6, 0.2],
  [0.9, 0.8, 0.25],
  [0.35, 0.75, 0.35],
  [0.25, 0.7, 0.75],
  [0.3, 0.5, 0.9],
  [0.6, 0.4, 0.85],
  [0.85, 0.4, 0.65],
];

type GraphNodeLike = Pick<MaterialGraphNode, "id" | "type" | "properties">;

function isColor(value: unknown): value is NamedRerouteColor {
  return Array.isArray(value) && value.length === 3 && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

/** A declaration's colour, or the first default colour when it has none. */
export function namedRerouteColor(node: Pick<MaterialGraphNode, "properties">): NamedRerouteColor {
  const color = node.properties.color;
  return isColor(color) ? [color[0], color[1], color[2]] : [...DEFAULT_COLORS[0]!];
}

/** The default colour a declaration added to a graph that already has `declarationCount` takes. */
export function defaultNamedRerouteColor(declarationCount: number): NamedRerouteColor {
  return [...DEFAULT_COLORS[declarationCount % DEFAULT_COLORS.length]!];
}

/** A Named Reroute colour as a CSS colour, for node headers and Add Node rows. */
export function namedRerouteColorCss(color: readonly number[]): string {
  const channel = (value: number | undefined) =>
    Math.round(Math.min(1, Math.max(0, Number.isFinite(value) ? value! : 0)) * 255);
  return `rgb(${channel(color[0])}, ${channel(color[1])}, ${channel(color[2])})`;
}

/**
 * `name` when no other declaration holds it, else its stem with the first free `_1`, `_2`….
 * `exceptNodeId` is the declaration being renamed.
 */
export function uniqueNamedRerouteName(
  nodes: readonly GraphNodeLike[],
  name = DEFAULT_NAME,
  exceptNodeId?: string,
): string {
  return uniqueSuffixedName(new Set(nodes
    .filter((node) => node.id !== exceptNodeId && isNamedRerouteDeclarationType(node.type))
    .map(namedRerouteName)), name);
}

/**
 * Declarations `previous` did not have (added, pasted or duplicated) get a free name, theirs when no
 * other declaration holds it, and a default colour when they have none. Returns `nodes` itself when
 * nothing changes.
 */
export function nameNewNamedReroutes<N extends GraphNodeLike>(
  previous: readonly Pick<MaterialGraphNode, "id">[],
  nodes: readonly N[],
): N[] {
  const known = new Set(previous.map((node) => node.id));
  if (!nodes.some((node) => !known.has(node.id) && isNamedRerouteDeclarationType(node.type))) return nodes as N[];
  const named: GraphNodeLike[] = nodes.filter((node) => known.has(node.id) && isNamedRerouteDeclarationType(node.type));
  return nodes.map((node) => {
    if (known.has(node.id) || !isNamedRerouteDeclarationType(node.type)) return node;
    const name = uniqueNamedRerouteName(named, namedRerouteName(node) || DEFAULT_NAME);
    const color = isColor(node.properties.color) ? node.properties.color : defaultNamedRerouteColor(named.length);
    const next = { ...node, properties: { ...node.properties, name, color } };
    named.push(next);
    return next;
  });
}

/**
 * Point pasted usages at the declaration pasted with them. `idMap` maps each copied node's id to its
 * copy's id (GraphEditor's paste). A usage pasted without its declaration keeps its declaration.
 * Canvas nodes carry their graph type in `data.__nodeType`. Returns `pasted` itself when nothing
 * changes.
 */
export function remapPastedNamedReroutes<N extends { id: string; type?: string; data: Record<string, unknown> }>(
  pasted: readonly N[],
  idMap: ReadonlyMap<string, string>,
): N[] {
  const typeOf = (node: N) => (typeof node.data.__nodeType === "string" ? node.data.__nodeType : node.type ?? "");
  const pastedDeclarations = new Set(pasted.filter((node) => isNamedRerouteDeclarationType(typeOf(node))).map((node) => node.id));
  if (pastedDeclarations.size === 0) return pasted as N[];
  let changed = false;
  const next = pasted.map((node) => {
    if (!isNamedRerouteUsageType(typeOf(node))) return node;
    const copy = idMap.get(namedRerouteDeclarationId({ properties: node.data }));
    if (!copy || !pastedDeclarations.has(copy)) return node;
    changed = true;
    return { ...node, data: { ...node.data, declarationId: copy } };
  });
  return changed ? next : (pasted as N[]);
}

/** Rename a declaration; a taken name gets the first free `_N`. Returns `nodes` itself when nothing changes. */
export function renameNamedReroute<N extends GraphNodeLike>(
  nodes: readonly N[],
  nodeId: string,
  name: string,
): N[] {
  const trimmed = name.trim();
  const node = nodes.find((entry) => entry.id === nodeId);
  if (!trimmed || !node || !isNamedRerouteDeclarationType(node.type)) return nodes as N[];
  const unique = uniqueNamedRerouteName(nodes, trimmed, nodeId);
  if (node.properties.name === unique) return nodes as N[];
  return nodes.map((entry) => (entry.id === nodeId ? { ...entry, properties: { ...entry.properties, name: unique } } : entry));
}

export interface NamedRerouteDeclaration {
  nodeId: string;
  name: string;
  color: NamedRerouteColor;
}

/** The graph's declarations by name, then id. */
export function namedRerouteDeclarations(nodes: readonly GraphNodeLike[]): NamedRerouteDeclaration[] {
  return nodes
    .filter((node) => isNamedRerouteDeclarationType(node.type))
    .map((node) => ({ nodeId: node.id, name: namedRerouteName(node), color: namedRerouteColor(node) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
}

/**
 * Declarations whose input reads one of their own usages: walking upstream from the declaration,
 * through wires and from each usage into its declaration's input, reaches a usage of it. Each
 * declaration on a loop between several reroutes is listed.
 */
export function namedRerouteLoopDeclarations(graph: {
  nodes: readonly GraphNodeLike[];
  edges: readonly MaterialGraphEdge[];
}): Set<string> {
  const looping = new Set<string>();
  const nodes = new Map<string, GraphNodeLike>();
  const declarations = new Set<string>();
  for (const node of graph.nodes) {
    if (nodes.has(node.id)) continue;
    nodes.set(node.id, node);
    if (isNamedRerouteDeclarationType(node.type)) declarations.add(node.id);
  }
  if (declarations.size === 0) return looping;
  const incoming = new Map<string, MaterialGraphEdge[]>();
  for (const edge of graph.edges) {
    const edges = incoming.get(edge.targetNodeId);
    if (edges) edges.push(edge);
    else incoming.set(edge.targetNodeId, [edge]);
  }
  for (const declarationId of declarations) {
    const visited = new Set([declarationId]);
    const stack = [declarationId];
    walk: while (stack.length > 0) {
      for (const edge of incoming.get(stack.pop()!) ?? []) {
        const source = nodes.get(edge.sourceNodeId);
        if (!source) continue;
        let next = source.id;
        if (isNamedRerouteUsageType(source.type)) {
          const target = namedRerouteDeclarationId(source);
          if (target === declarationId) {
            looping.add(declarationId);
            break walk;
          }
          if (!declarations.has(target)) continue;
          next = target;
        }
        if (visited.has(next)) continue;
        visited.add(next);
        stack.push(next);
      }
    }
  }
  return looping;
}

/**
 * Declaration names (nonblank, unique among the graph's declarations), usages whose declaration is
 * gone, and declarations that read their own usages. `loops` is the set the caller already found.
 */
export function validateNamedReroutes(
  graph: { nodes: readonly GraphNodeLike[] },
  loops: ReadonlySet<string>,
): MaterialDiagnostic[] {
  const diagnostics: MaterialDiagnostic[] = [];
  const counts = new Map<string, number>();
  const declarations = new Set<string>();
  for (const node of graph.nodes) {
    if (!isNamedRerouteDeclarationType(node.type)) continue;
    declarations.add(node.id);
    const name = namedRerouteName(node);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const node of graph.nodes) {
    if (isNamedRerouteDeclarationType(node.type)) {
      const name = namedRerouteName(node);
      if (!name) {
        diagnostics.push({ code: "material.reroute.missingName", message: "Named Reroute needs a unique name", severity: "error", nodeId: node.id });
      } else if ((counts.get(name) ?? 0) > 1) {
        diagnostics.push({
          code: "material.reroute.duplicateName",
          message: `Named Reroute name "${name}" is already used; choose a unique name`,
          severity: "error",
          nodeId: node.id,
        });
      }
      if (loops.has(node.id)) {
        diagnostics.push({
          code: "material.reroute.selfUse",
          message: name ? `Named Reroute "${name}" uses itself` : "Named Reroute uses itself",
          severity: "error",
          nodeId: node.id,
          pinId: "in",
        });
      }
    } else if (isNamedRerouteUsageType(node.type) && !declarations.has(namedRerouteDeclarationId(node))) {
      diagnostics.push({ code: "material.reroute.missingDeclaration", message: "Named Reroute is missing", severity: "error", nodeId: node.id });
    }
  }
  return diagnostics;
}
