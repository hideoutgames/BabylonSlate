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
    overlay: () => ({ canvasSize: () => ({ width: 1, height: 1 }) }),
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

  it("drops a possession whose actor left the World and does not hand it to the slot's next owner", () => {
    const f = fixture();
    const fallback = f.spawn("fallback");
    const possessed = f.spawn("possessed");
    f.camera.possess(possessed);
    const slotId = f.slots.actorSlot(possessed)!;
    expect(f.camera.cameraActor()).toBe(possessed);
    f.remove(possessed);
    expect(f.camera.cameraActor()).toBe(fallback);
    f.slots.release(slotId);
    const successor = f.spawn("successor", { camera: false });
    expect(f.slots.actorSlot(successor)).toBe(slotId);
    expect(f.camera.cameraActor()).toBe(fallback);
  });
});
