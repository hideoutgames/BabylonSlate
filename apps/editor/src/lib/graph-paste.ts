import type { SerializedGraph } from "@haptic/core";
import { formatEventMemberName, formatEventTitle } from "@haptic/editor-kit";
import type { GraphPasteElements, GraphPasteResult } from "@haptic/graph-ui";
import { singletonEventKey } from "@haptic/scripting";
import { jsIdent } from "@haptic/scripting-nodes";
import { canRenameCustomEvent } from "./class-members";
import { duplicateBaseName } from "./scene-actor-names";

type PasteNode = GraphPasteElements["nodes"][number];
type PasteEdge = GraphPasteElements["edges"][number];

const CUSTOM_EVENT = "flow.event.custom";

function canvasTypeId(node: PasteNode): string {
  return typeof node.data.__nodeType === "string" ? node.data.__nodeType : node.type ?? "";
}

/** Nodes with a wire into their Input Binding pin, whose asset is unknown until run time. */
function bindingWiredNodes(edges: readonly PasteEdge[]): Set<string> {
  return new Set(edges.filter((edge) => edge.targetHandle === "binding").map((edge) => edge.target));
}

/**
 * Names collide when they compile to one identifier (the validator's rule) or
 * differ only in case (the rename rule).
 */
export function eventNameKeys(data: Record<string, unknown>): string[] {
  const name = formatEventMemberName(String(data.name ?? data.title ?? "")).toLowerCase();
  return [
    ...(typeof data.name === "string" && data.name ? [`id:${jsIdent(data.name)}`] : []),
    ...(name ? [`name:${name}`] : []),
  ];
}

/** `Open Door` → `Open Door Copy`, `Open Door Copy 2`, …, skipping names taken. */
function freeEventName(name: string, taken: ReadonlySet<string>): string {
  const isFree = (candidate: string) =>
    eventNameKeys({ name: candidate }).every((key) => !taken.has(key));
  if (isFree(name)) return name;
  const base = duplicateBaseName(name);
  let candidate = formatEventMemberName(base);
  for (let suffix = 2; !isFree(candidate); suffix += 1) {
    candidate = formatEventMemberName(`${base} ${suffix}`);
  }
  return candidate;
}

function leftOutNotice(titles: readonly string[]): string {
  const list =
    titles.length > 1
      ? `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`
      : titles[0];
  return `${list} ${titles.length > 1 ? "are" : "is"} already in this graph.`;
}

/**
 * What Paste and Duplicate do with event nodes, so a copy never shares an
 * identity with a node already there. A custom event gets a free name, shaped
 * like an actor's duplicate; an event that cannot be renamed (an engine or
 * component event, an input event, an override of a parent's event) is left
 * out when this graph already has it, with the wires to and from it.
 *
 * `classGraph` is the stored Class, so custom event names are unique across its
 * event graph and function graphs; `current` stands in for the open one.
 */
export function prepareClassGraphPaste(
  pasted: GraphPasteElements,
  current: GraphPasteElements,
  classGraph: SerializedGraph | null,
  activeFunctionId: string | null,
): GraphPasteResult {
  const present = new Set<string>();
  const currentWired = bindingWiredNodes(current.edges);
  const takenNames = new Set<string>();
  const claim = (typeId: string, data: Record<string, unknown>) => {
    if (typeId === CUSTOM_EVENT) for (const key of eventNameKeys(data)) takenNames.add(key);
  };
  for (const node of current.nodes) {
    const typeId = canvasTypeId(node);
    claim(typeId, node.data);
    const key = singletonEventKey(
      { typeId, properties: node.data },
      currentWired.has(node.id),
    );
    if (key !== undefined) present.add(key);
  }
  if (activeFunctionId) {
    for (const node of classGraph?.nodes ?? []) claim(node.type, node.data);
  }
  for (const [functionId, slice] of Object.entries(classGraph?.functionGraphs ?? {})) {
    if (functionId === activeFunctionId) continue;
    for (const node of slice.nodes) claim(node.type, node.data);
  }
  for (const member of classGraph?.members ?? []) {
    if (member.kind === "event") {
      for (const key of eventNameKeys({ name: member.name })) takenNames.add(key);
    }
  }

  const pastedWired = bindingWiredNodes(pasted.edges);
  const pastedGraph: SerializedGraph = {
    nodes: pasted.nodes.map((node) => ({
      id: node.id,
      type: canvasTypeId(node),
      position: node.position,
      data: node.data,
    })),
    edges: pasted.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
  };
  const nodes: PasteNode[] = [];
  const leftOut: string[] = [];
  for (const node of pasted.nodes) {
    const typeId = canvasTypeId(node);
    const name = formatEventMemberName(String(node.data.name ?? node.data.title ?? ""));
    if (typeId === CUSTOM_EVENT && name && canRenameCustomEvent(pastedGraph, node.id)) {
      const unique = freeEventName(name, takenNames);
      claim(typeId, { name: unique });
      nodes.push({
        ...node,
        data: { ...node.data, name: unique, title: formatEventTitle(unique) },
      });
      continue;
    }
    const key = singletonEventKey(
      { typeId, properties: node.data },
      pastedWired.has(node.id),
    );
    if (key !== undefined) {
      if (present.has(key)) {
        leftOut.push(
          typeof node.data.title === "string" && node.data.title
            ? node.data.title
            : formatEventTitle(typeId.replace(/^.*\./, "")),
        );
        continue;
      }
      present.add(key);
    }
    nodes.push(node);
  }
  return { nodes, ...(leftOut.length > 0 ? { notice: leftOutNotice(leftOut) } : {}) };
}
