import { createTimelineClip, type SerializedActor, type SerializedGraph } from "@haptic/core";
import { OWNED_ACTOR_GET_NODE_ID, OWNED_COMPONENT_GET_NODE_ID, ownedGetNodeProperties } from "@haptic/scripting-nodes";
import type { FeatureTestContext } from "./context";
import { classGraph, gChain, gNode, gWire, printString } from "./graph";

/**
 * A SceneScript / SceneLayerScript that, on Begin Play, gets one of its
 * owner's actors and that actor's first component through Get <Actor> and
 * Get <Component> (<Actor>), asserts both resolve, and prints a line.
 */
export function ownedActorProbeScript(owner: string, actor: SerializedActor): SerializedGraph {
  const component = actor.components[0];
  if (!component) throw new Error(`${owner} probe actor ${actor.name} has no component.`);
  const target = { actorId: actor.id, actorName: actor.name, actorClassId: actor.classId ?? "Actor" };
  return classGraph({
    nodes: [
      gNode("begin", "flow.event.beginPlay", 0, 0),
      gNode("get-actor", OWNED_ACTOR_GET_NODE_ID, 0, 180, ownedGetNodeProperties(target)),
      gNode("get-component", OWNED_COMPONENT_GET_NODE_ID, 0, 300, ownedGetNodeProperties({
        ...target, componentId: component.id, componentName: component.name ?? component.classId, componentClassId: component.classId,
      })),
      gNode("assert-actor", "debug.assertIsValid", 260, 0, { "default:message": `${owner} script could not get ${actor.name}` }),
      gNode("assert-component", "debug.assertIsValid", 520, 0, { "default:message": `${owner} script could not get a component of ${actor.name}` }),
      printString("report", 780, 0, `${owner} script found ${actor.name}`),
    ],
    edges: [
      ...gChain("begin", "assert-actor", "assert-component", "report"),
      gWire("get-actor", "actor", "assert-actor", "object"),
      gWire("get-component", "component", "assert-component", "object"),
    ],
  });
}

/** The main scene's SceneScript probes the hub Mannequin. */
export function placeFeatureTestSceneScript(ctx: FeatureTestContext): void {
  const mannequin = ctx.mainScene.actors.find((actor) => actor.id === ctx.assets.mannequin.actorId);
  if (!mannequin) throw new Error("FeatureTest main scene has no Mannequin for its Scene Script.");
  ctx.mainScene.script = ownedActorProbeScript("Feature Test scene", mannequin);
  // A Timeline Clip on the main scene; Timeline mode lists it in Clips.
  ctx.mainScene.timelineClips = [{ ...createTimelineClip("ft-timeline-clip-intro", "Intro"), length: 4 }];
}
