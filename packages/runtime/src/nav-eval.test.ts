import { beforeAll, describe, expect, it } from "vitest";
import {
  readActorSlot,
  snapshotFloatCount,
} from "@babylonslate/bridge";
import {
  createActor,
  createDefaultSceneSettings,
  type SerializedScene,
} from "@babylonslate/core";
import {
  createNavigationBackend,
  generateNavMesh,
  initNavigation,
} from "@babylonslate/navigation";
import { createInProcessRuntime } from "./driver";

function groundPrism(): { positions: number[]; indices: number[] } {
  const half = 10;
  return {
    positions: [
      -half, 0, -half,
      half, 0, -half,
      half, 0, half,
      -half, 0, half,
    ],
    indices: [0, 3, 2, 0, 2, 1],
  };
}

function patrolScene(): SerializedScene {
  return {
    name: "Nav",
    viewportMode: "3d",
    settings: createDefaultSceneSettings(),
    actors: [
      createActor("ground", "Ground", {
        components: [{ id: "mesh", classId: "MeshComponent", properties: { meshKind: "ground" } }],
      }),
      createActor("agent", "Agent", {
        transform: {
          position: [-4, 0, -4],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [
          {
            id: "nav",
            classId: "NavAgentComponent",
            properties: { radius: 0.5, height: 2, maxSpeed: 3.5 },
          },
        ],
      }),
    ],
  };
}

describe("runtime navmesh import and crowd", () => {
  let bytes: Uint8Array;

  beforeAll(async () => {
    await initNavigation();
    bytes = await generateNavMesh(groundPrism());
  });

  it("imports baked bytes without generating and copies the agent pose into the snapshot", async () => {
    const generated = createNavigationBackend();
    generated.importNavMesh(bytes);
    expect(generated.findPath({ x: -4, y: 0, z: -4 }, { x: 4, y: 0, z: 4 }).length).toBeGreaterThan(1);

    const runtime = createInProcessRuntime({
      seed: 1,
      maxActors: 8,
      seedDemoActors: false,
      playScene: patrolScene(),
    });
    await runtime.loadNavMesh(bytes);
    runtime.start();
    runtime.realizePlayWorld();
    expect(runtime.setNavAgentTarget("agent", { x: 4, y: 0, z: 4 })).toBe(true);
    for (let i = 0; i < 90; i += 1) runtime.tick();
    const buf = new Float32Array(snapshotFloatCount(8));
    expect(runtime.copySnapshot(buf)).toBe(true);
    const slot = readActorSlot(buf, 0);
    const agentSlot =
      slot.position.x !== 0 || slot.position.z !== 0
        ? slot
        : readActorSlot(buf, 1);
    expect(agentSlot.position.x).toBeGreaterThan(-4);
    runtime.stop();
  });
});
