import { describe, expect, it } from "vitest";
import { createDefaultWaterDefinition, identityTransform } from "@babylonslate/core";
import { ClassRegistry, World } from "@babylonslate/object-model";
import { createPhysicsBackend } from "@babylonslate/physics";
import { PhysicsWorldSync } from "./physics-sync";

describe("Water buoyancy with native collision response", () => {
  it("uses explicit cubic metres for carrying capacity, live edits and scale", async () => {
    const backend = await createPhysicsBackend({ kind: "3d", gravity: { x: 0, y: -9.81, z: 0 }, allowSoftwareFallback: false });
    const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
    const sync = new PhysicsWorldSync(backend);
    sync.water.setContent({ water: { ...createDefaultWaterDefinition(), waveHeight: 0 } });
    const sea = world.createActor({ classId: "Actor", guid: "sea" });
    sea.attachComponent(world.createComponent({ classId: "WaterOceanComponent", variables: { assetGuid: "water" } }));
    world.spawnActorNow(sea);
    const float = world.createActor({ classId: "Actor", guid: "float" });
    const buoyancy = world.createComponent({ classId: "WaterBuoyancyComponent", variables: { volume: 0.002, drag: 8 } });
    float.attachComponent(buoyancy);
    world.spawnActorNow(float);
    let tick = 0;
    const step = (count: number) => { for (let i = 0; i < count; i++) sync.step(1 / 60, world, tick++ / 60); };
    try {
      step(300);
      expect(Math.abs(float.transform.position.y)).toBeLessThan(0.025);
      buoyancy.setVariable("volume", 0.004);
      step(420);
      expect(Math.abs(float.transform.position.y - 0.25)).toBeLessThan(0.025);
      float.transform.scale.x = 2;
      step(420);
      expect(Math.abs(float.transform.position.y - 0.375)).toBeLessThan(0.025);
      // The scaled hull now displaces at most 0.5 kg of water: it cannot carry 1 kg.
      buoyancy.setVariable("volume", 0.00025);
      step(180);
      expect(float.transform.position.y).toBeLessThan(-1.5);
    } finally { sync.dispose(); }
  });

  it.each([1 / 60, 1 / 30])("keeps a light body stable entering water with a large explicit volume at dt=%s", async (dt) => {
    const backend = await createPhysicsBackend({ kind: "3d", gravity: { x: 0, y: -9.81, z: 0 }, allowSoftwareFallback: false });
    const world = new World({ seed: 1, dt, classRegistry: new ClassRegistry() });
    const sync = new PhysicsWorldSync(backend);
    sync.water.setContent({ water: { ...createDefaultWaterDefinition(), waveHeight: 0 } });
    const sea = world.createActor({ classId: "Actor", guid: "sea" });
    sea.attachComponent(world.createComponent({ classId: "WaterOceanComponent", variables: { assetGuid: "water" } }));
    world.spawnActorNow(sea);
    const float = world.createActor({ classId: "Actor", guid: "float", transform: { ...identityTransform(), position: { x: 0, y: 2, z: 0 } } });
    float.attachComponent(world.createComponent({ classId: "WaterBuoyancyComponent", variables: { volume: 1 } }));
    world.spawnActorNow(float);
    const settled: number[] = [];
    let entered = false, maximumAfterEntry = -Infinity;
    try {
      for (let i = 0; i < Math.round(12 / dt); i++) {
        sync.step(dt, world, i * dt);
        const y = float.transform.position.y;
        entered ||= y < 0.5;
        if (entered) maximumAfterEntry = Math.max(maximumAfterEntry, y);
        if (i * dt > 10) settled.push(y);
      }
      expect(entered).toBe(true);
      expect(maximumAfterEntry).toBeLessThan(1);
      // A 1 kg body displaces 0.001 m³: only the bottom millimetre stays submerged.
      expect(Math.min(...settled)).toBeGreaterThan(0.48);
      expect(Math.max(...settled)).toBeLessThan(0.52);
    } finally { sync.dispose(); }
  });

  it("creates a collidable body from buoyancy alone and follows moving waves", async () => {
    const backend = await createPhysicsBackend({ kind: "3d", gravity: { x: 0, y: -9.81, z: 0 }, allowSoftwareFallback: false });
    const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
    const sync = new PhysicsWorldSync(backend);
    const sea = world.createActor({ classId: "Actor", guid: "sea" });
    sea.attachComponent(world.createComponent({ classId: "WaterOceanComponent" }));
    world.spawnActorNow(sea);
    const boat = world.createActor({ classId: "Actor", guid: "float" });
    boat.attachComponent(world.createComponent({ classId: "WaterBuoyancyComponent", variables: { drag: 8 } }));
    world.spawnActorNow(boat);
    const heights: number[] = [];
    try {
      for (let i = 0; i < 360; i++) {
        sync.step(1 / 60, world, i / 60);
        if (i > 180) heights.push(boat.transform.position.y);
      }
      expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(0.2);
      const p = boat.transform.position;
      expect(sync.lineTrace({ ...p, y: p.y + 3 }, { ...p, y: p.y - 3 }).actorId).toBe("float");
      expect(Math.abs(p.y)).toBeLessThan(0.6);
    } finally { sync.dispose(); }
  });
  it("floats a body, dips under a falling rigid body, and retains its added load", async () => {
    const backend = await createPhysicsBackend({ kind: "3d", gravity: { x: 0, y: -9.81, z: 0 }, allowSoftwareFallback: false });
    const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
    const sync = new PhysicsWorldSync(backend);
    sync.water.setContent({ water: { ...createDefaultWaterDefinition(), waveHeight: 0 } });
    const sea = world.createActor({ classId: "Actor", guid: "sea" });
    sea.attachComponent(world.createComponent({ classId: "WaterOceanComponent", variables: { assetGuid: "water" } }));
    world.spawnActorNow(sea);
    const boat = world.createActor({ classId: "Actor", guid: "boat" });
    boat.attachComponent(world.createComponent({ classId: "RigidBodyComponent", variables: { mass: 10, angularDamping: 1 } }));
    boat.attachComponent(world.createComponent({ classId: "ColliderComponent", variables: { shape: { kind: "box", halfExtents: { x: 2, y: 0.5, z: 2 } }, friction: 0.8 } }));
    boat.attachComponent(world.createComponent({ classId: "WaterBuoyancyComponent", variables: { width: 3, length: 3, height: 1, drag: 5 } }));
    world.spawnActorNow(boat);
    let tick = 0;
    const step = (count: number) => { for (let i = 0; i < count; i++) sync.step(1 / 60, world, tick++ / 60); };
    try {
      step(300);
      const unloaded = boat.transform.position.y;
      expect(Math.abs(unloaded)).toBeLessThan(0.06);
      const cargo = world.createActor({ classId: "Actor", guid: "cargo", transform: { ...identityTransform(), position: { x: 0.5, y: 4, z: 0 } } });
      cargo.attachComponent(world.createComponent({ classId: "RigidBodyComponent", variables: { mass: 3 } }));
      cargo.attachComponent(world.createComponent({ classId: "ColliderComponent", variables: { shape: { kind: "box", halfExtents: { x: 0.4, y: 0.4, z: 0.4 } }, friction: 0.8 } }));
      world.spawnActorNow(cargo);
      let minimum = unloaded;
      for (let i = 0; i < 180; i++) { step(1); minimum = Math.min(minimum, boat.transform.position.y); }
      expect(minimum).toBeLessThan(unloaded - 0.1);
      step(420);
      expect(boat.transform.position.y).toBeLessThan(unloaded - 0.08);
      expect(boat.transform.position.y).toBeGreaterThan(-0.4);
      expect(cargo.transform.position.y).toBeGreaterThan(boat.transform.position.y + 0.65);
      expect(Math.abs(boat.transform.rotation.z)).toBeGreaterThan(0.001);
    } finally { backend.dispose(); }
  });
});
