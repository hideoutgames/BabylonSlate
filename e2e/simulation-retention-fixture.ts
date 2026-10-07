import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { createActor, createDefaultScene, createDefaultSceneLayer, createMeshComponent, identitySerializedTransform,
  MAIN_CLASS_FILE, MAIN_SCENE_FILE, type SerializedComponent, type SerializedGraph } from "../packages/core/src/index";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";

export const RETENTION_MATERIAL_GUID = "00000000-0000-4000-8000-000000000085";
const MAIN_GUID = "00000000-0000-4000-8000-000000000002";
const CHILD_GUID = "00000000-0000-4000-8000-000000000081";
const VICTIM_GUID = "00000000-0000-4000-8000-000000000082";
const INITIAL_MATERIAL_GUID = "00000000-0000-4000-8000-000000000083";
const LAYER_GUID = "00000000-0000-4000-8000-000000000084";

/** Authored Execute JavaScript nodes compile normally. No browser test hook
 * substitutes world data, scripts, serialization or a retained result. */
export async function simulationRetentionProject(kind: "complete" | "history-budget" | "independent-layer") {
  const files = await minimalProjectFiles();
  const migrations = createDefaultMigrationRegistry();
  const sourceMesh = createMeshComponent("source-mesh", "box");
  sourceMesh.properties.materialGuid = INITIAL_MATERIAL_GUID;
  const sourceLight: SerializedComponent = { id: "source-light", classId: "PointLightComponent", properties: { intensity: 1 } };
  const body = kind === "history-budget" ? [
    'ctx.setVariable("LargeValue", "x".repeat(1_100_000));',
    'ctx.print("RETENTION_READY", "retention", 30);',
  ].join("\n") : kind === "complete" ? [
    'if (ctx.getVariable("Applied")) return;',
    'ctx.setVariable("Applied", true);',
    'const child = await ctx.spawnActorAsync("RetainedChild", {location:{x:2,y:1,z:0}, rotation:{pitch:0,yaw:0,roll:0}, scale:{x:1,y:1,z:1}});',
    'if (!child) throw new Error("Retention child did not spawn");',
    'child.setVariable("name", "Gameplay Child");',
    'ctx.attachActor(child, ctx.self);',
    'ctx.setVariable("Target", child);',
    'ctx.setVariable("Health", 42);',
    'const light = ctx.addComponent(child, "PointLightComponent");',
    'ctx.setVariableOn(light, "intensity", 2);',
    'const removed = ctx.getComponentById(ctx.self, "source-light");',
    'if (!removed) throw new Error("Sourced component did not load");',
    // This is authored gameplay's existing object-model lifetime boundary, not
    // an editor command or a synthetic captured document.
    'removed.destroyed = true; removed.callOnDestroyed();',
    'ctx.destroyActor(ctx.getActorOfClass("RetentionVictim"));',
    'ctx.print("RETENTION_READY", "retention", 30);',
  ].join("\n") : 'ctx.print("RETENTION_READY", "retention", 30);';
  const main: SerializedGraph = {
    components: [sourceMesh, sourceLight],
    members: [
      { id: "applied", kind: "variable", name: "Applied", typeId: "bool", defaultValue: false },
      { id: "health", kind: "variable", name: "Health", typeId: "float", defaultValue: 10 },
      { id: "target", kind: "variable", name: "Target", typeId: "object", typeClassId: "Actor", defaultValue: null },
      { id: "large", kind: "variable", name: "LargeValue", typeId: "string", defaultValue: "" },
    ],
    nodes: [
      { id: "begin", type: "flow.event.beginPlay", data: {}, position: { x: 0, y: 0 } },
      { id: "gameplay", type: "debug.executeJavaScript", data: { async: kind === "complete", body }, position: { x: 240, y: 0 } },
    ],
    edges: [{ id: "begin-gameplay", source: "begin", sourceHandle: "execOut", target: "gameplay", targetHandle: "execIn" }],
  };
  const scene = createDefaultScene();
  scene.actors = scene.actors.filter(actor => actor.id !== "actor-1");
  scene.actors.unshift(createActor("retention-host", "Retention Host", {
    classId: "Main", components: main.components!.map(component => ({ ...structuredClone(component), id: `host-${component.id}`, sourceId: component.id })),
  }));
  if (kind === "complete") scene.actors.push(createActor("victim", "Victim", {
    classId: "RetentionVictim", transform: { ...identitySerializedTransform(), position: [-3, 1, 0] },
    components: [{ ...createMeshComponent("victim-mesh", "box"), sourceId: "victim-source" }],
  }));
  if (kind === "independent-layer") scene.settings.sceneLayers = [{ assetGuid: LAYER_GUID, zOrder: 0, enabled: true }];
  const material = createDefaultMaterialDocument("Initial Material");
  material.nodes.push({ id: "roughness", type: "param.float", position: { x: 0, y: 200 }, properties: { name: "Roughness", value: [0.5] } });
  material.edges.push({ id: "roughness-output", sourceNodeId: "roughness", sourcePinId: "out", targetNodeId: "output", targetPinId: "roughness" });
  const assets = [
    { path: MAIN_SCENE_FILE, guid: "00000000-0000-4000-8000-000000000001", type: "Scene", name: "Main", payload: scene,
      dependencies: [MAIN_GUID, ...(kind === "complete" ? [VICTIM_GUID] : []), ...(kind === "independent-layer" ? [LAYER_GUID] : [])] },
    { path: MAIN_CLASS_FILE, guid: MAIN_GUID, type: "Class", name: "Main", payload: main, dependencies: [INITIAL_MATERIAL_GUID, ...(kind === "complete" ? [CHILD_GUID] : [])] },
    { path: "assets/RetainedChild.class.babasset", guid: CHILD_GUID, type: "Class", name: "RetainedChild", payload: { nodes: [], edges: [], components: [createMeshComponent("child-source", "sphere")] }, dependencies: [] },
    { path: "assets/RetentionVictim.class.babasset", guid: VICTIM_GUID, type: "Class", name: "RetentionVictim", payload: { nodes: [], edges: [], components: [createMeshComponent("victim-source", "box")] }, dependencies: [] },
    { path: "assets/Initial.material.babasset", guid: INITIAL_MATERIAL_GUID, type: "Material", name: "Initial Material", payload: material, dependencies: [] },
    { path: "assets/Retained.material.babasset", guid: RETENTION_MATERIAL_GUID, type: "Material", name: "Retained Material", payload: { ...material, name: "Retained Material" }, dependencies: [] },
    { path: "assets/Independent.scenelayer.babasset", guid: LAYER_GUID, type: "SceneLayer", name: "Independent", payload: createDefaultSceneLayer(), dependencies: [] },
  ];
  for (const asset of assets) files.set(asset.path, await encodeAssetDocument({
    ...asset, version: migrations.currentVersion(asset.type), payload: asset.payload as unknown as Record<string, unknown>,
  }, { dependencies: asset.dependencies, ...(asset.type === "Class" ? { parentClass: "Actor" } : {}) }));
  return files;
}
