import { describe, expect, it } from "vitest";
import { createDefaultScene } from "@babylonslate/core";
import { ClassRegistry, World, type Actor } from "@babylonslate/object-model";
import { RenderSlots } from "./render-slots";
import { RuntimeCamera } from "./runtime-camera";
import { RuntimeSubsystems } from "./runtime-subsystems";

function fixture() {
  const world = new World({ seed: 1, dt: 0.1, classRegistry: new ClassRegistry() });
  const subsystems = new RuntimeSubsystems();
  const slots = new RenderSlots(subsystems, { ensureCapacity: () => {}, findActor: (guid) => world.findActor(guid) });
  const scene = createDefaultScene();
  const streamActors = new Set<Actor>();
  const camera = subsystems.register(new RuntimeCamera({
    world: () => world,
    playScene: () => scene,
    frameId: () => 0,
    slot: (actor) => slots.actorSlot(actor),
    slotOwner: (slotId) => slots.owner(slotId),
    guidSlot: (guid) => slots.guidSlot(guid),
    streams: () => ({ isStreamActor: (actor) => streamActors.has(actor) }),
    cursor: () => ({ x: 0, y: 0, pressed: false }),
    touches: () => [],
    overlay: () => ({ canvasSize: () => ({ width: 1, height: 1 }), viewBounds: () => ({ width: 32, height: 18 }) }),
    physics: () => ({}) as never,
    emit: () => {},
  }));
  const spawn = (guid: string, options: { camera?: boolean; layer?: string } = {}) => {
    const actor = world.createActor({ guid, classId: "Actor", sceneLayerId: options.layer ?? null });
    if (options.camera ?? true) actor.attachComponent(world.createComponent({ guid: `${guid}-camera`, classId: "CameraComponent" }));
    world.spawnActorNow(actor);
    slots.allocate(actor);
    return actor;
  };
  const remove = (actor: Actor) => {
    world.destroyActorInstance(actor);
    world.flushPending();
  };
  return { world, slots, scene, streamActors, camera, spawn, remove };
}

describe("RuntimeCamera.cameraActor", () => {
  it("picks the possessed camera, else the Scene's main camera, else the first main-Scene camera in world order", () => {
    const f = fixture();
    f.spawn("plain", { camera: false });
    const first = f.spawn("first");
    const second = f.spawn("second");
    const third = f.spawn("third");
    expect(f.camera.cameraActor()).toBe(first);
    f.scene.settings.mainCameraActorId = "second";
    expect(f.camera.cameraActor()).toBe(second);
    f.camera.possess(third);
    expect(f.camera.cameraActor()).toBe(third);
    f.camera.resetPossession();
    expect(f.camera.cameraActor()).toBe(second);
    f.scene.settings.mainCameraActorId = "missing";
    expect(f.camera.cameraActor()).toBe(first);
  });

  it("skips destroyed, Scene Layer and streamed actors and destroyed camera components in the fallback", () => {
    const f = fixture();
    f.spawn("overlay", { layer: "layer" });
    const streamed = f.spawn("streamed");
    f.streamActors.add(streamed);
    const flagged = f.spawn("flagged");
    flagged.destroyed = true;
    const stripped = f.spawn("stripped");
    stripped.components[0]!.destroyed = true;
    expect(f.camera.cameraActor()).toBeNull();
    const usable = f.spawn("usable");
    expect(f.camera.cameraActor()).toBe(usable);
  });

  it("finds a camera component attached after the actor spawned", () => {
    const f = fixture();
    const late = f.spawn("late", { camera: false });
    expect(f.camera.cameraActor()).toBeNull();
    late.attachComponent(f.world.createComponent({ guid: "late-camera", classId: "CameraComponent" }));
    expect(f.camera.cameraActor()).toBe(late);
  });

  describe("a possessed slot whose owner no longer qualifies", () => {
    /** A possession of `possessed`, with `fallback` as the camera the rest of the order yields. */
    function possessing() {
      const f = fixture();
      const fallback = f.spawn("fallback");
      const possessed = f.spawn("possessed");
      f.camera.possess(possessed);
      expect(f.camera.cameraActor()).toBe(possessed);
      return { ...f, fallback, possessed };
    }

    it("falls back once the owner left the World, before its slot is released", () => {
      const f = possessing();
      f.remove(f.possessed);
      expect(f.slots.owner(f.slots.recordedSlot(f.possessed)!)).toBe(f.possessed);
      expect(f.camera.cameraActor()).toBe(f.fallback);
    });

    it("falls back while a destroyed owner is still listed in the World", () => {
      const f = possessing();
      f.possessed.destroyed = true;
      expect(f.world.findActor("possessed")).toBe(f.possessed);
      expect(f.camera.cameraActor()).toBe(f.fallback);
    });

    it("falls back when the slot's owner is not the live actor for its guid", () => {
      const f = fixture();
      const fallback = f.spawn("fallback");
      // Holds a slot and is not destroyed, but was never spawned (or was replaced): not a World actor.
      const ghost = f.world.createActor({ guid: "ghost", classId: "Actor" });
      ghost.attachComponent(f.world.createComponent({ guid: "ghost-camera", classId: "CameraComponent" }));
      f.slots.allocate(ghost);
      f.camera.possess(ghost);
      expect(ghost.destroyed).toBe(false);
      expect(f.world.findActor("ghost")).toBeUndefined();
      expect(f.camera.cameraActor()).toBe(fallback);
      f.world.spawnActorNow(ghost);
      expect(f.camera.cameraActor()).toBe(ghost);
    });

    it("falls back when the owner now records a different slot", () => {
      const f = possessing();
      const possessedSlot = f.slots.actorSlot(f.possessed)!;
      // Allocating again moves the actor's own slot; the old slot still names it as owner.
      const moved = f.slots.allocate(f.possessed);
      expect(moved).not.toBe(possessedSlot);
      expect(f.slots.owner(possessedSlot)).toBe(f.possessed);
      expect(f.camera.cameraActor()).toBe(f.fallback);
    });

    it("forgets the possession when its slot is released, so the slot's next owner is not the camera", () => {
      const f = possessing();
      const slotId = f.slots.actorSlot(f.possessed)!;
      f.remove(f.possessed);
      f.slots.release(slotId);
      const successor = f.spawn("successor");
      expect(f.slots.actorSlot(successor)).toBe(slotId);
      expect(f.camera.cameraActor()).toBe(f.fallback);
    });
  });
});
