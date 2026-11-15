import { describe, expect, it } from "vitest";
import { createDefaultAnimGraph } from "@haptic/anim-graph";
import { scriptPaletteNodes } from "../services/script-palette";
import { defaultNodeRegistry } from "../services/graph-hydration";
import { animGraphEventEntries } from "./anim-graph-events";

const asset = (type: string, payload: Record<string, unknown>) => ({ header: { type, payload } });

describe("animGraphEventEntries", () => {
  it("lists the events on the Animations a 3D graph can play and its states' events, a window where any clip has one", () => {
    const doc = createDefaultAnimGraph("Loco", { skeletonGuid: "rig" });
    doc.stateMachine.states[0]!.events = { enter: "Idle Started" };
    const entries = animGraphEventEntries(doc, "3d", [
      asset("Animation", { skeletonGuid: "rig", events: [{ name: "Footstep", timeMs: 100 }, { name: "Swing", timeMs: 200, durationMs: 100 }] }),
      asset("Animation", { skeletonGuid: "rig", events: [{ name: "Swing", timeMs: 300 }] }),
      // Another Skeleton's Animation and a Sprite Animation cannot play in this graph.
      asset("Animation", { skeletonGuid: "ogre", events: [{ name: "Roar", timeMs: 0 }] }),
      asset("SpriteAnimation", { frames: [{ textureGuid: "t", durationMs: 100, events: [{ name: "Blink" }] }] }),
    ]);
    expect(entries).toEqual([
      { name: "Footstep", window: false },
      { name: "Idle Started", window: false },
      { name: "Swing", window: true },
    ]);
  });

  it("lists a 2D graph's Sprite Animation frame events", () => {
    const doc = createDefaultAnimGraph("Robot", { dimension: "2d" });
    const entries = animGraphEventEntries(doc, "2d", [
      asset("SpriteAnimation", { frames: [{ textureGuid: "t", durationMs: 100, events: [{ name: "Step" }] }] }),
      asset("Animation", { skeletonGuid: null, events: [{ name: "Footstep", timeMs: 0 }] }),
    ]);
    expect(entries).toEqual([{ name: "Step", window: false }]);
  });
});

describe("Animation Event rows in Add Node", () => {
  const rows = (host: "object" | "rule" | undefined) =>
    scriptPaletteNodes(defaultNodeRegistry(), {
      parentClass: "Object",
      animationGraphHost: host,
      animEvents: [{ name: "Footstep", window: false }, { name: "Swing", window: true }],
    }).filter((node) => node.nodeType === "anim.event.notify");

  it("offers an Event <Name> per event in the Animation Object only, a window's with Begin and End", () => {
    const offered = rows("object");
    expect(offered.map((node) => node.title)).toEqual(["Event Footstep", "Event Swing"]);
    expect(offered[0]!.defaultData).toMatchObject({ eventName: "Footstep", window: false });
    expect(offered[1]!.pins?.map((pin) => pin.id)).toEqual(["begin", "end"]);
    expect(rows("rule")).toEqual([]);
    expect(rows(undefined)).toEqual([]);
  });
});

describe("Use Cached Pose and skeletal control rows in Add Node", () => {
  const rows = (dimension: "3d" | "2d") =>
    scriptPaletteNodes(defaultNodeRegistry(), {
      parentClass: "Object",
      animationGraphHost: "pose",
      animPose: { dimension, cachedPoses: ["Locomotion"] },
    });

  it("offers a Use Cached Pose <Name> per saved cached pose, never a bare one, and Transform Bone in 3D only", () => {
    const offered = rows("3d");
    expect(offered.filter((node) => node.nodeType === "anim.pose.useCachedPose").map((node) => [node.title, node.defaultData])).toEqual([
      ["Use Cached Pose Locomotion", { name: "Locomotion", title: "Use Cached Pose Locomotion" }],
    ]);
    // Registry rows carry their type as their id; injected rows name it.
    const types = (list: typeof offered) => list.map((node) => node.nodeType ?? node.id);
    expect(types(offered)).toEqual(expect.arrayContaining(["anim.control.transformBone", "anim.pose.layeredBlendPerBone", "anim.pose.saveCachedPose"]));
    expect(types(offered).filter((type) => type === "anim.pose.useCachedPose")).toHaveLength(1);
    expect(types(rows("2d")).some((type) => type.startsWith("anim.control.") || type.startsWith("anim.pose."))).toBe(false);
  });
});
