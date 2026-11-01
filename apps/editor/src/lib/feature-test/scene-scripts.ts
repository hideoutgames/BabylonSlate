import {
  createTimelineClip,
  type GraphClassMember,
  type SerializedActor,
  type SerializedGraph,
  type SerializedTimelineClip,
  type TimelineEventTrack,
} from "@haptic/core";
import {
  TIMELINE_REFIRED_CLIP_INPUT,
  timelineClassId,
  timelineClipClassId,
  timelineRefiredDispatcherName,
} from "@haptic/object-model";
import {
  OWNED_ACTOR_GET_NODE_ID,
  OWNED_COMPONENT_GET_NODE_ID,
  OWNED_TIMELINE_CLIP_GET_NODE_ID,
  TIMELINE_FROM_ASSET_NODE_ID,
  TIMELINE_GET_CLIP_NODE_ID,
  ownedGetNodeProperties,
} from "@haptic/scripting-nodes";
import { requireRef, type FeatureTestContext } from "./context";
import { classGraph, gChain, gNode, gWire, printString } from "./graph";

/**
 * A Timeline Clip the probe plays. With its document's guid the getter is
 * typed to the clip's class, so its Custom Event Tracks can be bound too.
 */
export type ProbedTimelineClip = { clip: SerializedTimelineClip; documentGuid?: string };

/** The one-input Custom Event Track the main scene's Intro clip fires, and the line it carries. */
const INTRO_LINE: TimelineEventTrack = {
  id: "ft-timeline-event-intro-line",
  name: "On Intro Line",
  inputs: [{ name: "Line", typeId: "string", direction: "in" }],
  keys: [{ id: "ft-timeline-event-intro-line-key", time: 0.5, values: { Line: "Feature Test Timeline" } }],
};

/**
 * Before Play: Bind Event to each of the clip's Custom Event Tracks (a custom
 * event that asserts the first key's first value and prints it) and to On
 * Finished (a custom event that prints).
 */
function clipEventBindings(owner: string, probed: ProbedTimelineClip) {
  const classId = probed.documentGuid ? timelineClipClassId(probed.documentGuid, probed.clip.id) : undefined;
  const members: GraphClassMember[] = [];
  const nodes = [];
  const edges = [];
  const binds: string[] = [];
  (classId ? probed.clip.eventTracks : []).forEach((track, index) => {
    const input = track.inputs[0];
    const expected = input ? track.keys[0]?.values[input.name] : undefined;
    const event: GraphClassMember = {
      id: `ft-scene-script-evt-${track.id}`, kind: "event", name: `Handle ${track.name}`,
      pins: track.inputs.map((pin) => ({ ...pin, direction: "out" as const })),
    };
    members.push(event);
    const bind = `bind-${index}`;
    binds.push(bind);
    nodes.push(
      gNode(bind, "flow.dispatcher.bind", 1040 + index * 260, 0, {
        title: `Bind Event to ${track.name}`, name: track.name, classId, implicitSelf: false, pins: track.inputs.map((pin) => ({ ...pin })),
      }),
      gNode(event.id, "flow.event.custom", 0, 600 + index * 300, { title: `Event ${event.name}`, name: event.name, pins: event.pins }),
      ...(input ? [gNode(`${event.id}-check`, "debug.assertEqual", 260, 600 + index * 300, {
        "default:expected": expected, "default:message": `${owner} script's ${track.name} carried the wrong ${input.name}`,
      })] : []),
      printString(`${event.id}-print`, 520, 600 + index * 300, `${owner} script heard ${track.name}`),
    );
    edges.push(
      gWire(event.id, "OutputDelegate", bind, "event"),
      gWire("get-clip", "clip", bind, "target"),
      ...(input
        ? [gWire(event.id, "execOut", `${event.id}-check`, "execIn"), gWire(event.id, input.name, `${event.id}-check`, "actual"),
            gWire(`${event.id}-check`, "execOut", `${event.id}-print`, "execIn")]
        : [gWire(event.id, "execOut", `${event.id}-print`, "execIn")]),
    );
  });
  const finished: GraphClassMember = { id: "ft-scene-script-evt-clip-finished", kind: "event", name: `${probed.clip.name} Finished`, pins: [] };
  members.push(finished);
  binds.push("bind-finished");
  nodes.push(
    gNode("bind-finished", "flow.dispatcher.bind", 1040 + probed.clip.eventTracks.length * 260, 0, {
      title: "Bind Event to On Finished", name: "On Finished", classId: "TimelineClip", implicitSelf: false, pins: [],
    }),
    gNode(finished.id, "flow.event.custom", 0, 300, { title: `Event ${finished.name}`, name: finished.name, pins: [] }),
    printString("finished-print", 260, 300, `${owner} script's ${probed.clip.name} Timeline Clip finished`),
  );
  edges.push(
    gWire(finished.id, "OutputDelegate", "bind-finished", "event"),
    gWire("get-clip", "clip", "bind-finished", "target"),
    gWire(finished.id, "execOut", "finished-print", "execIn"),
  );
  return { members, nodes, edges, binds, classId };
}

