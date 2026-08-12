import type { GraphEdge, GraphNode, LogicGraph } from "./ir";
import { findNode, findPin } from "./ir";
import { diagnostic, type Diagnostic } from "./diagnostics";
import {
  listValidationRules,
  type TypeContext,
  type ValidateOptions,
} from "./type-context";
import { isAssignable, type PinType } from "./types";

function pinById(node: GraphNode, pinId: string) {
  return findPin(node, pinId);
}

function buildAdjacency(graph: LogicGraph): {
  execOut: Map<string, string[]>;
  dataDeps: Map<string, string[]>;
} {
  const execOut = new Map<string, string[]>();
  const dataDeps = new Map<string, string[]>();
  for (const node of graph.nodes) {
    execOut.set(node.id, []);
    dataDeps.set(node.id, []);
  }
  for (const edge of graph.edges) {
    const source = findNode(graph, edge.sourceNodeId);
    const target = findNode(graph, edge.targetNodeId);
    if (!source || !target) continue;
    const sp = pinById(source, edge.sourcePinId);
    const tp = pinById(target, edge.targetPinId);
    if (!sp || !tp) continue;
    if (sp.kind === "exec" && tp.kind === "exec") {
      execOut.get(source.id)!.push(target.id);
    } else if (sp.kind === "data" && tp.kind === "data") {
      dataDeps.get(target.id)!.push(source.id);
    }
  }
  return { execOut, dataDeps };
}

function hasCycle(adj: Map<string, string[]>): string | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function dfs(id: string): string | null {
    if (visiting.has(id)) return id;
    if (visited.has(id)) return null;
    visiting.add(id);
    stack.push(id);
    for (const next of adj.get(id) ?? []) {
      const hit = dfs(next);
      if (hit) return hit;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  }

  for (const id of adj.keys()) {
    const hit = dfs(id);
    if (hit) return hit;
  }
  return null;
}

function resolveWildcards(
  graph: LogicGraph,
  edge: GraphEdge,
): { from: PinType; to: PinType } | null {
  const source = findNode(graph, edge.sourceNodeId);
  const target = findNode(graph, edge.targetNodeId);
  if (!source || !target) return null;
  const sp = pinById(source, edge.sourcePinId);
  const tp = pinById(target, edge.targetPinId);
  if (!sp || !tp) return null;
  return { from: sp.type, to: tp.type };
}

function validateStructural(
  graph: LogicGraph,
  ctx: TypeContext,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const { execOut, dataDeps } = buildAdjacency(graph);

  const execCycle = hasCycle(execOut);
  if (execCycle) {
    out.push(
      diagnostic({
        code: "exec.cycle",
        message: `Execution cycle involving node ${execCycle}`,
        assetGuid: ctx.assetGuid,
        graphId: graph.id,
        nodeId: execCycle,
      }),
    );
  }

  const dataCycle = hasCycle(dataDeps);
  if (dataCycle) {
    out.push(
      diagnostic({
        code: "pure.cycle",
        message: `Pure data cycle involving node ${dataCycle}`,
        assetGuid: ctx.assetGuid,
        graphId: graph.id,
        nodeId: dataCycle,
      }),
    );
  }

  const entryNodes = graph.nodes.filter((n) =>
    n.pins.some((p) => p.kind === "exec" && p.direction === "in"),
  );
  const hasIncomingExec = new Set(
    graph.edges
      .filter((e) => {
        const src = findNode(graph, e.sourceNodeId);
        const sp = src && pinById(src, e.sourcePinId);
        return sp?.kind === "exec";
      })
      .map((e) => e.targetNodeId),
  );

  for (const node of entryNodes) {
    const isEventLike =
      node.typeId.startsWith("flow.event") ||
      node.typeId === "flow.entry" ||
      node.pins.every(
        (p) => !(p.kind === "exec" && p.direction === "in"),
      );
    if (!isEventLike && !hasIncomingExec.has(node.id)) {
      // Only flag if the node has both exec in and is not an entry producer.
      if (node.pins.some((p) => p.kind === "exec" && p.direction === "in")) {
        out.push(
          diagnostic({
            severity: "warning",
            code: "exec.unreachable",
            message: `Node ${node.id} has no incoming exec connection`,
            assetGuid: ctx.assetGuid,
            graphId: graph.id,
            nodeId: node.id,
          }),
        );
      }
    }
  }

  return out;
}

