import { describe, expect, it } from "vitest";
import { Actor, ActorComponent } from "@babylonslate/object-model";
import { createActor, createDefaultSceneSettings, createDefaultWaterDefinition, type SerializedActor } from "@babylonslate/core";
import { compileGraph, type LogicGraph } from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { createInProcessRuntime } from "./driver";
import { ScriptHost } from "./script-host";
import { WaterWorld } from "./water-world";

describe("Water graph queries", () => {
  it("executes a compiled surface query against live bounded water and resolves the Actor", () => {
    const lake = new Actor({ guid: "lake", classId: "Actor" });
    lake.transform.position.y = 4;
    lake.attachComponent(new ActorComponent({ classId: "WaterLakeComponent", variables: { assetGuid: "water", width: 10, length: 10 } }));
    const water = new WaterWorld();
    water.setContent({ water: { ...createDefaultWaterDefinition(), waveHeight: 0 } });
    water.update([lake], 0);
    const logs: string[] = [];
    const ctx = new ScriptHost({
      log: (_severity, _category, message) => logs.push(message), print: () => {}, destroyActor: () => {},
      executeConsoleCommand: () => ({ success: true, output: "" }), delay: async () => {}, reportError: (error) => { throw error; },
      sampleWater: (point, actorId) => water.sample(point, actorId), findActor: (id) => id === lake.guid ? lake : undefined,
    }).createContext(null, 0, 0);
    const registry = createDefaultNodeRegistry();
    const graph: LogicGraph = {
      id: "water-query", kind: "event",
      nodes: [
        ["begin", "flow.event.beginPlay", {}],
        ["sample", "water.sampleSurface", { "default:position": { x: 0, y: 1, z: 0 } }],
        ["log", "debug.log", {}],
      ].map(([id, typeId, properties]) => ({ id: id as string, typeId: typeId as string, properties: properties as Record<string, unknown>, position: { x: 0, y: 0 }, pins: registry.get(typeId as string)!.pins(properties as Record<string, unknown>) })),
      edges: [
        { id: "begin", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "sample", targetPinId: "execIn" },
        { id: "then", sourceNodeId: "sample", sourcePinId: "execOut", targetNodeId: "log", targetPinId: "execIn" },
        { id: "depth", sourceNodeId: "sample", sourcePinId: "depth", targetNodeId: "log", targetPinId: "message" },
      ],
    };
    const compiled = compileGraph(graph, { assetGuid: "logic", registry });
    const run = new Function(`${compiled.source.replace(/export\s+(async\s+)?function\s+/g, "$1function ")}\nreturn onBeginPlay;`)();
    run(ctx);
    expect(logs).toEqual(["3"]);
    expect(ctx.sampleWater({ x: 0, y: 1, z: 0 }).actor).toBe(lake);
    expect(ctx.sampleWater({ x: 30, y: 1, z: 0 })).toMatchObject({ found: false, actor: null });
    expect(ctx.sampleWater({ x: 0, y: 1, z: 0 }, new Actor({ guid: "other", classId: "Actor" })).found).toBe(false);
    water.update([], 1);
    expect(ctx.sampleWater({ x: 0, y: 1, z: 0 }).found).toBe(false);
  });
  it("answers with one continuous surface where a river runs into a lake, and steps without Water Blend Distance", () => {
    const lake = new Actor({ guid: "lake", classId: "Actor" });
    lake.attachComponent(new ActorComponent({ classId: "WaterLakeComponent", variables: { assetGuid: "water", width: 40, length: 40, waveScale: 0.4 } }));
    // The river's water stands 0.4 m above the lake's where it ends 10 m inside it.
    const river = new Actor({ guid: "river", classId: "Actor" });
    river.transform.position.y = 0.4;
    river.attachComponent(new ActorComponent({ classId: "WaterRiverComponent", variables: {
      assetGuid: "water", width: 8, flowSpeed: 1.5, waveScale: 0.15, points: [[0, 0, -60], [0, 0, -10]],
    } }));
    const water = new WaterWorld();
    water.setContent({ water: { ...createDefaultWaterDefinition(), waveHeight: 0.3, waveLength: 16 } });
    const profile = (time: number) => {
      const owners: string[] = [];
      let previous: number | null = null, steepest = 0;
      for (let z = -40; z <= 10; z += 0.1) {
        const sample = water.query([lake, river], time, { x: 0.7, y: -2, z });
        expect(sample.found).toBe(true);
        if (owners.at(-1) !== sample.actorId) owners.push(sample.actorId!);
        if (previous !== null) steepest = Math.max(steepest, Math.abs(sample.height - previous) / 0.1);
        previous = sample.height;
      }
      return { owners, steepest };
    };
    for (const time of [0.5, 3.25]) {
      const { owners, steepest } = profile(time);
      expect(owners).toEqual(["river", "lake"]);
      expect(steepest).toBeLessThan(0.6);
    }
    // Blending off: the river's surface ends 0.4 m above the lake's.
    water.setBlendDistance(0);
    expect(profile(0.5).steepest).toBeGreaterThan(3);
  });
  it("removes water inside live removal volumes and under terrain that rises above Global Water Volume", () => {
    const ocean = new Actor({ guid: "ocean", classId: "Actor" });
    ocean.attachComponent(new ActorComponent({ classId: "GlobalWaterVolumeComponent", variables: {} }));
    const island = new Actor({ guid: "island", classId: "Actor" });
    island.transform.position.x = 40;
    island.attachComponent(new ActorComponent({ classId: "LandscapeComponent", variables: {
      width: 20, depth: 20, subdivisions: 4, heights: Array.from({ length: 25 }, (_, i) => i === 12 ? 5 : -3),
    } }));
    const boat = new Actor({ guid: "boat", classId: "Actor" });
    boat.transform.position.x = -20;
    const hull = new ActorComponent({ classId: "WaterRemovalVolumeComponent", variables: { shape: "box", width: 2, height: 2, length: 6 } });
    boat.attachComponent(hull);
    const water = new WaterWorld();
    water.setContent({ calm: { ...createDefaultWaterDefinition(), waveHeight: 0 } });
    ocean.components[0]!.setVariable("assetGuid", "calm");
    water.update([ocean, island, boat], 0);
    expect(water.sample({ x: 0, y: -1, z: 0 }).found).toBe(true);
    expect(water.sample({ x: 40, y: -1, z: 0 }).found).toBe(false);
    expect(water.sample({ x: 48, y: -1, z: 0 }).found).toBe(true);
    expect(water.sample({ x: -20, y: -0.5, z: 2.5 }).found).toBe(false);
    // Moving the boat carries its hole with it.
    boat.transform.position.x = -60;
    water.update([ocean, island, boat], 0);
    expect(water.sample({ x: -20, y: -0.5, z: 2.5 }).found).toBe(true);
    hull.setVariable("enabled", false);
    water.update([ocean, island, boat], 0);
    expect(water.sample({ x: -60, y: -0.5, z: 0 }).found).toBe(true);
  });
});

