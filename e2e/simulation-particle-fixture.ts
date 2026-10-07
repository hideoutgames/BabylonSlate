import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { normalizeParticleEmitterPayload } from "../packages/assets/src/particle-basic-emitter";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { createActor, createDefaultScene, createMeshComponent, identitySerializedTransform, MAIN_SCENE_FILE, PROJECT_FILE } from "../packages/core/src/index";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";

/** Small saved assets loaded by the normal registry/compiler/player preparation.
 * Red moving particles occupy the middle; a blue editable cube below them proves
 * redraw without contaminating the particle pixel population. */
export async function simulationParticleProject() {
  const files = await minimalProjectFiles();
  const migrations = createDefaultMigrationRegistry();
  const particleMaterialGuid = "00000000-0000-4000-8000-000000000071";
  const emitterGuid = "00000000-0000-4000-8000-000000000072";
  const systemGuid = "00000000-0000-4000-8000-000000000073";
  const blueMaterialGuid = "00000000-0000-4000-8000-000000000074";
  const particleMaterial = createDefaultMaterialDocument("Pause Particles", "particle");
  const blueMaterial = createDefaultMaterialDocument("Redraw Control");
  blueMaterial.shadingModel = "unlit";
  blueMaterial.nodes.find(node => node.id === "baseColor")!.properties.value = [0, 0, 1];
  const emitter = normalizeParticleEmitterPayload({
    emitter: { loop: "infinite", duration: 2, capacity: 128 },
    spawn: { rate: { mode: "constant", value: 30 } },
    shape: { kind: "point", direction1: [1, 0, 0], direction2: [1, 0, 0] },
    initialize: {
      lifetime: { mode: "constant", value: 1.5 }, speed: { mode: "constant", value: 2 },
      size: { mode: "constant", value: 0.2 }, color: { mode: "constant", color: [1, 0, 0, 1] },
    },
    render: { materialGuid: particleMaterialGuid, blendMode: "additive" },
  });
  const cameraId = "pause-camera";
  const scene = createDefaultScene();
  scene.settings.environmentColor = [0, 0, 0];
  scene.settings.grid.showGrid = false;
  scene.settings.mainCameraActorId = cameraId;
  scene.settings.mainCameraComponentId = "lens";
  const cube = createMeshComponent("control-mesh", "box");
  cube.properties.materialGuid = blueMaterialGuid;
  scene.actors = [
    createActor(cameraId, "Camera", {
      transform: { ...identitySerializedTransform(), position: [0, 0, -10] },
      components: [{ id: "lens", classId: "CameraComponent", properties: { nearClip: 0.1, farClip: 100, fieldOfView: 60 } }],
    }),
    createActor("particles", "Moving Particles", {
      components: [{ id: "emitter", classId: "ParticleComponent", properties: { particleSystemGuid: systemGuid, playOnStart: true } }],
    }),
    createActor("control", "Redraw Control", {
      transform: { ...identitySerializedTransform(), position: [-3, -2.5, 0] }, components: [cube],
    }),
  ];
  const project = JSON.parse(new TextDecoder().decode(files.get(PROJECT_FILE)!));
  project.settings.render.gpuBackend = "webgl2";
  files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
  const assets = [
    { path: MAIN_SCENE_FILE, guid: "00000000-0000-4000-8000-000000000001", type: "Scene", name: "Main", payload: scene, dependencies: [systemGuid, blueMaterialGuid] },
    { path: "assets/PauseParticles.material.babasset", guid: particleMaterialGuid, type: "Material", name: "Pause Particles", payload: particleMaterial, dependencies: [] },
    { path: "assets/RedrawControl.material.babasset", guid: blueMaterialGuid, type: "Material", name: "Redraw Control", payload: blueMaterial, dependencies: [] },
    { path: "assets/PauseParticles.emitter.babasset", guid: emitterGuid, type: "ParticleEmitter", name: "Pause Particles", payload: emitter, dependencies: [particleMaterialGuid] },
    { path: "assets/PauseParticles.particles.babasset", guid: systemGuid, type: "ParticleSystem", name: "Pause Particles", payload: { emitterGuids: [emitterGuid], space: "world" }, dependencies: [emitterGuid] },
  ];
  for (const asset of assets) files.set(asset.path, await encodeAssetDocument({
    ...asset, version: migrations.currentVersion(asset.type), payload: asset.payload as unknown as Record<string, unknown>,
  }, { dependencies: asset.dependencies }));
  return files;
}
