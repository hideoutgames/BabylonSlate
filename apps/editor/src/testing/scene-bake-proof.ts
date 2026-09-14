import { Engine, Scene } from "@babylonjs/core";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  identitySerializedTransform,
} from "@babylonslate/core";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import {
  applyActorTransform,
  createActorMesh,
  syncAuthoredIllumination,
} from "@babylonslate/render";
import {
  prepareSceneBake,
  preparedBakeReceiverTransport,
} from "@babylonslate/render/scene-bake-preparation";
import { unwrapBakeGeometry } from "@babylonslate/render/bake-uv-atlas";
import { bakeLightingPrototype } from "@babylonslate/render/bake-provider-prototype";

/** Numeric authored Scene fixture, loaded only by the established test-build entry. */
export async function runSceneBakeProof() {
  const document = createDefaultScene();
  const meshComponent = createMeshComponent("receiver-component", "ground");
  meshComponent.properties.materialGuid = "diffuse-material";
  meshComponent.properties.bakeParticipation = "staticReceiver";
  document.actors = [
    createActor("receiver-actor", "Receiver", {
      transform: { ...identitySerializedTransform(), scale: [0.2, 0.2, 0.2] },
      components: [meshComponent],
    }),
    createActor("static-actor", "Static", {
      transform: { ...identitySerializedTransform(), position: [0, 2, 0] },
      components: [
        {
          id: "static-component",
          classId: "LightComponent",
          properties: { mobility: "static", intensity: 4 },
        },
      ],
    }),
    createActor("stationary-actor", "Stationary", {
      transform: { ...identitySerializedTransform(), position: [0, 2, 0] },
      components: [
        {
          id: "stationary-component",
          classId: "LightComponent",
          properties: { mobility: "stationary", intensity: 2 },
        },
      ],
    }),
  ];
  const material = createDefaultMaterialDocument();
  material.twoSided = true;
  material.nodes[0]!.properties.value = [0.1, 0.3, 0.7];
  const canvas = window.document.createElement("canvas");
  const engine = new Engine(canvas, false, { disableWebGL2Support: false });
  const scene = new Scene(engine);
  const abort = new AbortController();
  const owner = { sceneGuid: "authored-bake-scene", generation: 1 };
  let prepared;
  let realtimeCount = 0;
  try {
    const mesh = createActorMesh(scene, document.actors[0]!);
    applyActorTransform(mesh, document.actors[0]!);
    syncAuthoredIllumination(scene, document);
    realtimeCount = scene.lights.filter((light) => light.isEnabled()).length;
    prepared = await prepareSceneBake({
      owner,
      current: () => owner,
      document,
      materials: new Map([["diffuse-material", material]]),
      meshForComponent: (actorId, componentId) =>
        actorId === "receiver-actor" && componentId === "receiver-component"
          ? mesh
          : null,
      settings: { resolution: 32, paddingTexels: 2, samples: 1, bounces: 2 },
      signal: abort.signal,
    });
    if (
      scene.lights.filter((light) => light.isEnabled()).length !== realtimeCount
    )
      throw new Error("Preparation removed realtime light fallback.");
  } finally {
    scene.dispose();
    engine.dispose();
  }
  const receiver = prepared.meshes[0]!;
  const uv = await unwrapBakeGeometry(receiver.source, {
    resolution: 32,
    paddingTexels: 2,
    signal: abort.signal,
  });
  const transport = preparedBakeReceiverTransport(receiver, uv.topology);
  const results = [];
  for (const batch of prepared.batches) {
    let released = false;
    const baked = await bakeLightingPrototype(
      {
        meshes: [transport],
        lights: batch.lights,
        size: 32,
        samples: 1,
        bounces: 2,
        mode: batch.mode,
      },
      {
        signal: abort.signal,
        onDisposed: (result) => {
          released = result.contextReleased;
        },
      },
    );
    let minimum = Infinity,
      maximum = 0,
      colorDelta = 0;
    for (let index = 0; index < baked.irradiance.length; index += 4) {
      if (!baked.irradiance[index + 3]) continue;
      for (let channel = 0; channel < 3; channel++) {
        const value = baked.irradiance[index + channel]!;
        if (!Number.isFinite(value))
          throw new Error("Nonfinite prepared irradiance.");
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
        colorDelta = Math.max(
          colorDelta,
          Math.abs(value - baked.irradiance[index]!),
        );
      }
    }
    results.push({
      mode: batch.mode,
      sources: batch.sourceIds,
      minimum,
      maximum,
      colorDelta,
      covered: baked.coveredTexels,
      released,
    });
  }
  return {
    sceneGuid: prepared.owner.sceneGuid,
    receiver: receiver.identity,
    realtimeCount,
    sourceCount: prepared.sources.length,
    inputs: prepared.inputs,
    results,
  };
}
