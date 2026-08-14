import type {
  BehaviourTreeDocument,
  BlackboardValues,
  BtDecorator,
  BtEvalState,
  BtNode,
  BtResult,
  BtService,
  BtServiceHost,
  BtStackFrame,
  BtTaskHost,
  EvaluateBehaviourTreeOptions,
} from "./types";

import { BUILTIN_TASKS, builtinClassId } from "./builtins";

function cloneMemory(
  source: Record<string, Record<string, unknown>> | undefined,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, row] of Object.entries(source ?? {})) {
    out[id] = { ...row };
  }
  return out;
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

function compareBlackboard(
  left: unknown,
  op: unknown,
  right: unknown,
): boolean {
  switch (op) {
    case "neq":
      return left !== right;
    case "gt":
      return Number(left) > Number(right);
    case "gte":
      return Number(left) >= Number(right);
    case "lt":
      return Number(left) < Number(right);
    case "lte":
      return Number(left) <= Number(right);
    case "eq":
    default:
      return left === right;
  }
}

function decoratorCondition(decorator: BtDecorator, blackboard: BlackboardValues): boolean {
  const classId = builtinClassId(decorator.classId);
  if (classId === "bt.decorator.blackboardIsSet") {
    const key =
      typeof decorator.properties.key === "string"
        ? decorator.properties.key
        : decorator.observedKeys[0];
    if (!key) return false;
    return isSet(blackboard[key]);
  }
  if (classId === "bt.decorator.compareBlackboardValue") {
    const key =
      typeof decorator.properties.key === "string"
        ? decorator.properties.key
        : decorator.observedKeys[0];
    if (!key) return false;
    return compareBlackboard(
      blackboard[key],
      decorator.properties.op,
      decorator.properties.value,
    );
  }
  return true;
}

function decoratorBlocks(node: BtNode, blackboard: BlackboardValues): boolean {
  return node.decorators.some((decorator) => !decoratorCondition(decorator, blackboard));
}

function tickTask(
  node: BtNode,
  blackboard: BlackboardValues,
  dtSeconds: number,
  memory: Record<string, unknown>,
  host?: BtTaskHost,
): BtResult {
  if (host && !BUILTIN_TASKS.has(builtinClassId(node.classId))) {
    return host.tick(node, blackboard, dtSeconds, memory);
  }
  switch (builtinClassId(node.classId)) {
    case "bt.task.succeed":
    case "bt.task.moveTo":
    case "bt.task.rotateToFace":
    case "bt.task.playAnimation":
    case "bt.task.playSound":
      return "success";
    case "bt.task.fail":
      return "failure";
    case "bt.task.setBlackboard": {
      const key = typeof node.properties.key === "string" ? node.properties.key : "";
      if (key) blackboard[key] = node.properties.value;
      return "success";
    }
    case "bt.task.wait": {
      const duration =
        typeof node.properties.durationMs === "number" && Number.isFinite(node.properties.durationMs)
          ? node.properties.durationMs
          : 0;
      const elapsed = (typeof memory.elapsedMs === "number" ? memory.elapsedMs : 0) + dtSeconds * 1000;
      memory.elapsedMs = elapsed;
      return elapsed >= duration ? "success" : "running";
    }
    default:
      return "failure";
  }
}

function parentOf(nodes: Map<string, BtNode>): Map<string, string> {
  const parent = new Map<string, string>();
  for (const node of nodes.values()) {
    for (const childId of node.children) parent.set(childId, node.id);
  }
  return parent;
}

function subtreeIds(nodes: Map<string, BtNode>, rootId: string): Set<string> {
  const out = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    const node = nodes.get(id);
    if (node) stack.push(...node.children);
  }
  return out;
}

function nearestSelector(
  nodes: Map<string, BtNode>,
  parents: Map<string, string>,
  nodeId: string,
): { selector: BtNode; index: number } | null {
  let current = parents.get(nodeId);
  let childId = nodeId;
  while (current) {
    const node = nodes.get(current);
    if (node?.kind === "selector") {
      return { selector: node, index: node.children.indexOf(childId) };
    }
    childId = current;
    current = parents.get(current);
  }
  return null;
}

function popThrough(
  stack: BtStackFrame[],
  lastResults: Record<string, BtResult>,
  nodeId: string,
): void {
  while (stack.length > 0) {
    const frame = stack.pop()!;
    lastResults[frame.nodeId] = "failure";
    if (frame.nodeId === nodeId) break;
  }
}

