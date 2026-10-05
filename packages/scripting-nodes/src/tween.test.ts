import { describe, expect, it } from "vitest";
import {
  compileGraph, validateGraphs, pin, objectRef,
  type GraphNode, type LogicGraph, type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";

function node(registry: NodeRegistry, id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode {
  return { id, typeId, properties, position: { x: 0, y: 0 }, pins: registry.get(typeId)!.pins(properties) };
}
function edge(source: string, sourcePin: string, target: string, targetPin: string) {
  return { id: `${source}:${sourcePin}:${target}:${targetPin}`, sourceNodeId: source, sourcePinId: sourcePin, targetNodeId: target, targetPinId: targetPin };
}
function load(graph: LogicGraph, registry: NodeRegistry, localPreamble?: string[]) {
  const compiled = compileGraph(graph, { registry, assetGuid: "tween-test", localPreamble });
  const source = compiled.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  return new Function(`${source}\nreturn run;`)() as (ctx: Record<string, unknown>) => Promise<void>;
}
function floatGraph(registry: NodeRegistry, properties: Record<string, unknown> = {}): LogicGraph {
  return {
    id: "g", kind: "event",
    nodes: [node(registry, "entry", "flow.entry"),
      node(registry, "variable", "variables.get", { variableName: "Amount", typeId: "float", implicitSelf: true, ...properties }),
      node(registry, "tween", "tween.float", { a: 2, b: 8 }),
      node(registry, "done", "debug.log", { message: "completed" })],
    edges: [edge("entry", "execOut", "tween", "execIn"), edge("variable", "value", "tween", "target"), edge("tween", "execOut", "done", "execIn")],
  };
}

describe("Tween compilation", () => {
  it("captures the referenced object once, passes defaults and waits before Completed", async () => {
    const registry = createDefaultNodeRegistry();
    registry.register({ id: "test.target", title: "Target", category: "test", pure: true,
      pins: () => [pin("out", "Out", "out", objectRef("BObject"))],
      codegen: () => ({ out: "ctx.nextTarget()" }) });
    const graph = floatGraph(registry, { implicitSelf: false });
    graph.nodes.push(node(registry, "owner", "test.target"));
    graph.edges.push(edge("owner", "out", "variable", "target"));
    const first = { Amount: 0 }, second = { Amount: 100 };
    let selected = first, reads = 0;
    let finish: () => void = () => { throw new Error("Tween did not start"); };
    const logs: string[] = [];
    const calls: unknown[][] = [];
    const running = load(graph, registry)({
      nextTarget: () => { reads += 1; return selected; },
      variableReference: (target: typeof first, property: "Amount") => ({ set: (value: number) => { target[property] = value; } }),
      tweenValue: (reference: { set(value: number): void }, ...args: unknown[]) => {
        calls.push(args); reference.set(args[1] as number);
        return new Promise<boolean>((resolve) => { finish = () => { reference.set(args[2] as number); resolve(true); }; });
      },
      formatValue: String,
      log: (_severity: string, _category: string, message: string) => logs.push(message),
    });
    expect(first.Amount).toBe(2);
    expect(logs).toEqual([]);
    selected = second;
    finish();
    await running;
    expect(calls).toEqual([["float", 2, 8, 2, "linear"]]);
    expect([first.Amount, second.Amount, reads]).toEqual([8, 100, 1]);
    expect(logs).toEqual(["completed"]);
  });

  it("keeps each local's reference stable across tweens and isolated between invocations", async () => {
    const registry = createDefaultNodeRegistry();
    const graph = floatGraph(registry, { scope: "local" });
    graph.nodes.push(node(registry, "again", "tween.float", { a: 8, b: 12 }));
    graph.nodes.find((entry) => entry.id === "done")!.properties = {};
    graph.edges = graph.edges.filter((entry) => entry.sourceNodeId !== "tween");
    graph.edges.push(edge("tween", "execOut", "again", "execIn"), edge("variable", "value", "again", "target"),
      edge("again", "execOut", "done", "execIn"), edge("variable", "value", "done", "message"));
    const run = load(graph, registry, ["  let __lv_Amount = 0;"]);
    const references: Array<{ identity: object; set(value: number): void }> = [];
    const logs: string[] = [];
    const ctx = {
      tweenValue: async (reference: typeof references[number], _type: string, _a: number, b: number) => {
        references.push(reference); reference.set(b); return true;
      }, formatValue: String,
      log: (_severity: string, _category: string, message: string) => logs.push(message),
    };
    await run(ctx);
    await run(ctx);
    expect(logs).toEqual(["12", "12"]);
    expect(references[0]).toBe(references[1]);
    expect(references[2]).toBe(references[3]);
    expect(references[0]!.identity).not.toBe(references[2]!.identity);
  });

  it("skips canceled Completed paths while preserving sibling Sequence outputs", async () => {
    const registry = createDefaultNodeRegistry();
    const graph = floatGraph(registry);
    graph.nodes.push(node(registry, "sequence", "flow.sequence"), node(registry, "sibling", "debug.log", { message: "sibling" }));
    graph.edges = graph.edges.filter((entry) => entry.sourceNodeId !== "entry");
    graph.edges.push(edge("entry", "execOut", "sequence", "execIn"), edge("sequence", "then0", "tween", "execIn"), edge("sequence", "then1", "sibling", "execIn"));
    const logs: string[] = [];
    await load(graph, registry)({ variableReference: () => ({}), tweenValue: async () => false,
      formatValue: String, log: (_severity: string, _category: string, message: string) => logs.push(message) });
    expect(logs).toEqual(["sibling"]);
  });

  it("repeats completed execution cycles and exits when the next tween is canceled", async () => {
    const registry = createDefaultNodeRegistry();
    const graph = floatGraph(registry);
    graph.edges.push(edge("done", "execOut", "tween", "execIn"));
    const logs: string[] = [];
    let calls = 0;
    await load(graph, registry)({ variableReference: () => ({}), tweenValue: async () => ++calls < 3,
      formatValue: String, log: (_severity: string, _category: string, message: string) => logs.push(message) });
    expect(calls).toBe(3);
    expect(logs).toEqual(["completed", "completed"]);
  });

  it.each([
    ["tween.actorRotation", "actor.rotation", "rotator", "local"],
    ["tween.componentTransform", "component.transform", "transform", "world"],
    ["tween.opacity", "overlay.opacity", "float", undefined],
    ["tween.scrollOffset", "scroll.offset", "vec2", undefined],
    ["tween.textColor", "text.color", "color", undefined],
  ])("routes %s to its property with captured endpoints and space", async (typeId, property, valueType, space) => {
    const registry = createDefaultNodeRegistry();
    const a = valueType === "float" ? 0 : valueType === "vec2" ? { x: 1, y: 2 }
      : valueType === "rotator" ? { pitch: 0, yaw: 0, roll: 0 }
      : valueType === "transform" ? { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } }
      : { x: 0, y: 0, z: 0, w: 1 };
    const b = valueType === "float" ? 1 : a;
    const graph: LogicGraph = { id: "g", kind: "event", nodes: [node(registry, "entry", "flow.entry"),
      node(registry, "tween", typeId!, { a, b, ...(space === "world" ? { space } : {}) })],
      edges: [edge("entry", "execOut", "tween", "execIn")] };
    const calls: unknown[][] = [];
    await load(graph, registry)({ tweenProperty: async (...args: unknown[]) => { calls.push(args); return true; } });
    expect(calls).toEqual([[null, property, valueType, a, b, 2, "linear", ...(space ? [space] : [])]]);
  });
});

describe("Tween writable targets", () => {
  it.each(["literal", "computed", "readOnly", "integer", "missing"])("rejects %s targets", (kind) => {
    const registry = createDefaultNodeRegistry();
    const graph = floatGraph(registry);
    const variable = graph.nodes.find((entry) => entry.id === "variable")!;
    if (kind === "literal" || kind === "computed") {
      variable.typeId = kind === "literal" ? "literal.makeFloat" : "math.add";
      variable.pins = registry.get(variable.typeId)!.pins({});
      graph.edges.find((entry) => entry.sourceNodeId === "variable")!.sourcePinId = "out";
    } else if (kind === "readOnly") variable.properties.getOnly = true;
    else if (kind === "integer") variable.pins[0]!.type = { kind: "int" };
    else graph.edges = graph.edges.filter((entry) => entry.sourceNodeId !== "variable");
    const diagnostics = validateGraphs([graph], { assetGuid: "a" }, { registry });
    expect(diagnostics.some((entry) => entry.nodeId === "tween" && entry.pinId === "target" && entry.severity === "error")).toBe(true);
  });

  it("accepts mutable reflected variables but respects their authoritative get-only symbol", () => {
    const registry = createDefaultNodeRegistry();
    const graph = floatGraph(registry, { variableId: "opacity", classId: "2DPanelComponent", propertyKey: "opacity" });
    const member = { id: "opacity", name: "Amount", classId: "2DPanelComponent", kind: "variable" as const, typeId: "float" };
    const validate = (getOnly: boolean) => validateGraphs([graph], { assetGuid: "a", members: [{ ...member, getOnly }] }, { registry });
    expect(validate(false).filter((entry) => entry.code === "pin.invalid_reference")).toEqual([]);
    expect(validate(true).some((entry) => entry.code === "pin.invalid_reference")).toBe(true);
  });
});