/**
 * A SceneScript / SceneLayerScript that, on Begin Play, gets one of its
 * owner's actors and that actor's first component through Get <Actor> and
 * Get <Component> (<Actor>), asserts both resolve, and prints a line. With a
 * clip, it also binds the clip's events, plays it and asserts it is playing.
 */
export function ownedActorProbeScript(owner: string, actor: SerializedActor, probed?: ProbedTimelineClip): SerializedGraph {
  const component = actor.components[0];
  if (!component) throw new Error(`${owner} probe actor ${actor.name} has no component.`);
  const target = { actorId: actor.id, actorName: actor.name, actorClassId: actor.classId ?? "Actor" };
  const clip = probed?.clip;
  const events = probed ? clipEventBindings(owner, probed) : undefined;
  const after = 1040 + (events?.binds.length ?? 0) * 260;
  const clipNodes = clip && events
    ? [
        gNode("get-clip", OWNED_TIMELINE_CLIP_GET_NODE_ID, 780, 180, {
          sceneTimelineClipId: clip.id, sceneTimelineClipName: clip.name, ...(events.classId ? { sceneTimelineClipClassId: events.classId } : {}),
        }),
        gNode("assert-clip", "debug.assertIsValid", 780, 0, { "default:message": `${owner} script could not get its ${clip.name} Timeline Clip` }),
        ...events.nodes,
        gNode("play-clip", "timelineClip.play", after, 0),
        gNode("clip-playing", "timelineClip.isPlaying", after + 260, 180),
        gNode("assert-playing", "debug.assert", after + 260, 0, { "default:message": `${owner} script's ${clip.name} Timeline Clip did not play` }),
      ]
    : [];
  const clipEdges = clip && events
    ? [
        ...gChain("assert-component", "assert-clip", ...events.binds, "play-clip", "assert-playing", "report"),
        ...events.edges,
        gWire("get-clip", "clip", "assert-clip", "object"),
        gWire("get-clip", "clip", "play-clip", "target"),
        gWire("get-clip", "clip", "clip-playing", "target"),
        gWire("clip-playing", "playing", "assert-playing", "condition"),
      ]
    : gChain("assert-component", "report");
  return classGraph({
    members: events?.members ?? [],
    nodes: [
      gNode("begin", "flow.event.beginPlay", 0, 0),
      gNode("get-actor", OWNED_ACTOR_GET_NODE_ID, 0, 180, ownedGetNodeProperties(target)),
      gNode("get-component", OWNED_COMPONENT_GET_NODE_ID, 0, 300, ownedGetNodeProperties({
        ...target, componentId: component.id, componentName: component.name ?? component.classId, componentClassId: component.classId,
      })),
      gNode("assert-actor", "debug.assertIsValid", 260, 0, { "default:message": `${owner} script could not get ${actor.name}` }),
      gNode("assert-component", "debug.assertIsValid", 520, 0, { "default:message": `${owner} script could not get a component of ${actor.name}` }),
      ...clipNodes,
      printString("report", clip ? after + 520 : 780, 0, `${owner} script found ${actor.name}`),
    ],
    edges: [
      ...gChain("begin", "assert-actor", "assert-component"),
      ...clipEdges,
      gWire("get-actor", "actor", "assert-actor", "object"),
      gWire("get-component", "component", "assert-component", "object"),
    ],
  });
}

/**
 * The main scene's SceneScript probes the hub Mannequin, binds the Intro
 * Timeline Clip's On Intro Line and On Finished, and plays it.
 */
export async function placeFeatureTestSceneScript(ctx: FeatureTestContext): Promise<void> {
  const mannequin = ctx.mainScene.actors.find((actor) => actor.id === ctx.assets.mannequin.actorId);
  if (!mannequin) throw new Error("FeatureTest main scene has no Mannequin for its Scene Script.");
  // A Timeline Clip on the main scene; Timeline mode lists it in Clips.
  const intro: SerializedTimelineClip = { ...createTimelineClip("ft-timeline-clip-intro", "Intro"), length: 4, eventTracks: [INTRO_LINE] };
  ctx.mainScene.timelineClips = [intro];
  const documentGuid = await ctx.host.guidForAsset(ctx.mainScenePath);
  const timelineGuid = await bindFeatureTestTimelineAsset(ctx, intro);
  ctx.mainScene.script = withTimelineAssetProbe(
    ownedActorProbeScript("Feature Test scene", mannequin, { clip: intro, documentGuid }),
    timelineGuid, intro, documentGuid,
  );
}

