import type {
  BehaviourTreeDocument,
  BtDecorator,
  BtNode,
  BtService,
} from "./types";
import { defaultPropertiesForClassId, kindForCatalogClassId } from "./catalog";

function uniqueId(prefix: string, used: Set<string>): string {
  let index = 1;
  let id = `${prefix}-${index}`;
  while (used.has(id)) {
    index += 1;
    id = `${prefix}-${index}`;
  }
  return id;
}

function usedIds(doc: BehaviourTreeDocument): Set<string> {
  const used = new Set<string>();
  for (const node of doc.nodes) {
    used.add(node.id);
    for (const row of node.decorators) used.add(row.id);
    for (const row of node.services) used.add(row.id);
  }
  return used;
}

function patchNode(
  doc: BehaviourTreeDocument,
  nodeId: string,
  patch: Partial<BtNode> | ((node: BtNode) => BtNode),
): BehaviourTreeDocument {
  return {
    ...doc,
    nodes: doc.nodes.map((node) => {
      if (node.id !== nodeId) return node;
      return typeof patch === "function" ? patch(node) : { ...node, ...patch };
    }),
  };
}

function subtreeIds(doc: BehaviourTreeDocument, rootId: string): Set<string> {
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const out = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    const node = byId.get(id);
    if (node) stack.push(...node.children);
  }
  return out;
}

export function wrapInSequence(
  doc: BehaviourTreeDocument,
  nodeId: string,
): BehaviourTreeDocument {
  if (!doc.nodes.some((node) => node.id === nodeId)) return doc;
  const used = usedIds(doc);
  const wrapperId = uniqueId("sequence", used);
  const wrapper: BtNode = {
    id: wrapperId,
    kind: "sequence",
    classId: "bt.composite.sequence",
    children: [nodeId],
    decorators: [],
    services: [],
    properties: {},
  };
  if (doc.rootId === nodeId) {
    return { ...doc, rootId: wrapperId, nodes: [...doc.nodes, wrapper] };
  }
  return {
    ...doc,
    nodes: [
      ...doc.nodes.map((node) =>
        node.children.includes(nodeId)
          ? {
              ...node,
              children: node.children.map((childId) =>
                childId === nodeId ? wrapperId : childId,
              ),
            }
          : node,
      ),
      wrapper,
    ],
  };
}

function cloneNode(node: BtNode, idMap: Map<string, string>): BtNode {
  return {
    ...node,
    id: idMap.get(node.id) ?? node.id,
    children: node.children.map((childId) => idMap.get(childId) ?? childId),
    decorators: node.decorators.map((row) => ({
      ...row,
      id: idMap.get(row.id) ?? row.id,
      properties: { ...row.properties },
      observedKeys: [...row.observedKeys],
    })),
    services: node.services.map((row) => ({
      ...row,
      id: idMap.get(row.id) ?? row.id,
      properties: { ...row.properties },
    })),
    properties: { ...node.properties },
  };
}

export function duplicateSubtree(
  doc: BehaviourTreeDocument,
  nodeId: string,
): BehaviourTreeDocument {
  const source = doc.nodes.find((node) => node.id === nodeId);
  if (!source) return doc;
  const ids = subtreeIds(doc, nodeId);
  const used = usedIds(doc);
  const idMap = new Map<string, string>();
  for (const id of ids) {
    const prefix = id.replace(/-\d+$/, "") || "node";
    const nextId = uniqueId(prefix, used);
    used.add(nextId);
    idMap.set(id, nextId);
  }
  for (const node of doc.nodes) {
    if (!ids.has(node.id)) continue;
    for (const row of [...node.decorators, ...node.services]) {
      const nextId = uniqueId(row.id.replace(/-\d+$/, "") || "attach", used);
      used.add(nextId);
      idMap.set(row.id, nextId);
    }
  }
  const clones = doc.nodes
    .filter((node) => ids.has(node.id))
    .map((node) => cloneNode(node, idMap));
  const cloneRoot = idMap.get(nodeId)!;
  if (doc.rootId === nodeId) {
    return { ...doc, nodes: [...doc.nodes, ...clones] };
  }
  return {
    ...doc,
    nodes: [
      ...doc.nodes.map((node) => {
        const index = node.children.indexOf(nodeId);
        if (index < 0) return node;
        const children = [...node.children];
        children.splice(index + 1, 0, cloneRoot);
        return { ...node, children };
      }),
      ...clones,
    ],
  };
}

