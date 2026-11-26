import { describe, expect, it } from "vitest";
import {
  compileGraph,
  type GraphEdge,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@haptic/scripting";
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

function edge(id: string, source: string, sourcePin: string, target: string, targetPin: string): GraphEdge {
  return { id, sourceNodeId: source, sourcePinId: sourcePin, targetNodeId: target, targetPinId: targetPin };
}

function loadEntry(source: string, name: string): (ctx: Record<string, unknown>) => unknown {
  const body = source.replace(/export\s+function\s+/g, "function ");
  return (new Function(`${body}\nreturn ${name};`)() as (ctx: Record<string, unknown>) => unknown);
}

describe("zero-closure unboxing and frozen constants", () => {
  const registry = createDefaultNodeRegistry();

  it("compiles a hot onTick movement chain with zero per-tick closures and scalar setActorLocationXYZ", () => {
    const graph: LogicGraph = {
      id: "move",
      kind: "event",
      nodes: [
        node(registry, "tick", "flow.event.tick"),
        node(registry, "loc", "transform.getLocation"),
        node(registry, "fwd", "transform.forward"),
        node(registry, "scale", "math.mul", { aType: "vec3", bType: "float", "default:b": 2 }),
        node(registry, "add", "math.add", { aType: "vec3", bType: "vec3" }),
        node(registry, "setLoc", "transform.setLocation"),
        node(registry, "branch", "flow.branch", { "default:condition": false }),
        node(registry, "coldMap", "map.set", { "default:key": "k", "default:value": 1 }),
      ],
      edges: [
        edge("x1", "tick", "execOut", "setLoc", "execIn"),
        edge("x2", "setLoc", "execOut", "branch", "execIn"),
        edge("x3", "branch", "true", "coldMap", "execIn"),
        edge("d1", "fwd", "out", "scale", "a"),
        edge("d2", "loc", "out", "add", "a"),
        edge("d3", "scale", "out", "add", "b"),
        edge("d4", "add", "out", "setLoc", "location"),
      ],
    };

    const compiled = compileGraph(graph, { assetGuid: "a", registry, className: "Runner" });
    const tickBody = compiled.source.slice(compiled.source.indexOf("export function onTick("));

    // Zero closures inside onTick, zero eager `new Map()` preamble, scalar XYZ setter used.
    expect(tickBody).not.toContain("=>");
    expect(tickBody).not.toContain("new Map()");
    expect(tickBody).toContain("ctx.setActorLocationXYZ(");

    // Runtime equivalence: 90-degree yaw quaternion rotates +Z forward to +X.
    const half = Math.PI / 4;
    const actor = {
      guid: "runner-1",
      destroyed: false,
      transform: {
        position: { x: 1, y: 2, z: 3 },
        rotation: { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) },
        scale: { x: 1, y: 1, z: 1 },
      },
    };
    const calls: Array<[unknown, number, number, number]> = [];
    loadEntry(compiled.source, "onTick")({
      self: actor,
      nullAccess: () => { throw new Error("unexpected nullAccess"); },
      destroyedAccess: () => { throw new Error("unexpected destroyedAccess"); },
      setActorLocationXYZ: (target: unknown, x: number, y: number, z: number) => {
        calls.push([target, x, y, z]);
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(actor);
    expect(calls[0]![1]).toBeCloseTo(3, 6);
    expect(calls[0]![2]).toBeCloseTo(2, 6);
    expect(calls[0]![3]).toBeCloseTo(3, 6);

    // Null/destroyed diagnostics still fire identically on the unboxed path.
    const nullLogs: string[] = [];
    const destroyedLogs: unknown[] = [];
    loadEntry(compiled.source, "onTick")({
      self: { guid: "dead", destroyed: true },
      nullAccess: (m: string) => nullLogs.push(m),
      destroyedAccess: (loc: unknown, target: unknown) => destroyedLogs.push([loc, target]),
      setActorLocationXYZ: () => { throw new Error("should skip dead target"); },
    });
    expect(nullLogs).toEqual([]);
    expect(destroyedLogs.length).toBeGreaterThanOrEqual(1);
  });

  it("preserves full trace output for unboxed chains when debugging is active", () => {
    const graph: LogicGraph = {
      id: "trace",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "make", "vector.make3", { "default:x": 3, "default:y": 4, "default:z": 5 }),
        node(registry, "setLoc", "transform.setLocation"),
      ],
      edges: [
        edge("x1", "begin", "execOut", "setLoc", "execIn"),
        edge("d1", "make", "out", "setLoc", "location"),
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry, instrumentExecutionTrace: true });
    const writes: Array<[string, string, unknown]> = [];
    const reads: Array<[string, string, unknown]> = [];
    const moved: number[][] = [];
    loadEntry(compiled.source, "onBeginPlay")({
      self: { guid: "a1", destroyed: false },
      debugTrace: {
        graph: () => ({
          exec: () => {},
          edge: () => {},
          write: (nodeId: string, pinId: string, value: unknown) => writes.push([nodeId, pinId, value]),
          read: (nodeId: string, pinId: string, value: unknown) => reads.push([nodeId, pinId, value]),
        }),
      },
      breakpoints: null,
      setActorLocationXYZ: (_target: unknown, x: number, y: number, z: number) => moved.push([x, y, z]),
    });
    expect(moved).toEqual([[3, 4, 5]]);
    expect(writes).toContainEqual(["make", "out", { x: 3, y: 4, z: 5 }]);
    expect(reads).toContainEqual(["setLoc", "location", { x: 3, y: 4, z: 5 }]);
  });
});

describe("COW containers and O(1) value-keyed Map", () => {
  const registry = createDefaultNodeRegistry();

  it("preserves value-copy isolation on aliased arrays while accumulating 10,000 items in linear time", () => {
    const arrProp = (name: string) => ({ variableName: name, typeId: "int", container: "array", implicitSelf: true });
    const graph: LogicGraph = {
      id: "cowArr",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "make", "array.make", { count: 1, "default:item0": 1 }),
        node(registry, "setA0", "variables.set", arrProp("A")),
        node(registry, "getA1", "variables.get", arrProp("A")),
        node(registry, "setB", "variables.set", arrProp("B")),
        node(registry, "loop", "flow.forLoop", { "default:firstIndex": 2, "default:lastIndex": 10_000 }),
        node(registry, "getA2", "variables.get", arrProp("A")),
        node(registry, "append", "array.append"),
        node(registry, "setA2", "variables.set", arrProp("A")),
      ],
      edges: [
        edge("x1", "begin", "execOut", "setA0", "execIn"),
        edge("d1", "make", "out", "setA0", "value"),
        edge("x2", "setA0", "execOut", "setB", "execIn"),
        edge("d2", "getA1", "value", "setB", "value"),
        edge("x3", "setB", "execOut", "loop", "execIn"),
        edge("x4", "loop", "loopBody", "setA2", "execIn"),
        edge("d3", "getA2", "value", "append", "array"),
        edge("d4", "loop", "index", "append", "item"),
        edge("d5", "append", "out", "setA2", "value"),
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    expect(compiled.source).toContain("__arr_append_cow");
    expect(compiled.source).toContain("__cowShare");

    const vars = new Map<string, unknown>();
    loadEntry(compiled.source, "onBeginPlay")({
      getVariable: (k: string) => vars.get(k),
      setVariable: (k: string, v: unknown) => vars.set(k, v),
    });
    // B kept its isolated [1] snapshot while A accumulated all 10,000 items.
    expect(vars.get("B")).toEqual([1]);
    const a = vars.get("A") as number[];
    expect(a.length).toBe(10_000);
    expect(a[0]).toBe(1);
    expect(a[9_999]).toBe(10_000);
  });

  it("handles self-appendArray(a, a) without infinite looping", () => {
    const arrProp = { variableName: "A", typeId: "int", container: "array", implicitSelf: true };
    const graph: LogicGraph = {
      id: "selfConcat",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "make", "array.make", { count: 2, "default:item0": 1, "default:item1": 2 }),
        node(registry, "set0", "variables.set", arrProp),
        node(registry, "get1", "variables.get", arrProp),
        node(registry, "get2", "variables.get", arrProp),
        node(registry, "concat", "array.appendArray"),
        node(registry, "set1", "variables.set", arrProp),
      ],
      edges: [
        edge("x1", "begin", "execOut", "set0", "execIn"),
        edge("d1", "make", "out", "set0", "value"),
        edge("x2", "set0", "execOut", "set1", "execIn"),
        edge("d2", "get1", "value", "concat", "array"),
        edge("d3", "get2", "value", "concat", "other"),
        edge("d4", "concat", "out", "set1", "value"),
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    const vars = new Map<string, unknown>();
    loadEntry(compiled.source, "onBeginPlay")({
      getVariable: (k: string) => vars.get(k),
      setVariable: (k: string, v: unknown) => vars.set(k, v),
    });
    expect(vars.get("A")).toEqual([1, 2, 1, 2]);
  });

  it("accumulates and looks up 4,000 Vec3 keys in Map in O(1) with -0/+0 equality and alias isolation", () => {
    const mapProp = (name: string) => ({ variableName: name, typeId: "int", container: "map", keyTypeId: "vec3", implicitSelf: true });
    const graph: LogicGraph = {
      id: "cowMap",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "makeMap", "map.make", { count: 0 }),
        node(registry, "setM0", "variables.set", mapProp("M")),
        node(registry, "loop", "flow.forLoop", { "default:firstIndex": 0, "default:lastIndex": 3999 }),
        node(registry, "getM", "variables.get", mapProp("M")),
        node(registry, "keyVec", "vector.make3", { "default:y": 0, "default:z": -0 }),
        node(registry, "mapSet", "map.set"),
        node(registry, "setM", "variables.set", mapProp("M")),
        // Alias M to Snapshot, then mutate M once more and verify Snapshot is isolated.
        node(registry, "getM2", "variables.get", mapProp("M")),
        node(registry, "setSnap", "variables.set", mapProp("Snap")),
        node(registry, "getM3", "variables.get", mapProp("M")),
        node(registry, "extraKey", "vector.make3", { "default:x": -0, "default:y": 0, "default:z": 0 }),
        node(registry, "mapSet2", "map.set", { "default:value": 9999 }),
        node(registry, "setM2", "variables.set", mapProp("M")),
        // Lookup with +0 matches -0 key.
        node(registry, "getM4", "variables.get", mapProp("M")),
        node(registry, "probeKey", "vector.make3", { "default:x": 0, "default:y": 0, "default:z": 0 }),
        node(registry, "mapGet", "map.get"),
        node(registry, "log", "debug.log"),
      ],
      edges: [
        edge("x1", "begin", "execOut", "setM0", "execIn"),
        edge("d1", "makeMap", "out", "setM0", "value"),
        edge("x2", "setM0", "execOut", "loop", "execIn"),
        edge("x3", "loop", "loopBody", "mapSet", "execIn"),
        edge("x4", "mapSet", "execOut", "setM", "execIn"),
        edge("d2", "getM", "value", "mapSet", "map"),
        edge("d3", "loop", "index", "keyVec", "x"),
        edge("d4", "keyVec", "out", "mapSet", "key"),
        edge("d5", "loop", "index", "mapSet", "value"),
        edge("d6", "mapSet", "out", "setM", "value"),
        edge("x5", "loop", "completed", "setSnap", "execIn"),
        edge("d7", "getM2", "value", "setSnap", "value"),
        edge("x6", "setSnap", "execOut", "mapSet2", "execIn"),
        edge("x7", "mapSet2", "execOut", "setM2", "execIn"),
        edge("d8", "getM3", "value", "mapSet2", "map"),
        edge("d9", "extraKey", "out", "mapSet2", "key"),
        edge("d10", "mapSet2", "out", "setM2", "value"),
        edge("x8", "setM2", "execOut", "log", "execIn"),
        edge("d11", "getM4", "value", "mapGet", "map"),
        edge("d12", "probeKey", "out", "mapGet", "key"),
        edge("d13", "mapGet", "out", "log", "message"),
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    const vars = new Map<string, unknown>();
    const logs: string[] = [];
    loadEntry(compiled.source, "onBeginPlay")({
      getVariable: (k: string) => vars.get(k),
      setVariable: (k: string, v: unknown) => vars.set(k, v),
      formatValue: (v: unknown) => String(v),
      log: (_sev: string, _cat: string, msg: string) => logs.push(msg),
    });
    expect(logs).toEqual(["9999"]);
    const m = vars.get("M") as Map<unknown, unknown>;
    const snap = vars.get("Snap") as Map<unknown, unknown>;
    expect(m.size).toBe(4000);
    expect(snap.size).toBe(4000);
    // Snapshot retained original value 0 at key (0,0,0), while M updated it to 9999.
    const snapZero = [...snap.entries()].find(([k]) => (k as { x: number }).x === 0)?.[1];
    expect(snapZero).toBe(0);
  });

  it("marks container inputs shared when passed to debug.executeJavaScript so aliased JS references stay isolated", () => {
    const arrProp = { variableName: "A", typeId: "int", container: "array", implicitSelf: true };
    const graph: LogicGraph = {
      id: "execJsCow",
      kind: "event",
      nodes: [
        node(registry, "begin", "flow.event.beginPlay"),
        node(registry, "make", "array.make", { count: 1, "default:item0": 10 }),
        node(registry, "setA0", "variables.set", arrProp),
        node(registry, "getA1", "variables.get", arrProp),
        node(registry, "js", "debug.executeJavaScript", {
          inputs: [{ name: "arr", type: { kind: "array", elementType: { kind: "int" } } }],
          outputs: [],
          body: "ctx.stashed = arr;",
        }),
        node(registry, "getA2", "variables.get", arrProp),
        node(registry, "append", "array.append", { "default:item": 20 }),
        node(registry, "setA1", "variables.set", arrProp),
      ],
      edges: [
        edge("x1", "begin", "execOut", "setA0", "execIn"),
        edge("d1", "make", "out", "setA0", "value"),
        edge("x2", "setA0", "execOut", "js", "execIn"),
        edge("d2", "getA1", "value", "js", "in_arr"),
        edge("x3", "js", "execOut", "setA1", "execIn"),
        edge("d3", "getA2", "value", "append", "array"),
        edge("d4", "append", "out", "setA1", "value"),
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "a", registry });
    const vars = new Map<string, unknown>();
    const ctxObj: Record<string, unknown> = {
      getVariable: (k: string) => vars.get(k),
      setVariable: (k: string, v: unknown) => vars.set(k, v),
    };
    loadEntry(compiled.source, "onBeginPlay")(ctxObj);
    expect(ctxObj.stashed).toEqual([10]);
    expect(vars.get("A")).toEqual([10, 20]);
    expect(ctxObj.stashed).not.toBe(vars.get("A"));
  });
});
