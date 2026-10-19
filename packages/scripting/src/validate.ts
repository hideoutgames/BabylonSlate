import { formatEventTitle, humanizePropertyLabel } from "@babylonslate/core";
import type { GraphEdge, GraphNode, GraphPin, LogicGraph } from "./ir";
import { findNode, findPin } from "./ir";
import { compiledNodeIds, entryNodes } from "./compiled-nodes";
import { diagnostic, type Diagnostic } from "./diagnostics";
import {
  listValidationRules,
  type TypeContext,
  type ValidateOptions,
} from "./type-context";
import { isAssignable, pinTypeEquals } from "./types";
import { isWritableVariableOutput } from "./variable-references";
import {
  isClassConstraintTypeId,
  isMemberTypeId,
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
import { eventNameForEntry } from "./compile";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as FunctionConstructor;

function pinById(node: GraphNode, pinId: string) {
  return findPin(node, pinId);
}

/** First edge into an input pin; later duplicate wires are not reported through it. */
type IncomingEdge = (nodeId: string, pinId: string) => GraphEdge | undefined;

function indexIncomingEdges(graph: LogicGraph): IncomingEdge {
  const byNode = new Map<string, Map<string, GraphEdge>>();
  for (const edge of graph.edges) {
    let pins = byNode.get(edge.targetNodeId);
    if (!pins) byNode.set(edge.targetNodeId, (pins = new Map()));
    if (!pins.has(edge.targetPinId)) pins.set(edge.targetPinId, edge);
  }
  return (nodeId, pinId) => byNode.get(nodeId)?.get(pinId);
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
  dataDeps: Map<string, string[]>;
} {
  const dataDeps = new Map<string, string[]>();
  for (const node of graph.nodes) {
    dataDeps.set(node.id, []);
  }
  for (const edge of graph.edges) {
    const source = findNode(graph, edge.sourceNodeId);
    const target = findNode(graph, edge.targetNodeId);
    if (!source || !target) continue;
    const sp = pinById(source, edge.sourcePinId);
    const tp = pinById(target, edge.targetPinId);
    if (!sp || !tp) continue;
    // A reversed wire reports pin.direction; it is not a dependency.
    if (sp.direction !== "out" || tp.direction !== "in") continue;
    if (
      sp.kind === "data" &&
      tp.kind === "data" &&
      isPureEvalSource(source, registry)
    ) {
      dataDeps.get(target.id)!.push(source.id);
    }
  }
  return { dataDeps };
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
      node.typeId === "flow.whileLoop" ||
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
        message: "Break must be inside a While Loop or a For Loop / For Each With Break body",
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
  incoming: IncomingEdge,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const { dataDeps } = buildAdjacency(graph, registry);

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

  const execAdjacency = new Map(graph.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of graph.edges) {
    const source = findNode(graph, edge.sourceNodeId);
    const target = findNode(graph, edge.targetNodeId);
    if (!source || !target) continue;
    // Warn only on unconditional synchronous paths. Branches and stateful
    // flow controls may exit; latent actions yield to the runtime.
    const definition = registry?.get(source.typeId);
    if (definition?.latent || definition?.structuredFlow || source.properties.async === true ||
      source.pins.filter((pin) => pin.kind === "exec" && pin.direction === "out").length !== 1 ||
      source.pins.filter((pin) => pin.kind === "exec" && pin.direction === "in").length > 1) continue;
    if (findPin(source, edge.sourcePinId)?.kind === "exec" &&
      findPin(target, edge.targetPinId)?.kind === "exec") {
      execAdjacency.get(source.id)!.push(target.id);
    }
  }
  const execCycle = hasCycle(execAdjacency, compiled);
  if (execCycle) {
    out.push(diagnostic({ severity: "warning", code: "exec.cycle",
      message: "Execution cycle may run indefinitely. Ensure it exits or yields through a latent action.",
      assetGuid: ctx.assetGuid, graphId: graph.id, nodeId: execCycle }));
  }
  for (const node of graph.nodes) {
    if (!compiled.has(node.id) || node.typeId !== "flow.whileLoop") continue;
    const condition = node.pins.find((pin) => pin.id === "condition");
    if (!condition || !isConstantTrue(graph, incoming, node, condition.id)) continue;
    out.push(diagnostic({ severity: "warning", code: "flow.constant_loop",
      message: "While Loop condition is always True. Ensure the loop body breaks or yields.",
      assetGuid: ctx.assetGuid, graphId: graph.id, nodeId: node.id, pinId: condition.id }));
  }

  return out;
}

/**
 * True when an input is the literal True: its unwired default, or a wire from
 * a Make Bool whose own input is (recursively) the literal True.
 */
function isConstantTrue(
  graph: LogicGraph,
  incoming: IncomingEdge,
  node: GraphNode,
  pinId: string,
  seen = new Set<string>(),
): boolean {
  const pin = findPin(node, pinId);
  if (!pin || seen.has(node.id)) return false;
  seen.add(node.id);
  const edge = incoming(node.id, pinId);
  if (!edge) return readPinDefaultForPin(node.properties, pin) === true;
  const source = findNode(graph, edge.sourceNodeId);
  return source?.typeId === "literal.makeBool" && isConstantTrue(graph, incoming, source, "in", seen);
}

function validatePinTyping(
  graph: LogicGraph,
  ctx: TypeContext,
  registry: ValidateOptions["registry"],
  incoming: IncomingEdge,
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
      const requiresReference = tp.reference === "required" ||
        registry?.get(target.typeId)?.pins(target.properties).find((pin) => pin.id === tp.id)?.reference === "required";
      if (requiresReference && (!isWritableVariableOutput(source, sp, ctx.members) || !pinTypeEquals(from, to))) {
        out.push(diagnostic({
          code: "pin.invalid_reference",
          message: `Input "${tp.name}" requires a writable ${to.kind} variable; values and read-only properties cannot be reference targets`,
          assetGuid: ctx.assetGuid, graphId: graph.id, nodeId: target.id,
          pinId: tp.id, relatedNodeId: source.id,
        }));
      }
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

  // Each exec output drives one wire (inputs may merge many). Graphs saved
  // before the editor enforced that still compile, wire after wire.
  const execFanOut = new Map<string, number>();
  for (const edge of graph.edges) {
    const source = findNode(graph, edge.sourceNodeId);
    const sp = source ? pinById(source, edge.sourcePinId) : undefined;
    if (!sp || sp.kind !== "exec" || sp.direction !== "out") continue;
    const key = `${edge.sourceNodeId}\u0000${edge.sourcePinId}`;
    execFanOut.set(key, (execFanOut.get(key) ?? 0) + 1);
  }
  for (const [key, count] of execFanOut) {
    if (count < 2) continue;
    const [nodeId, pinId] = key.split("\u0000") as [string, string];
    const pin = pinById(findNode(graph, nodeId)!, pinId)!;
    out.push(
      diagnostic({
        severity: "warning",
        code: "exec.multiple_wires",
        message: `Exec output "${pin.name}" has ${count} wires; an exec output supports one. Use a Sequence node to run several in order.`,
        assetGuid: ctx.assetGuid,
        graphId: graph.id,
        nodeId,
        pinId,
      }),
    );
  }

  for (const node of graph.nodes) {
    let catalogPins: readonly GraphPin[] | undefined;
    const catalogPinOf = (pinId: string) => {
      catalogPins ??= registry?.get(node.typeId)?.pins(node.properties) ?? [];
      return catalogPins.find((entry) => entry.id === pinId);
    };
    for (const pin of node.pins) {
      if (pin.direction !== "in" || pin.kind !== "data" || pin.optional) {
        continue;
      }
      const catalogPin = catalogPinOf(pin.id);
      const connected = incoming(node.id, pin.id) !== undefined;
      const stored = readPinDefaultForPin(node.properties, pin);
      const hasStored = stored !== undefined;
      const requiresReference = pin.reference === "required" ||
        catalogPin?.reference === "required";
      if (hasStored && (requiresReference || pinRejectsStoredDefault(pin.type))) {
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
          pin.id === "target" &&
          node.properties.implicitSelf === true &&
          (pin.type.kind === "objectRef" || pin.type.kind === "actorRef") &&
          (registry === undefined || registry.get(node.typeId)?.implicitSelfTarget === true);
        // A catalog default is as authored as a stored one: compile and the
        // editor both fall back to it before the type default.
        const authored = hasStored || pin.defaultValue !== undefined ||
          catalogPin?.defaultValue !== undefined;
        const defaultClearsMissing =
          !requiresReference && authored &&
          (pinAcceptsLiteralDefault(pin.type) ||
            pin.type.kind === "boxedWildcard");
        // A literal pin always has a value (stored, catalog or type default).
        // Reference pins, which can really be empty, are the ones that warn.
        const literalPin =
          !requiresReference &&
          pinAcceptsLiteralDefault(pin.type) &&
          pin.type.kind !== "classRef" &&
          pin.type.kind !== "assetRef";
        const owner = ctx.members?.find(
          (member) =>
            member.kind === "function" &&
            (member.id === graph.id || member.name === graph.id),
        );
        const interfaceOutput =
          node.typeId === "flow.function.output" &&
          (ctx.interfaceImplementation === true ||
            Boolean(owner?.implementsInterface));
        if (
          !defaultClearsMissing &&
          !implicitSelfTarget &&
          (!literalPin || interfaceOutput)
        ) {
          const liveRef =
            pin.type.kind === "objectRef" || pin.type.kind === "actorRef";
          out.push(
            diagnostic({
              severity: requiresReference || liveRef || interfaceOutput ? "error" : "warning",
              code: "pin.missing_input",
              message: `Required input "${humanizePropertyLabel(pin.name)}" is not connected`,
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

function executeJavaScriptRowNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row: unknown) => {
    const name = row && typeof row === "object" ? (row as { name?: unknown }).name : undefined;
    return typeof name === "string" ? [name] : [];
  });
}

function validateExecuteJavaScript(
  graph: LogicGraph,
  ctx: TypeContext,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const node of graph.nodes) {
    if (node.typeId !== "debug.executeJavaScript") continue;
    const body = String(node.properties.body ?? "");
    // Parse the body the way the compiler wraps it, without evaluating it: a
    // strict-mode module function taking ctx and the inputs, with each output
    // declared by `let`. Invalid row names are the node's own error, so they
    // fall back to a bare wrapper here.
    const ParseFunction = node.properties.async ? AsyncFunction : Function;
    const inputs = executeJavaScriptRowNames(node.properties.inputs);
    const outputs = executeJavaScriptRowNames(node.properties.outputs);
    let params = ["ctx", ...inputs];
    let prologue = `"use strict";${outputs.length > 0 ? ` let ${outputs.join(", ")};` : ""}`;
    try {
      new ParseFunction(...params, prologue);
    } catch {
      params = ["ctx"];
      prologue = '"use strict";';
    }
    try {
      new ParseFunction(...params, `${prologue}\n${body}`);
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
          bodyLine: match ? Math.max(1, Number(match[1]) - 1) : 1,
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
  return eventBindingName(stringProp(node.properties, "name"));
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
      const functionId =
        stringProp(node.properties, "functionId") ??
        ctx.activeFunctionId ??
        undefined;
      const local = node.properties.scope === "local";
      const found = variableId
        ? members.find((member) => member.kind === "variable" && member.id === variableId)
        : undefined;
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
  container?: "single" | "array" | "map";
};

function signaturePinKey(pin: SignaturePin): string {
  const container = pin.container === "array" || pin.container === "map" ? pin.container : "single";
  return `${pin.direction}:${pin.name}:${container}:${pin.typeId}:${pin.typeClassId ?? ""}`;
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

/**
 * The runtime dispatches a custom event by its compiled identifier, so two
 * differently spelled names that compile to one identifier ("A/B", "A B")
 * would both run whenever either is called.
 */
function validateCustomEventNames(
  graphs: readonly LogicGraph[],
  ctx: TypeContext,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const firstNameByEvent = new Map<string, string>();
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      if (node.typeId !== "flow.event.custom") continue;
      const event = eventNameForEntry(node);
      const name = node.properties.name;
      if (!event || typeof name !== "string") continue;
      const first = firstNameByEvent.get(event);
      if (first === undefined) {
        firstNameByEvent.set(event, name);
      } else if (first !== name) {
        out.push(
          diagnostic({
            code: "event.name_collision",
            message: `Custom events "${first}" and "${name}" compile to the same event "${event}"; rename one of them`,
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

/**
 * Member declarations belong to the class, not to one graph: `ctx.members`
 * may also list other project classes' members, so only the validated
 * class's own members are checked, once per `validateGraphs` call.
 */
function validateMemberTypes(
  graphs: readonly LogicGraph[],
  ctx: TypeContext,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const graphId = graphs[0]?.id ?? "";
  for (const member of ctx.members ?? []) {
    if (ctx.classId && member.classId !== ctx.classId) continue;
    const typeIds = [
      member.typeId,
      member.container === "map" ? member.keyTypeId : undefined,
      ...(member.pins ?? []).map((pin) => pin.typeId),
    ];
    for (const typeId of typeIds) {
      if (typeId === undefined || isMemberTypeId(typeId)) continue;
      out.push(
        diagnostic({
          code: "member.unknown_type",
          message: `"${member.name}" uses unknown type "${typeId}"`,
          assetGuid: ctx.assetGuid,
          graphId,
        }),
      );
    }
    if (!isStructOrEnumTypeId(member.typeId)) continue;
    reportTypeGuid(
      out,
      ctx,
      graphId,
      member.typeId === "struct" ? "structRef" : "enumRef",
      member.typeClassId?.trim() || undefined,
    );
  }
  return out;
}

function validateTypeRefs(
  graph: LogicGraph,
  ctx: TypeContext,
): Diagnostic[] {
  const out: Diagnostic[] = [];
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

/** Editor-facing node name: the authored title, else the catalog title. */
function nodeTitle(node: GraphNode, registry: ValidateOptions["registry"]): string {
  return (
    stringProp(node.properties, "title") ??
    registry?.get(node.typeId)?.title ??
    humanizePropertyLabel(node.typeId.replace(/^.*\./, ""))
  );
}

function eventTitle(node: GraphNode, registry: ValidateOptions["registry"]): string {
  const authored = stringProp(node.properties, "title");
  if (authored) return authored;
  if (node.typeId === "flow.event.custom") {
    return formatEventTitle(String(node.properties.name ?? ""));
  }
  return (
    registry?.get(node.typeId)?.title ??
    formatEventTitle(
      node.typeId.replace(/^.*\./, ""),
      stringProp(node.properties, "eventQualifier"),
    )
  );
}

/**
 * What makes two entry nodes the same event, or undefined when they cannot be
 * told apart statically. Input events share one tick handler, so their
 * identity is the Input Action or Axis they read, never the handler name.
 */
export function singletonEventKey(
  node: Pick<GraphNode, "typeId" | "properties">,
  /** True when a wire feeds the Input Binding pin, so the asset is unknown until run time. */
  bindingWired: boolean,
): string | undefined {
  if (node.typeId === "flow.event.custom") {
    return eventNameForEntry(node) ? `${node.typeId}\0${String(node.properties.name)}` : undefined;
  }
  if (eventNameForEntry(node) === undefined) return undefined;
  if (node.typeId === "input.actionEvent" || node.typeId === "input.axisEvent") {
    if (bindingWired) return undefined;
    const input = (node.properties["default:binding"] as { Input?: { Asset?: unknown; Name?: unknown } } | undefined)?.Input;
    const asset = input?.Asset || input?.Name;
    return typeof asset === "string" && asset ? `${node.typeId}\0${asset}` : undefined;
  }
  return `${node.typeId}\0${stringProp(node.properties, "componentId") ?? ""}`;
}

/**
 * Every entry node runs its event once per dispatch, and the compiler exports
 * a second entry of the same event under a renamed function that the runtime
 * still dispatches, so a duplicate runs the event twice.
 */
function validateDuplicateEvents(
  graph: LogicGraph,
  ctx: TypeContext,
  registry: ValidateOptions["registry"],
  incoming: IncomingEdge,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const firstByKey = new Map<string, GraphNode>();
  for (const node of entryNodes(graph)) {
    const key = singletonEventKey(node, incoming(node.id, "binding") !== undefined);
    if (key === undefined) continue;
    const first = firstByKey.get(key);
    if (!first) {
      firstByKey.set(key, node);
      continue;
    }
    out.push(
      diagnostic({
        code: "event.duplicate",
        message: `${eventTitle(node, registry)} appears more than once in this graph. Keep one; use a Sequence to run several things.`,
        assetGuid: ctx.assetGuid,
        graphId: graph.id,
        nodeId: node.id,
        relatedNodeId: first.id,
      }),
    );
  }
  return out;
}

/**
 * An impure node (one with exec pins) that no event reaches never runs, so
 * its outputs keep their type defaults: the compiler declares each impure
 * output slot at the top of the entry and only the node's own run fills it.
 */
function validateUnexecutedSources(
  graph: LogicGraph,
  ctx: TypeContext,
  compiled: ReadonlySet<string>,
  registry: ValidateOptions["registry"],
  incoming: IncomingEdge,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const edge of graph.edges) {
    const source = findNode(graph, edge.sourceNodeId);
    const target = findNode(graph, edge.targetNodeId);
    if (!source || !target || compiled.has(source.id) || !compiled.has(target.id)) continue;
    const sp = findPin(source, edge.sourcePinId);
    const tp = findPin(target, edge.targetPinId);
    if (sp?.kind !== "data" || sp.direction !== "out" || tp?.kind !== "data" || tp.direction !== "in") continue;
    if (!source.pins.some((pin) => pin.kind === "exec")) continue;
    // Only the first wire into an input is read.
    if (incoming(target.id, tp.id) !== edge) continue;
    out.push(
      diagnostic({
        severity: "warning",
        code: "pin.unexecuted_source",
        message: `Input "${humanizePropertyLabel(tp.name)}" reads from ${nodeTitle(source, registry)}, which never runs because no event reaches it. Connect it into the execution chain before this node.`,
        assetGuid: ctx.assetGuid,
        graphId: graph.id,
        nodeId: target.id,
        pinId: tp.id,
        relatedNodeId: source.id,
      }),
    );
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
    const compiled = compiledNodeIds(graph);
    const keep = (diags: readonly Diagnostic[]) =>
      keepCompiledNodeDiagnostics(diags, compiled);
    const incoming = indexIncomingEdges(graph);
    diagnostics.push(
      ...keep(validateStructural(graph, ctx, compiled, options.registry, incoming)),
    );
    diagnostics.push(...keep(validateBreakContext(graph, ctx, compiled, options)));
    diagnostics.push(...keep(validatePinTyping(graph, ctx, options.registry, incoming)));
    diagnostics.push(...keep(validateDuplicateEvents(graph, ctx, options.registry, incoming)));
    diagnostics.push(
      ...keep(validateUnexecutedSources(graph, ctx, compiled, options.registry, incoming)),
    );
    diagnostics.push(...keep(validateExecuteJavaScript(graph, ctx)));
    diagnostics.push(...keep(validateMemberBindings(graph, ctx)));
    diagnostics.push(...keep(validateComponentAndInheritedBindings(graph, ctx)));
    diagnostics.push(...keep(validateTypeRefs(graph, ctx)));
    diagnostics.push(...keep(validateFlowSwitchCases(graph, ctx)));
  }
  diagnostics.push(...validateMemberTypes(graphs, ctx));
  diagnostics.push(...validateInterfaceAndOverrides(graphs, ctx));
  diagnostics.push(...validateCustomEventNames(graphs, ctx));
  for (const rule of listValidationRules()) {
    diagnostics.push(...rule.run(graphs, ctx));
  }
  return diagnostics;
}
