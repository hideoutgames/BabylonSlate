import { expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  encodeFoliageChunk,
  foliageBatchInfos,
  encodeLandscapeChunk,
  foliageChunkId,
  identitySerializedTransform,
  landscapeChunkId,
  packFoliageTransforms,
  parseLandscapeProperties,
  serializeFoliageProperties,
} from "@haptic/core";
import type { CommandMessage } from "@haptic/bridge";
import { createInProcessRuntime } from "./driver";

it("transports authored terrain and a whole mixed foliage stroke via raw HPLD and HPFG chunks as component parts for Play", async () => {
  const landscape = parseLandscapeProperties({ subdivisions: 4, heights: new Float32Array(25).fill(3), materialGuid: "terrain", collisionsEnabled: true });
  const chunkId = landscapeChunkId("terrain");
  const chunkBytes = encodeLandscapeChunk(landscape);
  const foliage = { groupId: "trees", batches: ["oak", "pine"].map((modelGuid, index) => ({
    modelGuid, materialGuid: "leaves", cullDistance: 120, fadeRange: 15, shadowDistance: 45,
    transforms: packFoliageTransforms([{ ...identitySerializedTransform(), position: [index, 0, 2] }]),
  })) };
  const foliageChunk = foliageChunkId("environment/plants");
  // A Prefab or Class template's Foliage carries its instances inline.
  const inline = { groupId: "trees", batches: [{ ...foliage.batches[0]!, transforms: packFoliageTransforms([{ ...identitySerializedTransform(), position: [5, 0, 5] }]) }] };
  const commands: CommandMessage[] = [];
  const runtime = createInProcessRuntime({
    seed: 1,
    preferSoftwarePhysics: true,
    playSceneGuid: "scene-env",
    sceneComponentChunks: { [`scene-env:${chunkId}`]: chunkBytes, [`scene-env:${foliageChunk}`]: encodeFoliageChunk(foliage.batches) },
    playScene: { ...createDefaultScene(), actors: [createActor("environment", "Environment", { components: [
      { id: "terrain", classId: "LandscapeComponent", properties: { width: landscape.width, depth: landscape.depth, subdivisions: landscape.subdivisions, chunkId, materialGuid: "terrain", collisionsEnabled: true } },
      { id: "plants", classId: "FoliageComponent", properties: {
        groupId: "trees", batches: foliageBatchInfos(foliage), chunkId: foliageChunk,
      } },
      { id: "template", classId: "FoliageComponent", properties: { ...serializeFoliageProperties(inline) } },
    ] })] },
    onCommand: (command) => commands.push(command),
  });
  try {
    await runtime.realizePlayWorld();
    const assignment = commands.find((command) => command.type === "assignMesh");
    expect(assignment).toMatchObject({ type: "assignMesh", parts: [
      { componentId: "terrain", meshKind: "landscape", landscape },
      { componentId: "plants", meshKind: "foliage", foliage },
      { componentId: "template", meshKind: "foliage", foliage: inline },
    ] });
    expect(runtime.getWorld().getActors()).toHaveLength(1);
    runtime.start();
    runtime.tick();
    const hit = runtime.getPhysicsSync()!.lineTrace({ x: 0.2, y: 10, z: 0.2 }, { x: 0.2, y: -10, z: 0.2 });
    expect(hit).toMatchObject({ hit: true, actorId: "environment" });
    expect(hit.location!.y).toBeCloseTo(3, 5);
  } finally { runtime.stop(); }
});
