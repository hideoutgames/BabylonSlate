import type { TimelineClipProxySummary } from "@haptic/core";
import { EXEC, arrayOf, assetRef, objectRef, pin, type NodeDefinition } from "@haptic/scripting";
import { subject } from "./self-pin";
import { TIMELINE_CLIP_CATEGORY } from "./timeline-clips";

/** Get Timeline Object Reference From Timeline Asset: the asset's Timeline object. */
export const TIMELINE_FROM_ASSET_NODE_ID = "timeline.fromAsset";
/** Get <Name> Timeline Clip on a Timeline: one scene clip of its asset. Hidden; the editor adds one row per clip. */
export const TIMELINE_GET_CLIP_NODE_ID = "timeline.getClip";
/** Get Loaded Timeline Clips: every loaded scene clip of a Timeline's asset. */
export const TIMELINE_LOADED_CLIPS_NODE_ID = "timeline.getLoadedClips";
/** Create <Name> Timeline Clip on a Timeline: a new instance of one of its clip assets. Hidden; the editor adds one row per clip asset. */
export const TIMELINE_CREATE_CLIP_NODE_ID = "timeline.createClip";

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** `Timeline:<guid>` for a Timeline Asset guid, else the plain `Timeline` class. */
const timelineClass = (assetGuid: string) => (assetGuid ? `Timeline:${assetGuid}` : "Timeline");

/**
 * The Timeline Asset that types Get Timeline Object Reference From Timeline
 * Asset's output. While its input is wired, the editor sets
 * `timelineAssetGuid` (a wired variable's default, else empty for a plain
 * Timeline); otherwise the pin's own value names it.
 */
export function timelineFromAssetGuid(properties: Record<string, unknown>): string {
  return "timelineAssetGuid" in properties ? text(properties.timelineAssetGuid) : text(properties["default:timelineAsset"]);
}

/** What a Get <Name> Timeline Clip node on a Timeline names. Ids stay put across renames. */
export function timelineClipNodeProperties(properties: Record<string, unknown>): {
  assetGuid: string;
  documentGuid: string;
  clipId: string;
  clipName: string;
  clipClassId: string;
} {
  return {
    assetGuid: text(properties.timelineAssetGuid),
    documentGuid: text(properties.timelineClipDocument),
    clipId: text(properties.timelineClipId),
    clipName: text(properties.timelineClipName),
    clipClassId: text(properties.timelineClipClassId),
  };
}

/** `Get Intro Timeline Clip`, or `Get Timeline Clip` before it names one. */
export function timelineClipNodeTitle(properties: Record<string, unknown>): string {
  const { clipName } = timelineClipNodeProperties(properties);
  return clipName ? `Get ${clipName} Timeline Clip` : "Get Timeline Clip";
}

/** The proxies a Create <Name> Timeline Clip node offers inputs for, as the editor last stored them. */
export function timelineCreateClipProxies(properties: Record<string, unknown>): TimelineClipProxySummary[] {
  const raw = properties.timelineClipProxies;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): TimelineClipProxySummary[] => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const id = text(row.id);
    const classId = text(row.classId);
    if (!id || !classId) return [];
    return [{ id, name: text(row.name) || classId, represents: row.represents === "component" ? "component" : "actor", classId }];
  });
}

/** A Create node's input for one proxy; its id never changes with the proxy's name. */
export function timelineProxyPinId(proxyId: string): string {
  return `proxy:${proxyId}`;
}

/** `Create Door Swing Timeline Clip`, or `Create Timeline Clip` before it names one. */
export function timelineCreateClipNodeTitle(properties: Record<string, unknown>): string {
  const { clipName } = timelineClipNodeProperties(properties);
  return clipName ? `Create ${clipName} Timeline Clip` : "Create Timeline Clip";
}

/**
 * A Timeline Asset's Timeline object and its scene clips. The Timeline is
 * valid whether or not the scenes are loaded; a clip reads None while its
 * Scene or Scene Layer is not loaded.
 */