function validatePinTyping(
  graph: LogicGraph,
  ctx: TypeContext,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const edge of graph.edges) {
    const source = findNode(graph, edge.sourceNodeId);
    const target = findNode(graph, edge.targetNodeId);
    if (!source || !target) {
      out.push(
        diagnostic({
          code: "ref.missing_node",
          message: "Edge references a missing node",
          assetGuid: ctx.assetGuid,
          graphId: graph.id,
          nodeId: edge.sourceNodeId,
          relatedNodeId: edge.targetNodeId,
        }),
      );
      continue;
    }
    const sp = pinById(source, edge.sourcePinId);
    const tp = pinById(target, edge.targetPinId);
    if (!sp || !tp) {
      out.push(
        diagnostic({
          code: "ref.missing_pin",
          message: "Edge references a missing pin",
          assetGuid: ctx.assetGuid,
          graphId: graph.id,
          nodeId: source.id,
          relatedNodeId: target.id,
        }),
      );
      continue;
    }
    if (sp.direction !== "out" || tp.direction !== "in") {
      out.push(
        diagnostic({
          code: "pin.direction",
          message: "Edge must connect an output pin to an input pin",
          assetGuid: ctx.assetGuid,
          graphId: graph.id,
          nodeId: source.id,
          pinId: sp.id,
          relatedNodeId: target.id,
        }),
      );
      continue;
    }
    if (sp.kind !== tp.kind) {
      out.push(
        diagnostic({
          code: "type.mismatch",
          message: `Cannot connect ${sp.kind} pin to ${tp.kind} pin`,
          assetGuid: ctx.assetGuid,
          graphId: graph.id,
          nodeId: target.id,
          pinId: tp.id,
          relatedNodeId: source.id,
        }),
      );
      continue;
    }
    if (sp.kind === "data") {
      const resolved = resolveWildcards(graph, edge);
      if (
        resolved &&
        !isAssignable(resolved.from, resolved.to, {
          hierarchy: ctx.hierarchy,
        })
      ) {
        out.push(
          diagnostic({
            code: "type.mismatch",
            message: `Type mismatch: ${resolved.from.kind} is not assignable to ${resolved.to.kind}`,
            assetGuid: ctx.assetGuid,
            graphId: graph.id,
            nodeId: target.id,
            pinId: tp.id,
            relatedNodeId: source.id,
          }),
        );
      }
    }
  }

  for (const node of graph.nodes) {
    for (const pin of node.pins) {
      if (pin.direction !== "in" || pin.kind !== "data" || pin.optional) {
        continue;
      }
      const connected = graph.edges.some(
        (e) => e.targetNodeId === node.id && e.targetPinId === pin.id,
      );
      if (!connected && pin.type.kind !== "exec") {
        // Required data inputs without a default property key.
        const hasDefault =
          node.properties[`default:${pin.name}`] !== undefined ||
          node.properties[pin.name] !== undefined;
        if (!hasDefault) {
          out.push(
            diagnostic({
              severity: "warning",
              code: "pin.missing_input",
              message: `Required input "${pin.name}" is not connected`,
              assetGuid: ctx.assetGuid,
              graphId: graph.id,
              nodeId: node.id,
              pinId: pin.id,
            }),
          );
        }
      }
    }
  }

  return out;
}

function validateExecuteJavaScript(
  graph: LogicGraph,
  ctx: TypeContext,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const node of graph.nodes) {
    if (node.typeId !== "debug.executeJavaScript") continue;
    const body = String(node.properties.body ?? "");
    try {
      // Parse as a function body.
      // eslint-disable-next-line no-new-func
      new Function(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const match = /:(\d+):(\d+)/.exec(message);
      out.push(
        diagnostic({
          code: "js.parse",
          message: `ExecuteJavaScript parse error: ${message}`,
          assetGuid: ctx.assetGuid,
          graphId: graph.id,
          nodeId: node.id,
          bodyLine: match ? Number(match[1]) : 1,
          bodyColumn: match ? Number(match[2]) : 1,
        }),
      );
    }
  }
  return out;
}

export function validateGraphs(
  graphs: readonly LogicGraph[],
  ctx: TypeContext,
  options: ValidateOptions = {},
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const graph of graphs) {
    diagnostics.push(...validateStructural(graph, ctx));
    diagnostics.push(...validatePinTyping(graph, ctx));
    diagnostics.push(...validateExecuteJavaScript(graph, ctx));
  }
  for (const rule of listValidationRules()) {
    diagnostics.push(...rule.run(graphs, ctx));
  }
  for (const rule of options.extraRules ?? []) {
    diagnostics.push(...rule.run(graphs, ctx));
  }
  return diagnostics;
}
