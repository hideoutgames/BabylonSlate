import { compileGraph, type GraphNode, type LogicGraph } from "../packages/scripting/src/index";
import { createDefaultNodeRegistry } from "../packages/scripting-nodes/src/index";
import type { ScriptBundleEntry } from "../packages/bridge/src/channels";

/** The same saved Class graphs qualify editor compilation and standalone execution. */
export function scalabilityGraphDefinitions(): { name: string; graph: LogicGraph }[] {
  const registry = createDefaultNodeRegistry();
  const graphCommand = (name: string, actions: [string, Record<string, unknown>][]) => {
    const nodes: GraphNode[] = [["flow.event.commandRun", { commandName: name }] as [string, Record<string, unknown>], ...actions].map(([typeId, properties], index) => ({
      id: `node-${index}`, typeId, properties, position: { x: index * 300, y: 0 }, pins: registry.get(typeId)!.pins(properties),
    }));
    const graph: LogicGraph = { id: name, kind: "event", nodes, edges: actions.map((_, index) => ({
      id: `exec-${index}`, sourceNodeId: `node-${index}`, sourcePinId: "execOut", targetNodeId: `node-${index + 1}`, targetPinId: "execIn",
    })) };
    return { name, graph };
  };
  const outlineRoundtrip = graphCommand("qual_outline_roundtrip", [["scalability.setCelOutlines", { "default:enabled": true, "default:width": 4 }]]);
  outlineRoundtrip.graph.nodes.push({ id: "read", typeId: "scalability.getEffective", properties: {}, position: { x: 0, y: 160 }, pins: registry.get("scalability.getEffective")!.pins({}) });
  outlineRoundtrip.graph.edges.push({ id: "outline-color", sourceNodeId: "read", sourcePinId: "outlineColor", targetNodeId: "node-1", targetPinId: "color" });
  return [
    graphCommand("qual_outlines", [["scalability.setCelOutlines", { "default:enabled": true, "default:color": { x: 0.1875, y: 0.75, z: 0.375, w: 1 }, "default:width": 4 }]]),
    graphCommand("qual_outlines_off", [["scalability.setCelOutlines", { "default:enabled": false, "default:color": { x: 0.1875, y: 0.75, z: 0.375, w: 1 }, "default:width": 4 }]]),
    outlineRoundtrip,
    graphCommand("qual_pbr", [["scalability.setRenderMode", { "default:mode": "pbr" }]]),
    graphCommand("qual_cel", [["scalability.setRenderMode", { "default:mode": "cel" }]]),
    graphCommand("qual_runtime", [["scalability.setFrameCap", { "default:fps": 20 }], ["scalability.setRenderScale", { "default:scale": 0.5 }]]),
    graphCommand("qual_reset", [["scalability.reset", {}]]),
    graphCommand("qual_clamped", [["scalability.setRenderScale", { "default:scale": 0.1 }]]),
    graphCommand("qual_invalid", [["scalability.setFrameCap", { "default:fps": -10 }]]),
    graphCommand("qual_aa", [["scalability.setAntialiasing", { "default:enabled": true }]]),
    graphCommand("qual_cluster", [["scalability.setRenderPath", { "default:path": "clusteredForward" }]]),
    graphCommand("qual_settings", [
      ["scalability.setResolution", { "default:width": 400, "default:height": 240 }],
      ["scalability.setResolutionQuality", { "default:settings": { scale: 0.75, minScale: 0.75, dynamic: false, targetFps: 30 } }],
      ["scalability.setFrameCap", { "default:fps": 24 }],
      ["scalability.setShadowsEnabled", { "default:enabled": false }],
      ["scalability.setShadowQuality", { "default:settings": { distance: 80, fadeFraction: 0.2, mapSize: 512, cascades: 1, filter: "pcf", filterQuality: "low", softness: 0.08, autoBias: false, depthBias: 0.002, normalBias: 0.01, localLightMode: "manual", maxLocalLights: 1, localMapSize: 256 } }],
      ["scalability.setLightingQuality", { "default:settings": { localLightMode: "manual", maxLocalLights: 3 } }],
      ["scalability.setTextureQuality", { "default:settings": { lodBias: 1, anisotropy: 2, byteBudget: 128 * 1024 ** 2 } }],
      ["scalability.setGeometryQuality", { "default:settings": { autoLod: false, lodDistanceScale: 2 } }],
      ["scalability.setPostProcessingQuality", { "default:settings": { resolutionScale: 0.5 } }],
      ["scalability.setEffects", { "default:settings": { fxaa: false, exposure: 1.5, contrast: 1.2, vignette: { enabled: true, weight: 1.1 }, bloom: { enabled: false } } }],
      ["scalability.setVignetteColor", { "default:color": { x: 0.2, y: 0.1, z: 0.3, w: 1 } }],
      ["scalability.setCelShading", { "default:settings": { shadowBands: 6, shadowThreshold: 0.4, shadowStrength: 0.7, specularEnabled: false, specularStrength: 0.1, specularSize: 0.3, lightColorInfluence: 0.8, lightMixing: "additive" } }],
      ["scalability.setCelOutlines", { "default:enabled": true, "default:color": { x: 0.1875, y: 0.75, z: 0.375, w: 1 }, "default:width": 4 }],
      ["scalability.setEnvironmentLighting", { "default:settings": { enabled: false, intensity: 0.3, rotationYDegrees: 23, celStrength: 0.5 } }],
    ]),
    ...["low", "medium", "high", "ultra"].map((preset) => graphCommand(`qual_${preset}`, [["scalability.setPreset", { "default:preset": preset }]])),
  ];
}

/** Commands only trigger the compiled graph's native entry. */
export function scalabilityGraphScripts(): ScriptBundleEntry[] {
  const registry = createDefaultNodeRegistry();
  return scalabilityGraphDefinitions().map(({ name, graph }) => {
    const compiled = compileGraph(graph, { registry, assetGuid: name });
    return { assetGuid: name, classId: name, parentClassId: "BDebugCommand", source: compiled.source, anchors: compiled.anchors,
      entryPoints: compiled.entryPoints, command: { name, category: "Qualification", description: "Exercise a compiled scalability graph", parameters: [] } };
  });
}
