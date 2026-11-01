import {
  TIMELINE_CLIP_ASSET_CLIP_ID,
  createDefaultTimelineClipAsset,
  createTimelineClip,
  defaultTimelineProxyPreview,
  timelineClipAssetSummaries,
  type SerializedTimelineClipAsset,
  type TimelineClipAssetType,
  type GraphClassMember,
  type GraphClassMemberPin,
  type SerializedActor,
  type SerializedComponent,
  type SerializedGraph,
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
import {
  TIMELINE_CREATE_CLIP_NODE_ID,
  TIMELINE_FROM_ASSET_NODE_ID,
  TIMELINE_LOADED_CLIPS_NODE_ID,
  TIMELINE_PROXY_BIND_COMPONENT_NODE_ID,
  TIMELINE_PROXY_GET_NODE_ID,
  timelineCreateClipNodeTitle,
  timelineProxyNodeTitle,
  timelineProxyPinId,
} from "@haptic/scripting-nodes";
import { actor, comp, instanceComponents, meshComp, requireRef, tf, type FeatureTestContext, type Vec3 } from "./context";
import { classGraph, gChain, gNode, gWire, getVar, printString, setVar, varMember } from "./graph";

/**
 * Timeline showcase. `FT_Timeline` (created before any scene binds a clip to
 * it) holds the main scene's Intro, FT_HUD's Reveal and FT_World's Door Loop.
 * FT_World's Timeline Pavilion: a door and a lamp that Door Loop animates on
 * an Auto Play loop, `FT_TimelineListener`, which reaches the clip through
 * a Timeline Asset variable and binds its re-fired On Door Open, and two
 * `FT_SwingDoor`s, each playing its own instance of the FT_DoorSwing clip asset.
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
export const FEATURE_TEST_SWING_DOOR = "FT_SwingDoor";
const DOOR_SWING = "FT_DoorSwing";
const SWING_OPEN_EVENT = "On Swing Open";
const HUD_PULSE = "FT_HudPulse";
const HUD_PULSE_PROXIES = [{ id: "ft-hud-pulse-badge", name: "Badge", represents: "component" as const, classId: "2DTextComponent" }];
const DOOR_SWING_PROXIES = [
  { id: "ft-door-swing-door", name: "Door", represents: "actor" as const, classId: "Actor" },
  { id: "ft-door-swing-glow", name: "Handle Glow", represents: "component" as const, classId: "LightComponent" },
];

/**
 * `FT_Timeline`, which scenes bind their clips to, and the clip assets it
 * holds: `FT_DoorSwing` (3D, looping: a Door actor proxy and a Handle Glow
 * light proxy; FT_SwingDoor plays it) and `FT_HudPulse` (2D, ping-pong: a
 * Badge text proxy whose Opacity dips; each FT_HUD instance plays one on its title).
 */
export async function buildFeatureTestTimeline(ctx: FeatureTestContext): Promise<void> {
  const { guid } = await ctx.createAsset("Timeline", FOLDER, FEATURE_TEST_TIMELINE_ASSET, {
    payload: () => ({ description: "The Feature Test's Timeline Clips: Intro (main scene), Reveal (FT_HUD), Door Loop (FT_World), and the FT_DoorSwing and FT_HudPulse clip assets." }),
  });
  ctx.assets.timeline = guid;
  const [door, glow] = DOOR_SWING_PROXIES;
  ctx.assets.doorSwing = await createClipAsset(ctx, "TimelineClip3D", DOOR_SWING, {
    ...createDefaultTimelineClipAsset(guid),
    length: 2,
    loopMode: "loop",
    proxies: [
      { ...door!, tracks: [{
        id: "ft-door-swing-rotation", target: { kind: "transform", property: "rotation" }, valueType: "rotator",
        keys: [key("swing-0", 0, { pitch: 0, yaw: 0, roll: 0 }), key("swing-1", 1, { pitch: 0, yaw: DOOR.openYaw, roll: 0 }), key("swing-2", 2, { pitch: 0, yaw: 0, roll: 0 })],
      }] },
      { ...glow!, tracks: [{
        id: "ft-door-swing-intensity", target: { kind: "component", componentId: "ft-door-swing-glow", property: "intensity" }, valueType: "float",
        keys: [key("glow-0", 0, LAMP.intensity), key("glow-1", 1, LAMP.bright), key("glow-2", 2, LAMP.intensity)],
      }] },
    ],
    eventTracks: [{ id: "ft-door-swing-event", name: SWING_OPEN_EVENT, inputs: [], keys: [{ id: "ft-door-swing-event-key", time: 1, values: {} }] }],
    editorPreview: { proxies: {
      "ft-door-swing-door": { ...defaultTimelineProxyPreview(0), size: 2 },
      "ft-door-swing-glow": { ...defaultTimelineProxyPreview(1), location: [1, 1.2, 0], size: 0.3 },
    } },
  });
  const [badge] = HUD_PULSE_PROXIES;
  ctx.assets.hudPulse = await createClipAsset(ctx, "TimelineClip2D", HUD_PULSE, {
    ...createDefaultTimelineClipAsset(guid),
    length: 1,
    loopMode: "pingPong",
    proxies: [{ ...badge!, tracks: [{
      id: "ft-hud-pulse-opacity", target: { kind: "component", componentId: badge!.id, property: "opacity" }, valueType: "float",
      keys: [key("pulse-0", 0, 1), key("pulse-1", 1, 0.6)],
    }] }],
    editorPreview: { proxies: { [badge!.id]: { ...defaultTimelineProxyPreview(0), size: 120 } } },
  });
}

/** Writes a clip asset whose header already lists its clip, as New Asset does; its guid. */
async function createClipAsset(ctx: FeatureTestContext, type: TimelineClipAssetType, name: string, clip: SerializedTimelineClipAsset): Promise<string> {
  const { guid } = await ctx.createAsset(type, FOLDER, name, {
    build: { timelineAsset: clip.timelineAsset },
    payload: () => ({ ...clip, ...timelineClipAssetSummaries(clip, "") }),
  });
  return guid;
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

/**
 * `FT_SwingDoor`: a door panel hinged at the actor with a light at its
 * handle. Begin Play: Create FT_DoorSwing Timeline Clip on FT_Timeline's
 * Timeline with Door bound to Self, keep the instance in `Swing`, Bind Handle
 * Glow Proxy to its light (both Relative, so each door swings from where it
 * stands), Bind Event to its On Swing Open, play it and assert Get Door Proxy
 * is valid. Two are placed, turned differently, beside the pavilion.
 */
export async function placeTimelineSwingDoors(ctx: FeatureTestContext, scene: SerializedScene, positions: ReadonlyArray<{ position: Vec3; yaw: number }>): Promise<void> {
  const timelineGuid = requireRef(ctx.assets.timeline, "FT_Timeline");
  const swingGuid = requireRef(ctx.assets.doorSwing, DOOR_SWING);
  const create = createClipNodeData(timelineGuid, swingGuid, DOOR_SWING, DOOR_SWING_PROXIES);
  const clipClassId = create.timelineClipClassId;
  const swing = varMember("ft-swing-door-swing", "Swing", "object", undefined, { typeClassId: clipClassId });
  const opened: GraphClassMember = { id: "ft-swing-door-opened", kind: "event", name: "Swing Opened", pins: [] };
  const half = DOOR.width / 2;
  const graph = classGraph({
    members: [swing, opened],
    components: [
      box("ft-swing-door-panel", [half, DOOR.height / 2, 0], [DOOR.width, DOOR.height, DOOR.depth]),
      comp("ft-swing-door-glow", "LightComponent", {
        enabled: true, lightKind: "point", color: [WARM.x, WARM.y, WARM.z], intensity: LAMP.intensity, range: 4, castShadows: false, shadowPriority: 0,
      }, tf([DOOR.width - 0.15, DOOR.height / 2, 0.2])),
    ],
    nodes: [
      gNode("begin", "flow.event.beginPlay", 0, 0),
      gNode("timeline", TIMELINE_FROM_ASSET_NODE_ID, 0, 200, { "default:timelineAsset": timelineGuid }),
      gNode("self", "actor.getSelf", 0, 320),
      gNode("glow", "component.getNamed", 0, 420, { componentClassId: "LightComponent", implicitSelf: true }),
      gNode("create", TIMELINE_CREATE_CLIP_NODE_ID, 280, 0, create),
      setVar("keep", swing, 560, 0),
      gNode("bind", "flow.dispatcher.bind", 820, 0, {
        title: `Bind Event to ${SWING_OPEN_EVENT}`, name: SWING_OPEN_EVENT, classId: clipClassId, implicitSelf: false, pins: [],
      }),
      gNode("bind-glow", TIMELINE_PROXY_BIND_COMPONENT_NODE_ID, 700, 200, proxyNodeData(TIMELINE_PROXY_BIND_COMPONENT_NODE_ID, create, DOOR_SWING_PROXIES[1]!)),
      gNode("play", "timelineClip.play", 1080, 0),
      gNode("get-door", TIMELINE_PROXY_GET_NODE_ID, 1080, 200, proxyNodeData(TIMELINE_PROXY_GET_NODE_ID, create, DOOR_SWING_PROXIES[0]!)),
      gNode("assert-door", "debug.assertIsValid", 1320, 0, { "default:message": `${FEATURE_TEST_SWING_DOOR} found nothing bound to its Door proxy` }),
      printString("ready", 1560, 0, `${FEATURE_TEST_SWING_DOOR} plays its own ${DOOR_SWING}`),
      gNode(opened.id, "flow.event.custom", 0, 600, { title: `Event ${opened.name}`, name: opened.name, pins: [] }),
      printString("heard", 280, 600, `${FEATURE_TEST_SWING_DOOR} heard ${SWING_OPEN_EVENT} (${DOOR_SWING})`),
    ],
    edges: [
      ...gChain("begin", "create", "keep", "bind-glow", "bind", "play", "assert-door", "ready"),
      gWire("timeline", "timeline", "create", "target"),
      gWire("self", "out", "create", timelineProxyPinId(DOOR_SWING_PROXIES[0]!.id)),
      gWire("glow", "out", "bind-glow", "component"),
      gWire("create", "clip", "bind-glow", "target"),
      gWire("create", "clip", "get-door", "target"),
      gWire("get-door", "object", "assert-door", "object"),
      gWire("create", "clip", "keep", "value"),
      gWire("create", "clip", "bind", "target"),
      gWire("create", "clip", "play", "target"),
      gWire(opened.id, "OutputDelegate", "bind", "event"),
      ...gChain(opened.id, "heard"),
    ],
  });
  const ref = await ctx.saveClass({ folder: FOLDER, name: FEATURE_TEST_SWING_DOOR, parentClass: "Actor", graph });
  positions.forEach(({ position, yaw }, index) => {
    const id = `ft-world-swing-door-${index + 1}`;
    ctx.addActor(actor(id, `Swing Door ${index + 1}`, tf(position, { rotationDeg: [0, yaw, 0] }),
      instanceComponents(id, graph.components ?? []), { classId: ref.classId }), { scene });
  });
}

/** A Bind, Unbind or Get Timeline Proxy node's properties for `proxy` of a Create node's clip asset. */
function proxyNodeData(nodeType: string, create: ReturnType<typeof createClipNodeData>, proxy: (typeof DOOR_SWING_PROXIES)[number]) {
  const data = {
    timelineClipDocument: create.timelineClipDocument,
    timelineClipName: create.timelineClipName,
    timelineClipClassId: create.timelineClipClassId,
    timelineProxyId: proxy.id,
    timelineProxyName: proxy.name,
    timelineProxyClassId: proxy.classId,
    timelineProxyRepresents: proxy.represents,
  };
  return { ...data, title: timelineProxyNodeTitle(nodeType, data) };
}

/** Create <Name> Timeline Clip's node properties for one of FT_Timeline's clip assets. */
function createClipNodeData(timelineGuid: string, assetGuid: string, name: string, proxies: ReadonlyArray<Record<string, unknown>>) {
  const data = {
    timelineAssetGuid: timelineGuid,
    timelineClipDocument: assetGuid,
    timelineClipId: TIMELINE_CLIP_ASSET_CLIP_ID,
    timelineClipName: name,
    timelineClipClassId: timelineClipClassId(assetGuid, TIMELINE_CLIP_ASSET_CLIP_ID),
    timelineClipProxies: proxies.map((proxy) => ({ ...proxy })),
  };
  return { ...data, title: timelineCreateClipNodeTitle(data) };
}

/**
 * FT_HUD's script, after its probe's report: Create FT_HudPulse Timeline
 * Clip with Badge bound to the probed title text (`componentNode`'s
 * `component`), kept in `Pulse`, and played; every FT_HUD instance pulses
 * its own title.
 */
export function withFeatureTestHudPulse(graph: SerializedGraph, refs: { timeline: string; hudPulse: string }, after: string, componentNode: string): SerializedGraph {
  const data = createClipNodeData(refs.timeline, refs.hudPulse, HUD_PULSE, HUD_PULSE_PROXIES);
  const pulse = varMember("ft-hud-pulse-instance", "Pulse", "object", undefined, { typeClassId: data.timelineClipClassId });
  const y = 2000;
  return {
    ...graph,
    members: [...(graph.members ?? []), pulse],
    nodes: [
      ...graph.nodes,
      gNode("pulse-timeline", TIMELINE_FROM_ASSET_NODE_ID, 0, y + 180, { "default:timelineAsset": refs.timeline }),
      gNode("pulse-create", TIMELINE_CREATE_CLIP_NODE_ID, 260, y, data),
      setVar("pulse-keep", pulse, 520, y),
      gNode("pulse-play", "timelineClip.play", 780, y),
      printString("pulse-report", 1040, y, `FT_HUD script plays its own ${HUD_PULSE}`),
    ],
    edges: [
      ...graph.edges,
      ...gChain(after, "pulse-create", "pulse-keep", "pulse-play", "pulse-report"),
      gWire("pulse-timeline", "timeline", "pulse-create", "target"),
      gWire(componentNode, "component", "pulse-create", timelineProxyPinId(HUD_PULSE_PROXIES[0]!.id)),
      gWire("pulse-create", "clip", "pulse-keep", "value"),
      gWire("pulse-create", "clip", "pulse-play", "target"),
    ],
  };
}