function applyAborts(
  nodes: Map<string, BtNode>,
  stack: BtStackFrame[],
  lastResults: Record<string, BtResult>,
  blackboard: BlackboardValues,
): void {
  if (stack.length === 0) return;
  const parents = parentOf(nodes);
  const onStack = new Set(stack.map((frame) => frame.nodeId));

  for (const node of nodes.values()) {
    for (const decorator of node.decorators) {
      if (decorator.abortMode === "none") continue;
      const condition = decoratorCondition(decorator, blackboard);
      const self = decorator.abortMode === "self" || decorator.abortMode === "both";
      const lower =
        decorator.abortMode === "lowerPriority" || decorator.abortMode === "both";

      if (self && !condition && onStack.has(node.id)) {
        popThrough(stack, lastResults, node.id);
        lastResults[node.id] = "failure";
        return;
      }

      if (lower && condition) {
        const found = nearestSelector(nodes, parents, node.id);
        if (!found || found.index < 0) continue;
        const runningLower = found.selector.children.some((childId, index) => {
          if (index <= found.index) return false;
          const ids = subtreeIds(nodes, childId);
          return stack.some((frame) => ids.has(frame.nodeId));
        });
        if (!runningLower) continue;
        while (stack.length > 0 && stack[stack.length - 1]!.nodeId !== found.selector.id) {
          const frame = stack.pop()!;
          lastResults[frame.nodeId] = "failure";
        }
        const selectorFrame = stack[stack.length - 1];
        if (selectorFrame) {
          selectorFrame.childIndex = found.index;
          selectorFrame.opened = true;
          for (const childId of found.selector.children.slice(found.index)) {
            for (const id of subtreeIds(nodes, childId)) {
              delete lastResults[id];
            }
          }
        }
        return;
      }
    }
  }
}

function hash01(seed: number, id: string, fireIndex: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < id.length; i += 1) {
    h = Math.imul(h ^ id.charCodeAt(i), 2654435761) >>> 0;
  }
  h = Math.imul(h ^ fireIndex, 1597334677) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function serviceIntervalMs(service: BtService, seed: number, fireIndex: number): number {
  const base = service.intervalMs;
  const deviation = service.randomDeviationMs;
  if (!(deviation > 0)) return Math.max(0, base);
  const offset = (hash01(seed, service.id, fireIndex) * 2 - 1) * deviation;
  return Math.max(0, base + offset);
}

function fireService(
  service: BtService,
  node: BtNode,
  blackboard: BlackboardValues,
  dtSeconds: number,
  memory: Record<string, unknown>,
  host?: BtServiceHost,
): void {
  if (service.classId === "bt.service.setBlackboard" || builtinClassId(service.classId) === "bt.service.setBlackboard") {
    const key = typeof service.properties.key === "string" ? service.properties.key : "";
    if (key) blackboard[key] = service.properties.value;
    return;
  }
  host?.tick(service, node, blackboard, dtSeconds, memory);
}

function tickNodeServices(
  node: BtNode,
  blackboard: BlackboardValues,
  dtSeconds: number,
  nodeMemory: Record<string, Record<string, unknown>>,
  seed: number,
  host?: BtServiceHost,
): void {
  if (node.services.length === 0) return;
  const memory = (nodeMemory[node.id] ??= {});
  for (const service of node.services) {
    const key = `__svc:${service.id}`;
    const row = (memory[key] as Record<string, unknown> | undefined) ?? {};
    let elapsed = typeof row.elapsedMs === "number" ? row.elapsedMs : 0;
    let fires = typeof row.fires === "number" ? row.fires : 0;
    let nextMs =
      typeof row.nextMs === "number" ? row.nextMs : serviceIntervalMs(service, seed, fires);
    elapsed += dtSeconds * 1000;
    if (nextMs <= 0) {
      fireService(service, node, blackboard, dtSeconds, memory, host);
      fires += 1;
      elapsed = 0;
      nextMs = serviceIntervalMs(service, seed, fires);
    } else {
      while (elapsed >= nextMs && nextMs > 0) {
        elapsed -= nextMs;
        fireService(service, node, blackboard, dtSeconds, memory, host);
        fires += 1;
        nextMs = serviceIntervalMs(service, seed, fires);
        if (nextMs <= 0) break;
      }
    }
    memory[key] = { elapsedMs: elapsed, nextMs, fires };
  }
}

function tickStackServices(
  stack: BtStackFrame[],
  nodes: Map<string, BtNode>,
  blackboard: BlackboardValues,
  dtSeconds: number,
  nodeMemory: Record<string, Record<string, unknown>>,
  seed: number,
  host?: BtServiceHost,
): void {
  for (const frame of stack) {
    if (!frame.opened) continue;
    const node = nodes.get(frame.nodeId);
    if (node) tickNodeServices(node, blackboard, dtSeconds, nodeMemory, seed, host);
  }
}

function runningLeaf(stack: BtStackFrame[], nodes: Map<string, BtNode>): string | null {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const node = nodes.get(stack[i]!.nodeId);
    if (node?.kind === "task") return node.id;
  }
  return null;
}

