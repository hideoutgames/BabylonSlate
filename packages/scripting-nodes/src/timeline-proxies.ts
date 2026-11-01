import { BOOL, EXEC, objectRef, pin, type NodeDefinition } from "@haptic/scripting";
import { subject } from "./self-pin";
import { TIMELINE_CLIP_CATEGORY } from "./timeline-clips";

/** Bind Actor to Timeline Proxy: binds a clip asset instance's Actor proxy. Hidden; the editor adds one row per Actor proxy. */
export const TIMELINE_PROXY_BIND_ACTOR_NODE_ID = "timelineProxy.bindActor";
/** Bind Component to Timeline Proxy: binds a Component proxy. Hidden; one row per Component proxy. */
export const TIMELINE_PROXY_BIND_COMPONENT_NODE_ID = "timelineProxy.bindComponent";
/** Unbind Timeline Proxy: clears one proxy. Hidden; one row per proxy. */
export const TIMELINE_PROXY_UNBIND_NODE_ID = "timelineProxy.unbind";
/** Get Timeline Proxy: the object a proxy is bound to. Hidden; one row per proxy. */
export const TIMELINE_PROXY_GET_NODE_ID = "timelineProxy.get";
/** Unbind All Timeline Proxies: clears every proxy of an instance. */
export const TIMELINE_PROXY_UNBIND_ALL_NODE_ID = "timelineProxy.unbindAll";

/** The proxy nodes that pick one proxy of one clip asset. */
export const TIMELINE_PROXY_PICKER_NODE_IDS: readonly string[] = [
  TIMELINE_PROXY_BIND_ACTOR_NODE_ID,
  TIMELINE_PROXY_BIND_COMPONENT_NODE_ID,
  TIMELINE_PROXY_UNBIND_NODE_ID,
  TIMELINE_PROXY_GET_NODE_ID,
];

export function isTimelineProxyPickerNode(typeId: string): boolean {
  return TIMELINE_PROXY_PICKER_NODE_IDS.includes(typeId);
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** What a proxy node names: the clip asset and the picked proxy. Ids stay put across renames. */
export function timelineProxyNodeProperties(properties: Record<string, unknown>): {
  clipAssetGuid: string;
  clipName: string;
  clipClassId: string;
  proxyId: string;
  proxyName: string;
  proxyClassId: string;
  represents: "actor" | "component";
} {
  return {
    clipAssetGuid: text(properties.timelineClipDocument),
    clipName: text(properties.timelineClipName),
    clipClassId: text(properties.timelineClipClassId),
    proxyId: text(properties.timelineProxyId),
    proxyName: text(properties.timelineProxyName),
    proxyClassId: text(properties.timelineProxyClassId),
    represents: properties.timelineProxyRepresents === "component" ? "component" : "actor",
  };
}

const VERBS: Record<string, string> = {
  [TIMELINE_PROXY_BIND_ACTOR_NODE_ID]: "Bind",
  [TIMELINE_PROXY_BIND_COMPONENT_NODE_ID]: "Bind",
  [TIMELINE_PROXY_UNBIND_NODE_ID]: "Unbind",
  [TIMELINE_PROXY_GET_NODE_ID]: "Get",
};

/** `Bind Door Proxy`, `Get Door Proxy`; the catalog title before the node picks a proxy. */
export function timelineProxyNodeTitle(typeId: string, properties: Record<string, unknown>): string {
  const { proxyName } = timelineProxyNodeProperties(properties);
  const verb = VERBS[typeId];
  if (!verb) return "";
  if (proxyName) return `${verb} ${proxyName} Proxy`;
  return typeId === TIMELINE_PROXY_BIND_ACTOR_NODE_ID ? "Bind Actor to Timeline Proxy"
    : typeId === TIMELINE_PROXY_BIND_COMPONENT_NODE_ID ? "Bind Component to Timeline Proxy"
      : `${verb} Timeline Proxy`;
}

const clipTarget = (properties: Record<string, unknown>) =>
  subject(pin("target", "Target", "in", objectRef(timelineProxyNodeProperties(properties).clipClassId || "TimelineClip")));

function bindNode(id: string, title: string, objectPin: { id: string; name: string; base: string }, description: string): NodeDefinition {
  return {
    id,
    title,
    category: TIMELINE_CLIP_CATEGORY,
    description,
    pins: (properties) => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      clipTarget(properties),
      pin(objectPin.id, objectPin.name, "in", objectRef(timelineProxyNodeProperties(properties).proxyClassId || objectPin.base)),
      pin("absolute", "Absolute Transform", "in", BOOL, "data", true, false),
    ],
    codegen: (ctx) => {
      const { proxyId } = timelineProxyNodeProperties(ctx.node.properties);
      ctx.emit(`ctx.timelineProxy(${ctx.input("target")}, "bind", ${JSON.stringify(proxyId)}, { object: ${ctx.input(objectPin.id)}, absolute: ${ctx.input("absolute")} });`);
    },
  };
}

