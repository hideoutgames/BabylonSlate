import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultWaterDefinition, identityTransform } from "@babylonslate/core";
import { ClassRegistry, World, type Actor } from "@babylonslate/object-model";
import { createSoftwarePhysicsBackend } from "@babylonslate/physics";
import { PhysicsWorldSync } from "./physics-sync";

afterEach(() => vi.restoreAllMocks());

type Components = Array<[string, Record<string, unknown>]>;

function createWorld() {
  const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
  const spawn = (
    guid: string,
    position: { x?: number; y?: number } = {},
    components: Components = [],
    parentId?: string,
  ) => {
    const actor = world.createActor({
      classId: "Actor",
      guid,
      transform: identityTransform(),
      variables: parentId ? { parentId } : {},
    });
    actor.transform.position.x = position.x ?? 0;
    actor.transform.position.y = position.y ?? 0;
    for (const [classId, variables] of components)
      actor.attachComponent(world.createComponent({ classId, variables }));
    world.spawnActorNow(actor);
    return actor;
  };
  return { world, spawn };
}

/** Counts accesses to these actors' transforms, as the ragdoll work fixture does. */
function countTransformReads(actors: readonly Actor[]) {
  const reads = { count: 0 };
  for (const actor of actors) {
    const transform = actor.transform;
    Object.defineProperty(actor, "transform", {
      get: () => {
        reads.count++;
        return transform;
      },
    });
  }
  return reads;
}

const dynamicBody: Components[number] = [
  "RigidBodyComponent",
  { motionType: "dynamic", mass: 1, gravityScale: 0, linearDamping: 0 },
];

describe("physics tick composition work", () => {
  it("composes water poses only for water participants, and none until water exists", () => {
    const { world, spawn } = createWorld();
    const decorations = Array.from({ length: 2048 }, (_, index) =>
      spawn(`decoration-${index}`, { x: index }),
    );
    const landscape = spawn("landscape", { x: -40, y: -2 }, [
      ["LandscapeComponent", { width: 20, depth: 20, subdivisions: 4, heights: Array.from({ length: 25 }, () => 3) }],
    ]);
    const decorationReads = countTransformReads(decorations);
    const landscapeReads = countTransformReads([landscape]);
    const sync = new PhysicsWorldSync(
      createSoftwarePhysicsBackend("3d", { x: 0, y: -9.81, z: 0 }),
    );
    sync.water.setContent({ water: { ...createDefaultWaterDefinition(), waveHeight: 0 } });
    let tick = 0;
    const step = (count: number) => {
      for (let i = 0; i < count; i++) sync.step(1 / 60, world, tick++ / 60, 9.81);
    };
    try {
      step(20);
      sync.water.update(world.getActors(), tick / 60); // the script sampleWater path
      const landscapeOnly = { decorations: decorationReads.count, landscape: landscapeReads.count };

      spawn("sea", {}, [["WaterOceanComponent", { assetGuid: "water" }]]);
      // The parented float must receive the same buoyancy as its unparented twin.
      const raft = spawn("raft", { x: 10, y: 1 });
      const float = spawn("float", {}, [["WaterBuoyancyComponent", { drag: 4 }]], raft.guid);
      const twin = spawn("twin", { x: 20, y: 1 }, [["WaterBuoyancyComponent", { drag: 4 }]]);
      step(300);
      const withWater = { decorations: decorationReads.count - landscapeOnly.decorations };
      const floatY = raft.transform.position.y + float.transform.position.y;
      console.info("water composition transform reads", { landscapeOnly, withWater, floatY, twinY: twin.transform.position.y });
      expect(landscapeOnly).toEqual({ decorations: 0, landscape: 0 });
      expect(withWater).toEqual({ decorations: 0 });
      expect(twin.transform.position.y).toBeGreaterThan(-1);
      expect(twin.transform.position.y).toBeLessThan(1);
      expect(floatY).toBeCloseTo(twin.transform.position.y, 9);
      // With water present, the landscape still cuts it.
      expect(sync.water.sample({ x: 0, y: -1, z: 0 }).found).toBe(true);
      expect(sync.water.sample({ x: -40, y: -1, z: 0 }).found).toBe(false);
    } finally {
      sync.dispose();
    }
  });

  it("reads back unparented and parented bodies without resolving unrelated actors", () => {
    const { world, spawn } = createWorld();
    // Render meshes participate in pre-step physics composition but own no body.
    const decorations = Array.from({ length: 2048 }, (_, index) =>
      spawn(`mesh-${index}`, { x: index }, [["MeshComponent", { meshKind: "box", collisionMode: "none" }]]),
    );
    const bodies = Array.from({ length: 8 }, (_, index) =>
      spawn(`body-${index}`, { x: index * 4, y: 10 }, [dynamicBody]),
    );
    const reads = countTransformReads(decorations);
    const backend = createSoftwarePhysicsBackend("3d", { x: 0, y: 0, z: 0 });
    const sync = new PhysicsWorldSync(backend);
    const nativeStep = backend.step.bind(backend);
    let postStepReads = 0;
    vi.spyOn(backend, "step").mockImplementation((dt) => {
      nativeStep(dt);
      postStepReads = -reads.count;
    });
    const stepOnce = () => {
      sync.step(1 / 60, world);
      postStepReads += reads.count;
      return postStepReads;
    };
    try {
      sync.syncFromWorld(world);
      for (const body of bodies) sync.addImpulse(body.guid, { x: 6, y: 0, z: 0 });
      const unparented = stepOnce();
      expect(bodies.map((body) => body.transform.position.x)).toEqual(
        bodies.map((_, index) => expect.closeTo(index * 4 + 0.1, 9)),
      );

      const upper = spawn("upper", { y: 20 }, [dynamicBody]);
      const middle = spawn("middle", { x: 2 }, [], upper.guid);
      const lower = spawn("lower", { x: 1 }, [dynamicBody], middle.guid);
      sync.syncFromWorld(world);
      sync.addImpulse(upper.guid, { x: 6, y: 0, z: 0 });
      const parented = stepOnce();
      console.info("readback transform reads", { unparented, parented });
      expect({ unparented, parented }).toEqual({ unparented: 0, parented: 0 });
      expect(lower.transform.position.x).toBeCloseTo(0.9, 9);
    } finally {
      sync.dispose();
    }
  });
});