export function evaluateBehaviourTree(
  tree: BehaviourTreeDocument,
  previous: BtEvalState | null,
  dtSeconds: number,
  options?: EvaluateBehaviourTreeOptions,
): BtEvalState {
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const blackboard: BlackboardValues =
    options?.blackboard !== undefined
      ? { ...options.blackboard }
      : { ...(previous?.blackboard ?? {}) };
  const lastResults: Record<string, BtResult> = { ...(previous?.lastResults ?? {}) };
  const nodeMemory = cloneMemory(previous?.nodeMemory);
  const stack: BtStackFrame[] = (previous?.stack ?? []).map((frame) => ({ ...frame }));
  const seed = options?.seed ?? 0;

  applyAborts(nodes, stack, lastResults, blackboard);
  tickStackServices(
    stack,
    nodes,
    blackboard,
    dtSeconds,
    nodeMemory,
    seed,
    options?.serviceHost,
  );

  if (stack.length === 0) {
    const aborted = lastResults[tree.rootId];
    if (aborted === "failure" || aborted === "success") {
      return {
        stack: [],
        status: aborted,
        lastResults,
        btNodeId: null,
        blackboard,
        nodeMemory,
      };
    }
    stack.push({ nodeId: tree.rootId, childIndex: 0, opened: false });
  }

  let status: BtResult = "running";
  let guard = 0;
  while (stack.length > 0 && guard < 10_000) {
    guard += 1;
    const frame = stack[stack.length - 1]!;
    const node = nodes.get(frame.nodeId);
    if (!node) {
      lastResults[frame.nodeId] = "failure";
      stack.pop();
      continue;
    }

    const parent = stack.length >= 2 ? nodes.get(stack[stack.length - 2]!.nodeId) : undefined;

    if (node.kind === "task") {
      if (!frame.opened) {
        if (decoratorBlocks(node, blackboard)) {
          lastResults[node.id] = "failure";
          stack.pop();
          continue;
        }
        frame.opened = true;
        tickNodeServices(
          node,
          blackboard,
          dtSeconds,
          nodeMemory,
          seed,
          options?.serviceHost,
        );
      }
      const memory = (nodeMemory[node.id] ??= {});
      const result = tickTask(node, blackboard, dtSeconds, memory, options?.host);
      lastResults[node.id] = result;
      if (result === "running") {
        if (parent?.kind === "parallel") {
          stack.pop();
          continue;
        }
        status = "running";
        break;
      }
      stack.pop();
      continue;
    }

    if (!frame.opened) {
      if (decoratorBlocks(node, blackboard)) {
        lastResults[node.id] = "failure";
        stack.pop();
        continue;
      }
      frame.opened = true;
      frame.childIndex = 0;
      tickNodeServices(
        node,
        blackboard,
        dtSeconds,
        nodeMemory,
        seed,
        options?.serviceHost,
      );
    }

    if (node.kind === "parallel") {
      const childId = node.children[frame.childIndex];
      if (childId === undefined) {
        const results = node.children.map((id) => lastResults[id]);
        if (results.includes("failure")) {
          lastResults[node.id] = "failure";
          stack.pop();
          continue;
        }
        if (results.length > 0 && results.every((row) => row === "success")) {
          lastResults[node.id] = "success";
          stack.pop();
          continue;
        }
        lastResults[node.id] = "running";
        frame.childIndex = 0;
        status = "running";
        break;
      }
      const existing = lastResults[childId];
      if (existing === "success" || existing === "failure") {
        frame.childIndex += 1;
        continue;
      }
      stack.push({
        nodeId: childId,
        childIndex: 0,
        opened: existing === "running",
      });
      if (existing !== "running") delete lastResults[childId];
      frame.childIndex += 1;
      continue;
    }

    const childId = node.children[frame.childIndex];
    if (childId === undefined) {
      lastResults[node.id] = node.kind === "selector" ? "failure" : "success";
      stack.pop();
      continue;
    }

    const childResult = lastResults[childId];
    const childOnStack = stack.some((entry) => entry.nodeId === childId);
    if (childOnStack) {
      status = "running";
      break;
    }
    if (childResult === undefined) {
      stack.push({ nodeId: childId, childIndex: 0, opened: false });
      continue;
    }
    if (childResult === "running") {
      stack.push({ nodeId: childId, childIndex: 0, opened: true });
      continue;
    }
    if (node.kind === "sequence") {
      if (childResult === "failure") {
        lastResults[node.id] = "failure";
        stack.pop();
        continue;
      }
      frame.childIndex += 1;
      continue;
    }
    // selector
    if (childResult === "success") {
      lastResults[node.id] = "success";
      stack.pop();
      continue;
    }
    frame.childIndex += 1;
  }

  if (stack.length === 0) {
    status = lastResults[tree.rootId] ?? "failure";
  }

  return {
    stack,
    status,
    lastResults,
    btNodeId: status === "running" ? runningLeaf(stack, nodes) : null,
    blackboard,
    nodeMemory,
  };
}
