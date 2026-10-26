import { pin, type NodeDefinition, objectRef } from "@haptic/scripting";

/**
 * Get <Actor> and Get <Component> (<Actor>) for a SceneScript or
 * SceneLayerScript: direct references to what that Scene or Scene Layer
 * instance placed. Hidden from Add Node like Get <Subsystem>; the editor
 * injects one row per actor and per actor component of the owning document.
 */
export const OWNED_ACTOR_GET_NODE_ID = "scene.getOwnedActor";
export const OWNED_COMPONENT_GET_NODE_ID = "scene.getOwnedComponent";

/** What a Get <Actor> / Get <Component> (<Actor>) node names. */
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
    actorId: text(properties.actorId),
    actorName: text(properties.actorName),
    actorClassId: text(properties.actorClassId),
    componentId: text(properties.componentId),
    componentName: text(properties.componentName),
    componentClassId: text(properties.componentClassId),
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
];