/**
 * After the probe's report: Get Timeline Object Reference From Timeline Asset
 * (FT_Timeline), Get Intro Timeline Clip on it (asserted valid), and Bind
 * Event to On Intro Line (Intro), the Timeline's re-fired event, whose
 * listener asserts the line and the clip that fired it.
 */
function withTimelineAssetProbe(graph: SerializedGraph, timelineGuid: string, intro: SerializedTimelineClip, documentGuid: string): SerializedGraph {
  const clipClassId = timelineClipClassId(documentGuid, intro.id);
  const name = timelineRefiredDispatcherName(INTRO_LINE.name, intro.name);
  const pins = [
    ...INTRO_LINE.inputs.map((pin) => ({ ...pin })),
    { name: TIMELINE_REFIRED_CLIP_INPUT, typeId: "object", typeClassId: clipClassId, direction: "in" as const },
  ];
  const event: GraphClassMember = {
    id: "ft-scene-script-evt-timeline-intro-line", kind: "event", name: `Handle ${name}`,
    pins: pins.map((pin) => ({ ...pin, direction: "out" as const })),
  };
  const y = 1200;
  return {
    ...graph,
    members: [...(graph.members ?? []), event],
    nodes: [
      ...graph.nodes,
      gNode("timeline", TIMELINE_FROM_ASSET_NODE_ID, 0, y + 180, { "default:timelineAsset": timelineGuid }),
      gNode("timeline-clip", TIMELINE_GET_CLIP_NODE_ID, 260, y + 180, {
        title: `Get ${intro.name} Timeline Clip`, timelineAssetGuid: timelineGuid, timelineClipDocument: documentGuid,
        timelineClipId: intro.id, timelineClipName: intro.name, timelineClipClassId: clipClassId,
      }),
      gNode("timeline-assert-clip", "debug.assertIsValid", 520, y, { "default:message": "Feature Test scene script could not get Intro through FT_Timeline" }),
      gNode("timeline-bind", "flow.dispatcher.bind", 780, y, {
        title: `Bind Event to ${name}`, name, classId: timelineClassId(timelineGuid), implicitSelf: false, pins,
      }),
      gNode(event.id, "flow.event.custom", 0, y + 400, { title: `Event ${event.name}`, name: event.name, pins: event.pins }),
      gNode("timeline-assert-line", "debug.assertEqual", 260, y + 400, {
        "default:expected": INTRO_LINE.keys[0]?.values.Line, "default:message": `FT_Timeline's ${name} carried the wrong Line`,
      }),
      gNode("timeline-assert-source", "debug.assertIsValid", 520, y + 400, { "default:message": `FT_Timeline's ${name} came without its Timeline Clip` }),
      printString("timeline-print", 780, y + 400, `Feature Test scene script heard ${name} through FT_Timeline`),
    ],
    edges: [
      ...graph.edges,
      ...gChain("report", "timeline-assert-clip", "timeline-bind"),
      gWire("timeline", "timeline", "timeline-clip", "target"),
      gWire("timeline", "timeline", "timeline-bind", "target"),
      gWire("timeline-clip", "clip", "timeline-assert-clip", "object"),
      gWire(event.id, "OutputDelegate", "timeline-bind", "event"),
      ...gChain(event.id, "timeline-assert-line", "timeline-assert-source", "timeline-print"),
      gWire(event.id, "Line", "timeline-assert-line", "actual"),
      gWire(event.id, TIMELINE_REFIRED_CLIP_INPUT, "timeline-assert-source", "object"),
    ],
  };
}

/**
 * Binds the main scene's Intro and FT_HUD's Reveal to `FT_Timeline` (one clip
 * from a Scene, one from a Scene Layer; FT_World binds Door Loop too).
 */
async function bindFeatureTestTimelineAsset(ctx: FeatureTestContext, intro: SerializedTimelineClip): Promise<string> {
  const guid = requireRef(ctx.assets.timeline, "FT_Timeline");
  intro.timelineAsset = guid;
  const reveal = ctx.sceneDocuments
    .flatMap((doc) => (doc.content as { timelineClips?: SerializedTimelineClip[] }).timelineClips ?? [])
    .find((clip) => clip.id === "ft-timeline-clip-hud-reveal");
  if (!reveal) throw new Error("FT_HUD has no Reveal Timeline Clip to bind to FT_Timeline.");
  reveal.timelineAsset = guid;
  return guid;
}
