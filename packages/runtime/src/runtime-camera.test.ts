import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@haptic/bridge";
import { createDefaultScene, type PhysicsWorldKind } from "@haptic/core";
import { ClassRegistry, World, type Actor } from "@haptic/object-model";
import { RenderSlots } from "./render-slots";
import { RuntimeCamera } from "./runtime-camera";
import { RuntimeSubsystems } from "./runtime-subsystems";

function fixture(options: { physicsKind?: PhysicsWorldKind; canvas?: { width: number; height: number } } = {}) {
  const world = new World({ seed: 1, dt: 0.1, classRegistry: new ClassRegistry() });
  const subsystems = new RuntimeSubsystems();
  const slots = new RenderSlots(subsystems, { ensureCapacity: () => {}, findActor: (guid) => world.findActor(guid) });
  const scene = createDefaultScene();
  scene.settings.defaultCameraActorId = null;
  const emitted: CommandMessage[] = [];
  const warnings: string[] = [];
  const traces: Array<{ start: unknown; end: unknown }> = [];
  const overlaps: unknown[] = [];
  const physics = {
    kind: options.physicsKind ?? "3d",
    main: {
      lineTrace: (start: unknown, end: unknown) => {
        traces.push({ start, end });
        return { hit: false, location: null, normal: null, distance: 0, actorId: null, bodyId: null };
      },
      sphereOverlap: (center: unknown) => {
        overlaps.push(center);
        return { actorIds: ["box"], bodyIds: [7] };
      },
    },
    layer: () => undefined,
  };
  const camera = subsystems.register(new RuntimeCamera({
    world: () => world,
    playScene: () => scene,
    frameId: () => 0,
    slot: (actor) => slots.actorSlot(actor),
    slotOwner: (slotId) => slots.owner(slotId),
    guidSlot: (guid) => slots.guidSlot(guid),
    cursor: () => ({ x: 0, y: 0, pressed: false }),
    touches: () => [],
    overlay: () => ({ canvasSize: () => options.canvas ?? { width: 1, height: 1 }, viewBounds: () => ({ width: 32, height: 18 }) }),
    physics: () => physics as never,
    traceDebugDraw: false,
    warn: (message) => warnings.push(message),
    emit: (command) => emitted.push(command),
  }));
  const spawn = (guid: string, spawnOptions: { camera?: boolean; layer?: string } = {}) => {
    const actor = world.createActor({ guid, classId: "Actor", sceneLayerId: spawnOptions.layer ?? null });
    if (spawnOptions.camera ?? true) actor.attachComponent(world.createComponent({ guid: `${guid}-camera`, classId: "CameraComponent" }));
    world.spawnActorNow(actor);
    slots.allocate(actor);
    return actor;
  };
  /** A placed actor in the Scene document, as the Default Camera and Attempt Possess View Target read them. */
  const author = (id: string, components: Array<{ id: string; classId: string; properties?: Record<string, unknown> }>) => {
    scene.actors.push({
      id, name: id, classId: "Actor", parentId: null, visible: true, locked: false, folderId: null,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      components: components.map((component) => ({ properties: {}, ...component })),
    });
  };
  const remove = (actor: Actor) => {
    world.destroyActorInstance(actor);
    world.flushPending();
  };
  const possessions = () => emitted.flatMap((command) => command.type === "possessCamera" ? [command.slotId] : []);
  return { world, slots, scene, camera, spawn, author, remove, emitted, possessions, warnings, traces, overlaps };
}

