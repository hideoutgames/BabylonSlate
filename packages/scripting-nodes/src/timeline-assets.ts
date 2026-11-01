import { arrayOf, assetRef, objectRef, pin, type NodeDefinition } from "@haptic/scripting";
import { subject } from "./self-pin";
import { TIMELINE_CLIP_CATEGORY } from "./timeline-clips";

/** Get Timeline Object Reference From Timeline Asset: the asset's Timeline object. */
export const TIMELINE_FROM_ASSET_NODE_ID = "timeline.fromAsset";
/** Get <Name> Timeline Clip on a Timeline: one scene clip of its asset. Hidden; the editor adds one row per clip. */
export const TIMELINE_GET_CLIP_NODE_ID = "timeline.getClip";
/** Get Loaded Timeline Clips: every loaded scene clip of a Timeline's asset. */
export const TIMELINE_LOADED_CLIPS_NODE_ID = "timeline.getLoadedClips";

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
];
