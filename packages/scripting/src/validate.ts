import type { GraphNode, LogicGraph } from "./ir";
import { findNode, findPin } from "./ir";
import { compiledNodeIds } from "./compiled-nodes";
import { diagnostic, type Diagnostic } from "./diagnostics";
import {
  listValidationRules,
  type TypeContext,
  type ValidateOptions,
} from "./type-context";
import { isAssignable } from "./types";
import {
  isClassConstraintTypeId,
  isStructOrEnumTypeId,
} from "./member-pin-type";
import {
  pinAcceptsLiteralDefault,
  pinRejectsStoredDefault,
  readPinDefaultForPin,
} from "./pin-defaults";
import {
  pinTypeKey,
  resolveWildcardPinTypes,
} from "./wildcard-resolve";
import {
  normalizeIntSwitchCases,
  normalizeStringSwitchCases,
} from "./flow-switch-pins";
import { isBreakableLoopKind } from "./structured-flow";

function pinById(node: GraphNode, pinId: string) {
  return findPin(node, pinId);
}

function canonicalizeEdges(graph: LogicGraph): LogicGraph {
  const edges = graph.edges.map((edge) => {
    const source = findNode(graph, edge.sourceNodeId);
    const target = findNode(graph, edge.targetNodeId);
    if (!source || !target) return edge;
    const sp = pinById(source, edge.sourcePinId);
    const tp = pinById(target, edge.targetPinId);
    if (!sp || !tp) return edge;
    if (sp.direction !== "in" || tp.direction !== "out") return edge;
    return {
      ...edge,
      sourceNodeId: edge.targetNodeId,
      sourcePinId: edge.targetPinId,
      targetNodeId: edge.sourceNodeId,
      targetPinId: edge.sourcePinId,
    };
  });
  return { ...graph, edges };
}

function isPureEvalSource(
  node: GraphNode,
  registry: ValidateOptions["registry"],
): boolean {
  return registry?.get(node.typeId)?.pure === true;
}

function buildAdjacency(
  graph: LogicGraph,
  registry: ValidateOptions["registry"],
): {
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
    } else if (
      sp.kind === "data" &&
      tp.kind === "data" &&
      isPureEvalSource(source, registry)
    ) {
      dataDeps.get(target.id)!.push(source.id);
    }
  }
  return { execOut, dataDeps };
}

function hasCycle(
  adj: Map<string, string[]>,
  compiled: ReadonlySet<string>,
): string | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function dfs(id: string): string | null {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      const cycle = start >= 0 ? stack.slice(start) : [id];
      return cycle.find((nodeId) => compiled.has(nodeId)) ?? null;
    }
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

  for (const id of compiled) {
    const hit = dfs(id);
    if (hit) return hit;
  }
  return null;
}

function validateBreakContext(
  graph: LogicGraph,
  ctx: TypeContext,
  compiled: ReadonlySet<string>,
  options: ValidateOptions,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const registry = options.registry;
  const breakNodes = graph.nodes.filter((n) => {
    if (!compiled.has(n.id)) return false;
    const meta = registry?.get(n.typeId)?.structuredFlow;
    return meta?.kind === "break" || n.typeId === "flow.break";
  });
  if (breakNodes.length === 0) return out;

  const loopBodyReachable = new Set<string>();
  for (const node of graph.nodes) {
    if (!compiled.has(node.id)) continue;
    const meta = registry?.get(node.typeId)?.structuredFlow;
    const kind = meta?.kind;
    const breakable =
      isBreakableLoopKind(kind) ||
      node.typeId === "flow.forLoopWithBreak" ||
      node.typeId === "flow.forEachWithBreak" ||
      node.typeId === "flow.forEachMapWithBreak";
    if (!breakable) continue;
    const loopBodyPin =
      meta && "loopBodyPin" in meta
        ? meta.loopBodyPin
        : "loopBody";
    const queue: string[] = [];
    for (const edge of graph.edges) {
      if (edge.sourceNodeId !== node.id) continue;
      const srcPin = findPin(node, edge.sourcePinId);
      if (!srcPin || srcPin.kind !== "exec") continue;
      if (srcPin.name !== loopBodyPin && srcPin.id !== loopBodyPin) continue;
      if (!loopBodyReachable.has(edge.targetNodeId)) {
        loopBodyReachable.add(edge.targetNodeId);
        queue.push(edge.targetNodeId);
      }
    }
    while (queue.length > 0) {
      const id = queue.pop()!;
      for (const edge of graph.edges) {
        if (edge.sourceNodeId !== id) continue;
        const src = findNode(graph, id);
        const sp = src && findPin(src, edge.sourcePinId);
        if (!sp || sp.kind !== "exec") continue;
        if (loopBodyReachable.has(edge.targetNodeId)) continue;
        loopBodyReachable.add(edge.targetNodeId);
        queue.push(edge.targetNodeId);
      }
    }
  }

  for (const brk of breakNodes) {
    if (loopBodyReachable.has(brk.id)) continue;
    out.push(
      diagnostic({
        code: "flow.break_outside_loop",
        message: "Break must be inside a For Loop / For Each With Break body",
        assetGuid: ctx.assetGuid,
        graphId: graph.id,
        nodeId: brk.id,
      }),
    );
  }
  return out;
}

