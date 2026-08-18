import { formatValue } from "@babylonslate/core";
import type { DebugInspectNode } from "@babylonslate/object-model";

export type FlattenedInspectNode = DebugInspectNode & {
  depth: number;
  hasChildren: boolean;
};

function nodeMatchesQuery(node: DebugInspectNode, query: string): boolean {
  if (!query) {
    return true;
  }
  const q = query.toLowerCase();
  return (
    node.label.toLowerCase().includes(q) ||
    node.classId.toLowerCase().includes(q) ||
    node.id.toLowerCase().includes(q)
  );
}

export function flattenInspectTree(
  nodes: DebugInspectNode[],
  expandedIds: Set<string>,
  query: string,
): FlattenedInspectNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const childrenByParent = new Map<string | null, DebugInspectNode[]>();
  for (const node of nodes) {
    const parentId = node.parentId;
    const key = parentId && byId.has(parentId) ? parentId : null;
    const list = childrenByParent.get(key) ?? [];
    list.push(node);
    childrenByParent.set(key, list);
  }

  const hasChildren = (id: string) =>
    (childrenByParent.get(id) ?? []).length > 0;

  const trimmed = query.trim();
  const matchingIds = new Set<string>();
  const ancestorIds = new Set<string>();
  if (trimmed) {
    for (const node of nodes) {
      if (!nodeMatchesQuery(node, trimmed)) {
        continue;
      }
      matchingIds.add(node.id);
      let parentId = node.parentId;
      while (parentId && byId.has(parentId)) {
        ancestorIds.add(parentId);
        parentId = byId.get(parentId)?.parentId ?? null;
      }
    }
  }

  const out: FlattenedInspectNode[] = [];
  const walk = (node: DebugInspectNode, depth: number) => {
    if (trimmed && !matchingIds.has(node.id) && !ancestorIds.has(node.id)) {
      return;
    }
    out.push({ ...node, depth, hasChildren: hasChildren(node.id) });
    const children = childrenByParent.get(node.id) ?? [];
    if (children.length === 0) {
      return;
    }
    const showChildren = trimmed ? true : expandedIds.has(node.id);
    if (!showChildren) {
      return;
    }
    for (const child of children) {
      walk(child, depth + 1);
    }
  };

  for (const root of childrenByParent.get(null) ?? []) {
    walk(root, 0);
  }
  return out;
}

export function nextInspectSelection(
  previousId: string | null,
  nodes: DebugInspectNode[],
): string | null {
  if (!previousId) {
    return null;
  }
  return nodes.some((node) => node.id === previousId) ? previousId : null;
}

export function formatInspectVariable(value: unknown): string {
  return formatValue(value);
}
