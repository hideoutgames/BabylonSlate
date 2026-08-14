import type {
  BehaviourTreeDocument,
  BlackboardValues,
  BtDecorator,
  BtEvalState,
  BtNode,
  BtResult,
  BtStackFrame,
  BtTaskHost,
} from "./types";

const BUILTIN_TASKS = new Set([
  "bt.task.succeed",
  "bt.task.fail",
  "bt.task.wait",
  "bt.task.setBlackboard",
]);

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

function decoratorCondition(decorator: BtDecorator, blackboard: BlackboardValues): boolean {
  if (decorator.classId === "bt.decorator.blackboardIsSet") {
    const key =
      typeof decorator.properties.key === "string"
        ? decorator.properties.key
        : decorator.observedKeys[0];
    if (!key) return false;
    return isSet(blackboard[key]);
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
  if (host && !BUILTIN_TASKS.has(node.classId)) {
    return host.tick(node, blackboard, dtSeconds, memory);
  }
  switch (node.classId) {
    case "bt.task.succeed":
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
  options?: { host?: BtTaskHost; blackboard?: BlackboardValues },
): BtEvalState {
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const blackboard: BlackboardValues =
    options?.blackboard !== undefined
      ? { ...options.blackboard }
      : { ...(previous?.blackboard ?? {}) };
  const lastResults: Record<string, BtResult> = { ...(previous?.lastResults ?? {}) };
  const nodeMemory = cloneMemory(previous?.nodeMemory);
  const stack: BtStackFrame[] = (previous?.stack ?? []).map((frame) => ({ ...frame }));

  applyAborts(nodes, stack, lastResults, blackboard);

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
