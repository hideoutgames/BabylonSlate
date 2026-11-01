import {
  createTimelineClip,
  type GraphClassMember,
  type GraphClassMemberPin,
  type SerializedActor,
  type SerializedComponent,
  type SerializedScene,
  type SerializedTimelineClip,
  type TimelineKey,
} from "@haptic/core";
import {
  TIMELINE_REFIRED_CLIP_INPUT,
  timelineClassId,
  timelineClipClassId,
  timelineRefiredDispatcherName,
} from "@haptic/object-model";
import { TIMELINE_FROM_ASSET_NODE_ID, TIMELINE_LOADED_CLIPS_NODE_ID } from "@haptic/scripting-nodes";
import { actor, comp, meshComp, requireRef, tf, type FeatureTestContext, type Vec3 } from "./context";
import { classGraph, gChain, gNode, gWire, getVar, printString, varMember } from "./graph";

/**
 * Timeline showcase. `FT_Timeline` (created before any scene binds a clip to
 * it) holds the main scene's Intro, FT_HUD's Reveal and FT_World's Door Loop.
 * FT_World's Timeline Pavilion: a door and a lamp that Door Loop animates on
 * an Auto Play loop, and `FT_TimelineListener`, which reaches the clip through
 * a Timeline Asset variable and binds its re-fired On Door Open.
 */

const FOLDER = "Timeline";
export const FEATURE_TEST_TIMELINE_ASSET = "FT_Timeline";
export const FEATURE_TEST_TIMELINE_LISTENER = "FT_TimelineListener";

/** Landscape-local pavilion origin (x, z), on the south slope in front of the world camera. */
export const TIMELINE_PAVILION = { x: -4, z: -24, radius: 5 } as const;
const DOOR = { width: 1.2, height: 2.2, depth: 0.12, openYaw: -100 } as const;
const LAMP = { height: 3, intensity: 0.5, bright: 4 } as const;
const WARM = { x: 1, y: 0.55, z: 0.25, w: 1 };
const COOL = { x: 0.55, y: 0.75, z: 1, w: 1 };

const CLIP_ID = "ft-timeline-clip-door-loop";
const CLIP_NAME = "Door Loop";
const DOOR_OPEN_EVENT = "On Door Open";
const DOOR_OPEN_TIME = 1;
const ANGLE_INPUT = "Angle";

/** `FT_Timeline`, with no clips until scenes bind theirs. */
export async function buildFeatureTestTimeline(ctx: FeatureTestContext): Promise<void> {
  const { guid } = await ctx.createAsset("Timeline", FOLDER, FEATURE_TEST_TIMELINE_ASSET, {
    payload: () => ({ description: "The Feature Test's Timeline Clips: Intro (main scene), Reveal (FT_HUD) and Door Loop (FT_World)." }),
  });
  ctx.assets.timeline = guid;
}

const key = (id: string, Time: number, Value: unknown): TimelineKey => ({
  id, Time, Value, Interpolation: "cubicInOut", ArriveTangent: 0, LeaveTangent: 0,
});

/** Box of `size` metres centered at `center`. */
function box(id: string, center: Vec3, size: Vec3): SerializedComponent {
  return { ...meshComp(id, "box", { collision: "simple" }), transform: tf(center, { scale: [size[0] / 1.5, size[1] / 1.5, size[2] / 1.5] }) };
}

/**
 * The pavilion's frame, door (hinged at its left edge) and lamp at `origin`
 * (scene space, on the ground), and Door Loop: a 4 s Auto Play loop that swings
 * the door open and shut, brightens and cools the lamp while it is open, and
 * keys On Door Open (Angle) as it opens.
 */
