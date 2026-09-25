import { expect, it } from "vitest";
import { createActor, createDefaultScene, identitySerializedTransform, parseLandscapeProperties } from "@babylonslate/core";
import type { CommandMessage } from "@babylonslate/bridge";
import { createInProcessRuntime } from "./driver";

it("transports authored terrain and a whole mixed foliage stroke as component parts for Play", async () => {
  const landscape = parseLandscapeProperties({ subdivisions: 4, heights: Array(25).fill(3), materialGuid: "terrain", collisionsEnabled: true });
  const foliage = { groupId: "trees", batches: ["oak", "pine"].map((modelGuid) => ({ modelGuid, materialGuid: "leaves", transforms: [identitySerializedTransform()] })) };
  const commands: CommandMessage[] = [];
  const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
    playScene: { ...createDefaultScene(), actors: [createActor("environment", "Environment", { components: [
      { id: "terrain", classId: "LandscapeComponent", properties: { ...landscape } },
      { id: "plants", classId: "FoliageComponent", properties: { ...foliage } },
    ] })] }, onCommand: (command) => commands.push(command),
  });
  try {
    await runtime.realizePlayWorld();
    const assignment = commands.find((command) => command.type === "assignMesh");
    expect(assignment).toMatchObject({ type: "assignMesh", parts: [
      { componentId: "terrain", meshKind: "landscape", landscape },
      { componentId: "plants", meshKind: "foliage", foliage },
    ] });
    expect(runtime.getWorld().getActors()).toHaveLength(1);
    expect(runtime.getPhysicsSync()!.lineTrace({ x: 0.2, y: 10, z: 0.2 }, { x: 0.2, y: -10, z: 0.2 })).toMatchObject({ hit: true, actorId: "environment", location: { y: 3 } });
  } finally { runtime.stop(); }
});