describe("Project Water Blend Distance in Play", () => {
  // A lake at rest height 0 and a river whose water stands 0.4 m above it, ending 10 m inside the lake; no waves.
  const actors = (): SerializedActor[] => [
    createActor("lake", "Lake", { components: [{ id: "lake-surface", classId: "WaterLakeComponent", properties: { assetGuid: "water", width: 40, length: 40 } }] }),
    createActor("river", "River", {
      transform: { position: [0, 0.4, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      components: [{ id: "river-surface", classId: "WaterRiverComponent", properties: { assetGuid: "water", width: 8, points: [[0, 0, -60], [0, 0, -10]] } }],
    }),
  ];
  it.each([{ blendDistance: undefined, blends: true }, { blendDistance: 0, blends: false }])(
    "applies Water Blend Distance $blendDistance to the physics world's water, before and after the native backend loads",
    async ({ blendDistance, blends }) => {
      const runtime = createInProcessRuntime({
        seed: 1, dt: 1 / 60, seedDemoActors: false, physicsWorld: "3d",
        renderSettings: blendDistance === undefined ? {} : { water: { blendDistance } },
        waters: { water: { ...createDefaultWaterDefinition(), waveHeight: 0 } },
        playScene: { name: "Water", viewportMode: "3d", settings: createDefaultSceneSettings(), folders: [], actors: actors() },
      });
      // A metre past the river's rounded end (its half width beyond the last point), inside the lake: the blended surface
      // still ramps down from the river's height there; unblended, the lake's own surface is all there is.
      const heightPastRiverEnd = () => { runtime.tick(); return runtime.getPhysicsSync()!.water.sample({ x: 0, y: -2, z: -5 }).height; };
      try {
        runtime.realizePlayWorld();
        runtime.start();
        const software = heightPastRiverEnd();
        await runtime.loadPhysics();
        const native = heightPastRiverEnd();
        for (const height of [software, native]) {
          if (blends) expect(height).toBeGreaterThan(0.05);
          else expect(height).toBeCloseTo(0, 6);
        }
      } finally { runtime.stop(); }
    },
  );
});