export function placeTimelinePavilion(ctx: FeatureTestContext, scene: SerializedScene, origin: Vec3): void {
  const [x, y, z] = origin;
  const add = (next: SerializedActor) => ctx.addActor(next, { scene });
  const half = DOOR.width / 2;
  add(actor("ft-world-timeline-frame", "Timeline Door Frame", tf([x, y, z]), [
    box("ft-world-timeline-frame-left", [-half - 0.1, DOOR.height / 2, 0], [0.2, DOOR.height, 0.2]),
    box("ft-world-timeline-frame-right", [half + 0.1, DOOR.height / 2, 0], [0.2, DOOR.height, 0.2]),
    box("ft-world-timeline-frame-top", [0, DOOR.height + 0.1, 0], [DOOR.width + 0.4, 0.2, 0.2]),
  ]));
  // The actor sits on the hinge, so the Rotation track swings the panel around it.
  const door = add(actor("ft-world-timeline-door", "Timeline Door", tf([x - half, y, z]), [
    box("ft-world-timeline-door-panel", [half, DOOR.height / 2, 0], [DOOR.width, DOOR.height, DOOR.depth]),
  ]));
  const lamp = add(actor("ft-world-timeline-lamp", "Timeline Lamp", tf([x + half + 1.2, y, z]), [
    { ...meshComp("ft-world-timeline-lamp-post", "cylinder", { collision: "simple" }), transform: tf([0, LAMP.height / 2, 0], { scale: [0.15, LAMP.height / 1.5, 0.15] }) },
    comp("ft-world-timeline-lamp-light", "LightComponent", {
      enabled: true, lightKind: "point", color: [WARM.x, WARM.y, WARM.z], intensity: LAMP.intensity, range: 8, castShadows: false, shadowPriority: 0,
    }, tf([0, LAMP.height + 0.2, 0])),
  ]));
  const closed = { pitch: 0, yaw: 0, roll: 0 };
  const open = { pitch: 0, yaw: DOOR.openYaw, roll: 0 };
  const clip: SerializedTimelineClip = {
    ...createTimelineClip(CLIP_ID, CLIP_NAME),
    length: 4,
    loopMode: "loop",
    autoPlay: true,
    timelineAsset: requireRef(ctx.assets.timeline, "FT_Timeline"),
    objects: [
      { id: "ft-timeline-object-door", actorId: door.id, tracks: [{
        id: "ft-timeline-track-door-rotation", target: { kind: "transform", property: "rotation" }, valueType: "rotator",
        keys: [key("door-0", 0, closed), key("door-1", 1, open), key("door-2", 2.5, open), key("door-3", 3.5, closed)],
      }] },
      { id: "ft-timeline-object-lamp", actorId: lamp.id, tracks: [
        { id: "ft-timeline-track-lamp-intensity", target: { kind: "component", componentId: "ft-world-timeline-lamp-light", property: "intensity" }, valueType: "float",
          keys: [key("lamp-i0", 0, LAMP.intensity), key("lamp-i1", 1, LAMP.bright), key("lamp-i2", 2.5, LAMP.bright), key("lamp-i3", 3.5, LAMP.intensity)] },
        { id: "ft-timeline-track-lamp-color", target: { kind: "component", componentId: "ft-world-timeline-lamp-light", property: "color" }, valueType: "color",
          keys: [key("lamp-c0", 0, WARM), key("lamp-c1", 1, COOL), key("lamp-c2", 3.5, WARM)] },
      ] },
    ],
    eventTracks: [{
      id: "ft-timeline-event-door-open", name: DOOR_OPEN_EVENT,
      inputs: [{ name: ANGLE_INPUT, typeId: "float", direction: "in" }],
      keys: [{ id: "ft-timeline-event-door-open-key", time: DOOR_OPEN_TIME, values: { [ANGLE_INPUT]: -DOOR.openYaw } }],
    }],
  };
  scene.timelineClips = [...(scene.timelineClips ?? []), clip];
}

