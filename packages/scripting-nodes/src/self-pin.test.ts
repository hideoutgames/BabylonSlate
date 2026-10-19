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
  { typeId: "actor.destroy", title: "Destroy Actor", pin: "target", label: "Target", method: "destroyActor", pure: false },
  { typeId: "particles.play", title: "Play Particles", pin: "actor", label: "Actor", method: "playParticles", pure: false },
  { typeId: "particles.stop", title: "Stop Particles", pin: "actor", label: "Actor", method: "stopParticles", pure: false },
  { typeId: "actor.attachToBone", title: "Attach To Bone", pin: "actor", label: "Actor", method: "attachToBone", pure: false },
  { typeId: "component.get", title: "Get Component", pin: "actor", label: "Actor", method: "getComponent", pure: true },
  { typeId: "component.has", title: "Has Component", pin: "actor", label: "Actor", method: "getComponent", pure: true },
  { typeId: "component.add", title: "Add Component", pin: "actor", label: "Actor", method: "addComponent", pure: false },
] as const;

/** Begin Play into the node, or into Print when the node is a pure value. */
function graphFor(
  registry: NodeRegistry,
  testCase: (typeof CASES)[number],
  wired: boolean,
): LogicGraph {
  const subject = node(registry, "subject", testCase.typeId, { title: testCase.title });
  const nodes = [node(registry, "begin", "flow.event.beginPlay"), subject];
  const edges: GraphEdge[] = [];
  if (testCase.pure) {
    nodes.push(node(registry, "print", "debug.print"));
    edges.push(edge("begin", "execOut", "print", "execIn"), edge("subject", "out", "print", "value"));
  } else {
    edges.push(edge("begin", "execOut", "subject", "execIn"));
  }
  if (testCase.typeId === "actor.attachToBone") {
    // The bone's actor is a subject too: give it a live actor so only the Actor pin is under test.
    nodes.push(node(registry, "anchor", "actor.getSelf"));
    edges.push(edge("anchor", "out", "subject", "target"));
  }
  if (wired) {
    // Get Actor Of Class reads null in the test context: a wired reference that is empty.
    nodes.push(node(registry, "source", "actor.getOfClass"));
    edges.push(edge("source", "out", "subject", testCase.pin));
  }
  return { id: "g", kind: "event", nodes, edges };
}

function runBeginPlay(registry: NodeRegistry, testCase: (typeof CASES)[number], wired: boolean) {
  const compiled = compileGraph(graphFor(registry, testCase, wired), { assetGuid: "a", registry, className: "Hero" });
  const body = compiled.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  const onBeginPlay = new Function(`${body}\nreturn { onBeginPlay };`)().onBeginPlay as (ctx: unknown) => void;
  const calls: unknown[][] = [];
  const logged: string[] = [];
  const printed: unknown[] = [];
  const self = { guid: "self" };
  onBeginPlay({
    self,
    getActorOfClass: () => null,
    nullAccess: (message: string) => logged.push(message),
    formatValue: (value: unknown) => value,
    print: (value: unknown) => printed.push(value),
    [testCase.method]: (...args: unknown[]) => {
      calls.push(args);
      return null;
    },
  });
  return { calls, logged, printed, self };
}

describe("optional Actor pins that read Self", () => {
  const registry = createDefaultNodeRegistry();

  it.each(CASES)("$typeId passes Self when its Actor pin is unwired and reports nothing missing", (testCase) => {
    // The graph labels the pin "(Self)" only when the catalog pin says it reads Self.
    expect(registry.get(testCase.typeId)?.pins({}).find((entry) => entry.id === testCase.pin)).toMatchObject({
      optional: true,
      selfWhenUnwired: true,
    });
    const { calls, logged, self } = runBeginPlay(registry, testCase, false);
    expect(calls.map((call) => call[0])).toEqual([self]);
    expect(logged).toEqual([]);
    const missing = validateGraphs([graphFor(registry, testCase, false)], { assetGuid: "a" }, { registry })
      .filter((d) => d.code === "pin.missing_input" && d.nodeId === "subject" && d.pinId === testCase.pin);
    expect(missing).toEqual([]);
  });

  it.each(CASES)("$typeId does nothing and reports the null access when its wired reference is empty", (testCase) => {
    const { calls, logged, printed } = runBeginPlay(registry, testCase, true);
    // A wired empty reference never becomes Self: the node is skipped.
    expect(calls).toEqual([]);
    expect(logged).toEqual([`Hero: ${testCase.title} (${testCase.label}) tried to access null.`]);
    // A pure node still yields its output default.
    if (testCase.pure) expect(printed).toEqual([testCase.typeId === "component.has" ? false : null]);
  });
});
