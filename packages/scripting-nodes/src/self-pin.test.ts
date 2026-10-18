import { describe, expect, it } from "vitest";
import {
  compileGraph,
  validateGraphs,
  type GraphEdge,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";

function node(
  registry: NodeRegistry,
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  const def = registry.get(typeId);
  if (!def) throw new Error(`missing node ${typeId}`);
  return { id, typeId, position: { x: 0, y: 0 }, pins: def.pins(properties), properties };
}

function edge(source: string, sourcePin: string, target: string, targetPin: string): GraphEdge {
  return {
    id: `${source}.${sourcePin}->${target}.${targetPin}`,
    sourceNodeId: source,
    sourcePinId: sourcePin,
    targetNodeId: target,
    targetPinId: targetPin,
  };
}

/** Nodes whose optional Actor pin reads the actor running the graph when left unwired. */
const CASES = [
  { typeId: "actor.destroy", pin: "target", method: "destroyActor", pure: false },
  { typeId: "particles.play", pin: "actor", method: "playParticles", pure: false },
  { typeId: "particles.stop", pin: "actor", method: "stopParticles", pure: false },
  { typeId: "actor.attachToBone", pin: "actor", method: "attachToBone", pure: false },
  { typeId: "component.get", pin: "actor", method: "getComponent", pure: true },
] as const;

/** Begin Play into the node, or into Print when the node is a pure value. */
function graphFor(
  registry: NodeRegistry,
  testCase: (typeof CASES)[number],
  wired: boolean,
): LogicGraph {
  const subject = node(registry, "subject", testCase.typeId);
  const nodes = [node(registry, "begin", "flow.event.beginPlay"), subject];
  const edges: GraphEdge[] = [];
  if (testCase.pure) {
    nodes.push(node(registry, "print", "debug.print"));
    edges.push(edge("begin", "execOut", "print", "execIn"), edge("subject", "out", "print", "value"));
  } else {
    edges.push(edge("begin", "execOut", "subject", "execIn"));
  }
  if (wired) {
    // Get Parent reads null in the test context: a wired reference that is empty.
    nodes.push(node(registry, "parent", "actor.getParent"));
    edges.push(edge("parent", "out", "subject", testCase.pin));
  }
  return { id: "g", kind: "event", nodes, edges };
}

function firstArgumentOf(registry: NodeRegistry, testCase: (typeof CASES)[number], wired: boolean): unknown {
  const compiled = compileGraph(graphFor(registry, testCase, wired), { assetGuid: "a", registry });
  const body = compiled.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  const onBeginPlay = new Function(`${body}\nreturn { onBeginPlay };`)().onBeginPlay as (ctx: unknown) => void;
  const calls: unknown[][] = [];
  const self = { guid: "self" };
  onBeginPlay({
    self,
    getParent: () => null,
    formatValue: String,
    print: () => {},
    [testCase.method]: (...args: unknown[]) => {
      calls.push(args);
      return null;
    },
  });
  expect(calls).toHaveLength(1);
  return calls[0]![0] === self ? "self" : calls[0]![0];
}

describe("optional Actor pins that read Self", () => {
  const registry = createDefaultNodeRegistry();

  it.each(CASES)("$typeId passes Self when its Actor pin is unwired and reports nothing missing", (testCase) => {
    expect(firstArgumentOf(registry, testCase, false)).toBe("self");
    const missing = validateGraphs([graphFor(registry, testCase, false)], { assetGuid: "a" }, { registry })
      .filter((d) => d.code === "pin.missing_input" && d.nodeId === "subject" && d.pinId === testCase.pin);
    expect(missing).toEqual([]);
  });

  it.each(CASES)("$typeId passes a wired reference through even when it is empty", (testCase) => {
    expect(firstArgumentOf(registry, testCase, true)).toBeNull();
  });
});
