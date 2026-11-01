import { pin, type NodeDefinition, objectRef } from "@haptic/scripting";

/**
 * Get <Actor> and Get <Component> (<Actor>) for a SceneScript or
 * SceneLayerScript: direct references to what that Scene or Scene Layer
 * instance placed. Hidden from Add Node like Get <Subsystem>; the editor
 * injects one row per actor and per actor component of the owning document.
 */
export const OWNED_ACTOR_GET_NODE_ID = "scene.getOwnedActor";
export const OWNED_COMPONENT_GET_NODE_ID = "scene.getOwnedComponent";
/** Get <Name> Timeline Clip: one of the owning Scene's or Scene Layer's Timeline Clips, for this copy. */
export const OWNED_TIMELINE_CLIP_GET_NODE_ID = "scene.getOwnedTimelineClip";

/** What a Get <Name> Timeline Clip node names: the clip id (stable across renames) and its name for the title. */
export function ownedTimelineClipProperties(properties: Record<string, unknown>): { clipId: string; clipName: string } {
  return { clipId: text(properties.sceneTimelineClipId), clipName: text(properties.sceneTimelineClipName) };
}

/** `Get Intro Timeline Clip`, or `Get Timeline Clip` before it names one. */
export function ownedTimelineClipGetTitle(properties: Record<string, unknown>): string {
  const { clipName } = ownedTimelineClipProperties(properties);
  return clipName ? `Get ${clipName} Timeline Clip` : "Get Timeline Clip";
}

/**
 * What a Get <Actor> / Get <Component> (<Actor>) node names. Stored as
 * `sceneActorId`, `sceneActorName`, ... node properties: a plain
 * `componentId` would mark the node as bound to a component of its own Class.
 */
export type OwnedGetProperties = {
  actorId: string;
  actorName: string;
  actorClassId: string;
  componentId?: string;
  componentName?: string;
  componentClassId?: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function ownedGetProperties(properties: Record<string, unknown>): OwnedGetProperties {
  return {
    actorId: text(properties.sceneActorId),
    actorName: text(properties.sceneActorName),
    actorClassId: text(properties.sceneActorClassId),
    componentId: text(properties.sceneComponentId),
    componentName: text(properties.sceneComponentName),
    componentClassId: text(properties.sceneComponentClassId),
  };
}

/** Node properties naming an owned actor and, for Get <Component> (<Actor>), one of its components. */
export function ownedGetNodeProperties(target: OwnedGetProperties): Record<string, string> {
  return {
    sceneActorId: target.actorId,
    sceneActorName: target.actorName,
    sceneActorClassId: target.actorClassId,
    ...(target.componentId ? {
      sceneComponentId: target.componentId,
      sceneComponentName: target.componentName ?? "",
      sceneComponentClassId: target.componentClassId ?? "",
    } : {}),
  };
}

/** `Get Hero`, or `Get Actor` before it names one. */
export function ownedActorGetTitle(properties: Record<string, unknown>): string {
  return `Get ${ownedGetProperties(properties).actorName || "Actor"}`;
}

/** `Get Mesh (Hero)`, or `Get Component` before it names one. */
export function ownedComponentGetTitle(properties: Record<string, unknown>): string {
  const { actorName, componentName } = ownedGetProperties(properties);
  if (!componentName) return "Get Component";
  return actorName ? `Get ${componentName} (${actorName})` : `Get ${componentName}`;
}

export const sceneOwnedNodes: NodeDefinition[] = [
  {
    id: OWNED_ACTOR_GET_NODE_ID,
    title: "Get Actor",
    category: "scene",
    description:
      "Returns this Scene's or Scene Layer's placed actor, or null when it is gone.",
    pure: true,
    pins: (properties) => [
      pin("actor", "Actor", "out", objectRef(ownedGetProperties(properties).actorClassId || "Actor")),
    ],
    codegen: (ctx) => {
      const { actorId } = ownedGetProperties(ctx.node.properties);
      return { actor: actorId ? `ctx.getOwnedActor(${JSON.stringify(actorId)})` : "null" };
    },
  },
  {
    id: OWNED_COMPONENT_GET_NODE_ID,
    title: "Get Component",
    category: "scene",
    description:
      "Returns a component of this Scene's or Scene Layer's placed actor, or null when it is gone.",
    pure: true,
    pins: (properties) => [
      pin("component", "Component", "out", objectRef(ownedGetProperties(properties).componentClassId || "ActorComponent")),
    ],
    codegen: (ctx) => {
      const { actorId, componentId } = ownedGetProperties(ctx.node.properties);
      return {
        component: actorId && componentId
          ? `ctx.getOwnedComponent(${JSON.stringify(actorId)}, ${JSON.stringify(componentId)})`
          : "null",
      };
    },
  },
  {
    id: OWNED_TIMELINE_CLIP_GET_NODE_ID,
    title: "Get Timeline Clip",
    category: "scene",
    description:
      "Returns this Scene's or Scene Layer's Timeline Clip, for this loaded copy; each Scene Layer copy has its own.",
    pure: true,
    pins: () => [pin("clip", "Timeline Clip", "out", objectRef("TimelineClip"))],
    codegen: (ctx) => {
      const { clipId } = ownedTimelineClipProperties(ctx.node.properties);
      return { clip: clipId ? `ctx.getOwnedTimelineClip(${JSON.stringify(clipId)})` : "null" };
    },
  },
];
