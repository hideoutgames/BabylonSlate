import { expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  encodeLandscapeChunk,
  identitySerializedTransform,
  landscapeChunkId,
  parseLandscapeProperties,
} from "@haptic/core";
import type { CommandMessage } from "@haptic/bridge";
import { createInProcessRuntime } from "./driver";

it("transports authored terrain via raw HPLD chunks and a whole mixed foliage stroke as component parts for Play", async () => {
  const landscape = parseLandscapeProperties({ subdivisions: 4, heights: new Float32Array(25).fill(3), materialGuid: "terrain", collisionsEnabled: true });
  const chunkId = landscapeChunkId("terrain");
  const chunkBytes = encodeLandscapeChunk(landscape);
  const foliage = { groupId: "trees", batches: ["oak", "pine"].map((modelGuid) => ({ modelGuid, materialGuid: "leaves", transforms: [identitySerializedTransform()] })) };
  const commands: CommandMessage[] = [];
  const runtime = createInProcessRuntime({
    seed: 1,
    preferSoftwarePhysics: true,
    playSceneGuid: "scene-env",
    sceneLandscapeBytes: { [`scene-env:${chunkId}`]: chunkBytes },
    playScene: { ...createDefaultScene(), actors: [createActor("environment", "Environment", { components: [
      { id: "terrain", classId: "LandscapeComponent", properties: { width: landscape.width, depth: landscape.depth, subdivisions: landscape.subdivisions, chunkId, materialGuid: "terrain", collisionsEnabled: true } },
      { id: "plants", classId: "FoliageComponent", properties: { ...foliage } },
    ] })] },
    onCommand: (command) => commands.push(command),
  });
  try {
    await runtime.realizePlayWorld();
    const assignment = commands.find((command) => command.type === "assignMesh");
    expect(assignment).toMatchObject({ type: "assignMesh", parts: [
      { componentId: "terrain", meshKind: "landscape", landscape },
      { componentId: "plants", meshKind: "foliage", foliage },
    ] });
    expect(runtime.getWorld().getActors()).toHaveLength(1);
    runtime.start();
    runtime.tick();
    const hit = runtime.getPhysicsSync()!.lineTrace({ x: 0.2, y: 10, z: 0.2 }, { x: 0.2, y: -10, z: 0.2 });
    expect(hit).toMatchObject({ hit: true, actorId: "environment" });
    expect(hit.location!.y).toBeCloseTo(3, 5);
  } finally { runtime.stop(); }
});
