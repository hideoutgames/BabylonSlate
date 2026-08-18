import { hierarchy, tree } from "d3-hierarchy";
import type { SerializedGraph } from "@babylonslate/core";
import type {
  BehaviourTreeDocument,
  BtAbortMode,
  BtDecorator,
  BtEvalState,
  BtNode,
  BtNodeKind,
  BtService,
} from "./types";
import { createDefaultBehaviourTree } from "./tree";
import { kindForCatalogClassId, titleForBtClassId } from "./catalog";
import type { BtEditorPosition } from "./types";

export const BT_NODE_TYPE = "bt.node";
export const BT_PARENT_HANDLE = "parent";
export const BT_CHILDREN_HANDLE = "children";
export const BT_LAYOUT_NODE_WIDTH = 220;
export const BT_LAYOUT_NODE_HEIGHT = 180;
export const BT_DUPLICATE_OFFSET: BtEditorPosition = { x: 40, y: 40 };

export type BtPin = {
  id: string;
  name: string;
  kind: "exec";
  direction: "in" | "out";
  type: { kind: "exec" };
};

export const BT_PARENT_PIN: BtPin = {
  id: BT_PARENT_HANDLE,
  name: "parent",
  kind: "exec",
  direction: "in",
  type: { kind: "exec" },
};

export const BT_CHILDREN_PIN: BtPin = {
  id: BT_CHILDREN_HANDLE,
  name: "children",
  kind: "exec",
  direction: "out",
  type: { kind: "exec" },
};

export function pinsForBtKind(
  kind: BtNodeKind,
  options?: { isRoot?: boolean },
): BtPin[] {
  const includeParent = options?.isRoot !== true;
  if (kind === "task") return includeParent ? [BT_PARENT_PIN] : [];
  return includeParent ? [BT_PARENT_PIN, BT_CHILDREN_PIN] : [BT_CHILDREN_PIN];
}

type HierarchyRow = {
  id: string;
  children: HierarchyRow[];
};

