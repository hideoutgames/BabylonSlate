import { describe, expect, it, vi } from "vitest";
import { createTimelineClip, type SerializedTimelineClip, type TimelineKey } from "@haptic/core";
import { ClassRegistry, EngineObject, World, type Actor } from "@haptic/object-model";
import { TimelineRuntime } from "./timeline-runtime";

const key = (id: string, Time: number, Value: unknown): TimelineKey => ({ id, Time, Value, Interpolation: "linear", ArriveTangent: 0, LeaveTangent: 0 });

function setup(clipOverrides: Partial<SerializedTimelineClip> = {}) {
  const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
  const door = world.createActor({ classId: "Actor", guid: "door", variables: { visible: true, Glow: 1 } });
  const light = world.createComponent({ classId: "LightComponent", guid: "light", variables: { intensity: 1, color: [1, 1, 1] } });
  door.attachComponent(light);
  world.spawnActorNow(door);
  const owner = new EngineObject({ classId: "Scene", guid: "scene" });
  const teleportActor = vi.fn();
  const refreshComponent = vi.fn();
  let clips: SerializedTimelineClip[] = [];
  const runtime = new TimelineRuntime({
    clipsFor: (candidate) => (candidate === owner ? clips : undefined),
    ownedActor: (_owner, id) => (id === "door" ? door : null),
    findActor: (guid) => world.findActor(guid),
    component: (actor: Actor, id) => actor.components.find((entry) => entry.guid === id) ?? null,
    teleportActor,
    refreshComponent,
  });
  const clip: SerializedTimelineClip = {
    ...createTimelineClip("intro", "Intro"),
    length: 2,
    objects: [{ id: "o", actorId: "door", tracks: [
      { id: "loc", target: { kind: "transform", property: "location" }, valueType: "vec3", keys: [key("a", 0, { x: 0, y: 0, z: 0 }), key("b", 2, { x: 4, y: 0, z: 0 })] },
      { id: "vis", target: { kind: "visible", property: "visible" }, valueType: "bool", keys: [key("v", 1, false)] },
      { id: "glow", target: { kind: "variable", property: "Glow" }, valueType: "float", keys: [key("g0", 0, 0), key("g1", 2, 10)] },
      { id: "col", target: { kind: "component", componentId: "light", property: "color" }, valueType: "color", keys: [key("c", 0, { x: 1, y: 0, z: 0, w: 1 })] },
    ] }],
    ...clipOverrides,
  };
  clips = [clip];
  return { runtime, owner, door, light, teleportActor, refreshComponent, clip: runtime.clip(owner, "intro")! };
}

describe("TimelineRuntime", () => {
  it("plays a clip, writing transforms, visibility, variables and component properties", () => {
    const { runtime, owner, door, light, clip, teleportActor, refreshComponent } = setup();
    runtime.play(clip);
    runtime.advance(1, [owner], () => true);
    expect(door.transform.position).toMatchObject({ x: 2, y: 0, z: 0 });
    expect(door.getVariable("visible")).toBe(false);
    expect(door.getVariable("Glow")).toBe(5);
    // A three-channel colour stays three channels.
    expect(light.getVariable("color")).toEqual([1, 0, 0]);
    expect(teleportActor).toHaveBeenCalledWith(door);
    expect(refreshComponent).toHaveBeenCalledWith(light, "color");
    runtime.advance(5, [owner], () => true);
    expect(clip.playback).toMatchObject({ time: 2, playing: false });
  });

  it("auto plays once its owner can run, and waits while it cannot", () => {
    const { runtime, owner, clip, door } = setup({ autoPlay: true });
    runtime.advance(0.5, [owner], () => false);
    expect(clip.playback.playing).toBe(false);
    runtime.advance(0.5, [owner], () => true);
    expect(clip.playback).toMatchObject({ playing: true, time: 0.5 });
    expect(door.transform.position.x).toBe(1);
  });

  it("restores the animated values when a Restore clip finishes", () => {
    const { runtime, owner, clip, door, light } = setup({ whenFinished: "restore" });
    runtime.play(clip);
    runtime.advance(1, [owner], () => true);
    expect(door.getVariable("Glow")).toBe(5);
    runtime.advance(1, [owner], () => true);
    expect(door.transform.position.x).toBe(0);
    expect(door.getVariable("visible")).toBe(true);
    expect(door.getVariable("Glow")).toBe(1);
    expect(light.getVariable("color")).toEqual([1, 1, 1]);
  });

  it("pauses, stops at the start, sets the time, plays in reverse and ends with its owner", () => {
    const { runtime, owner, clip, door } = setup();
    runtime.play(clip);
    runtime.advance(0.5, [owner], () => true);
    runtime.pause(clip);
    runtime.advance(1, [owner], () => true);
    expect(clip.playback.time).toBe(0.5);
    runtime.setTime(clip, 1.5);
    expect(door.transform.position.x).toBe(3);
    runtime.play(clip, true);
    runtime.advance(0.5, [owner], () => true);
    expect(clip.playback.time).toBe(1);
    runtime.stop(clip);
    expect(door.transform.position.x).toBe(0);
    runtime.setPlayRate(clip, 2);
    runtime.play(clip);
    runtime.advance(0.25, [owner], () => true);
    expect(clip.playback.time).toBe(0.5);
    owner.destroyed = true;
    runtime.advance(0.1, [], () => true);
    expect(clip.destroyed).toBe(true);
    expect(runtime.clip(owner, "intro")).toBeNull();
  });
});
