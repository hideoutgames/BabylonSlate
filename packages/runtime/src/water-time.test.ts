import { describe, expect, it } from "vitest";
import { readSnapshotHeader, snapshotFloatCount, type CommandMessage } from "@babylonslate/bridge";
import {
  createActor, createDefaultSceneSettings, createDefaultWaterDefinition, identityTransform, normalizeWaterBody, sampleWaterSurface,
  type SerializedActor,
} from "@babylonslate/core";
import { createInProcessRuntime } from "./driver";

const probe = { x: 3, y: -0.5, z: 2 };
/** Default (Realistic Gerstner) waves, so the surface height changes with time. */
const waveHeightAt = (time: number) =>
  sampleWaterSurface(createDefaultWaterDefinition(), normalizeWaterBody({}, "ocean"), probe, time).height;

const ocean = (): SerializedActor => createActor("sea", "Sea", { classId: "Hero", components: [
  { id: "surface", classId: "WaterOceanComponent", properties: {} },
] });

async function waterRuntime(dt: number, onCommand?: (command: CommandMessage) => void) {
  const runtime = createInProcessRuntime({
    seed: 1, dt, seedDemoActors: false, preferSoftwarePhysics: true, physicsWorld: "3d", onCommand,
    playScene: { name: "Water", viewportMode: "3d", settings: createDefaultSceneSettings(), folders: [], actors: [ocean()] },
  });
  await runtime.loadScripts([{
    assetGuid: "hero-script", classId: "Hero", parentClassId: "Actor", anchors: [],
    source: `export function Update(ctx) { ctx.setVariable("height", ctx.sampleWater(${JSON.stringify(probe)}).height); }`,
    entryPoints: [{ name: "Update", event: "Update", isAsync: false }],
  }]);
  runtime.realizePlayWorld();
  runtime.start();
  return runtime;
}

describe("Water simulation time", () => {
  it("advances script queries, the physics step and the render clock by the dilated step, and freezes while paused", async () => {
    const sent: Array<{ seconds: number; frameId: number }> = [];
    const runtime = await waterRuntime(0.1, (command) => { if (command.type === "waterTime") sent.push(command); });
    const sea = runtime.getWorld().findActor("sea")!;
    const scriptHeight = () => { runtime.invokeScriptEvent("Hero", "Update", sea); return sea.getVariable("height") as number; };
    const snapshot = new Float32Array(snapshotFloatCount(runtime.snapshotCapacity));
    try {
      expect(runtime.executeConsoleCommand("slomo 0.5").success).toBe(true);
      for (let tick = 0; tick < 3; tick++) runtime.tick();
      // Tick 3 at slomo 0.5: 0.5 × 3 × 0.1 s of simulated time.
      expect(scriptHeight()).toBeCloseTo(waveHeightAt(0.15), 9);
      expect(runtime.executeConsoleCommand("slomo 1").success).toBe(true);
      runtime.tick(); runtime.tick();
      // Continuous across the change: 0.15 s, then two full 0.1 s steps (not 5 × 0.1 s).
      expect(scriptHeight()).toBeCloseTo(waveHeightAt(0.35), 9);
      // Each step evaluates (and buoyancy reads) the water at the simulated time before its own step.
      expect(sent.map((entry) => entry.seconds)).toEqual([0, 0.05, 0.1, 0.15, 0.25].map((seconds) => expect.closeTo(seconds, 12)));
      expect(runtime.getPhysicsSync()!.water.sample(probe).height).toBeCloseTo(waveHeightAt(0.25), 9);
      // The render clock is paired with the snapshot that step published.
      expect(runtime.copySnapshot(snapshot)).toBe(true);
      expect(sent.at(-1)!.frameId).toBe(readSnapshotHeader(snapshot).frameId);
      runtime.pause();
      runtime.tick();
      expect(sent).toHaveLength(5);
      expect(scriptHeight()).toBeCloseTo(waveHeightAt(0.35), 9);
    } finally { runtime.stop(); }
  });

  it("floats a hull at slomo 0.5 as it floats at the same step without dilation", async () => {
    // Both sessions simulate 1 s before the hull appears, then step it 120 times by 1/120 s: one with a 1/60 s step
    // slowed to half, one with a 1/120 s step. Only the water clock could tell them apart.
    const run = async (dt: number, before: number, slomo: string) => {
      const runtime = await waterRuntime(dt);
      try {
        for (let tick = 0; tick < before; tick++) runtime.tick();
        expect(runtime.executeConsoleCommand(slomo).success).toBe(true);
        const world = runtime.getWorld();
        const hull = world.createActor({ classId: "Actor", guid: "hull", transform: { ...identityTransform(), position: { x: 1, y: 0, z: -2 } } });
        hull.attachComponent(world.createComponent({ classId: "WaterBuoyancyComponent", variables: { drag: 8 } }));
        world.spawnActorNow(hull);
        const heights: number[] = [];
        for (let tick = 0; tick < 120; tick++) { runtime.tick(); heights.push(hull.transform.position.y); }
        return { heights, position: { ...hull.transform.position } };
      } finally { runtime.stop(); }
    };
    const dilated = await run(1 / 60, 60, "slomo 0.5");
    const reference = await run(1 / 120, 120, "slomo 1");
    expect(Math.max(...reference.heights) - Math.min(...reference.heights)).toBeGreaterThan(0.05);
    for (const [index, height] of dilated.heights.entries()) expect(height).toBeCloseTo(reference.heights[index]!, 4);
    expect(dilated.position.x).toBeCloseTo(reference.position.x, 4);
    expect(dilated.position.z).toBeCloseTo(reference.position.z, 4);
  });
});