function computeBehaviourTreeLayout(
  doc: BehaviourTreeDocument,
): Map<string, BtEditorPosition> {
  const byId = new Map(doc.nodes.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const toRow = (id: string): HierarchyRow => {
    seen.add(id);
    const node = byId.get(id);
    const children = (node?.children ?? []).filter(
      (childId) => byId.has(childId) && !seen.has(childId),
    );
    return { id, children: children.map(toRow) };
  };
  const rootId = byId.has(doc.rootId) ? doc.rootId : doc.nodes[0]?.id;
  const positions = new Map<string, { x: number; y: number }>();
  if (!rootId) return positions;
  const root = hierarchy(toRow(rootId), (row) => row.children);
  tree<HierarchyRow>().nodeSize([BT_LAYOUT_NODE_WIDTH, BT_LAYOUT_NODE_HEIGHT])(
    root,
  );
  root.each((entry) => {
    positions.set(entry.data.id, { x: entry.x ?? 0, y: entry.y ?? 0 });
  });
  for (const node of doc.nodes) {
    if (!positions.has(node.id)) {
      positions.set(node.id, { x: 0, y: 0 });
    }
  }
  const xs = [...positions.values()].map((pos) => pos.x);
  const minX = Math.min(...xs, 0);
  const shiftX = minX < 40 ? 40 - minX : 0;
  for (const pos of positions.values()) {
    pos.x += shiftX;
    pos.y += 40;
  }
  return positions;
}

export function layoutBehaviourTree(
  doc: BehaviourTreeDocument,
): Map<string, BtEditorPosition> {
  const positions = computeBehaviourTreeLayout(doc);
  if (!doc.editorPositions) return positions;
  for (const [id, pos] of Object.entries(doc.editorPositions)) {
    if (!positions.has(id)) continue;
    positions.set(id, { x: pos.x, y: pos.y });
  }
  return positions;
}

function cloneEditorPositions(
  positions: Readonly<Record<string, BtEditorPosition>> | undefined,
): Record<string, BtEditorPosition> | undefined {
  if (!positions) return undefined;
  const out: Record<string, BtEditorPosition> = {};
  for (const [id, pos] of Object.entries(positions)) {
    out[id] = { x: pos.x, y: pos.y };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function withEditorPositions(
  doc: BehaviourTreeDocument,
  positions: Record<string, BtEditorPosition> | undefined,
): BehaviourTreeDocument {
  if (!positions || Object.keys(positions).length === 0) {
    if (!doc.editorPositions) return doc;
    const rest = { ...doc };
    delete rest.editorPositions;
    return rest;
  }
  return { ...doc, editorPositions: positions };
}

export function keepEditorPositionsFor(
  doc: BehaviourTreeDocument,
  ids: ReadonlySet<string>,
): Record<string, BtEditorPosition> | undefined {
  if (!doc.editorPositions) return undefined;
  const next: Record<string, BtEditorPosition> = {};
  for (const [id, pos] of Object.entries(doc.editorPositions)) {
    if (!ids.has(id)) continue;
    next[id] = { x: pos.x, y: pos.y };
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

export function arrangeBehaviourTree(
  doc: BehaviourTreeDocument,
): BehaviourTreeDocument {
  const computed = computeBehaviourTreeLayout(doc);
  const editorPositions: Record<string, BtEditorPosition> = {};
  for (const [id, pos] of computed) {
    editorPositions[id] = { x: pos.x, y: pos.y };
  }
  return withEditorPositions(doc, editorPositions);
}

export function applyNodePositions(
  doc: BehaviourTreeDocument,
  positions: Readonly<Record<string, { x: number; y?: number }>>,
): BehaviourTreeDocument {
  const known = new Set(doc.nodes.map((node) => node.id));
  const editorPositions = cloneEditorPositions(doc.editorPositions) ?? {};
  for (const [id, pos] of Object.entries(positions)) {
    if (!known.has(id)) continue;
    if (typeof pos.x !== "number" || !Number.isFinite(pos.x)) continue;
    const y =
      typeof pos.y === "number" && Number.isFinite(pos.y)
        ? pos.y
        : (editorPositions[id]?.y ?? 0);
    editorPositions[id] = { x: pos.x, y };
  }
  const next = withEditorPositions(doc, editorPositions);
  return reorderSiblingsByPosition(next, editorPositions);
}

export function reorderSiblingsByPosition(
  doc: BehaviourTreeDocument,
  positions: Readonly<Record<string, { x: number; y?: number }>>,
): BehaviourTreeDocument {
  return {
    ...doc,
    nodes: doc.nodes.map((node) => {
      if (node.children.length < 2) return node;
      const children = [...node.children].sort((left, right) => {
        const dx = (positions[left]?.x ?? 0) - (positions[right]?.x ?? 0);
        if (dx !== 0) return dx;
        return node.children.indexOf(left) - node.children.indexOf(right);
      });
      return { ...node, children };
    }),
  };
}

export type BtGraphOverlay = Pick<BtEvalState, "lastResults" | "btNodeId" | "stack">;

function sortIndexFor(doc: BehaviourTreeDocument, nodeId: string): number {
  for (const node of doc.nodes) {
    const index = node.children.indexOf(nodeId);
    if (index >= 0) return index;
  }
  return 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseAbortMode(value: unknown): BtAbortMode {
  if (value === "self" || value === "lowerPriority" || value === "both") {
    return value;
  }
  return "none";
}

function parseDecorators(value: unknown): BtDecorator[] {
  if (!Array.isArray(value)) return [];
  const out: BtDecorator[] = [];
  for (const entry of value) {
    const row = asRecord(entry);
    if (typeof row.id !== "string" || typeof row.classId !== "string") continue;
    out.push({
      id: row.id,
      classId: row.classId,
      abortMode: parseAbortMode(row.abortMode),
      observedKeys: Array.isArray(row.observedKeys)
        ? row.observedKeys.filter((key): key is string => typeof key === "string")
        : [],
      properties: asRecord(row.properties),
    });
  }
  return out;
}

function parseServices(value: unknown): BtService[] {
  if (!Array.isArray(value)) return [];
  const out: BtService[] = [];
  for (const entry of value) {
    const row = asRecord(entry);
    if (typeof row.id !== "string" || typeof row.classId !== "string") continue;
    out.push({
      id: row.id,
      classId: row.classId,
      intervalMs: typeof row.intervalMs === "number" ? row.intervalMs : 0,
      randomDeviationMs:
        typeof row.randomDeviationMs === "number" ? row.randomDeviationMs : 0,
      properties: asRecord(row.properties),
    });
  }
  return out;
}

function parseKind(value: unknown, classId: string): BtNodeKind {
  if (value === "selector" || value === "sequence" || value === "parallel" || value === "task") {
    return value;
  }
  return kindForCatalogClassId(classId);
}

export function behaviourTreeToSerialized(
  doc: BehaviourTreeDocument,
  overlay?: BtGraphOverlay,
): SerializedGraph {
  const positions = layoutBehaviourTree(doc);
  const running = new Set(overlay?.stack.map((frame) => frame.nodeId) ?? []);
  if (overlay?.btNodeId) running.add(overlay.btNodeId);
  return {
    nodes: doc.nodes.map((node) => ({
      id: node.id,
      type: BT_NODE_TYPE,
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      data: {
        title: titleForBtClassId(node.classId),
        kind: node.kind,
        classId: node.classId,
        sortIndex: sortIndexFor(doc, node.id),
        decorators: node.decorators.map((row) => ({
          ...row,
          title: titleForBtClassId(row.classId),
        })),
        services: node.services.map((row) => ({
          ...row,
          title: titleForBtClassId(row.classId),
        })),
        properties: node.properties,
        lastResult: overlay?.lastResults[node.id] ?? null,
        running: running.has(node.id),
        __pins: pinsForBtKind(node.kind, { isRoot: node.id === doc.rootId }),
        __protected: node.id === doc.rootId,
      },
    })),
    edges: doc.nodes.flatMap((node) =>
      node.children.map((childId) => ({
        id: `bt-${node.id}-${childId}`,
        source: node.id,
        target: childId,
        sourceHandle: BT_CHILDREN_HANDLE,
        targetHandle: BT_PARENT_HANDLE,
      })),
    ),
  };
}

export function serializedToBehaviourTree(
  graph: SerializedGraph,
  previous: BehaviourTreeDocument = createDefaultBehaviourTree(),
): BehaviourTreeDocument {
  const previousById = new Map(previous.nodes.map((node) => [node.id, node]));
  const childrenByParent = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.sourceHandle && edge.sourceHandle !== BT_CHILDREN_HANDLE) continue;
    const list = childrenByParent.get(edge.source) ?? [];
    list.push(edge.target);
    childrenByParent.set(edge.source, list);
  }
  for (const [parentId, childIds] of childrenByParent) {
    const previousChildren = previousById.get(parentId)?.children ?? [];
    const ordered = [...childIds].sort((left, right) => {
      const leftNode = graph.nodes.find((entry) => entry.id === left);
      const rightNode = graph.nodes.find((entry) => entry.id === right);
      const dx = (leftNode?.position.x ?? 0) - (rightNode?.position.x ?? 0);
      if (dx !== 0) return dx;
      return previousChildren.indexOf(left) - previousChildren.indexOf(right);
    });
    childrenByParent.set(parentId, ordered);
  }
  const nodes: BtNode[] = graph.nodes.map((entry) => {
    const data = asRecord(entry.data);
    const prev = previousById.get(entry.id);
    const classId =
      typeof data.classId === "string" && data.classId !== ""
        ? data.classId
        : prev?.classId ??
          (typeof data.title === "string" ? data.title : "bt.task.succeed");
    const kind = parseKind(data.kind, classId);
    return {
      id: entry.id,
      kind,
      classId,
      children: childrenByParent.get(entry.id) ?? [],
      decorators: Array.isArray(data.decorators)
        ? parseDecorators(data.decorators)
        : (prev?.decorators ?? []),
      services: Array.isArray(data.services)
        ? parseServices(data.services)
        : (prev?.services ?? []),
      properties: {
        ...(prev?.properties ?? {}),
        ...asRecord(data.properties),
      },
    };
  });
  const targeted = new Set(graph.edges.map((edge) => edge.target));
  const rootId =
    nodes.find((node) => node.id === previous.rootId)?.id ??
    nodes.find((node) => !targeted.has(node.id))?.id ??
    nodes[0]?.id ??
    previous.rootId;
  const editorPositions: Record<string, BtEditorPosition> = {};
  for (const entry of graph.nodes) {
    editorPositions[entry.id] = {
      x: entry.position.x,
      y: entry.position.y,
    };
  }
  return {
    name: previous.name,
    rootId,
    blackboardGuid: previous.blackboardGuid,
    nodes,
    ...(Object.keys(editorPositions).length > 0 ? { editorPositions } : {}),
  };
}

export function hydrateBehaviourTreeForEditor(
  graph: SerializedGraph,
): SerializedGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const data = asRecord(node.data);
      if (Array.isArray(data.__pins) && data.__pins.length > 0) {
        return { ...node, data };
      }
      const kind = parseKind(data.kind, String(data.classId ?? ""));
      return {
        ...node,
        data: {
          ...data,
          __pins: pinsForBtKind(kind, { isRoot: data.__protected === true }),
        },
      };
    }),
  };
}
