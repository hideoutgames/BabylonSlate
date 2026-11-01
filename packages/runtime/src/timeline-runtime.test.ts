import { describe, expect, it, vi } from "vitest";
import { createTimelineClip, type SerializedTimelineClip, type TimelineKey } from "@haptic/core";
import { ClassRegistry, EngineObject, TimelineObject, World, type Actor } from "@haptic/object-model";
import { TimelineRuntime, timelineClipControl, timelineClipState } from "./timeline-runtime";

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
  const fired: Array<[string, unknown[]]> = [];
  // With the object each fired on: a clip, or the Timeline that re-fires it.
  const firedOn: Array<[EngineObject, string, unknown[]]> = [];
  const listeners = new Map<string, (values: unknown[]) => void>();
  const ensureClipClass = vi.fn();
  const ensureTimelineClass = vi.fn();
  const release = vi.fn();
  const runtime = new TimelineRuntime({
    clipsFor: (candidate) => (candidate === owner ? { documentGuid: "level", clips } : undefined),
    ensureClipClass,
    ensureTimelineClass,
    fireDispatcher: (target, name, values) => {
      firedOn.push([target, name, [...values]]);
      if (target instanceof TimelineObject) return;
      fired.push([name, [...values]]);
      listeners.get(name)?.([...values]);
    },
    release,
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
  return {
    runtime, owner, door, light, teleportActor, refreshComponent, fired, firedOn, listeners, ensureClipClass, ensureTimelineClass, release,
    clip: runtime.clip(owner, "intro")!,
  };
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

  it("pauses, stops at the start, sets the position, plays in reverse and ends with its owner", () => {
    const { runtime, owner, clip, door, release } = setup();
    runtime.play(clip);
    runtime.advance(0.5, [owner], () => true);
    runtime.pause(clip);
    runtime.advance(1, [owner], () => true);
    expect(clip.playback.time).toBe(0.5);
    runtime.setPosition(clip, 1.5);
    expect(door.transform.position.x).toBe(3);
    runtime.play(clip, true);
    runtime.advance(0.5, [owner], () => true);
    expect(timelineClipState(clip, "position")).toBe(1);
    expect(timelineClipState(clip, "reversed")).toBe(true);
    // Stop while reversing returns to the end.
    runtime.stop(clip);
    expect(door.transform.position.x).toBe(4);
    expect(timelineClipState(clip, "playing")).toBe(false);
    runtime.playFromStart(clip);
    expect(clip.playback).toMatchObject({ time: 0, direction: 1, playing: true });
    runtime.stop(clip);
    expect(door.transform.position.x).toBe(0);
    runtime.setPlayRate(clip, 2);
    runtime.setPlayRate(clip, -3);
    expect(timelineClipState(clip, "playRate")).toBe(0);
    timelineClipControl(runtime, clip, "setPlayRate", { playRate: 2 });
    runtime.play(clip);
    runtime.advance(0.25, [owner], () => true);
    expect(clip.playback.time).toBe(0.5);
    owner.destroyed = true;
    runtime.advance(0.1, [], () => true);
    expect(clip.destroyed).toBe(true);
    expect(release).toHaveBeenCalledWith(clip);
    expect(runtime.clip(owner, "intro")).toBeNull();
  });

  it("starts at the clip's Play Rate and Loop Mode and changes them per copy", () => {
    const { runtime, owner, clip } = setup({ playRate: 2, loopMode: "loop" });
    expect(timelineClipState(clip, "playRate")).toBe(2);
    expect(timelineClipState(clip, "length")).toBe(2);
    runtime.play(clip);
    runtime.advance(1.5, [owner], () => true);
    expect(clip.playback).toMatchObject({ time: 1, playing: true });
    timelineClipControl(runtime, clip, "setLoopMode", { loopMode: "Once" });
    runtime.advance(1, [owner], () => true);
    expect(clip.playback).toMatchObject({ time: 2, playing: false });
    // The authored clip is unchanged.
    expect(clip.clip.loopMode).toBe("loop");
  });

  it("is an object of its document's clip class", () => {
    const { clip, ensureClipClass } = setup();
    expect(clip.classId).toBe("TimelineClip:level:intro");
    expect(ensureClipClass).toHaveBeenCalledWith("TimelineClip:level:intro");
  });

  it("makes one Timeline object per Timeline Asset and finds the asset's loaded clips", () => {
    const { runtime, owner, clip, ensureTimelineClass, release } = setup({ timelineAsset: "fx" });
    const timeline = runtime.timeline("fx")!;
    expect(runtime.timeline(" fx ")).toBe(timeline);
    expect(runtime.timeline("")).toBeNull();
    expect(timeline.classId).toBe("Timeline:fx");
    expect(ensureTimelineClass).toHaveBeenCalledWith("Timeline:fx");
    expect(runtime.timelineClips(timeline, [owner])).toEqual([clip]);
    expect(runtime.timelineClips(timeline, [owner], { documentGuid: "level", clipId: "intro" })).toEqual([clip]);
    expect(runtime.timelineClips(timeline, [owner], { documentGuid: "other", clipId: "intro" })).toEqual([]);
    // Another asset's Timeline holds none of them, and an unloaded owner has none.
    expect(runtime.timelineClips(runtime.timeline("other")!, [owner])).toEqual([]);
    expect(runtime.timelineClips(timeline, [])).toEqual([]);

    runtime.reset();
    expect(timeline.destroyed).toBe(true);
    expect(release).toHaveBeenCalledWith(timeline);
    expect(runtime.timeline("fx")).not.toBe(timeline);
  });

  it("re-fires a bound clip's events on its Timeline, with the clip as the last input", () => {
    const { runtime, owner, clip, firedOn } = setup({
      timelineAsset: "fx",
      loopMode: "once",
      eventTracks: [{ id: "e", name: "On Line", inputs: [{ name: "Text", typeId: "string", direction: "in" }], keys: [{ id: "k", time: 0.5, values: { Text: "Hi" } }] }],
    });
    runtime.play(clip);
    runtime.advance(1, [owner], () => true);
    // No script asked for the Timeline yet, so nothing listens on it.
    expect(firedOn.map(([target, name]) => [target === clip ? "clip" : "timeline", name])).toEqual([["clip", "On_Line"]]);

    const timeline = runtime.timeline("fx")!;
    firedOn.length = 0;
    runtime.playFromStart(clip);
    runtime.advance(2, [owner], () => true);
    expect(firedOn).toEqual([
      [clip, "On_Line", ["Hi"]],
      [timeline, "On_Line__Intro_", ["Hi", clip]],
      [clip, "On_Finished", []],
      [timeline, "On_Finished__Intro_", [clip]],
    ]);
  });

  it("fires event keys with their values, then On Looped, in playback order", () => {
    const { runtime, owner, clip, fired } = setup({
      loopMode: "loop",
      eventTracks: [{
        id: "e", name: "On Line", inputs: [{ name: "Text", typeId: "string", direction: "in" }, { name: "Volume", typeId: "float", direction: "in" }],
        keys: [{ id: "k0", time: 0.5, values: { Text: "Hello" } }, { id: "k1", time: 1.5, values: { Text: "Bye", Volume: 2 } }],
      }],
    });
    runtime.play(clip);
    runtime.advance(1, [owner], () => true);
    expect(fired).toEqual([["On_Line", ["Hello", 0]]]);
    runtime.advance(1.75, [owner], () => true);
    expect(fired.slice(1)).toEqual([["On_Line", ["Bye", 2]], ["On_Line", ["Hello", 0]], ["On_Looped", []]]);
  });

  it("fires On Finished after When Finished, and a listener that stops the clip ends the step", () => {
    const { runtime, owner, clip, fired, listeners, door } = setup({
      whenFinished: "restore",
      eventTracks: [{ id: "e", name: "Beat", inputs: [], keys: [{ id: "a", time: 1, values: {} }, { id: "b", time: 1, values: {} }] }],
    });
    listeners.set("On_Finished", () => expect(door.getVariable("Glow")).toBe(1));
    runtime.play(clip);
    runtime.advance(3, [owner], () => true);
    expect(fired.map(([name]) => name)).toEqual(["Beat", "Beat", "On_Finished"]);
    fired.length = 0;
    listeners.set("Beat", () => runtime.stop(clip));
    runtime.play(clip);
    runtime.advance(3, [owner], () => true);
    expect(fired.map(([name]) => name)).toEqual(["Beat"]);
    expect(clip.playback).toMatchObject({ playing: false, time: 0 });
  });

  it("fires the keys passed over only when Set Position asks", () => {
    const { runtime, clip, fired } = setup({
      eventTracks: [{ id: "e", name: "Beat", inputs: [], keys: [{ id: "a", time: 0.5, values: {} }, { id: "b", time: 1.5, values: {} }] }],
    });
    runtime.setPosition(clip, 1);
    expect(fired).toEqual([]);
    timelineClipControl(runtime, clip, "setPosition", { time: 2, fireEvents: true });
    timelineClipControl(runtime, clip, "setPosition", { time: 0, fireEvents: true });
    expect(fired.map(([name]) => name)).toEqual(["Beat", "Beat", "Beat"]);
  });
});
