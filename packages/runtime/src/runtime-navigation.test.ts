import { beforeAll, describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultSceneSettings,
  eulerDegreesToQuaternion,
  type SerializedActor,
  type SerializedScene,
} from "@babylonslate/core";
import {
  generateNavMesh,
  initNavigation,
  mergeNavBakeMeshes,
  recastWalkableQuadFromXy,
  solidBlockerMesh,
} from "@babylonslate/navigation";
import { actorGuidIndex, actorWorldTransform } from "./actor-world-transform";
import { createInProcessRuntime } from "./driver";

const ground = {
  positions: [-10, 0, -10, 10, 0, -10, 10, 0, 10, -10, 0, 10],
  indices: [0, 3, 2, 0, 2, 1],
};

/** A wall at x = 0 with a 4-wide gap at the origin; the long way round passes |z| > 10. */
const corridor = mergeNavBakeMeshes([
  { positions: [-12, 0, -12, 12, 0, -12, 12, 0, 12, -12, 0, 12], indices: [0, 3, 2, 0, 2, 1] },
  solidBlockerMesh({ kind: "box", pose: { x: 0, y: 1, z: -6 }, size: { x: 2, y: 2, z: 8 } }),
  solidBlockerMesh({ kind: "box", pose: { x: 0, y: 1, z: 6 }, size: { x: 2, y: 2, z: 8 } }),
]);
const fine = { cellSize: 0.25, cellHeight: 0.25, maxEdgeLen: 2, maxSimplificationError: 0.3, minRegionArea: 2, mergeRegionArea: 4 };