/**
 * Bind, Unbind and Get on one proxy of a 2D or 3D Timeline Clip asset
 * instance (the proxy is picked on the node), and Unbind All. A rebind
 * applies from the next tick.
 */
export const timelineProxyNodes: NodeDefinition[] = [
  bindNode(TIMELINE_PROXY_BIND_ACTOR_NODE_ID, "Bind Actor to Timeline Proxy", { id: "actor", name: "Actor", base: "Actor" },
    "Binds an Actor proxy of the clip to an actor. Off, Absolute Transform makes the proxy's transform keys offsets from where the actor stands now; on, they set its world transform."),
  bindNode(TIMELINE_PROXY_BIND_COMPONENT_NODE_ID, "Bind Component to Timeline Proxy", { id: "component", name: "Component", base: "ActorComponent" },
    "Binds a Component proxy of the clip to a component. Off, Absolute Transform makes the proxy's transform keys offsets from the component's transform now; on, they set it relative to its parent."),
  {
    id: TIMELINE_PROXY_UNBIND_NODE_ID,
    title: "Unbind Timeline Proxy",
    category: TIMELINE_CLIP_CATEGORY,
    description: "Clears the picked proxy of the clip: its tracks stop applying.",
    pins: (properties) => [pin("execIn", "exec", "in", EXEC), pin("execOut", "then", "out", EXEC), clipTarget(properties)],
    codegen: (ctx) => {
      const { proxyId } = timelineProxyNodeProperties(ctx.node.properties);
      ctx.emit(`ctx.timelineProxy(${ctx.input("target")}, "unbind", ${JSON.stringify(proxyId)}, {});`);
    },
  },
  {
    id: TIMELINE_PROXY_GET_NODE_ID,
    title: "Get Timeline Proxy",
    category: TIMELINE_CLIP_CATEGORY,
    description: "The object the picked proxy of the clip is bound to, or None.",
    pure: true,
    pins: (properties) => {
      const { proxyClassId, represents } = timelineProxyNodeProperties(properties);
      return [
        clipTarget(properties),
        pin("object", "Object", "out", objectRef(proxyClassId || (represents === "component" ? "ActorComponent" : "Actor"))),
      ];
    },
    codegen: (ctx) => {
      const { proxyId } = timelineProxyNodeProperties(ctx.node.properties);
      return { object: `ctx.timelineProxyGet(${ctx.input("target")}, ${JSON.stringify(proxyId)})` };
    },
  },
  {
    id: TIMELINE_PROXY_UNBIND_ALL_NODE_ID,
    title: "Unbind All Timeline Proxies",
    category: TIMELINE_CLIP_CATEGORY,
    description: "Clears every proxy of a Timeline Clip asset instance.",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      subject(pin("target", "Target", "in", objectRef("TimelineClip"))),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.timelineProxy(${ctx.input("target")}, "unbindAll", "", {});`);
    },
  },
];
