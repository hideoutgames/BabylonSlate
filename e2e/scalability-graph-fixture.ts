import { compileGraph, type GraphNode, type LogicGraph } from "../packages/scripting/src/index";
import { createDefaultNodeRegistry } from "../packages/scripting-nodes/src/index";
import type { ScriptBundleEntry } from "../packages/bridge/src/channels";

/** Real compiled Class Graphs; commands only trigger the graph's native entry. */
export function scalabilityGraphScripts(): ScriptBundleEntry[] {
  const registry = createDefaultNodeRegistry();
  const graphCommand = (name: string, actions: [string, Record<string, unknown>][]): ScriptBundleEntry => {
    const nodes: GraphNode[] = [["flow.event.commandRun", {}] as [string, Record<string, unknown>], ...actions].map(([typeId, properties], index) => ({
      id: `node-${index}`, typeId, properties, position: { x: index * 300, y: 0 }, pins: registry.get(typeId)!.pins(properties),
    }));
    const graph: LogicGraph = { id: name, kind: "event", nodes, edges: actions.map((_, index) => ({
      id: `exec-${index}`, sourceNodeId: `node-${index}`, sourcePinId: "execOut", targetNodeId: `node-${index + 1}`, targetPinId: "execIn",
    })) };
    const compiled = compileGraph(graph, { registry, assetGuid: name });
    return { assetGuid: name, classId: name, parentClassId: "BDebugCommand", source: compiled.source, anchors: compiled.anchors,
      entryPoints: compiled.entryPoints, command: { name, category: "Qualification", description: "Exercise a compiled scalability graph", parameters: [] } };
  };
  return [
    graphCommand("qual_pbr", [["scalability.setRenderMode", { mode: "pbr" }]]),
    graphCommand("qual_cel", [["scalability.setRenderMode", { mode: "cel" }]]),
    graphCommand("qual_runtime", [["scalability.setFrameCap", { fps: 20 }], ["scalability.setRenderScale", { scale: 0.5 }]]),
    graphCommand("qual_reset", [["scalability.reset", {}]]),
    ...["low", "medium", "high", "ultra"].map((preset) => graphCommand(`qual_${preset}`, [["scalability.setPreset", { preset }]])),
  ];
}