function agent(id: string, position: [number, number, number], overrides: Partial<SerializedActor> = {}): SerializedActor {
  return createActor(id, id, {
    transform: { position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    components: [{ id: `${id}-nav`, classId: "NavAgentComponent", properties: { radius: 0.4, height: 2, maxSpeed: 3.5 } }],
    ...overrides,
  });
}

function blocker(
  id: string,
  properties: Record<string, unknown>,
  transform: SerializedActor["transform"],
  parentId: string | null = null,
): SerializedActor {
  return createActor(id, id, {
    parentId,
    transform,
    components: [{ id: `${id}-blocker`, classId: "NavMeshBlockerComponent", properties }],
  });
}

function scene(actors: SerializedActor[], viewportMode: "2d" | "3d" = "3d"): SerializedScene {
  return { name: "Navigation", viewportMode, settings: createDefaultSceneSettings(viewportMode), folders: [], actors };
}

async function play(actors: SerializedActor[], bytes: Uint8Array, viewportMode: "2d" | "3d" = "3d", dt?: number) {
  const runtime = createInProcessRuntime({ seed: 1, dt, seedDemoActors: false, playScene: scene(actors, viewportMode) });
  await runtime.loadNavMesh(bytes);
  runtime.start();
  runtime.realizePlayWorld();
  return runtime;
}

/** Rotation about one axis, in degrees, of an actor's quaternion. */
function turn(rotation: { x: number; y: number; z: number; w: number }, axis: "y" | "z"): number {
  return (2 * Math.atan2(rotation[axis], rotation.w) * 180) / Math.PI;
}

describe("RuntimeNavigation", () => {
  beforeAll(async () => {
    await initNavigation();
  });

  it("keeps an idle agent's facing and turns a moving 2D agent toward its velocity", async () => {
    const quad = recastWalkableQuadFromXy({ minX: -10, minY: -10, maxX: 10, maxY: 10 });
    const [x, y, z, w] = eulerDegreesToQuaternion([0, 0, 30]);
    const runtime = await play([agent("walker", [-4, 0, 0], {
      transform: { position: [-4, 0, 0], rotation: [x, y, z, w], scale: [1, 1, 1] },
    })], await generateNavMesh(quad), "2d");
    try {
      const walker = runtime.getWorld().findActor("walker")!;
      for (let tick = 0; tick < 5; tick++) runtime.tick();
      expect(turn(walker.transform.rotation, "z")).toBeCloseTo(30, 3);
      // Rotate To Face's 2D convention: +X forward.
      expect(runtime.setNavAgentTarget("walker", { x: 4, y: 0, z: 0 })).toBe(true);
      for (let tick = 0; tick < 30; tick++) runtime.tick();
      expect(walker.transform.position.x).toBeGreaterThan(-4);
      expect(turn(walker.transform.rotation, "z")).toBeCloseTo(0, 0);
    } finally {
      runtime.stop();
    }
  });

  it("places a child agent at its own crowd pose while its parent agent walks", async () => {
    const runtime = await play([
      agent("leader", [-4, 0, -4]),
      agent("follower", [0, 0, 3], { parentId: "leader" }),
    ], await generateNavMesh(ground), "3d", 0.1);
    try {
      expect(runtime.setNavAgentTarget("leader", { x: 4, y: 0, z: -4 })).toBe(true);
      const world = runtime.getWorld();
      for (let tick = 0; tick < 10; tick++) runtime.tick();
      expect(world.findActor("leader")!.transform.position.x).toBeGreaterThan(-2);
      // The idle child's crowd agent has not moved from (-4, -1).
      const follower = actorWorldTransform(world.findActor("follower")!, actorGuidIndex(world.getActors()))!;
      expect(follower.position.x).toBeCloseTo(-4, 2);
      expect(follower.position.z).toBeCloseTo(-1, 2);
    } finally {
      runtime.stop();
    }
  });

  it("registers a turned dynamic blocker with its own footprint, not its bounding box", async () => {
    const [x, y, z, w] = eulerDegreesToQuaternion([0, 45, 0]);
    const runtime = await play([
      blocker("strip", { dynamic: true, kind: "box", area: "unwalkable" }, {
        position: [0, 1, 0], rotation: [x, y, z, w], scale: [1, 2, 10],
      }),
    ], await generateNavMesh({ ...ground, settings: { supportDynamicObstacles: true } }));
    try {
      // Beside the diagonal strip but inside its 7.8-wide bounding box.
      const path = runtime.findNavPath({ x: -2, y: 0, z: 2 }, { x: -3, y: 0, z: 3 });
      expect(path).toHaveLength(2);
      expect(Math.hypot(path[0]!.x + 2, path[0]!.z - 2)).toBeLessThan(0.1);
    } finally {
      runtime.stop();
    }
  });

  it("stops carving once a dynamic blocker is destroyed", async () => {
    const runtime = await play([
      blocker("door", { dynamic: true, kind: "box", area: "unwalkable" }, {
        position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [2, 2, 8],
      }),
    ], await generateNavMesh({ ...ground, settings: { supportDynamicObstacles: true } }));
    try {
      expect(runtime.findNavPath({ x: -4, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }).length).toBeGreaterThan(2);
      runtime.getWorld().destroyActor("door");
      runtime.tick();
      expect(runtime.findNavPath({ x: -4, y: 0, z: 0 }, { x: 4, y: 0, z: 0 })).toHaveLength(2);
    } finally {
      runtime.stop();
    }
  });

  it("removes a destroyed blocker's cost volume", async () => {
    const runtime = await play([
      blocker("mud", { dynamic: false, kind: "box", area: "cost", cost: 10 }, {
        position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [4, 2, 3],
      }),
    ], await generateNavMesh({ ...corridor, settings: fine }));
    try {
      const route = () => runtime.findNavPath({ x: -8, y: 0, z: 0 }, { x: 8, y: 0, z: 0 });
      expect(route().some((point) => Math.abs(point.z) > 6)).toBe(true);
      runtime.getWorld().destroyActor("mud");
      runtime.tick();
      expect(route().every((point) => Math.abs(point.z) < 2.5)).toBe(true);
    } finally {
      runtime.stop();
    }
  });

  it("restamps a moving dynamic cost volume from its world pose", async () => {
    const runtime = await play([
      createActor("cart", "Cart", {
        transform: { position: [100, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      }),
      blocker("mud", { dynamic: true, kind: "box", area: "cost", cost: 10 }, {
        position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [4, 2, 3],
      }, "cart"),
    ], await generateNavMesh({ ...corridor, settings: fine }));
    try {
      runtime.tick();
      // The volume rides with the cart, far from the corridor.
      expect(runtime.findNavPath({ x: -8, y: 0, z: 0 }, { x: 8, y: 0, z: 0 })
        .every((point) => Math.abs(point.z) < 2.5)).toBe(true);
    } finally {
      runtime.stop();
    }
  });
});
