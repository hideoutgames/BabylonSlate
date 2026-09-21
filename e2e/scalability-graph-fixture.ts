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
    graphCommand("qual_clamped", [["scalability.setRenderScale", { scale: 0.1 }]]),
    graphCommand("qual_invalid", [["scalability.setFrameCap", { fps: -10 }]]),
    graphCommand("qual_aa", [["scalability.setAntialiasing", { enabled: true }]]),
    graphCommand("qual_cluster", [["scalability.setRenderPath", { path: "clusteredForward" }]]),
    graphCommand("qual_settings", [
      ["scalability.setResolution", { width: 400, height: 240 }],
      ["scalability.setResolutionQuality", { settings: { scale: 0.75, minScale: 0.75, dynamic: false, targetFps: 30 } }],
      ["scalability.setFrameCap", { fps: 24 }],
      ["scalability.setShadowsEnabled", { enabled: false }],
      ["scalability.setShadowQuality", { settings: { distance: 80, fadeFraction: 0.2, mapSize: 512, cascades: 1, filter: "pcf", filterQuality: "low", softness: 0.08, autoBias: false, depthBias: 0.002, normalBias: 0.01, localLightMode: "manual", maxLocalLights: 1, localMapSize: 256 } }],
      ["scalability.setLightingQuality", { settings: { localLightMode: "manual", maxLocalLights: 3 } }],
      ["scalability.setTextureQuality", { settings: { lodBias: 1, anisotropy: 2, byteBudget: 128 * 1024 ** 2 } }],
      ["scalability.setPostProcessingQuality", { settings: { resolutionScale: 0.5 } }],
      ["scalability.setEffects", { settings: { fxaa: false, exposure: 1.5, contrast: 1.2, vignette: { enabled: true, weight: 1.1 }, bloom: { enabled: false } } }],
      ["scalability.setVignetteColor", { color: { x: 0.2, y: 0.1, z: 0.3, w: 1 } }],
      ["scalability.setCelShading", { settings: { shadowBands: 6, shadowThreshold: 0.4, shadowStrength: 0.7, specularEnabled: false, specularStrength: 0.1, specularSize: 0.3, lightColorInfluence: 0.8, lightMixing: "additive" } }],
      ["scalability.setEnvironmentLighting", { settings: { enabled: false, intensity: 0.3, rotationYDegrees: 23, celStrength: 0.5 } }],
    ]),
    ...["low", "medium", "high", "ultra"].map((preset) => graphCommand(`qual_${preset}`, [["scalability.setPreset", { preset }]])),
  ];
}
