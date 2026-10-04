import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createActor,
  createDefaultSceneSettings,
  createDefaultWaterDefinition,
  identityTransform,
  type SerializedActor,
} from "@babylonslate/core";
import { ClassRegistry, World, type Actor } from "@babylonslate/object-model";
import { createSoftwarePhysicsBackend } from "@babylonslate/physics";
import { createInProcessRuntime } from "./driver";
import { PhysicsWorldSync } from "./physics-sync";
import type { CompiledScript } from "./script-host";

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

/** A Play runtime over an authored scene, with one script class bound to `events`. */
async function scriptedRuntime(
  actors: SerializedActor[],
  classId: string,
  events: Record<string, string>,
  waters?: Parameters<typeof createInProcessRuntime>[0]["waters"],
) {
  const runtime = createInProcessRuntime({
    seed: 1, seedDemoActors: false, preferSoftwarePhysics: true, physicsWorld: "3d", gravity: [0, 0, 0], waters,
    playScene: { name: "Composition", viewportMode: "3d", settings: createDefaultSceneSettings(), folders: [], actors },
  });
  const script: CompiledScript = {
    assetGuid: `${classId}-script`, classId, parentClassId: "Actor", anchors: [],
    source: Object.entries(events).map(([event, body]) => `export function ${event}(ctx) { ${body} }`).join("\n"),
    entryPoints: Object.keys(events).map((event) => ({ name: event, event, isAsync: false })),
  };
  await runtime.loadScripts([script]);
  runtime.realizePlayWorld();
  runtime.start();
  runtime.tick();
  return runtime;
}

/** Render meshes without collision: physics participants that own no body. */
function renderMeshes(count: number): SerializedActor[] {
  return Array.from({ length: count }, (_, index) => createActor(`mesh-${index}`, `Mesh ${index}`, {
    transform: { position: [index, 0, 20], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    components: [{ id: "mesh", classId: "MeshComponent", properties: { meshKind: "box", collisionMode: "none" } }],
  }));
}

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
      sync.water.query(world.getActors(), tick / 60, { x: 0, y: 0, z: 0 }); // the script sampleWater path
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

  it("publishes script pose writes without composing unrelated physics participants", async () => {
    const runtime = await scriptedRuntime([
      ...renderMeshes(512),
      createActor("lamp", "Lamp", { classId: "Mover", components: [{ id: "light", classId: "LightComponent", properties: {} }] }),
      createActor("crate", "Crate", { classId: "Mover", components: [
        { id: "body", classId: "RigidBodyComponent", properties: { motionType: "dynamic", mass: 1, gravityScale: 0 } },
        { id: "box", classId: "ColliderComponent", properties: { shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } } } },
      ] }),
    ], "Mover", {
      Place: "ctx.setActorLocation(ctx.self, { x: 3, y: 0, z: 0 });",
      Nudge: "ctx.addActorWorldOffset(ctx.self, { x: 3, y: 0, z: 0 });",
    });
    try {
      const world = runtime.getWorld();
      const meshes = world.getActors().filter((actor) => actor.guid.startsWith("mesh-"));
      const lamp = world.findActor("lamp")!, crate = world.findActor("crate")!;
      expect(meshes).toHaveLength(512);
      const reads = countTransformReads(meshes);
      runtime.invokeScriptEvent("Mover", "Place", lamp);
      const lampReads = reads.count;
      runtime.invokeScriptEvent("Mover", "Nudge", crate);
      const counts = { lamp: lampReads, crate: reads.count - lampReads };
      console.info("script pose write transform reads", counts);
      // Each call used to recompose all 512 participants before checking for a body.
      expect(counts).toEqual({ lamp: 0, crate: 0 });
      expect(lamp.transform.position.x).toBe(3);
      // The body is published before the next step, so a same-tick query sees it.
      const sync = runtime.getPhysicsSync()!;
      expect(sync.lineTrace({ x: 3, y: 4, z: 0 }, { x: 3, y: -4, z: 0 }).actorId).toBe("crate");
      expect(sync.lineTrace({ x: 0, y: 4, z: 0 }, { x: 0, y: -4, z: 0 }).hit).toBe(false);
    } finally {
      runtime.stop();
    }
  });

  it("samples water per script call from current water and cutter chains only", async () => {
    const runtime = await scriptedRuntime([
      ...renderMeshes(512),
      // A buoyant raft is composed by the physics step, never by a query.
      createActor("raft", "Raft", {
        transform: { position: [0, 2, 6], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        components: [
          { id: "body", classId: "RigidBodyComponent", properties: { motionType: "dynamic", mass: 1 } },
          { id: "float", classId: "WaterBuoyancyComponent", properties: {} },
        ],
      }),
      createActor("shore", "Shore", { classId: "Prober" }),
      createActor("lake", "Lake", {
        parentId: "shore",
        transform: { position: [0, 2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        components: [{ id: "surface", classId: "WaterLakeComponent", properties: { assetGuid: "water", width: 20, length: 20 } }],
      }),
      createActor("hull", "Hull", {
        transform: { position: [5, 2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        components: [{ id: "hole", classId: "WaterRemovalVolumeComponent", properties: { shape: "box", width: 2, height: 2, length: 2 } }],
      }),
    ], "Prober", {
      Probe: [
        "const open = ctx.sampleWater({ x: 0, y: 1, z: 0 });",
        "ctx.setVariable('openDepth', open.depth);",
        "ctx.setVariable('openActor', open.actor);",
        "ctx.setVariable('cut', ctx.sampleWater({ x: 5, y: 1.5, z: 0 }).found);",
        "ctx.setActorLocation(ctx.self, { x: 0, y: 3, z: 0 });",
        "ctx.setVariable('raisedDepth', ctx.sampleWater({ x: 0, y: 1, z: 0 }, open.actor).depth);",
      ].join(" "),
    }, { water: { ...createDefaultWaterDefinition(), waveHeight: 0 } });
    try {
      const world = runtime.getWorld();
      const meshes = world.getActors().filter((actor) => actor.guid.startsWith("mesh-"));
      const shore = world.findActor("shore")!;
      expect(meshes).toHaveLength(512);
      const meshReads = countTransformReads(meshes);
      const raftReads = countTransformReads([world.findActor("raft")!]);
      runtime.invokeScriptEvent("Prober", "Probe", shore);
      const counts = { meshes: meshReads.count, raft: raftReads.count };
      console.info("water query transform reads", counts);
      expect(counts).toEqual({ meshes: 0, raft: 0 });
      // The lake surface sits 2 above its shore: 1 deep at y=1, and 4 once the
      // shore is raised to y=3 earlier in the same event.
      expect(shore.getVariable("openDepth")).toBeCloseTo(1, 9);
      expect(shore.getVariable("openActor")).toBe(world.findActor("lake"));
      expect(shore.getVariable("cut")).toBe(false);
      expect(shore.getVariable("raisedDepth")).toBeCloseTo(4, 9);
    } finally {
      runtime.stop();
    }
  });
});