function validateStructural(
  graph: LogicGraph,
  ctx: TypeContext,
  compiled: ReadonlySet<string>,
  registry: ValidateOptions["registry"],
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const { execOut, dataDeps } = buildAdjacency(graph, registry);

  const execCycle = hasCycle(execOut, compiled);
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

  const dataCycle = hasCycle(dataDeps, compiled);
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
  const wildcards = resolveWildcardPinTypes(graph);
  for (const conflict of wildcards.conflicts) {
    out.push(
      diagnostic({
        code: "type.wildcard_group",
        message: conflict.message,
        assetGuid: ctx.assetGuid,
        graphId: graph.id,
        nodeId: conflict.nodeId,
        pinId: conflict.pinId,
        relatedNodeId: conflict.relatedNodeId,
      }),
    );
  }

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
      const from =
        wildcards.resolved.get(pinTypeKey(source.id, sp.id)) ?? sp.type;
      const to = wildcards.resolved.get(pinTypeKey(target.id, tp.id)) ?? tp.type;
      if (
        !isAssignable(from, to, {
          hierarchy: ctx.hierarchy,
        })
      ) {
        out.push(
          diagnostic({
            code: "type.mismatch",
            message: `Type mismatch: ${from.kind} is not assignable to ${to.kind}`,
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

  const seenDataTargets = new Set<string>();
  for (const edge of graph.edges) {
    const target = findNode(graph, edge.targetNodeId);
    if (!target) continue;
    const tp = pinById(target, edge.targetPinId);
    if (!tp || tp.kind !== "data" || tp.direction !== "in") continue;
    const key = `${edge.targetNodeId}:${edge.targetPinId}`;
    if (seenDataTargets.has(key)) {
      out.push(
        diagnostic({
          code: "pin.duplicate_connection",
          message: `Input "${tp.name}" already has a connection`,
          assetGuid: ctx.assetGuid,
          graphId: graph.id,
          nodeId: target.id,
          pinId: tp.id,
          relatedNodeId: edge.sourceNodeId,
        }),
      );
    }
    seenDataTargets.add(key);
  }

  for (const node of graph.nodes) {
    for (const pin of node.pins) {
      if (pin.direction !== "in" || pin.kind !== "data" || pin.optional) {
        continue;
      }
      const connected = graph.edges.some(
        (e) => e.targetNodeId === node.id && e.targetPinId === pin.id,
      );
      const stored = readPinDefaultForPin(node.properties, pin);
      const hasStored = stored !== undefined;
      if (hasStored && pinRejectsStoredDefault(pin.type)) {
        out.push(
          diagnostic({
            code: "pin.invalid_default",
            message: `Pin "${pin.name}" cannot store a literal default`,
            assetGuid: ctx.assetGuid,
            graphId: graph.id,
            nodeId: node.id,
            pinId: pin.id,
          }),
        );
      }
      if (!connected && pin.type.kind !== "exec") {
        const implicitSelfTarget =
          pin.name === "target" &&
          node.properties.implicitSelf === true &&
          (pin.type.kind === "objectRef" || pin.type.kind === "actorRef");
        const defaultClearsMissing =
          hasStored &&
          (pinAcceptsLiteralDefault(pin.type) ||
            pin.type.kind === "boxedWildcard");
        if (!defaultClearsMissing && !implicitSelfTarget) {
          const liveRef =
            pin.type.kind === "objectRef" || pin.type.kind === "actorRef";
          const owner = ctx.members?.find(
            (member) =>
              member.kind === "function" &&
              (member.id === graph.id || member.name === graph.id),
          );
          const interfaceOutput =
            node.typeId === "flow.function.output" &&
            (ctx.interfaceImplementation === true ||
              Boolean(owner?.implementsInterface));
          out.push(
            diagnostic({
              severity: liveRef || interfaceOutput ? "error" : "warning",
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

function stringProp(
  properties: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = properties[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Strip a leading "Event " so Call bindings match member body names. */
function eventBindingName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return raw.replace(/^(Event\s+)+/i, "").trim() || undefined;
}

function attachedComponentIds(ctx: TypeContext): Set<string> | undefined {
  if (!ctx.attachedComponents) return undefined;
  return new Set(ctx.attachedComponents.map((component) => component.id));
}

function matchingAttachedComponents(
  ctx: TypeContext,
  typeId: string,
): ReadonlyArray<{ id: string; classId: string }> | undefined {
  const classIds = ctx.eventTypeClassIds?.[typeId];
  if (!classIds || !ctx.attachedComponents) return undefined;
  const allowed = new Set(classIds);
  return ctx.attachedComponents.filter((component) =>
    allowed.has(component.classId),
  );
}

function isInheritedEventOverride(node: GraphNode): boolean {
  const qualifier = stringProp(node.properties, "eventQualifier");
  if (qualifier === "Inherited") return true;
  return (
    node.typeId === "flow.event.custom" &&
    !!stringProp(node.properties, "parentClassId")
  );
}

function inheritedEventName(node: GraphNode): string | undefined {
  return eventBindingName(
    stringProp(node.properties, "name") ??
      stringProp(node.properties, "title") ??
      stringProp(node.properties, "eventName"),
  );
}

function validateComponentAndInheritedBindings(
  graph: LogicGraph,
  ctx: TypeContext,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const attachedIds = attachedComponentIds(ctx);
  for (const node of graph.nodes) {
    if (ctx.parentEventNames && isInheritedEventOverride(node)) {
      const name = inheritedEventName(node);
      if (name && !ctx.parentEventNames.has(name)) {
        out.push(
          diagnostic({
            code: "event.missing_inherited",
            message: `Inherited event "${name}" is no longer declared on a parent class`,
            assetGuid: ctx.assetGuid,
            graphId: graph.id,
            nodeId: node.id,
          }),
        );
      }
    }

    const componentId = stringProp(node.properties, "componentId");
    if (componentId) {
      if (attachedIds && !attachedIds.has(componentId)) {
        out.push(
          diagnostic({
            code: "event.missing_component",
            message: `Component "${componentId}" is not attached to this class`,
            assetGuid: ctx.assetGuid,
            graphId: graph.id,
            nodeId: node.id,
            componentId,
          }),
        );
      }
      continue;
    }

    if (!node.typeId.startsWith("flow.event.")) continue;
    const matches = matchingAttachedComponents(ctx, node.typeId);
    if (!matches || matches.length === 1) continue;
    out.push(
      diagnostic({
        code: "event.missing_component",
        message:
          matches.length === 0
            ? `Event "${node.typeId}" has no attached component that exposes it`
            : `Event "${node.typeId}" is missing a component binding`,
        assetGuid: ctx.assetGuid,
        graphId: graph.id,
        nodeId: node.id,
      }),
    );
  }
  return out;
}

function validateMemberBindings(
  graph: LogicGraph,
  ctx: TypeContext,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const members = ctx.members ?? [];
  if (members.length === 0 && !ctx.knownClassIds) {
    // Still check local-name conflicts if members exist; skip stale lookups
    // when the editor did not supply a symbol table.
  }

  const classVars = members.filter(
    (member) => member.kind === "variable" && !member.functionId,
  );
  const locals = members.filter(
    (member) => member.kind === "variable" && member.functionId,
  );
  const seenLocal = new Set<string>();
  for (const local of locals) {
    const key = `${local.functionId}:${local.name}`;
    const classHit = classVars.some((entry) => entry.name === local.name);
    const duplicate = seenLocal.has(key);
    seenLocal.add(key);
    if (!classHit && !duplicate) continue;
    out.push(
      diagnostic({
        code: "member.local_name_conflict",
        message: classHit
          ? `Local variable "${local.name}" collides with a class variable`
          : `Local variable "${local.name}" is declared more than once`,
        assetGuid: ctx.assetGuid,
        graphId: graph.id,
      }),
    );
  }

  if (ctx.knownClassIds) {
    for (const member of members) {
      if (
        member.typeClassId &&
        isClassConstraintTypeId(member.typeId ?? "object") &&
        !ctx.knownClassIds.has(member.typeClassId)
      ) {
        out.push(
          diagnostic({
            code: "member.unknown_class",
            message: `Unknown class "${member.typeClassId}"`,
            assetGuid: ctx.assetGuid,
            graphId: graph.id,
          }),
        );
      }
    }
    for (const node of graph.nodes) {
      const typeId = stringProp(node.properties, "typeId");
      const typeClassId = stringProp(node.properties, "typeClassId");
      if (
        typeClassId &&
        isClassConstraintTypeId(typeId ?? "object") &&
        !ctx.knownClassIds.has(typeClassId)
      ) {
        out.push(
          diagnostic({
            code: "member.unknown_class",
            message: `Unknown class "${typeClassId}"`,
            assetGuid: ctx.assetGuid,
            graphId: graph.id,
            nodeId: node.id,
          }),
        );
      }
      for (const pin of node.pins) {
        if (
          (pin.type.kind === "objectRef" ||
            pin.type.kind === "actorRef" ||
            pin.type.kind === "classRef") &&
          pin.type.classId &&
          !ctx.knownClassIds.has(pin.type.classId)
        ) {
          out.push(
            diagnostic({
              code: "member.unknown_class",
              message: `Unknown class "${pin.type.classId}"`,
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

  if (members.length === 0) return out;

  for (const node of graph.nodes) {
    if (node.typeId === "variables.get" || node.typeId === "variables.set") {
      if (stringProp(node.properties, "componentId")) continue;
      const variableId = stringProp(node.properties, "variableId");
      const variableName = stringProp(node.properties, "variableName");
      const classId =
        stringProp(node.properties, "classId") ?? ctx.classId;
      const functionId =
        stringProp(node.properties, "functionId") ??
        ctx.activeFunctionId ??
        undefined;
      const local = node.properties.scope === "local";
      const found = members.find((member) => {
        if (member.kind !== "variable") return false;
        if (variableId && member.id === variableId) return true;
        if (!variableId && variableName && member.name === variableName) {
          if (local) return member.functionId === functionId;
          if (classId && member.classId !== classId) return false;
          return !member.functionId;
        }
        return false;
      });
      if (!found) {
        out.push(
          diagnostic({
            code: "member.missing_variable",
            message: `Variable "${variableName ?? variableId ?? "unknown"}" is not declared`,
            assetGuid: ctx.assetGuid,
            graphId: graph.id,
            nodeId: node.id,
          }),
        );
      } else if (local && found.functionId && found.functionId !== functionId) {
        out.push(
          diagnostic({
            code: "member.missing_variable",
            message: `Local variable "${found.name}" belongs to another function`,
            assetGuid: ctx.assetGuid,
            graphId: graph.id,
            nodeId: node.id,
          }),
        );
      }
      continue;
    }
    if (node.typeId === "functions.call") {
      const functionName = stringProp(node.properties, "functionName");
      const classId = stringProp(node.properties, "classId") ?? ctx.classId;
      const found = members.find((member) => {
        if (member.kind !== "function") return false;
        if (member.name !== functionName) return false;
        if (classId && member.classId !== classId) return false;
        return true;
      });
      if (!found) {
        out.push(
          diagnostic({
            code: "member.missing_function",
            message: `Function "${functionName ?? "unknown"}" is not declared`,
            assetGuid: ctx.assetGuid,
            graphId: graph.id,
            nodeId: node.id,
          }),
        );
      }
      continue;
    }
    if (node.typeId === "flow.event.call") {
      const eventName = eventBindingName(stringProp(node.properties, "name"));
      const classId = stringProp(node.properties, "classId") ?? ctx.classId;
      const found = members.find((member) => {
        if (member.kind !== "event") return false;
        if (eventBindingName(member.name) !== eventName) return false;
        if (classId && member.classId !== classId) return false;
        return true;
      });
      if (!found) {
        out.push(
          diagnostic({
            code: "member.missing_event",
            message: `Event "${eventName ?? "unknown"}" is not declared`,
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

type SignaturePin = {
  name: string;
  typeId: string;
  direction: "in" | "out";
  typeClassId?: string;
};

function signaturePinKey(pin: SignaturePin): string {
  return `${pin.direction}:${pin.name}:${pin.typeId}:${pin.typeClassId ?? ""}`;
}

function pinsMatch(
  actual: readonly SignaturePin[] | undefined,
  expected: readonly SignaturePin[] | undefined,
): boolean {
  const left = [...(actual ?? [])]
    .map(signaturePinKey)
    .sort((a, b) => a.localeCompare(b));
  const right = [...(expected ?? [])]
    .map(signaturePinKey)
    .sort((a, b) => a.localeCompare(b));
  if (left.length !== right.length) return false;
  return left.every((key, index) => key === right[index]);
}

function validateInterfaceAndOverrides(
  graphs: readonly LogicGraph[],
  ctx: TypeContext,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const graphId = graphs[0]?.id ?? "";
  const functions = (ctx.members ?? []).filter(
    (member) =>
      member.kind === "function" &&
      (!ctx.classId || member.classId === ctx.classId),
  );
  for (const iface of ctx.implementedInterfaces ?? []) {
    for (const method of iface.methods) {
      const impl = functions.find(
        (member) =>
          member.implementsInterface?.assetGuid === iface.guid &&
          member.implementsInterface.methodName === method.name,
      );
      if (!impl) {
        out.push(
          diagnostic({
            code: "interface.unimplemented",
            message: `Interface method "${method.name}" on ${iface.name} is not implemented`,
            assetGuid: ctx.assetGuid,
            graphId,
          }),
        );
        continue;
      }
      const implData = (impl.pins ?? []).filter((pin) => pin.typeId !== "exec");
      const methodData = method.pins.filter((pin) => pin.typeId !== "exec");
      if (!pinsMatch(implData, methodData)) {
        out.push(
          diagnostic({
            code: "interface.signature_mismatch",
            message: `Interface implementation "${method.name}" does not match ${iface.name}`,
            assetGuid: ctx.assetGuid,
            graphId,
          }),
        );
      }
    }
  }
  for (const member of functions) {
    if (!member.overrides) continue;
    const parent = (ctx.parentFunctionSignatures ?? []).find(
      (entry) =>
        entry.classId === member.overrides?.classId &&
        entry.name === member.overrides.name,
    );
    if (!parent) continue;
    if (!pinsMatch(member.pins, parent.pins)) {
      out.push(
        diagnostic({
          code: "member.override_signature",
          message: `Override "${member.name}" does not match ${member.overrides.classId}.${member.overrides.name}`,
          assetGuid: ctx.assetGuid,
          graphId,
        }),
      );
    }
  }
  return out;
}

function reportTypeGuid(
  out: Diagnostic[],
  ctx: TypeContext,
  graphId: string,
  kind: "structRef" | "enumRef",
  guid: string | undefined,
  nodeId?: string,
  pinId?: string,
): void {
  const unboundCode =
    kind === "structRef" ? "type.unbound_struct" : "type.unbound_enum";
  const label = kind === "structRef" ? "Structure" : "Enum";
  if (!guid) {
    out.push(
      diagnostic({
        code: unboundCode,
        message: `${label} type is not selected`,
        assetGuid: ctx.assetGuid,
        graphId,
        nodeId,
        pinId,
      }),
    );
    return;
  }
  if (ctx.knownGuids && !ctx.knownGuids.has(guid)) {
    out.push(
      diagnostic({
        code: "ref.unknown_guid",
        message: `Unknown ${label.toLowerCase()} "${guid}"`,
        assetGuid: ctx.assetGuid,
        graphId,
        nodeId,
        pinId,
      }),
    );
  }
}

function validateTypeRefs(
  graph: LogicGraph,
  ctx: TypeContext,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const member of ctx.members ?? []) {
    if (!isStructOrEnumTypeId(member.typeId)) continue;
    reportTypeGuid(
      out,
      ctx,
      graph.id,
      member.typeId === "struct" ? "structRef" : "enumRef",
      member.typeClassId?.trim() || undefined,
    );
  }
  for (const node of graph.nodes) {
    const typeId = stringProp(node.properties, "typeId");
    if (isStructOrEnumTypeId(typeId)) {
      reportTypeGuid(
        out,
        ctx,
        graph.id,
        typeId === "struct" ? "structRef" : "enumRef",
        stringProp(node.properties, "typeClassId"),
        node.id,
      );
    }
    const structGuid = stringProp(node.properties, "structGuid");
    if (node.typeId === "struct.make" || node.typeId === "struct.break") {
      reportTypeGuid(out, ctx, graph.id, "structRef", structGuid, node.id);
    }
    const enumGuid = stringProp(node.properties, "enumGuid");
    if (
      node.typeId === "enum.make" ||
      node.typeId === "enum.equals" ||
      node.typeId === "enum.notEquals" ||
      node.typeId === "enum.toString" ||
      node.typeId === "enum.switch" ||
      node.typeId === "enum.select"
    ) {
      reportTypeGuid(out, ctx, graph.id, "enumRef", enumGuid, node.id);
    }
    for (const pin of node.pins) {
      if (pin.type.kind === "structRef" || pin.type.kind === "enumRef") {
        reportTypeGuid(
          out,
          ctx,
          graph.id,
          pin.type.kind,
          pin.type.guid.trim() || undefined,
          node.id,
          pin.id,
        );
      }
    }
  }
  return out;
}

const EDGE_DIAGNOSTIC_CODES = new Set([
  "type.mismatch",
  "pin.direction",
  "pin.duplicate_connection",
  "ref.missing_pin",
  "ref.missing_node",
  "type.wildcard_group",
]);

function keepCompiledNodeDiagnostics(
  diagnostics: readonly Diagnostic[],
  compiled: ReadonlySet<string>,
): Diagnostic[] {
  return diagnostics.filter((d) => {
    if (!d.nodeId || compiled.has(d.nodeId)) return true;
    const related = d.relatedNodeId;
    return (
      !!related &&
      compiled.has(related) &&
      EDGE_DIAGNOSTIC_CODES.has(d.code)
    );
  });
}

function validateFlowSwitchCases(
  graph: LogicGraph,
  ctx: TypeContext,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const node of graph.nodes) {
    if (node.typeId !== "flow.switchInt" && node.typeId !== "flow.switchString") {
      continue;
    }
    const result =
      node.typeId === "flow.switchInt"
        ? normalizeIntSwitchCases(node.properties.cases)
        : normalizeStringSwitchCases(node.properties.cases);
    for (const warning of result.warnings) {
      out.push(
        diagnostic({
          severity: "warning",
          code: warning.code,
          message: warning.message,
          assetGuid: ctx.assetGuid,
          graphId: graph.id,
          nodeId: node.id,
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
  const canonicalGraphs = graphs.map(canonicalizeEdges);
  for (const graph of canonicalGraphs) {
    const compiled = compiledNodeIds(graph);
    const keep = (diags: readonly Diagnostic[]) =>
      keepCompiledNodeDiagnostics(diags, compiled);
    diagnostics.push(
      ...keep(validateStructural(graph, ctx, compiled, options.registry)),
    );
    diagnostics.push(...keep(validateBreakContext(graph, ctx, compiled, options)));
    diagnostics.push(...keep(validatePinTyping(graph, ctx)));
    diagnostics.push(...keep(validateExecuteJavaScript(graph, ctx)));
    diagnostics.push(...keep(validateMemberBindings(graph, ctx)));
    diagnostics.push(...keep(validateComponentAndInheritedBindings(graph, ctx)));
    diagnostics.push(...keep(validateTypeRefs(graph, ctx)));
    diagnostics.push(...keep(validateFlowSwitchCases(graph, ctx)));
  }
  diagnostics.push(...validateInterfaceAndOverrides(canonicalGraphs, ctx));
  for (const rule of listValidationRules()) {
    diagnostics.push(...rule.run(canonicalGraphs, ctx));
  }
  for (const rule of options.extraRules ?? []) {
    diagnostics.push(...rule.run(canonicalGraphs, ctx));
  }
  return diagnostics;
}
