import { expect, it } from "vitest";
import { compileGraph, type GraphNode, type LogicGraph } from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "./index";

it.each([true, false])("preload waits for readiness and follows the correct completion branch (success=%s)", async success => {
  const registry = createDefaultNodeRegistry();
  const node = (id: string, typeId: string, properties: Record<string, unknown> = {}): GraphNode => ({
    id, typeId, properties, position: { x: 0, y: 0 }, pins: registry.get(typeId)!.pins(properties),
  });
  const edge = (sourceNodeId: string, sourcePinId: string, targetNodeId: string, targetPinId: string) => ({
    id: `${sourceNodeId}:${sourcePinId}:${targetNodeId}`, sourceNodeId, sourcePinId, targetNodeId, targetPinId,
  });
  const graph: LogicGraph = {
    id: "preload", kind: "event", nodes: [
      node("entry", "flow.entry"), node("preload", "assets.preload", { assets: ["model"] }),
      node("complete", "debug.executeJavaScript", { body: "ctx.events.push('ready');" }),
      node("failed", "debug.executeJavaScript", { inputs: [{ name: "error", type: { kind: "string" } }], body: "ctx.events.push(error);" }),
      node("release", "assets.releasePreload"),
    ], edges: [
      edge("entry", "execOut", "preload", "execIn"), edge("preload", "completed", "complete", "execIn"),
      edge("preload", "failed", "failed", "execIn"), edge("preload", "error", "failed", "in_error"),
      edge("complete", "execOut", "release", "execIn"), edge("preload", "preload", "release", "preload"),
    ],
  };
  const compiled = compileGraph(graph, { registry, assetGuid: "preload-graph" });
  const source = compiled.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ");
  const run = new Function(`${source}\nreturn run;`)() as (ctx: Record<string, unknown>) => Promise<void>;
  let resolve!: (value: unknown) => void;
  const events: string[] = [];
  const requested: unknown[] = [];
  const operation = run({ events,
    preloadAssets: (ids: string[], options: { onProgress: (progress: number) => void }) => {
      requested.push(ids); options.onProgress(0.5); return new Promise(done => { resolve = done; });
    },
    releasePreload: (id: string) => events.push(id),
  });
  expect(requested).toEqual([["model"]]);
  expect(events).toEqual([]);
  resolve({ preloadId: "handle", success, progress: success ? 1 : 0.5, errorMessage: success ? "" : "Missing model" });
  await operation;
  expect(events).toEqual(success ? ["ready", "handle"] : ["Missing model"]);
});
