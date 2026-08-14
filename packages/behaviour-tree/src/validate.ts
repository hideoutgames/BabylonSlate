import { diagnostic, type Diagnostic, type TypeContext } from "@babylonslate/scripting";
import type { BehaviourTreeDocument, BtNode } from "./types";

export type BehaviourTreeValidateContext = Pick<TypeContext, "assetGuid"> & {
  blackboardKeys?: readonly string[];
};

function byId(doc: BehaviourTreeDocument): Map<string, BtNode> {
  return new Map(doc.nodes.map((node) => [node.id, node]));
}

function hasCycle(doc: BehaviourTreeDocument, nodes: Map<string, BtNode>): string | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function walk(id: string): string | null {
    if (visiting.has(id)) return id;
    if (visited.has(id)) return null;
    visiting.add(id);
    const node = nodes.get(id);
    for (const childId of node?.children ?? []) {
      const hit = walk(childId);
      if (hit) return hit;
    }
    visiting.delete(id);
    visited.add(id);
    return null;
  }

  return walk(doc.rootId);
}

function referencedKeys(node: BtNode): string[] {
  const keys: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value !== "") keys.push(value);
  };
  push(node.properties.key);
  for (const row of node.decorators) {
    push(row.properties.key);
    for (const key of row.observedKeys) push(key);
  }
  for (const row of node.services) push(row.properties.key);
  return [...new Set(keys)];
}

export function validateBehaviourTree(
  doc: BehaviourTreeDocument,
  ctx: BehaviourTreeValidateContext,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const nodes = byId(doc);
  const graphId = "tree";

  if (!nodes.has(doc.rootId)) {
    out.push(
      diagnostic({
        code: "bt.missing_root",
        message: `Root "${doc.rootId}" is not in the tree`,
        assetGuid: ctx.assetGuid,
        graphId,
        nodeId: doc.rootId,
      }),
    );
  }

  for (const node of doc.nodes) {
    if (node.kind === "task" && node.children.length > 0) {
      out.push(
        diagnostic({
          code: "bt.task_has_children",
          message: `Task "${node.id}" cannot own children`,
          assetGuid: ctx.assetGuid,
          graphId,
          nodeId: node.id,
        }),
      );
    }
    if (node.kind !== "task" && node.children.length === 0) {
      out.push(
        diagnostic({
          code: "bt.composite_empty",
          message: `Composite "${node.id}" has no children`,
          assetGuid: ctx.assetGuid,
          graphId,
          nodeId: node.id,
        }),
      );
    }
    if (node.kind === "parallel" && node.children.length < 2) {
      out.push(
        diagnostic({
          code: "bt.parallel_too_small",
          message: `Parallel "${node.id}" needs at least two children`,
          assetGuid: ctx.assetGuid,
          graphId,
          nodeId: node.id,
        }),
      );
    }
    if (ctx.blackboardKeys) {
      const known = new Set(ctx.blackboardKeys);
      for (const key of referencedKeys(node)) {
        if (known.has(key)) continue;
        out.push(
          diagnostic({
            code: "bt.missing_blackboard_key",
            message: `Blackboard key "${key}" is not declared`,
            assetGuid: ctx.assetGuid,
            graphId,
            nodeId: node.id,
          }),
        );
      }
    }
    for (const childId of node.children) {
      if (!nodes.has(childId)) {
        out.push(
          diagnostic({
            code: "bt.unknown_child",
            message: `Node "${node.id}" references missing child "${childId}"`,
            assetGuid: ctx.assetGuid,
            graphId,
            nodeId: node.id,
          }),
        );
      }
    }
  }

  if (nodes.has(doc.rootId) && hasCycle(doc, nodes)) {
    out.push(
      diagnostic({
        code: "bt.cycle",
        message: "Tree has a parent-child cycle",
        assetGuid: ctx.assetGuid,
        graphId,
        nodeId: doc.rootId,
      }),
    );
  }

  return out;
}
