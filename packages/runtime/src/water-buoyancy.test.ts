import { describe, expect, it } from "vitest";
import { createDefaultWaterDefinition, identityTransform } from "@babylonslate/core";
import { ClassRegistry, World } from "@babylonslate/object-model";
import { createPhysicsBackend } from "@babylonslate/physics";
import { PhysicsWorldSync } from "./physics-sync";

describe("Water buoyancy with native collision response", () => {
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
