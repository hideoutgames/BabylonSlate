import { describe, expect, it } from "vitest";
import { identityTransform } from "@babylonslate/core";
import type { CommandMessage } from "@babylonslate/bridge";
import { ClassRegistry, World } from "@babylonslate/object-model";
import { HavokPhysicsBackend } from "@babylonslate/physics";
import { PhysicsWorldSync } from "./physics-sync";
import { RagdollWorldSync } from "./ragdoll-sync";

describe("ragdoll synchronization work", () => {
  it("resolves only participating hierarchies while detecting direct edits and retirement", async () => {
    const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
    let unrelatedTransformReads = 0;
    for (let index = 0; index < 2048; index++) {
      const actor = world.createActor({ classId: "Actor", guid: `decoration-${index}`, transform: identityTransform() });
      const transform = actor.transform;
      Object.defineProperty(actor, "transform", { get: () => { unrelatedTransformReads++; return transform; } });
      world.spawnActorNow(actor);
    }
    const parent = world.createActor({ classId: "Actor", guid: "parent", transform: identityTransform() });
    parent.transform.position.x = 10;
    world.spawnActorNow(parent);
    const hero = world.createActor({ classId: "Actor", guid: "hero", transform: identityTransform(), variables: { parentId: parent.guid } });
    const component = world.createComponent({ classId: "RagdollComponent", variables: { enabled: false } });
    hero.attachComponent(component);
    world.spawnActorNow(hero);
    const backend = await HavokPhysicsBackend.create({ kind: "3d", gravity: { x: 0, y: -9.81, z: 0 } });
    const physics = new PhysicsWorldSync(backend);
    const commands: CommandMessage[] = [];
    const errors: Error[] = [];
    const sync = new RagdollWorldSync({ world, physics: () => physics, slot: () => 1,
      eligible: (actor) => !actor.destroyed, deferNative: false, emit: (command) => commands.push(command), error: (error) => errors.push(error) });
    const measure = (label: string) => {
      for (let warm = 0; warm < 20; warm++) { sync.sync(); sync.afterStep(); }
      const samples: number[] = [];
      unrelatedTransformReads = 0;
      for (let tick = 0; tick < 100; tick++) {
        const start = performance.now();
        sync.sync();
        sync.afterStep();
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      console.info("ragdoll sync (ms)", { label, actors: world.getActors().length, p50: samples[50], p95: samples[95], unrelatedTransformReads });
      return unrelatedTransformReads;
    };
    try {
      const inactiveReads = measure("disabled");
      expect(commands).toHaveLength(0);
      component.variables.set("enabled", true);
      sync.sync();
      const request = commands.find((command) => command.type === "captureRagdollPose")!;
      expect(request).toBeDefined();
      sync.accept({ type: "ragdollPoseCaptured", slotId: request.slotId, requestId: request.requestId, bones: [
        { name: "hip", parentName: null, position: { x: 10, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
        { name: "head", parentName: "hip", position: { x: 10, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
      ] });
      const activeReads = measure("one active");
      parent.transform.position.x = 20;
      for (let tick = 0; tick < 30; tick++) { sync.sync(); backend.step(1 / 60); sync.afterStep(); }
      expect(hero.transform.position.x).toBeCloseTo(-10, 3);
      expect(hero.transform.position.y).toBeLessThan(-0.5);
      const nextParent = world.createActor({ classId: "Actor", guid: "next-parent", transform: identityTransform() });
      nextParent.transform.position.x = 30;
      world.spawnActorNow(nextParent);
      hero.variables.set("parentId", nextParent.guid);
      sync.sync();
      sync.afterStep();
      expect(hero.transform.position.x).toBeCloseTo(-20, 3);
      nextParent.transform.scale.x = 2;
      sync.sync();
      expect(commands.filter((command) => command.type === "captureRagdollPose")).toHaveLength(2);
      expect(backend.listDebugColliders()).toHaveLength(0);
      hero.components.splice(0, 1);
      sync.sync();
      expect(component.getVariable("status")).toBe("disabled");
      expect(errors).toEqual([]);
      expect(inactiveReads).toBe(0);
      expect(activeReads).toBe(0);
    } finally { sync.dispose(); physics.dispose(); }
  });
});
