import { describe, expect, it } from "vitest";
import { compileGraph, type LogicGraph } from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";

type NodeSpec = [id: string, typeId: string, properties?: Record<string, unknown>];
type EdgeSpec = [source: string, sourcePin: string, target: string, targetPin: string];

function runBeginPlay(nodes: NodeSpec[], edges: EdgeSpec[], ctx: Record<string, unknown>): void {
  const registry = createDefaultNodeRegistry();
  const graph: LogicGraph = {
    id: "g",
    kind: "event",
    nodes: [["begin", "flow.event.beginPlay"] as NodeSpec, ...nodes].map(([id, typeId, properties = {}]) => ({
      id, typeId, position: { x: 0, y: 0 }, pins: registry.get(typeId)!.pins(properties), properties,
    })),
    edges: edges.map(([sourceNodeId, sourcePinId, targetNodeId, targetPinId], index) => ({
      id: `e${index}`, sourceNodeId, sourcePinId, targetNodeId, targetPinId,
    })),
  };
  const body = compileGraph(graph, { assetGuid: "a", registry }).source
    .replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  (new Function(`${body}\nreturn onBeginPlay;`)() as (context: unknown) => void)(ctx);
}

describe("scalability nodes", () => {
  it("Set Render Scale writes one sample of Scale as scale and minimum", () => {
    let samples = 0;
    const requests: unknown[] = [];
    runBeginPlay(
      [["roll", "math.random"], ["scale", "scalability.setRenderScale"]],
      [["begin", "execOut", "scale", "execIn"], ["roll", "out", "scale", "scale"]],
      { random: { float: () => (samples += 1) / 4 }, requestScalability: (request: unknown) => requests.push(request) },
    );
    expect(samples).toBe(1);
    expect(requests).toEqual([
      { kind: "patch", render: { quality: { resolution: { scale: 0.25, minScale: 0.25, dynamic: false } } } },
    ]);
  });

  it.each([
    ["scalability.setVignetteColor", (request: { render: { effects: { vignette: { color: unknown } } } }) => request.render.effects.vignette.color],
    ["scalability.setCelOutlines", (request: { render: { cel: { outlineColor: unknown } } }) => request.render.cel.outlineColor],
  ] as const)("%s sends the RGB of one read of a changing Color", (typeId, colorOf) => {
    let samples = 0;
    const requests: unknown[] = [];
    runBeginPlay(
      [...(["r", "g", "b", "a"] as const).map((channel): NodeSpec => [`r${channel}`, "math.random"]),
        ["make", "struct.makeColor"], ["set", typeId]],
      [["begin", "execOut", "set", "execIn"], ["make", "out", "set", "color"],
        ...(["r", "g", "b", "a"] as const).map((channel): EdgeSpec => [`r${channel}`, "out", "make", channel])],
      { random: { float: () => (samples += 1) }, requestScalability: (request: unknown) => requests.push(request) },
    );
    expect(samples).toBe(4);
    expect(requests.map((request) => colorOf(request as never))).toEqual([[1, 2, 3]]);
  });

  it("Get Effective Scalability reads the snapshot once for Requested GPU Backend", () => {
    let reads = 0;
    const logs: unknown[] = [];
    runBeginPlay(
      [["get", "scalability.getEffective"], ["log", "debug.log"]],
      [["begin", "execOut", "log", "execIn"], ["get", "requestedBackend", "log", "message"]],
      {
        getScalability: () => {
          reads += 1;
          return { requested: { render: { gpuBackend: "webgpu" } }, effective: null, pipeline: null };
        },
        formatValue: (value: unknown) => value,
        log: (_severity: string, _category: string, value: unknown) => logs.push(value),
      },
    );
    expect({ reads, logs }).toEqual({ reads: 1, logs: ["webgpu"] });
  });

  it("Get Effective Scalability reports the effective backend of an acknowledgement without a pipeline", () => {
    const logs: unknown[] = [];
    runBeginPlay(
      [["get", "scalability.getEffective"], ["log", "debug.log"]],
      [["begin", "execOut", "log", "execIn"], ["get", "effectiveBackend", "log", "message"]],
      {
        getScalability: () => ({
          requested: { render: { gpuBackend: "auto" } },
          effective: { render: { gpuBackend: "webgl2" } },
          pipeline: null,
        }),
        formatValue: (value: unknown) => value,
        log: (_severity: string, _category: string, value: unknown) => logs.push(value),
      },
    );
    expect(logs).toEqual(["webgl2"]);
  });
});