export const timelineAssetNodes: NodeDefinition[] = [
  {
    id: TIMELINE_FROM_ASSET_NODE_ID,
    title: "Get Timeline Object Reference From Timeline Asset",
    category: TIMELINE_CLIP_CATEGORY,
    description: "The Timeline object of a Timeline Asset, one per asset for the whole session. It is valid whether or not the scenes holding its clips are loaded.",
    pure: true,
    pins: (properties) => [
      pin("timelineAsset", "Timeline Asset", "in", assetRef("Timeline")),
      pin("timeline", "Timeline", "out", objectRef(timelineClass(timelineFromAssetGuid(properties)))),
    ],
    codegen: (ctx) => ({ timeline: `ctx.getTimeline(${ctx.input("timelineAsset")})` }),
  },
  {
    id: TIMELINE_GET_CLIP_NODE_ID,
    title: "Get Timeline Clip",
    category: TIMELINE_CLIP_CATEGORY,
    description: "The loaded clip: from the main Scene, else the first Scene Layer copy holding it. None while its Scene or Scene Layer is not loaded.",
    pure: true,
    pins: (properties) => {
      const { assetGuid, clipClassId } = timelineClipNodeProperties(properties);
      return [
        subject(pin("target", "Target", "in", objectRef(timelineClass(assetGuid)))),
        pin("clip", "Timeline Clip", "out", objectRef(clipClassId || "TimelineClip")),
      ];
    },
    codegen: (ctx) => {
      const { documentGuid, clipId } = timelineClipNodeProperties(ctx.node.properties);
      return {
        clip: clipId && documentGuid
          ? `ctx.getTimelineClip(${ctx.input("target")}, ${JSON.stringify(documentGuid)}, ${JSON.stringify(clipId)})`
          : "null",
      };
    },
  },
  {
    id: TIMELINE_LOADED_CLIPS_NODE_ID,
    title: "Get Loaded Timeline Clips",
    category: TIMELINE_CLIP_CATEGORY,
    description: "Every loaded scene clip of the Timeline's asset: the main Scene's first, then the Scene Layer copies' in the order they were created.",
    pure: true,
    pins: () => [
      subject(pin("target", "Target", "in", objectRef("Timeline"))),
      pin("clips", "Timeline Clips", "out", arrayOf(objectRef("TimelineClip"))),
    ],
    codegen: (ctx) => ({ clips: `ctx.getLoadedTimelineClips(${ctx.input("target")})` }),
  },
  {
    id: TIMELINE_CREATE_CLIP_NODE_ID,
    title: "Create Timeline Clip",
    category: TIMELINE_CLIP_CATEGORY,
    description:
      "Creates an instance of a 2D or 3D Timeline Clip asset, with its own playhead and proxy bindings, and binds each connected proxy input Relative: its keys offset that object's transform from where it stands now. Unconnected proxies stay unbound. The instance lives while a variable holds it or while it plays.",
    pins: (properties) => {
      const { assetGuid, clipClassId } = timelineClipNodeProperties(properties);
      return [
        pin("execIn", "exec", "in", EXEC),
        pin("execOut", "then", "out", EXEC),
        subject(pin("target", "Target", "in", objectRef(timelineClass(assetGuid)))),
        // Optional: an unconnected proxy stays unbound.
        ...timelineCreateClipProxies(properties).map((proxy) => pin(timelineProxyPinId(proxy.id), proxy.name, "in", objectRef(proxy.classId), "data", true)),
        pin("clip", "Timeline Clip", "out", objectRef(clipClassId || "TimelineClip")),
      ];
    },
    codegen: (ctx) => {
      const { documentGuid } = timelineClipNodeProperties(ctx.node.properties);
      const inputs = timelineCreateClipProxies(ctx.node.properties)
        .map((proxy) => `${JSON.stringify(proxy.id)}: ${ctx.input(timelineProxyPinId(proxy.id))}`);
      ctx.emit(documentGuid
        ? `${ctx.output("clip")} = ctx.createTimelineClip(${ctx.input("target")}, ${JSON.stringify(documentGuid)}, { ${inputs.join(", ")} });`
        : `${ctx.output("clip")} = null;`);
    },
  },
];