/**
 * `FT_TimelineListener` and its actor in the pavilion. Begin Play: Get
 * Timeline Object Reference From Timeline Asset on its `Story` variable
 * (Asset Type Timeline, FT_Timeline), Bind Event to On Door Open (Door Loop),
 * and assert Get Loaded Timeline Clips holds only Door Loop (FT_World loads
 * no other clip of FT_Timeline). The handler asserts the Angle and the clip.
 */
export async function placeTimelineListener(ctx: FeatureTestContext, scene: SerializedScene, worldGuid: string, position: Vec3): Promise<void> {
  const timelineGuid = requireRef(ctx.assets.timeline, "FT_Timeline");
  const clipClassId = timelineClipClassId(worldGuid, CLIP_ID);
  const name = timelineRefiredDispatcherName(DOOR_OPEN_EVENT, CLIP_NAME);
  const pins: GraphClassMemberPin[] = [
    { name: ANGLE_INPUT, typeId: "float", direction: "in" },
    { name: TIMELINE_REFIRED_CLIP_INPUT, typeId: "object", typeClassId: clipClassId, direction: "in" },
  ];
  const story = varMember("ft-timeline-listener-story", "Story", "asset", timelineGuid, { typeClassId: "Timeline" });
  const event: GraphClassMember = {
    id: "ft-timeline-listener-door-opened", kind: "event", name: "Door Opened",
    pins: pins.map((pin) => ({ ...pin, direction: "out" as const })),
  };
  const graph = classGraph({
    members: [story, event],
    nodes: [
      gNode("begin", "flow.event.beginPlay", 0, 0),
      getVar("get-story", story, 0, 200),
      gNode("timeline", TIMELINE_FROM_ASSET_NODE_ID, 240, 200),
      gNode("bind", "flow.dispatcher.bind", 520, 0, { title: `Bind Event to ${name}`, name, classId: timelineClassId(timelineGuid), implicitSelf: false, pins }),
      gNode("loaded", TIMELINE_LOADED_CLIPS_NODE_ID, 520, 200),
      gNode("loaded-count", "array.length", 780, 200),
      gNode("assert-loaded", "debug.assertEqual", 780, 0, { "default:expected": 1, "default:message": "FT_World should load only Door Loop of FT_Timeline" }),
      printString("ready", 1040, 0, "FT_TimelineListener bound On Door Open (Door Loop) through FT_Timeline"),
      gNode(event.id, "flow.event.custom", 0, 500, { title: `Event ${event.name}`, name: event.name, pins: event.pins }),
      gNode("assert-angle", "debug.assertEqual", 260, 500, { "default:expected": -DOOR.openYaw, "default:message": "On Door Open (Door Loop) carried the wrong Angle" }),
      gNode("assert-clip", "debug.assertIsValid", 520, 500, { "default:message": "On Door Open (Door Loop) came without its Timeline Clip" }),
      printString("heard", 780, 500, "FT_TimelineListener heard On Door Open (Door Loop)"),
    ],
    edges: [
      ...gChain("begin", "bind", "assert-loaded", "ready"),
      gWire("get-story", "value", "timeline", "timelineAsset"),
      gWire("timeline", "timeline", "bind", "target"),
      gWire("timeline", "timeline", "loaded", "target"),
      gWire("loaded", "clips", "loaded-count", "array"),
      gWire("loaded-count", "out", "assert-loaded", "actual"),
      gWire(event.id, "OutputDelegate", "bind", "event"),
      ...gChain(event.id, "assert-angle", "assert-clip", "heard"),
      gWire(event.id, ANGLE_INPUT, "assert-angle", "actual"),
      gWire(event.id, TIMELINE_REFIRED_CLIP_INPUT, "assert-clip", "object"),
    ],
  });
  const ref = await ctx.saveClass({ folder: FOLDER, name: FEATURE_TEST_TIMELINE_LISTENER, parentClass: "Actor", graph });
  ctx.addActor(actor("ft-world-timeline-listener", "Timeline Listener", tf(position), [], { classId: ref.classId }), { scene });
}