export function deleteSubtree(
  doc: BehaviourTreeDocument,
  nodeId: string,
): BehaviourTreeDocument {
  if (nodeId === doc.rootId) return doc;
  if (!doc.nodes.some((node) => node.id === nodeId)) return doc;
  const ids = subtreeIds(doc, nodeId);
  return {
    ...doc,
    nodes: doc.nodes
      .filter((node) => !ids.has(node.id))
      .map((node) => ({
        ...node,
        children: node.children.filter((childId) => !ids.has(childId)),
      })),
  };
}

export function addDecorator(
  doc: BehaviourTreeDocument,
  nodeId: string,
  classId: string,
): BehaviourTreeDocument {
  const node = doc.nodes.find((entry) => entry.id === nodeId);
  if (!node) return doc;
  const used = usedIds(doc);
  const row: BtDecorator = {
    id: uniqueId("decorator", used),
    classId,
    abortMode: "none",
    observedKeys: [],
    properties: defaultPropertiesForClassId(classId),
  };
  return patchNode(doc, nodeId, {
    decorators: [...node.decorators, row],
  });
}

export function addService(
  doc: BehaviourTreeDocument,
  nodeId: string,
  classId: string,
): BehaviourTreeDocument {
  const node = doc.nodes.find((entry) => entry.id === nodeId);
  if (!node) return doc;
  const used = usedIds(doc);
  const row: BtService = {
    id: uniqueId("service", used),
    classId,
    intervalMs: 250,
    randomDeviationMs: 0,
    properties: defaultPropertiesForClassId(classId),
  };
  return patchNode(doc, nodeId, {
    services: [...node.services, row],
  });
}

export function removeAttachment(
  doc: BehaviourTreeDocument,
  nodeId: string,
  attachmentId: string,
): BehaviourTreeDocument {
  return patchNode(doc, nodeId, (node) => ({
    ...node,
    decorators: node.decorators.filter((row) => row.id !== attachmentId),
    services: node.services.filter((row) => row.id !== attachmentId),
  }));
}

export function moveAttachment(
  doc: BehaviourTreeDocument,
  nodeId: string,
  attachmentId: string,
  delta: number,
): BehaviourTreeDocument {
  return patchNode(doc, nodeId, (node) => {
    const inDecorators = node.decorators.findIndex((row) => row.id === attachmentId);
    if (inDecorators >= 0) {
      const nextIndex = inDecorators + delta;
      if (nextIndex < 0 || nextIndex >= node.decorators.length) return node;
      const decorators = [...node.decorators];
      const [row] = decorators.splice(inDecorators, 1);
      decorators.splice(nextIndex, 0, row!);
      return { ...node, decorators };
    }
    const inServices = node.services.findIndex((row) => row.id === attachmentId);
    if (inServices < 0) return node;
    const nextIndex = inServices + delta;
    if (nextIndex < 0 || nextIndex >= node.services.length) return node;
    const services = [...node.services];
    const [row] = services.splice(inServices, 1);
    services.splice(nextIndex, 0, row!);
    return { ...node, services };
  });
}

export function pruneUnreachable(
  doc: BehaviourTreeDocument,
): BehaviourTreeDocument {
  const keep = subtreeIds(doc, doc.rootId);
  return {
    ...doc,
    nodes: doc.nodes
      .filter((node) => keep.has(node.id))
      .map((node) => ({
        ...node,
        children: node.children.filter((childId) => keep.has(childId)),
      })),
  };
}

export function addChildNode(
  doc: BehaviourTreeDocument,
  parentId: string,
  classId: string,
  parentOf?: (id: string) => string | null | undefined,
): BehaviourTreeDocument {
  const parent = doc.nodes.find((node) => node.id === parentId);
  if (!parent || parent.kind === "task") return doc;
  const used = usedIds(doc);
  const kind = kindForCatalogClassId(classId, parentOf);
  const id = uniqueId(kind === "task" ? "task" : kind, used);
  const child: BtNode = {
    id,
    kind,
    classId,
    children: [],
    decorators: [],
    services: [],
    properties: defaultPropertiesForClassId(classId),
  };
  return {
    ...doc,
    nodes: [
      ...doc.nodes.map((node) =>
        node.id === parentId ? { ...node, children: [...node.children, id] } : node,
      ),
      child,
    ],
  };
}
