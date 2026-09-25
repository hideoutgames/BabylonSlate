import { expect, it, vi } from "vitest";
import { identityTransform } from "@babylonslate/core";
import { ClassRegistry, World } from "@babylonslate/object-model";
import { createPhysicsBackend, createSoftwarePhysicsBackend } from "@babylonslate/physics";
import { PhysicsWorldSync } from "./physics-sync";

function worldWithLandscape() {
  const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
  const actor = world.createActor({ classId: "Actor", guid: "terrain", transform: identityTransform() });
  const component = world.createComponent({ classId: "LandscapeComponent", guid: "landscape",
    variables: { width: 4, depth: 4, subdivisions: 4, heights: Array(25).fill(0) } });
  actor.attachComponent(component);
  world.spawnActorNow(actor);
  return { world, actor, component };
}

it("creates opt-in Havok terrain that follows sculpting and transforms, reuses geometry, and retires cleanly", async () => {
  const { world, actor, component } = worldWithLandscape();
  const backend = await createPhysicsBackend({ kind: "3d", gravity: { x: 0, y: 0, z: 0 }, allowSoftwareFallback: false });
  const sync = new PhysicsWorldSync(backend);
  const publish = vi.spyOn(backend, "applyColliderChanges");
  const trace = (x = 14.25, z = 0.25) => backend.lineTrace({ x, y: 20, z }, { x, y: -20, z });
  const update = () => { sync.syncFromWorld(world); backend.step(1 / 60); };
  try {
    const parent = world.createActor({ classId: "Actor", guid: "parent", transform: {
      ...identityTransform(), position: { x: 10, y: 1, z: 0 }, scale: { x: 2, y: 2, z: 2 },
    } });
    world.spawnActorNow(parent);
    actor.setVariable("parentId", parent.guid);
    actor.transform.position.x = 1;
    component.transform.position.x = 1;
    const heights = Array(25).fill(0); heights[12] = 2;
    component.setVariable("heights", heights);
    update();
    expect(trace().hit).toBe(false);
    component.setVariable("collisionsEnabled", true);
    update();
    expect(trace().actorId).toBe("terrain");
    expect(trace().location!.y).toBeCloseTo(4, 3);
    expect(trace(10.5, -3.5).location!.y).toBeCloseTo(1, 3);

    publish.mockClear();
    component.setVariable("materialGuid", "different-material");
    component.setVariable("weights", Array(100).fill(0.25));
    update();
    expect(trace().location!.y).toBeCloseTo(4, 3);
    expect(publish).not.toHaveBeenCalled();

    component.setVariable("heights", heights.map((height) => height * 2));
    update();
    expect(trace().location!.y).toBeCloseTo(7, 3);
    parent.transform.position.y += 2;
    update();
    expect(trace().location!.y).toBeCloseTo(9, 3);
    component.setVariable("collisionsEnabled", false);
    update();
    expect(trace().hit).toBe(false);
    component.setVariable("collisionsEnabled", true);
    update();
    expect(trace().location!.y).toBeCloseTo(9, 3);
    component.destroyed = true;
    update();
    expect(trace().hit).toBe(false);
  } finally { publish.mockRestore(); sync.dispose(); }
});

it.each([false, true])("a falling Havok body lands only when Landscape Collisions is enabled (%s)", async (enabled) => {
  const { world, component } = worldWithLandscape();
  component.setVariable("collisionsEnabled", enabled);
  component.setVariable("heights", Array(25).fill(2));
  const ball = world.createActor({ classId: "Actor", guid: "ball", transform: {
    ...identityTransform(), position: { x: 0.2, y: 6, z: 0.2 },
  } });
  ball.attachComponent(world.createComponent({ classId: "RigidBodyComponent", variables: { motionType: "dynamic", mass: 1 } }));
  ball.attachComponent(world.createComponent({ classId: "ColliderComponent", variables: { shape: { kind: "sphere", radius: 0.5 } } }));
  world.spawnActorNow(ball);
  const backend = await createPhysicsBackend({ kind: "3d", gravity: { x: 0, y: -9.81, z: 0 }, allowSoftwareFallback: false });
  const sync = new PhysicsWorldSync(backend);
  try {
    for (let i = 0; i < 180; i++) sync.step(1 / 60, world);
    if (enabled) expect(ball.transform.position.y).toBeCloseTo(2.5, 1);
    else expect(ball.transform.position.y).toBeLessThan(-10);
  } finally { sync.dispose(); }
});

it("keeps Landscape collision geometry out of a 2D physics world", () => {
  const { world, component } = worldWithLandscape();
  component.setVariable("collisionsEnabled", true);
  const backend = createSoftwarePhysicsBackend("2d");
  const sync = new PhysicsWorldSync(backend);
  try {
    sync.syncFromWorld(world);
    expect(backend.getBodyTransform("body:terrain")).toBeNull();
  } finally { sync.dispose(); }
});