describe("RuntimeCamera possession", () => {
  it("keeps the Layer Camera in view until a camera actor is possessed", () => {
    const f = fixture();
    f.spawn("idle");
    expect(f.camera.cameraActor()).toBeNull();
    expect(f.camera.cameraComponent()).toBeNull();
    f.camera.possessStartCamera();
    expect(f.possessions()).toEqual([]);
    expect(f.camera.cameraActor()).toBeNull();
  });

  it("possesses the Default Camera at the start of the Scene, before any opted-in camera", () => {
    const f = fixture();
    f.author("opted", [{ id: "lens", classId: "CameraComponent", properties: { attemptPossessViewTarget: true } }]);
    f.author("rig", [{ id: "lens", classId: "CameraComponent" }]);
    f.scene.settings.defaultCameraActorId = "rig";
    f.spawn("opted");
    const rig = f.spawn("rig");
    f.camera.possessStartCamera();
    expect(f.possessions()).toEqual([f.slots.actorSlot(rig)]);
    expect(f.camera.cameraActor()).toBe(rig);
    expect(f.camera.cameraComponent()?.guid).toBe("rig-camera");
  });

  it("falls to an opted-in camera when the Default Camera has no Camera component", () => {
    const f = fixture();
    f.author("prop", [{ id: "mesh", classId: "MeshComponent" }]);
    f.author("opted", [{ id: "lens", classId: "CameraComponent", properties: { attemptPossessViewTarget: true } }]);
    f.scene.settings.defaultCameraActorId = "prop";
    f.spawn("prop", { camera: false });
    const opted = f.spawn("opted");
    f.camera.possessStartCamera();
    expect(f.camera.cameraActor()).toBe(opted);
  });

  it("lets a Possess Camera that already ran for the Scene win over the start camera", () => {
    const f = fixture();
    f.author("rig", [{ id: "lens", classId: "CameraComponent" }]);
    f.scene.settings.defaultCameraActorId = "rig";
    f.spawn("rig");
    const chosen = f.spawn("chosen");
    f.camera.possess(chosen);
    f.camera.possessStartCamera();
    expect(f.possessions()).toEqual([f.slots.actorSlot(chosen)]);
    expect(f.camera.cameraActor()).toBe(chosen);
  });

  it("returns the view to the Layer Camera on Possess Camera with None", () => {
    const f = fixture();
    const possessed = f.spawn("possessed");
    f.camera.possess(possessed);
    f.camera.possess(null);
    expect(f.possessions()).toEqual([f.slots.actorSlot(possessed), null]);
    expect(f.camera.cameraActor()).toBeNull();
    // Already on the Layer Camera: nothing more to send.
    f.camera.possess(undefined);
    expect(f.possessions()).toHaveLength(2);
    expect(f.warnings).toEqual([]);
  });

  it("warns and returns to the Layer Camera when the target has no Camera component", () => {
    const f = fixture();
    const possessed = f.spawn("possessed");
    const prop = f.spawn("prop", { camera: false });
    f.camera.possess(possessed);
    f.camera.possess(prop);
    expect(f.possessions()).toEqual([f.slots.actorSlot(possessed), null]);
    expect(f.camera.cameraActor()).toBeNull();
    expect(f.warnings).toHaveLength(1);
    expect(f.warnings[0]).toContain("has no Camera component");
  });

  it("possesses a component's owner", () => {
    const f = fixture();
    const rig = f.spawn("rig");
    f.camera.possess(rig.components[0]);
    expect(f.camera.cameraActor()).toBe(rig);
  });

  it("forgets the Scene's possession for the next Scene", () => {
    const f = fixture();
    f.camera.possess(f.spawn("possessed"));
    f.camera.resetPossession();
    expect(f.camera.cameraActor()).toBeNull();
  });

  describe("a possessed slot whose owner no longer qualifies leaves the Layer Camera in view", () => {
    function possessing() {
      const f = fixture();
      const possessed = f.spawn("possessed");
      f.camera.possess(possessed);
      expect(f.camera.cameraActor()).toBe(possessed);
      return { ...f, possessed };
    }

    it("once the owner left the World, before its slot is released", () => {
      const f = possessing();
      f.remove(f.possessed);
      expect(f.slots.owner(f.slots.recordedSlot(f.possessed)!)).toBe(f.possessed);
      expect(f.camera.cameraActor()).toBeNull();
    });

    it("while a destroyed owner is still listed in the World", () => {
      const f = possessing();
      f.possessed.destroyed = true;
      expect(f.world.findActor("possessed")).toBe(f.possessed);
      expect(f.camera.cameraActor()).toBeNull();
    });

    it("once its Camera component is destroyed", () => {
      const f = possessing();
      f.possessed.components[0]!.destroyed = true;
      expect(f.camera.cameraActor()).toBeNull();
      expect(f.camera.cameraComponent()).toBeNull();
    });

    it("when the slot's owner is not the live actor for its guid", () => {
      const f = fixture();
      // Holds a slot and is not destroyed, but was never spawned (or was replaced): not a World actor.
      const ghost = f.world.createActor({ guid: "ghost", classId: "Actor" });
      ghost.attachComponent(f.world.createComponent({ guid: "ghost-camera", classId: "CameraComponent" }));
      f.slots.allocate(ghost);
      f.camera.possess(ghost);
      expect(f.camera.cameraActor()).toBeNull();
      f.world.spawnActorNow(ghost);
      expect(f.camera.cameraActor()).toBe(ghost);
    });

    it("when the owner now records a different slot", () => {
      const f = possessing();
      const possessedSlot = f.slots.actorSlot(f.possessed)!;
      // Allocating again moves the actor's own slot; the old slot still names it as owner.
      const moved = f.slots.allocate(f.possessed);
      expect(moved).not.toBe(possessedSlot);
      expect(f.slots.owner(possessedSlot)).toBe(f.possessed);
      expect(f.camera.cameraActor()).toBeNull();
    });

    it("and forgets the possession when its slot is released, so the slot's next owner is not the camera", () => {
      const f = possessing();
      const slotId = f.slots.actorSlot(f.possessed)!;
      f.remove(f.possessed);
      f.slots.release(slotId);
      const successor = f.spawn("successor");
      expect(f.slots.actorSlot(successor)).toBe(slotId);
      expect(f.camera.cameraActor()).toBeNull();
    });
  });
});

describe("RuntimeCamera cursor projection through the Layer Camera", () => {
  it("casts along +Z from the Layer Camera's depth under the cursor in a 3D world", () => {
    const f = fixture({ canvas: { width: 160, height: 90 } });
    f.scene.settings.cameraBounds2D = { width: 16, height: 9 };
    f.world.createScene({ assetGuid: "scene", sceneName: "Main", cameraLocation: [10, 2] });
    // The cursor sits on the canvas's top-left corner: half the 16 × 9 view left of and above the camera at (10, 2).
    const result = f.camera.projectCursorToScene();
    expect(f.traces).toEqual([{ start: { x: 2, y: 6.5, z: -500 }, end: { x: 2, y: 6.5, z: 500 } }]);
    expect(result.worldDirection).toEqual({ x: 0, y: 0, z: 1 });
  });

  it("answers with the colliders under the cursor in a 2D world", () => {
    const f = fixture({ physicsKind: "2d", canvas: { width: 160, height: 90 } });
    f.scene.settings.cameraBounds2D = { width: 16, height: 9 };
    f.world.createScene({ assetGuid: "scene", sceneName: "Main", cameraLocation: [0, 0] });
    const result = f.camera.projectCursorToScene();
    expect(f.overlaps).toEqual([{ x: -8, y: 4.5, z: 0 }]);
    expect(f.traces).toEqual([]);
    expect(result).toMatchObject({ hit: true, actorId: "box", bodyId: 7, location: { x: -8, y: 4.5, z: 0 } });
  });
});
