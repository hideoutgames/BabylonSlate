import { createTimelineClip, type SerializedActor, type SerializedGraph, type SerializedTimelineClip } from "@haptic/core";
import { engineScriptApiFor } from "@haptic/object-model";
import {
  OWNED_ACTOR_GET_NODE_ID,
  OWNED_COMPONENT_GET_NODE_ID,
  OWNED_TIMELINE_CLIP_GET_NODE_ID,
  ownedGetNodeProperties,
} from "@haptic/scripting-nodes";
import type { FeatureTestContext } from "./context";
import { classGraph, gChain, gNode, gWire, printString } from "./graph";

/** Call node for a Timeline Clip function on the wired `get-clip` reference. */
function timelineClipCall(id: string, x: number, name: string) {
  const fn = engineScriptApiFor("TimelineClip")?.functions?.find((entry) => entry.name === name);
  if (!fn) throw new Error(`TimelineClip has no "${name}" function.`);
  return gNode(id, "functions.call", x, 0, {
    functionName: fn.name,
    classId: "TimelineClip",
    implicitSelf: false,
    pins: fn.pins.map((pin) => ({ ...pin })),
    runtime: fn.runtime,
  });
}

/**
 * A SceneScript / SceneLayerScript that, on Begin Play, gets one of its
 * owner's actors and that actor's first component through Get <Actor> and
 * Get <Component> (<Actor>), asserts both resolve, and prints a line. With a
 * `clip`, it also gets that Timeline Clip, plays it and asserts it is playing.
 */
export function ownedActorProbeScript(owner: string, actor: SerializedActor, clip?: SerializedTimelineClip): SerializedGraph {
  const component = actor.components[0];
  if (!component) throw new Error(`${owner} probe actor ${actor.name} has no component.`);
  const target = { actorId: actor.id, actorName: actor.name, actorClassId: actor.classId ?? "Actor" };
  const clipNodes = clip
    ? [
        gNode("get-clip", OWNED_TIMELINE_CLIP_GET_NODE_ID, 780, 180, { sceneTimelineClipId: clip.id, sceneTimelineClipName: clip.name }),
        gNode("assert-clip", "debug.assertIsValid", 780, 0, { "default:message": `${owner} script could not get its ${clip.name} Timeline Clip` }),
        timelineClipCall("play-clip", 1040, "Play"),
        timelineClipCall("clip-playing", 1300, "Is Playing"),
        gNode("assert-playing", "debug.assert", 1560, 0, { "default:message": `${owner} script's ${clip.name} Timeline Clip did not play` }),
      ]
    : [];
  const clipEdges = clip
    ? [
        gWire("assert-component", "execOut", "assert-clip", "execIn"),
        gWire("assert-clip", "execOut", "play-clip", "exec"),
        gWire("play-clip", "then", "clip-playing", "execIn"),
        gWire("clip-playing", "execOut", "assert-playing", "execIn"),
        gWire("assert-playing", "execOut", "report", "execIn"),
        gWire("get-clip", "clip", "assert-clip", "object"),
        gWire("get-clip", "clip", "play-clip", "target"),
        gWire("get-clip", "clip", "clip-playing", "target"),
        gWire("clip-playing", "playing", "assert-playing", "condition"),
      ]
    : gChain("assert-component", "report");
  return classGraph({
    nodes: [
      gNode("begin", "flow.event.beginPlay", 0, 0),
      gNode("get-actor", OWNED_ACTOR_GET_NODE_ID, 0, 180, ownedGetNodeProperties(target)),
      gNode("get-component", OWNED_COMPONENT_GET_NODE_ID, 0, 300, ownedGetNodeProperties({
        ...target, componentId: component.id, componentName: component.name ?? component.classId, componentClassId: component.classId,
      })),
      gNode("assert-actor", "debug.assertIsValid", 260, 0, { "default:message": `${owner} script could not get ${actor.name}` }),
      gNode("assert-component", "debug.assertIsValid", 520, 0, { "default:message": `${owner} script could not get a component of ${actor.name}` }),
      ...clipNodes,
      printString("report", clip ? 1820 : 780, 0, `${owner} script found ${actor.name}`),
    ],
    edges: [
      ...gChain("begin", "assert-actor", "assert-component"),
      ...clipEdges,
      gWire("get-actor", "actor", "assert-actor", "object"),
      gWire("get-component", "component", "assert-component", "object"),
    ],
  });
}

/** The main scene's SceneScript probes the hub Mannequin and plays the Intro Timeline Clip. */
export function placeFeatureTestSceneScript(ctx: FeatureTestContext): void {
  const mannequin = ctx.mainScene.actors.find((actor) => actor.id === ctx.assets.mannequin.actorId);
  if (!mannequin) throw new Error("FeatureTest main scene has no Mannequin for its Scene Script.");
  // A Timeline Clip on the main scene; Timeline mode lists it in Clips.
  const intro: SerializedTimelineClip = { ...createTimelineClip("ft-timeline-clip-intro", "Intro"), length: 4 };
  ctx.mainScene.timelineClips = [intro];
  ctx.mainScene.script = ownedActorProbeScript("Feature Test scene", mannequin, intro);
}
