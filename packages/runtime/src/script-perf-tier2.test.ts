import { describe, expect, it } from "vitest";
import { compileGraph, type GraphEdge, type GraphNode, type LogicGraph } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

function makeNode(
  registry: ReturnType<typeof createDefaultNodeRegistry>,
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  const def = registry.get(typeId);
  if (!def) throw new Error(`missing node ${typeId}`);
  return { id, typeId, position: { x: 0, y: 0 }, pins: def.pins(properties), properties };
}

function edge(id: string, sourceNodeId: string, sourcePinId: string, targetNodeId: string, targetPinId: string): GraphEdge {
  return { id, sourceNodeId, sourcePinId, targetNodeId, targetPinId };
}

function classScript(
  classId: string,
  parentClassId: string,
  source: string,
  events: readonly string[] = [],
  { functions = [], ...extra }: Partial<CompiledScript> & { functions?: readonly string[] } = {},
): CompiledScript {
  return {
    assetGuid: `${classId}-script`,
    classId,
    parentClassId,
    source,
    anchors: [],
    entryPoints: [
      ...events.map((event) => ({ name: event, event, isAsync: false })),
      ...functions.map((name) => ({ name, isAsync: false })),
    ],
    ...extra,
  };
}

describe("Tier 2 scripting optimizations: runtime parity and caching", () => {
  it("runs read-only For Each and actor variable fast paths with exact VersionedVariables semantics", async () => {
    const registry = createDefaultNodeRegistry();
    const listProp = { variableName: "Values", typeId: "int", container: "array", implicitSelf: true };
    const totalProp = { variableName: "Total", typeId: "int", implicitSelf: true };
    const graph: LogicGraph = {
      id: "sum",
      kind: "event",
      nodes: [
        makeNode(registry, "tick", "flow.event.tick"),
        makeNode(registry, "getList", "variables.get", listProp),
        makeNode(registry, "loop", "flow.forEach"),
        makeNode(registry, "getTotal", "variables.get", totalProp),
        makeNode(registry, "add", "math.add", { aType: "int", bType: "int" }),
        makeNode(registry, "setTotal", "variables.set", totalProp),
      ],
      edges: [
        edge("x1", "tick", "execOut", "loop", "execIn"),
        edge("d1", "getList", "value", "loop", "array"),
        edge("x2", "loop", "loopBody", "setTotal", "execIn"),
        edge("d2", "getTotal", "value", "add", "a"),
        edge("d3", "loop", "element", "add", "b"),
        edge("d4", "add", "out", "setTotal", "value"),
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "sum-1", registry, instrumentInfiniteLoops: true });
    expect(compiled.source).not.toContain(".slice(");

    const runtime = createInProcessRuntime({ seed: 1 });
    await runtime.loadScripts([{
      assetGuid: "sum-1",
      classId: "Summer",
      parentClassId: "Actor",
      source: compiled.source,
      anchors: compiled.anchors,
      entryPoints: compiled.entryPoints,
    }]);
    const actor = runtime.spawnScriptedActor({
      classId: "Summer",
      variables: { Values: [2, 3, 5, 7], Total: 0 },
    })!;
    runtime.start();

    for (let i = 0; i < 5; i++) runtime.tick();
    expect(actor.getVariable("Total")).toBe(85);

    // Unchanged primitive write does not bump revision; changed write does.
    const revBefore = actor.variablesRevision;
    actor.setVariable("Total", 85);
    expect(actor.variablesRevision).toBe(revBefore);
    actor.setVariable("Total", 86);
    expect(actor.variablesRevision).toBe(revBefore + 1);
    runtime.stop();
  });

  it("caches interface override resolution per class and invalidates cleanly on replaceScripts", async () => {
    const runtime = createInProcessRuntime({ seed: 1 });
    const callerSource = `export function onTick(ctx) {
      const b = ctx.callInterface(ctx.getVariable("base"), "iface-dmg", "TakeDamage", { amount: 5 });
      const s = ctx.callInterface(ctx.getVariable("sub"), "iface-dmg", "TakeDamage", { amount: 5 });
      ctx.setVariable("results", [b.out, s.out]);
    }`;

    await runtime.loadScripts([
      classScript(
        "Base",
        "Actor",
        `export function TakeDamage(ctx) { return { out: Number(ctx.args.amount ?? 0) * 1 }; }`,
        [],
        {
          functions: ["TakeDamage"],
          implementedInterfaces: ["iface-dmg"],
          interfaceImplementations: [{ interfaceGuid: "iface-dmg", method: "TakeDamage", exportName: "TakeDamage" }],
        },
      ),
      classScript(
        "Sub",
        "Base",
        `export function TakeDamage(ctx) { return { out: Number(ctx.args.amount ?? 0) * 2 }; }`,
        [],
        { functions: ["TakeDamage"], implementedInterfaces: ["iface-dmg"] },
      ),
      classScript("Caller", "Actor", callerSource, ["onTick"]),
    ]);

    const base = runtime.spawnScriptedActor({ classId: "Base" })!;
    const sub = runtime.spawnScriptedActor({ classId: "Sub" })!;
    const caller = runtime.spawnScriptedActor({ classId: "Caller", variables: { base, sub } })!;
    runtime.start();

    runtime.tick();
    runtime.tick();
    expect(caller.getVariable("results")).toEqual([5, 10]);

    // Hot-reload scripts with updated multipliers: cached targets must invalidate cleanly.
    await runtime.loadScripts([
      classScript(
        "Base",
        "Actor",
        `export function TakeDamage(ctx) { return { out: Number(ctx.args.amount ?? 0) * 3 }; }`,
        [],
        {
          functions: ["TakeDamage"],
          implementedInterfaces: ["iface-dmg"],
          interfaceImplementations: [{ interfaceGuid: "iface-dmg", method: "TakeDamage", exportName: "TakeDamage" }],
        },
      ),
      classScript(
        "Sub",
        "Base",
        `export function TakeDamage(ctx) { return { out: Number(ctx.args.amount ?? 0) * 10 }; }`,
        [],
        { functions: ["TakeDamage"], implementedInterfaces: ["iface-dmg"] },
      ),
      classScript("Caller", "Actor", callerSource, ["onTick"]),
    ]);

    runtime.tick();
    expect(caller.getVariable("results")).toEqual([15, 50]);
    runtime.stop();
  });
});
